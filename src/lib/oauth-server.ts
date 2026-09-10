import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { connectDb } from "@/lib/db";
import { OAuthAuthCode, OAuthClient, OAuthToken } from "@/lib/models";

/**
 * PLM as an OAuth2 authorization server.
 *
 * This is the half of requirement 1 that inverts MOS. MOS is only ever an
 * OAuth *client* of Onshape. PLM is that too — see lib/onshape/oauth.ts, which
 * is unchanged — but it is additionally a server, because Onshape's extension
 * action URLs use what Onshape calls External OAuth: "Onshape acts as a client,
 * and the application acts as a server."
 *
 * Grants: authorization code, and refresh token. Not client credentials —
 * Onshape's own sample application (onshape-public/inventory-oauth2-app) issues
 * codes and exchanges refresh tokens, and the token has to be attributable to
 * the PLM user who consented, not merely to Onshape as a whole.
 *
 * What this does NOT cover: webhooks. Onshape's webhook registration accepts no
 * custom headers and offers no signature scheme, so a webhook callback cannot
 * carry a bearer token. Those still authenticate with a shared secret in the
 * registered callback URL.
 */

/* -------------------------------------------------------------------------- */
/* Secrets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Hash a bearer token for storage.
 *
 * SHA-256 rather than bcrypt, deliberately. This is verified on every inbound
 * extension call, where a purposely slow hash would be the request's dominant
 * cost — and unlike a password, a 32-byte random token has nothing to
 * brute-force. The client *secret* is a different case and does use bcrypt: it
 * is checked rarely, and it is the one credential a person copies by hand.
 */
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

const newToken = () => randomBytes(32).toString("base64url");

/** Constant-time string comparison, for values a caller supplies. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* -------------------------------------------------------------------------- */
/* Client registration                                                         */
/* -------------------------------------------------------------------------- */

export type NewClient = {
  clientId: string;
  /** Shown once. Only its hash is stored. */
  clientSecret: string;
};

/**
 * Register Onshape as a client of this PLM.
 *
 * The returned secret is the only time it exists in readable form: it goes into
 * Onshape's Developer Portal, and there is no reason for PLM to be able to read
 * it back afterwards. Losing it means issuing a new one, which is the correct
 * cost.
 */
export async function registerClient(
  name: string,
  redirectUris: string[],
  enterpriseId?: string
): Promise<NewClient> {
  await connectDb();

  const clientId = `plm-${randomBytes(12).toString("hex")}`;
  const clientSecret = randomBytes(32).toString("base64url");

  await OAuthClient.create({
    name,
    clientId,
    clientSecretHash: await bcrypt.hash(clientSecret, 10),
    // Stored exactly as given. Matched verbatim at redemption, never by prefix:
    // a prefix match on a redirect URI is how an open redirector becomes a
    // token-exfiltration path.
    redirectUris: redirectUris.map((u) => u.trim()).filter(Boolean),
    enterpriseId: enterpriseId ?? null,
  });

  return { clientId, clientSecret };
}

/** Look up an enabled client, or null. */
export async function findClient(clientId: string): Promise<any | null> {
  await connectDb();
  const client: any = await OAuthClient.findOne({ clientId }).lean();
  if (!client || client.disabledAt) return null;
  return client;
}

/**
 * Authenticate a client presenting its id and secret.
 *
 * Used on the token endpoint. Returns null for every failure mode — unknown
 * client, disabled client, wrong secret — because telling a caller which of
 * those it was tells an attacker which client ids are real.
 */
export async function verifyClient(clientId: string, clientSecret: string): Promise<any | null> {
  const client = await findClient(clientId);
  if (!client) return null;
  const ok = await bcrypt.compare(clientSecret, client.clientSecretHash);
  return ok ? client : null;
}

/**
 * Whether a redirect URI is one this client registered.
 *
 * Exact match only. See the note in registerClient.
 */
