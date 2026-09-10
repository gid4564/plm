import { connectDb } from "@/lib/db";
import { Enterprise, User } from "@/lib/models";
import { LiveOnshapeClient } from "./live-client";
import { MockOnshapeClient } from "./mock-client";
import { isMock, refreshTokens } from "./oauth";
import type { OnshapeClient } from "./types";

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
    const t = await refreshTokens(user.onshapeRefreshToken);
    user.onshapeAccessToken = t.accessToken;
    if (t.refreshToken) user.onshapeRefreshToken = t.refreshToken;
    user.onshapeTokenExpiresAt = t.expiresAt;
    await user.save();
  }

  return new LiveOnshapeClient(user.onshapeAccessToken);
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
