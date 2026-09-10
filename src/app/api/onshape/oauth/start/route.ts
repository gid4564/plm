import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { connectDb } from "@/lib/db";
import { Enterprise, User } from "@/lib/models";
import { getSession } from "@/lib/auth/session";
import { authorizeUrl, isMock, baseUrl } from "@/lib/onshape/oauth";
import { handler } from "@/lib/api";
import crypto from "node:crypto";

/**
 * Only allow same-site relative paths as a post-login destination, so a crafted
 * ?returnTo= cannot turn this endpoint into an open redirect.
 */
function safeReturnTo(raw: string | null): string {
  if (!raw) return "/settings";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/settings";
  return raw;
}

/** Onshape hands us a URL to bounce back to; accept it only if it is Onshape's. */
function safeOnshapeUri(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const okHost = u.hostname === "onshape.com" || u.hostname.endsWith(".onshape.com");
    return u.protocol === "https:" && okHost ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Begin the Onshape OAuth handshake. This is the "OAuth URL" registered in the
 * Onshape Dev Portal, so it is also the entry point when a user launches the app
 * from Onshape's Applications page.
 *
 * That launch can arrive with no PLM session at all, so an unauthenticated
 * caller is sent to sign in and resumed here afterwards rather than being handed
 * a 401 — a JSON error body is a dead end for someone arriving from Onshape.
 *
 * In mock mode there is no external provider, so the connection is recorded
 * immediately and the user is bounced straight back — the rest of the app
 * cannot tell the difference.
 */
export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);

  // Onshape appends this when launching the app; prefer it over ?returnTo.
  const onshapeUri = safeOnshapeUri(url.searchParams.get("redirectOnshapeUri"));
  const returnTo = onshapeUri ?? safeReturnTo(url.searchParams.get("returnTo"));

  const session = await getSession();
  if (!session) {
    const resume = `/api/onshape/oauth/start${url.search}`;
    return NextResponse.redirect(
      `${baseUrl()}/login?returnTo=${encodeURIComponent(resume)}`
    );
  }

  if (isMock()) {
    await connectDb();
    const ent: any = await Enterprise.findById(session.enterpriseId);
    /*
     * Record an Onshape identity distinct from the PLM login, on purpose.
     *
     * The live callback stores whoever Onshape says the tokens authenticate as,
     * and that is routinely a different account — a dedicated service user. A
     * mock that echoed the PLM email back would make the two look like one
     * thing, and hide the distinction the service-account picker exists to
     * surface.
     */
    const localPart = session.email.split("@")[0] || "user";
    await User.findByIdAndUpdate(session.userId, {
      $set: {
        onshapeUserId: `mock-user-${session.userId.slice(-6)}`,
        onshapeEmail: `${localPart}@mockenterprise.test`,
        onshapeName: `${localPart} (mock Onshape account)`,
        onshapeAccessToken: "mock-access-token",
        onshapeRefreshToken: "mock-refresh-token",
        onshapeTokenExpiresAt: new Date(Date.now() + 3600_000),
        onshapeConnectedAt: new Date(),
      },
    });
    // First connector becomes the enterprise integration account.
    if (ent && !ent.integrationUserId) {
      ent.integrationUserId = session.userId;
      await ent.save();
    }
    if (onshapeUri) return NextResponse.redirect(onshapeUri);

    // See the note in the callback: concatenating a "?" onto a returnTo that
    // already has a query string corrupts its last parameter.
    const dest = new URL(returnTo, baseUrl());
    dest.searchParams.set("onshape", "connected");
    dest.searchParams.set("mock", "1");
    return NextResponse.redirect(dest.toString());
  }

  // CSRF protection: random state echoed back by Onshape and compared.
  const state = crypto.randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set("plm_oauth_state", `${state}|${returnTo}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: baseUrl().startsWith("https://"),
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(authorizeUrl(state));
});
