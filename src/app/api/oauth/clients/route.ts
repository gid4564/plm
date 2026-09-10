import { z } from "zod";
import { connectDb } from "@/lib/db";
import { ActivityLog, OAuthClient, OAuthToken } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { registerClient } from "@/lib/oauth-server";
import { baseUrl } from "@/lib/onshape/oauth";
import { handler, ok, fail } from "@/lib/api";

/** Client applications registered to call PLM — in practice, Onshape. */
export const GET = handler(async () => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can see the OAuth clients.", 403);

  await connectDb();
  const clients: any[] = await OAuthClient.find({}).sort({ createdAt: -1 }).lean();

  const liveByClient = new Map<string, number>();
  for (const row of await OAuthToken.aggregate([
    { $match: { revokedAt: null, expiresAt: { $gt: new Date() } } },
    { $group: { _id: "$clientId", n: { $sum: 1 } } },
  ])) {
    liveByClient.set(String(row._id), row.n);
  }

  return ok({
    /** What an admin pastes into Onshape's Developer Portal. */
    endpoints: {
      authorize: `${baseUrl()}/api/oauth/authorize`,
      token: `${baseUrl()}/api/oauth/token`,
    },
    clients: clients.map((c) => ({
      id: String(c._id),
      name: c.name,
      clientId: c.clientId,
      redirectUris: c.redirectUris ?? [],
      liveTokens: liveByClient.get(c.clientId) ?? 0,
      lastUsedAt: c.lastUsedAt,
      disabledAt: c.disabledAt,
      createdAt: c.createdAt,
    })),
  });
});

const Body = z.object({
  name: z.string().min(1).max(120),
  redirectUris: z.array(z.string().url()).min(1).max(10),
});

/**
 * Register a client and return its secret — once.
 *
 * The secret is shown in this response and never again: only its bcrypt hash
 * is stored. That is the correct cost. It exists to be pasted into Onshape's
 * Developer Portal, and a secret PLM could read back is a secret PLM could
 * leak.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can register an OAuth client.", 403);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const created = await registerClient(parsed.data.name, parsed.data.redirectUris, s.enterpriseId);

  await ActivityLog.create({
    enterpriseId: s.enterpriseId, direction: "plm", action: "created", trigger: "user-edit", ok: true,
    message: `${s.email} registered the OAuth client "${parsed.data.name}" (${created.clientId})`,
  });

  return ok({
    clientId: created.clientId,
    clientSecret: created.clientSecret,
    warning:
      "Copy the secret now — it is stored only as a hash and cannot be shown again. " +
      "Paste it, with the client id, into Onshape's Developer Portal against this " +
      "application's External OAuth settings.",
  }, 201);
});

const Patch = z.object({
  clientId: z.string().min(1),
  redirectUris: z.array(z.string().url()).min(1).max(10),
});

/**
 * Correct a client's registered redirect URIs, keeping its credentials.
 *
 * Necessary because the right value is not knowable in advance: it is whatever
 * Onshape sends, and an admin only finds out when a mismatch is reported. The
 * alternative — disable and re-register — throws away a secret that has already
 * been pasted into the Developer Portal, turning a one-field correction into
 * re-doing the whole exchange on both sides.
 *
 * Matching stays exact at redemption. This changes what the list contains, not
 * how strictly it is compared: a prefix match on a redirect URI is how an
 * authorization server becomes a token-exfiltration path.
 */
export const PATCH = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change an OAuth client.", 403);

  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const client: any = await OAuthClient.findOne({ clientId: parsed.data.clientId });
  if (!client) return fail("Client not found", 404);
  if (client.disabledAt) {
    return fail(
      "That client is disabled, and its tokens were revoked. Register a new one instead.",
      409
    );
  }

  const before: string[] = client.redirectUris ?? [];
  const after = parsed.data.redirectUris.map((u) => u.trim()).filter(Boolean);
  client.redirectUris = after;
  await client.save();

  /*
   * Tokens are left alone. Changing where a code may be sent does not
   * invalidate access already granted through a URI that was registered at the
   * time — and revoking here would mean every correction forced every user to
   * re-consent, which is the friction that stops people fixing it at all.
   */
  await ActivityLog.create({
    enterpriseId: s.enterpriseId, direction: "plm", action: "updated",
    trigger: "user-edit", ok: true,
    message:
      `${s.email} changed the redirect URIs for "${client.name}" (${client.clientId}) ` +
      `from [${before.join(", ") || "none"}] to [${after.join(", ")}]`,
  });

  return ok({
    clientId: client.clientId,
    redirectUris: after,
    message: `Updated. Onshape may now send a code to: ${after.join(", ")}`,
  });
});

/** Disable a client and revoke every token it holds. */
export const DELETE = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can disable an OAuth client.", 403);

  const clientId = new URL(req.url).searchParams.get("clientId") ?? "";
  if (!clientId) return fail("clientId is required.", 422);

  await connectDb();
  const client: any = await OAuthClient.findOne({ clientId });
  if (!client) return fail("Client not found", 404);

  client.disabledAt = new Date();
  await client.save();

  // Disabling without revoking would leave every issued access token working
  // until it expired — up to an hour of access after it was withdrawn.
  const revoked = await OAuthToken.updateMany(
    { clientId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );

  await ActivityLog.create({
    enterpriseId: s.enterpriseId, direction: "plm", action: "deleted", trigger: "user-edit", ok: true,
    message:
      `${s.email} disabled the OAuth client "${client.name}" and revoked ` +
      `${revoked.modifiedCount ?? 0} token(s)`,
  });

  return ok({ disabled: true, tokensRevoked: revoked.modifiedCount ?? 0 });
});
