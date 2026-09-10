import { NextResponse } from "next/server";
import { exchangeAuthCode, refreshAccessToken, verifyClient } from "@/lib/oauth-server";
import { handler } from "@/lib/api";

/**
 * The token endpoint. Onshape calls this server-to-server.
 *
 * Errors use OAuth2's own body shape — `{ error, error_description }` with the
 * status RFC 6749 prescribes — rather than this application's `{ error }`.
 * Onshape's client is a standards-conformant one and will read that; a bespoke
 * shape would leave it reporting nothing useful.
 */
function oauthError(error: string, description: string, status = 400) {
  return NextResponse.json(
    { error, error_description: description },
    {
      status,
      // Required by RFC 6749 for token responses, error or otherwise.
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    }
  );
}

/**
 * Read the client credentials.
 *
 * Both forms are accepted: HTTP Basic, which the RFC says a client SHOULD use,
 * and form parameters, which many clients actually use. Refusing the second
 * would be correct by the letter and would break real callers.
 */
function credentials(req: Request, form: FormData): { id: string; secret: string } {
  const header = req.headers.get("authorization") ?? "";
  const basic = /^Basic\s+(.+)$/i.exec(header.trim());
  if (basic) {
    try {
      const [id, ...rest] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      // The secret may itself contain a colon, so only the first one splits.
      return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(rest.join(":")) };
    } catch {
      /* fall through to the form */
    }
  }
  return {
    id: String(form.get("client_id") ?? ""),
    secret: String(form.get("client_secret") ?? ""),
  };
}

export const POST = handler(async (req: Request) => {
  const form = await req.formData().catch(() => new FormData());
  const grantType = String(form.get("grant_type") ?? "");
  const { id, secret } = credentials(req, form);

  if (!id || !secret) {
    return oauthError("invalid_client", "Client credentials are required.", 401);
  }

  const client = await verifyClient(id, secret);
  if (!client) {
    // One message for every failure mode — unknown client, disabled client,
    // wrong secret. Distinguishing them tells an attacker which client ids are
    // real.
    return oauthError("invalid_client", "Client authentication failed.", 401);
  }

  if (grantType === "authorization_code") {
    const result = await exchangeAuthCode({
      code: String(form.get("code") ?? ""),
      clientId: id,
      redirectUri: String(form.get("redirect_uri") ?? ""),
    });
    if (!result.ok) {
      return oauthError(
        result.error,
        "That authorization code is not valid, has expired, or has already been used."
      );
    }
    return tokenResponse(result.tokens);
  }

  if (grantType === "refresh_token") {
    const result = await refreshAccessToken({
      refreshToken: String(form.get("refresh_token") ?? ""),
      clientId: id,
    });
    if (!result.ok) {
      return oauthError(
        result.error,
        "That refresh token is not valid, or has already been exchanged. Refresh tokens " +
        "rotate: each one may be used once."
      );
    }
    return tokenResponse(result.tokens);
  }

  return oauthError(
    "unsupported_grant_type",
    `"${grantType}" is not supported. Use authorization_code or refresh_token.`
  );
});

function tokenResponse(t: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}) {
  return NextResponse.json(
    {
      access_token: t.accessToken,
      token_type: "Bearer",
      expires_in: t.expiresIn,
      refresh_token: t.refreshToken,
      ...(t.scope ? { scope: t.scope } : {}),
    },
    { status: 200, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}