export function redirectAllowed(client: any, redirectUri: string): boolean {
  const list: string[] = client?.redirectUris ?? [];
  return list.some((u) => safeEqual(u, redirectUri));
}

/* -------------------------------------------------------------------------- */
/* Authorization code                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Issue a one-time code after a PLM user has consented.
 *
 * The code carries the user and their enterprise, which is what makes an
 * inbound extension call attributable: when Onshape later presents the bearer
 * token, PLM knows whose data to answer with and which tenant it belongs to.
 */
export async function issueAuthCode(input: {
  clientId: string;
  redirectUri: string;
  userId: string;
  enterpriseId: string;
  scope?: string;
}): Promise<string> {
  await connectDb();
  const code = newToken();

  await OAuthAuthCode.create({
    code: hashToken(code),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    userId: input.userId,
    enterpriseId: input.enterpriseId,
    scope: input.scope ?? "",
  });

  return code;
}

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
};

/** How long an access token lasts. Refresh tokens do not expire on their own. */
const ACCESS_TOKEN_TTL_SECONDS = 3600;

/**
 * Redeem an authorization code for tokens.
 *
 * Three checks, and each one matters:
 *
 *  - the code must not already be used. A code presented twice is a replay,
 *    and is treated as one even though it may be an innocent retry: the
 *    difference is not knowable, and the safe reading is the strict one.
 *  - the code must belong to this client. Otherwise one registered client
 *    could redeem another's codes.
 *  - the redirect URI must match the one the code was issued against. This is
 *    what stops a code intercepted at a different callback being usable.
 */
export async function exchangeAuthCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
}): Promise<{ ok: true; tokens: IssuedTokens } | { ok: false; error: string }> {
  await connectDb();

  const row: any = await OAuthAuthCode.findOne({ code: hashToken(input.code) });
  if (!row) return { ok: false, error: "invalid_grant" };

  if (row.usedAt) {
    /*
     * A replayed code invalidates everything it ever produced.
     *
     * If the code leaked, the tokens minted from it are in unknown hands, and
     * leaving them live to avoid inconveniencing a legitimate retry is the
     * wrong trade. Re-consenting is cheap.
     */
    await OAuthToken.updateMany(
      { clientId: row.clientId, userId: row.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    return { ok: false, error: "invalid_grant" };
  }

  if (!safeEqual(String(row.clientId), input.clientId)) return { ok: false, error: "invalid_grant" };
  if (!safeEqual(String(row.redirectUri), input.redirectUri)) {
    return { ok: false, error: "invalid_grant" };
  }

  row.usedAt = new Date();
  await row.save();

  return { ok: true, tokens: await mintTokens({
    clientId: row.clientId,
    userId: String(row.userId),
    enterpriseId: String(row.enterpriseId),
    scope: row.scope ?? "",
  }) };
}

async function mintTokens(input: {
  clientId: string;
  userId: string;
  enterpriseId: string;
  scope: string;
}): Promise<IssuedTokens> {
  const accessToken = newToken();
  const refreshToken = newToken();

  await OAuthToken.create({
    accessTokenHash: hashToken(accessToken),
    refreshTokenHash: hashToken(refreshToken),
    clientId: input.clientId,
    userId: input.userId,
    enterpriseId: input.enterpriseId,
    scope: input.scope,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
  });

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope: input.scope };
}

/**
 * Exchange a refresh token for a new pair.
 *
 * The old row is revoked as the new one is issued — refresh tokens rotate. A
 * long-lived, reusable refresh token is a credential that never expires, and
 * rotation is what makes a stolen one detectable: the legitimate holder's next
 * refresh fails.
 */
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
}): Promise<{ ok: true; tokens: IssuedTokens } | { ok: false; error: string }> {
  await connectDb();

  const row: any = await OAuthToken.findOne({
    refreshTokenHash: hashToken(input.refreshToken),
    revokedAt: null,
  });
  if (!row) return { ok: false, error: "invalid_grant" };
  if (!safeEqual(String(row.clientId), input.clientId)) return { ok: false, error: "invalid_grant" };

  row.revokedAt = new Date();
  await row.save();

  return { ok: true, tokens: await mintTokens({
    clientId: row.clientId,
    userId: String(row.userId),
    enterpriseId: String(row.enterpriseId),
    scope: row.scope ?? "",
  }) };
}

