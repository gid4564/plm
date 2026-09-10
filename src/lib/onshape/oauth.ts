import type { OAuthTokens } from "./types";

export function isMock(): boolean {
  return (process.env.ONSHAPE_MODE || "mock") !== "live";
}

export function baseUrl(): string {
  return (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function redirectUri(): string {
  return `${baseUrl()}/api/onshape/oauth/callback`;
}


/**
 * Callback URL registered with Onshape.
 *
 * Onshape's webhook registration accepts no custom headers and offers no
 * signature scheme, so the shared secret has to travel in the URL itself —
 * Onshape calls back exactly the URL it was given. Without this the receiver
 * has no way to tell a genuine delivery from anyone who guessed the path.
 */
export function webhookCallbackUrl(enterpriseId?: string): string {
  const p = new URLSearchParams();

  const secret = process.env.ONSHAPE_WEBHOOK_SECRET;
  if (secret) p.set("token", secret);

  // Name the tenant in the URL rather than trying to infer it from the payload.
  // Onshape does not reliably include companyId, and matching on webhookId
  // breaks the moment a stale subscription is still live. The callback URL is
  // echoed back verbatim, so this always arrives.
  if (enterpriseId) p.set("ent", enterpriseId);

  const qs = p.toString();
  return `${baseUrl()}/api/webhooks/onshape${qs ? `?${qs}` : ""}`;
}

const OAUTH = () => (process.env.ONSHAPE_OAUTH_URL || "https://oauth.onshape.com").replace(/\/$/, "");

export function authorizeUrl(state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ONSHAPE_CLIENT_ID || "",
    redirect_uri: redirectUri(),
    state,
    // Read+write metadata is the minimum this app needs.
    scope: "OAuth2Read OAuth2Write OAuth2ReadPII",
  });
  return `${OAUTH()}/oauth/authorize?${p.toString()}`;
}

/**
 * Identify a credential without disclosing it, for error messages.
 *
 * Enough to tell "the wrong value" from "no value" and to compare against the
 * Developer Portal at a glance, and not enough to be worth redacting from a
 * ticket or a log.
 */
function fingerprint(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 8) return `${value.length} chars`;
  return `${value.length} chars, ${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Exchange with Onshape's token endpoint.
 *
 * The credentials go in the **form body**, not as HTTP Basic. RFC 6749 says a
 * server MUST accept Basic and a client SHOULD prefer it, but Onshape answers
 * `unauthorized_client` to Basic and accepts only the form-parameter form — so
 * this is deliberate rather than the lazier of two options. Verified against
 * the live endpoint; scripts/check-onshape-oauth.mjs re-establishes it on demand.
 */
async function tokenRequest(body: Record<string, string>): Promise<OAuthTokens> {
  const clientId = process.env.ONSHAPE_CLIENT_ID || "";
  const clientSecret = process.env.ONSHAPE_CLIENT_SECRET || "";

  /*
   * Refuse before calling out, when there is plainly nothing to authenticate
   * with. Onshape answers an empty client_id with `unauthorized_client`, which
   * reads as "your credentials are wrong" and sends people to check values that
   * are, in the file, entirely correct — the actual fault being that this
   * process started before the file did.
   */
  if (!clientId || !clientSecret) {
    throw new Error(
      `Onshape credentials are missing from this process: ` +
      `ONSHAPE_CLIENT_ID is ${fingerprint(clientId)}, ` +
      `ONSHAPE_CLIENT_SECRET is ${fingerprint(clientSecret)}. ` +
      `They are read once at startup, so a .env.local written afterwards is not ` +
      `picked up until the app restarts — try "pm2 restart plm --update-env".`
    );
  }

  const res = await fetch(`${OAUTH()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      ...body,
    }).toString(),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    /*
     * Say what was actually sent. Onshape's own reply names neither the client
     * it rejected nor the redirect_uri it compared against, so without this the
     * error is indistinguishable from a dozen different causes — and the values
     * held by a running process are exactly what nobody can see.
     */
    throw new Error(
      `Onshape token exchange failed (${res.status}): ${detail} ` +
      `— sent client_id ${fingerprint(clientId)}, secret ${fingerprint(clientSecret)}, ` +
      `redirect_uri ${redirectUri()}, to ${OAUTH()}/oauth/token. ` +
      `If those look right, run scripts/check-onshape-oauth.mjs from the deployment ` +
      `directory: it reports whether Onshape accepts the credentials at all.`
    );
  }

  const j = (await res.json()) as Record<string, any>;
  return {
    accessToken: String(j.access_token),
    refreshToken: String(j.refresh_token ?? ""),
    expiresAt: new Date(Date.now() + Number(j.expires_in ?? 3600) * 1000),
  };
}

export function exchangeCode(code: string): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
}

export function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

/**
 * Deep link to a part in the Onshape UI.
 *
 * The web host is not the API host: enterprises live on their own subdomain, so
 * prefer the enterprise's recorded domain, then derive from ONSHAPE_API_URL,
 * then fall back to the public host.
 *
 * Onshape addresses an element by workspace or version. A part cannot be
 * pre-selected from the URL, so this opens the tab that contains it.
 */
export function onshapeElementUrl(
  item: { documentId: string; elementId: string; workspaceId?: string | null; versionId?: string | null; configuration?: string | null },
  enterpriseDomain?: string | null
): string | null {
  if (!item.documentId || !item.elementId) return null;

  let host = "https://cad.onshape.com";
  if (enterpriseDomain) {
    host = /^https?:\/\//.test(enterpriseDomain)
      ? enterpriseDomain.replace(/\/$/, "")
      : `https://${enterpriseDomain.replace(/\/$/, "")}`;
  } else if (process.env.ONSHAPE_API_URL) {
    host = process.env.ONSHAPE_API_URL.replace(/\/api\/?$/, "").replace(/\/$/, "");
  }

  const wv = item.workspaceId ? `w/${item.workspaceId}` : item.versionId ? `v/${item.versionId}` : null;
  if (!wv) return null;

  const cfg = item.configuration && item.configuration !== "default"
    ? `?configuration=${encodeURIComponent(item.configuration)}`
    : "";

  return `${host}/documents/${item.documentId}/${wv}/e/${item.elementId}${cfg}`;
}
