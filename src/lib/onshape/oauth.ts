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

async function tokenRequest(body: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetch(`${OAUTH()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.ONSHAPE_CLIENT_ID || "",
      client_secret: process.env.ONSHAPE_CLIENT_SECRET || "",
      ...body,
    }).toString(),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Onshape token exchange failed (${res.status}): ${(await res.text()).slice(0, 400)}`);
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