/* -------------------------------------------------------------------------- */
/* Verifying an inbound call                                                   */
/* -------------------------------------------------------------------------- */

export type BearerIdentity = {
  userId: string;
  enterpriseId: string;
  clientId: string;
  scope: string;
};

/**
 * Resolve the bearer token on an inbound request from Onshape.
 *
 * This is what every extension action URL is guarded by. Returns null rather
 * than throwing so a route can answer 401 in its own shape — Onshape's
 * extension contract says nothing about a failure body, so the route decides.
 *
 * `lastUsedAt` is updated without awaiting the result: it is diagnostic, and
 * making every extension call wait on a write for it would be paying latency
 * for nothing.
 */
export async function authenticateBearer(req: Request): Promise<BearerIdentity | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;

  await connectDb();

  const row: any = await OAuthToken.findOne({
    accessTokenHash: hashToken(match[1].trim()),
    revokedAt: null,
  }).lean();

  if (!row) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) return null;

  void OAuthToken.updateOne({ _id: row._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
  void OAuthClient.updateOne(
    { clientId: row.clientId },
    { $set: { lastUsedAt: new Date() } }
  ).catch(() => {});

  return {
    userId: String(row.userId),
    enterpriseId: String(row.enterpriseId),
    clientId: String(row.clientId),
    scope: row.scope ?? "",
  };
}

/** Revoke every token a client holds for a user. Used when consent is withdrawn. */
export async function revokeConsent(clientId: string, userId: string): Promise<number> {
  await connectDb();
  const res = await OAuthToken.updateMany(
    { clientId, userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return res.modifiedCount ?? 0;
}

/**
 * Explain why a client id was not accepted, for an admin of this instance.
 *
 * `findClient` returns null for three different reasons — no such client, a
 * disabled one, and (indirectly) a client registered against a *different* PLM
 * instance or database. One message covering all three sends someone to
 * re-check a value that is fine.
 *
 * Only ever shown to a signed-in admin. Naming the client ids an instance holds
 * would otherwise let an anonymous caller enumerate them, which is why the
 * public message stays deliberately vague.
 */
export async function describeClientFailure(clientId: string): Promise<string> {
  await connectDb();

  const exact: any = await OAuthClient.findOne({ clientId }).lean();
  if (exact?.disabledAt) {
    return (
      `The client "${exact.name}" (${clientId}) was disabled on ` +
      `${new Date(exact.disabledAt).toISOString().slice(0, 10)}, and every token it held ` +
      `was revoked. Register a new one in Settings and paste the new id and secret into ` +
      `Onshape's Developer Portal.`
    );
  }

  const all: any[] = await OAuthClient.find({}).select("clientId name disabledAt").lean();

  if (all.length === 0) {
    return (
      `No OAuth client is registered on this PLM instance at all, so nothing could match ` +
      `"${clientId}". Register one under Settings → How Onshape authenticates to PLM, then ` +
      `paste its id and secret into Onshape's Developer Portal. If you registered one ` +
      `already, it was against a different instance or a different database — a client ` +
      `registered on a laptop does not exist on the server.`
    );
  }

  const live = all.filter((c) => !c.disabledAt);
  return (
    `No client with id "${clientId}" is registered here. This instance holds ` +
    `${live.length} enabled client(s): ` +
    `${live.map((c) => `${c.name} (${c.clientId})`).join(", ") || "none"}. ` +
    `Either Onshape is configured with an id from a different PLM instance, or the value ` +
    `pasted into the Developer Portal is not the client id — check it is not the secret, ` +
    `and that it carries no quotes or stray whitespace.`
  );
}
