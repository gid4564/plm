import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { connectDb } from "@/lib/db";
import { Enterprise, User } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { exchangeCode, baseUrl } from "@/lib/onshape/oauth";
import { LiveOnshapeClient } from "@/lib/onshape/live-client";
import { handler, fail } from "@/lib/api";

export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return fail(`Onshape denied the authorization: ${oauthError}`, 400);
  if (!code || !state) return fail("Missing code or state in OAuth callback", 400);

  const jar = await cookies();
  const stored = jar.get("plm_oauth_state")?.value;
  if (!stored) return fail("OAuth state cookie missing or expired. Start the connection again.", 400);

  // Split once — returnTo may itself be an absolute URL containing separators.
  const sep = stored.indexOf("|");
  const expectedState = sep === -1 ? stored : stored.slice(0, sep);
  const returnTo = sep === -1 ? "/settings" : stored.slice(sep + 1) || "/settings";

  if (expectedState !== state) return fail("OAuth state mismatch — possible CSRF. Aborted.", 400);
  jar.delete("plm_oauth_state");

  const session = await requireSession();
  const tokens = await exchangeCode(code);

  // Identify the Onshape user and confirm they belong to the bound enterprise.
  const client = new LiveOnshapeClient(tokens.accessToken);
  const onshapeUser = await client.getAuthenticatedUser();

  await connectDb();
  const ent: any = await Enterprise.findById(session.enterpriseId);
  if (!ent) return fail("Enterprise not found", 404);

  if (onshapeUser.companyId && onshapeUser.companyId !== ent.onshapeCompanyId) {
    // Name the account as well as the ids: two bare ObjectIds say nothing about
    // which account was actually signed in. The remedy matters too — pressing
    // Connect again reuses the same Onshape browser session and lands here
    // again, so the account has to be switched on Onshape's side first.
    const who = onshapeUser.companyName
      ? `${onshapeUser.companyName} (${onshapeUser.companyId})`
      : onshapeUser.companyId;
    return fail(
      `That Onshape account (${onshapeUser.email}) belongs to enterprise ${who}, but this PLM is bound to ` +
      `${ent.name || "enterprise"} (${ent.onshapeCompanyId}). Sign out of Onshape, sign back in with an ` +
      `account in that enterprise, then connect again — retrying now will reuse the same Onshape session.`,
      403
    );
  }

  await User.findByIdAndUpdate(session.userId, {
    $set: {
      onshapeUserId: onshapeUser.id,
      // Kept so the service-account picker can name the Onshape identity these
      // tokens act as, which may not be the PLM user holding them.
      onshapeEmail: onshapeUser.email || null,
      onshapeName: onshapeUser.name || null,
      onshapeAccessToken: tokens.accessToken,
      onshapeRefreshToken: tokens.refreshToken,
      onshapeTokenExpiresAt: tokens.expiresAt,
      onshapeConnectedAt: new Date(),
    },
  });

  // Onshape is the source of truth for the enterprise's own vanity domain
  // (e.g. https://acme.onshape.com) — every connect refreshes it, so a
  // domain change on Onshape's side heals itself the next time anyone
  // reconnects, rather than requiring a manual fix in Settings.
  let entChanged = false;
  if (!ent.integrationUserId) {
    ent.integrationUserId = session.userId;
    entChanged = true;
  }
  if (onshapeUser.companyDomain && onshapeUser.companyDomain !== ent.onshapeDomain) {
    ent.onshapeDomain = onshapeUser.companyDomain;
    entChanged = true;
  }
  if (entChanged) await ent.save();

  // returnTo is either an absolute Onshape URL (app launch) or a local path.
  if (/^https:\/\//.test(returnTo)) return NextResponse.redirect(returnTo);

  // Built through URL rather than concatenated: a returnTo that already carries
  // a query string used to gain a second "?", so the last parameter swallowed
  // "?onshape=connected" as part of its value.
  const dest = new URL(returnTo, baseUrl());
  dest.searchParams.set("onshape", "connected");
  return NextResponse.redirect(dest.toString());
});
