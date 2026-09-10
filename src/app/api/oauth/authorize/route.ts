import { redirect } from "next/navigation";
import { connectDb } from "@/lib/db";
import { ActivityLog } from "@/lib/models";
import { getSession } from "@/lib/auth/session";
import { findClient, issueAuthCode, redirectAllowed } from "@/lib/oauth-server";
import { handler, fail } from "@/lib/api";

/**
 * The authorization endpoint Onshape sends the user to.
 *
 * Onshape calls this when someone grants "External access" to the PLM
 * extension application. The user signs in to PLM (if they are not already),
 * confirms on /oauth/consent, and that page POSTs back here to issue the code.
 *
 * GET only redirects — it never issues a code. An authorization server that
 * granted access on a GET would be exploitable by any page that could make the
 * browser navigate.
 */
export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const responseType = url.searchParams.get("response_type") ?? "code";
  const scope = url.searchParams.get("scope") ?? "";

  if (responseType !== "code") {
    return fail("Only the authorization code flow is supported (response_type=code).", 400);
  }
  if (!clientId || !redirectUri) {
    return fail("client_id and redirect_uri are both required.", 400);
  }

  await connectDb();
  const client = await findClient(clientId);

  /*
   * A bad client or redirect URI is answered here, not by redirecting.
   *
   * Redirecting an error to an unverified URI is how an authorization server
   * becomes an open redirector. Until the URI is known to be registered, the
   * only safe place to report a problem is this page.
   */
  if (!client) return fail("Unknown or disabled client application.", 400);
  if (!redirectAllowed(client, redirectUri)) {
    return fail(
      "That redirect_uri is not registered for this client. It must match one of the " +
      "registered URIs exactly.",
      400
    );
  }

  const session = await getSession();
  const consent = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, scope });

  if (!session) {
    // Sign in first, then come back to the consent screen with the request intact.
    redirect(`/login?next=${encodeURIComponent(`/oauth/consent?${consent.toString()}`)}`);
  }

  redirect(`/oauth/consent?${consent.toString()}`);
});

/**
 * Record the user's decision and hand back a code.
 *
 * Posted by the consent page. On approval the browser is redirected to the
 * client's registered URI with `code` and the original `state`; on refusal, to
 * the same URI with `error=access_denied` — which is what tells Onshape the
 * user said no, rather than leaving it waiting.
 */
export const POST = handler(async (req: Request) => {
  const form = await req.formData();
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const state = String(form.get("state") ?? "");
  const scope = String(form.get("scope") ?? "");
  const approved = String(form.get("decision") ?? "") === "approve";

  const session = await getSession();
  if (!session) return fail("Not signed in", 401);

  await connectDb();
  const client = await findClient(clientId);
  if (!client) return fail("Unknown or disabled client application.", 400);
  if (!redirectAllowed(client, redirectUri)) {
    return fail("That redirect_uri is not registered for this client.", 400);
  }

  const target = new URL(redirectUri);
  if (state) target.searchParams.set("state", state);

  if (!approved) {
    target.searchParams.set("error", "access_denied");
    await ActivityLog.create({
      enterpriseId: session.enterpriseId, direction: "plm", action: "skipped",
      trigger: "oauth-consent", ok: true,
      message: `${session.email} refused access to "${client.name}"`,
    });
    redirect(target.toString());
  }

  const code = await issueAuthCode({
    clientId,
    redirectUri,
    userId: session.userId,
    enterpriseId: session.enterpriseId,
    scope,
  });

  await ActivityLog.create({
    enterpriseId: session.enterpriseId, direction: "plm", action: "created",
    trigger: "oauth-consent", ok: true,
    message: `${session.email} granted "${client.name}" access to PLM on their behalf`,
  });

  target.searchParams.set("code", code);
  redirect(target.toString());
});
