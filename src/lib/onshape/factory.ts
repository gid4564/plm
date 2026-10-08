import { connectDb } from "@/lib/db";
import { Enterprise, User } from "@/lib/models";
import { LiveOnshapeClient } from "./live-client";
import { MockOnshapeClient } from "./mock-client";
import { isMock, refreshTokens } from "./oauth";
import type { OnshapeClient } from "./types";

/**
 * In-flight refreshes, one per user.
 *
 * Onshape rotates the refresh token on use, so two concurrent refreshes race:
 * the second presents a token the first has already spent, and *both* end up
 * broken. A webhook burst is exactly when several calls discover an expired
 * token at once, so this is the common case rather than a corner.
 *
 * Sharing the promise means the first caller does the work and the rest wait
 * for its answer. In-process only — good enough here, where one server holds
 * the connection; a multi-instance deployment would need this in the database.
 */
const refreshing = new Map<string, Promise<string | null>>();

/**
 * Refresh one user's Onshape tokens and persist them.
 *
 * Returns the new access token, or null when the connection cannot be repaired
 * without a person — no refresh token stored, or Onshape refusing the one there
 * is. Null is deliberately not an exception: the caller is usually deciding
 * whether to retry, and "cannot" is an answer to that question.
 */
async function refreshFor(userId: string): Promise<string | null> {
  const inFlight = refreshing.get(userId);
  if (inFlight) return inFlight;

  const run = (async (): Promise<string | null> => {
    try {
      await connectDb();
      const user: any = await User.findById(userId);
      if (!user?.onshapeRefreshToken) return null;

      const t = await refreshTokens(user.onshapeRefreshToken);
      user.onshapeAccessToken = t.accessToken;
      if (t.refreshToken) user.onshapeRefreshToken = t.refreshToken;
      user.onshapeTokenExpiresAt = t.expiresAt;
      // A working refresh clears any previous failure: the connection has
      // repaired itself and should stop being reported as broken.
      user.onshapeTokenFailedAt = null;
      user.onshapeTokenError = null;
      await user.save();
      return t.accessToken;
    } catch (err: any) {
      /*
       * Recorded, not swallowed. A refresh that fails means the connection is
       * broken until somebody reconnects, and on the webhook path nobody is
       * looking at a response — the log is the only place it can surface.
       */
      const message = String(err?.message ?? err).slice(0, 400);
      console.warn(
        `[PLM] could not refresh the Onshape token for user ${userId}: ${message}. ` +
        `That account must press Connect Onshape again.`
      );
      // Recorded on the user as well as logged, so Settings can stop claiming
      // the connection is healthy.
      await User.updateOne(
        { _id: userId },
        { $set: { onshapeTokenFailedAt: new Date(), onshapeTokenError: message } }
      ).catch(() => {});
      return null;
    } finally {
      refreshing.delete(userId);
    }
  })();

  refreshing.set(userId, run);
  return run;
}

/**
 * Build a client acting as a specific PLM user, refreshing their Onshape token
 * first if it is within 60s of expiry.
 */
export async function clientForUser(userId: string): Promise<OnshapeClient> {
  await connectDb();
  const user: any = await User.findById(userId);
  if (!user) throw new Error("User not found");

  const enterprise: any = await Enterprise.findById(user.enterpriseId);
  if (!enterprise) throw new Error("Enterprise not found");

  if (isMock()) {
    return new MockOnshapeClient(enterprise.onshapeCompanyId, {
      id: user.onshapeUserId || `mock-${user._id}`,
      email: user.email,
      name: user.name || user.email,
    });
  }

  if (!user.onshapeAccessToken) {
    throw new Error("This user has not connected their Onshape account.");
  }

  const expiringSoon =
    !user.onshapeTokenExpiresAt || user.onshapeTokenExpiresAt.getTime() - Date.now() < 60_000;

  if (expiringSoon && user.onshapeRefreshToken) {
    await refreshFor(userId);
  }

  const fresh: any = await User.findById(userId);

  // The callback is what turns a rejected token into a retry rather than a
  // dead client — see the note on LiveOnshapeClient's constructor.
  return new LiveOnshapeClient(
    fresh.onshapeAccessToken,
    undefined,
    () => refreshFor(userId),
    enterprise.onshapeCompanyId,
    String(enterprise._id)
  );
}

/**
 * Build a client for background work (webhook-driven writes) using the
 * enterprise's designated integration account. Falls back to any connected
 * admin so a fresh install still functions before setup is finished.
 */
export async function clientForEnterprise(enterpriseId: string): Promise<{ client: OnshapeClient; actingUserId: string }> {
  await connectDb();
  const enterprise: any = await Enterprise.findById(enterpriseId);
  if (!enterprise) throw new Error("Enterprise not found");

  if (isMock()) {
    const anyUser: any = await User.findOne({ enterpriseId }).lean();
    return {
      client: new MockOnshapeClient(enterprise.onshapeCompanyId),
      actingUserId: anyUser ? String(anyUser._id) : "",
    };
  }

  let integrationId = enterprise.integrationUserId ? String(enterprise.integrationUserId) : null;

  if (!integrationId) {
    const fallback: any = await User.findOne({
      enterpriseId,
      onshapeAccessToken: { $ne: null },
    })
      .sort({ role: 1, onshapeConnectedAt: -1 })
      .lean();
    if (!fallback) {
      throw new Error(
        "No Onshape integration account is connected for this enterprise. Connect one in Settings."
      );
    }
    integrationId = String(fallback._id);
  }

  return { client: await clientForUser(integrationId), actingUserId: integrationId };
}
