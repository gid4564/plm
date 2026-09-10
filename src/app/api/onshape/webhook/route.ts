import { connectDb } from "@/lib/db";
import { Enterprise } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForUser } from "@/lib/onshape/factory";
import { baseUrl, isMock, webhookCallbackUrl } from "@/lib/onshape/oauth";
import { handler, ok, fail } from "@/lib/api";

const EVENTS = [
  // Keeps tracked parts current.
  "onshape.model.lifecycle.metadata",
  // Bring a newly released part in. Which of these a tenant emits depends on
  // its release workflow, so subscribe to both rather than guess.
  "onshape.revision.created",
  "onshape.workflow.transition",
];

export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();

  // Ask Onshape what actually exists, rather than trusting our own record. A
  // subscription left behind by an earlier registration is invisible otherwise,
  // and keeps delivering events that cannot be attributed.
  let live: { id: string; url: string; events: string[]; current: boolean; stray: boolean }[] = [];
  try {
    if (ent) {
      const client = await clientForUser(s.userId);
      const base = `${baseUrl()}/api/webhooks/onshape`;
      const all = await client.listWebhooks(ent.onshapeCompanyId);
      live = all
        .filter((w) => w.url.startsWith(base))
        .map((w) => ({
          id: w.id,
          url: w.url.replace(/token=[^&]+/, "token=•••"),
          events: w.events,
          current: w.id === ent.webhookId,
          stray: w.id !== ent.webhookId,
        }));
    }
  } catch {
    // Listing is diagnostic; never let it break the settings page.
  }

  return ok({
    live,
    strayCount: live.filter((w) => w.stray).length,
    webhookId: ent?.webhookId ?? null,
    registeredAt: ent?.webhookRegisteredAt ?? null,
    // Token masked — it is a secret, and nobody needs to copy this by hand.
    callbackUrl: webhookCallbackUrl(String(ent?._id ?? "")).replace(
      /token=[^&]+/, "token=%E2%80%A2%E2%80%A2%E2%80%A2"
    ),
    events: EVENTS,
    mode: isMock() ? "mock" : "live",
  });
});

export const POST = handler(async () => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can register the webhook", 403);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId);
  if (!ent) return fail("Enterprise not found", 404);

  const callbackUrl = webhookCallbackUrl(String(ent._id));
  if (!isMock() && callbackUrl.startsWith("http://")) {
    return fail(
      `Onshape requires an HTTPS callback. APP_BASE_URL is currently "${baseUrl()}" — put the app behind a tunnel or a real domain first.`,
      400
    );
  }

  const client = await clientForUser(s.userId);

  // Retire the previous subscription first. Registering without doing so leaves
  // the old one live in Onshape, and every orphan keeps delivering events under
  // a webhookId PLM no longer recognises.
  let removedPrevious: string | null = null;
  if (ent.webhookId) {
    try {
      await client.unregisterWebhook(ent.webhookId);
      removedPrevious = ent.webhookId;
    } catch (err: any) {
      // Already gone, or not ours to remove — not a reason to block re-registration.
      console.warn(`[PLM] could not remove previous webhook ${ent.webhookId}: ${err?.message ?? err}`);
    }
  }

  const reg = await client.registerWebhook(ent.onshapeCompanyId, callbackUrl, EVENTS);

  ent.webhookId = reg.id;
  ent.webhookRegisteredAt = new Date();
  await ent.save();

  // Flag anything Onshape quietly declined to subscribe to.
  const confirmed = reg.events.length ? reg.events : EVENTS;
  const missing = EVENTS.filter((e) => !confirmed.includes(e));

  return ok({
    webhookId: reg.id,
    callbackUrl,
    requested: EVENTS,
    confirmed,
    missing,
    removedPrevious,
  });
});

export const DELETE = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can remove the webhook", 403);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId);
  if (!ent) return fail("Enterprise not found", 404);

  // ?id= removes one specific subscription, which is how strays get cleaned up.
  const requested = new URL(req.url).searchParams.get("id");
  const target = requested || ent.webhookId;
  if (!target) return ok({ ok: true, message: "No webhook registered" });

  const client = await clientForUser(s.userId);
  await client.unregisterWebhook(target);

  if (target === ent.webhookId) {
    ent.webhookId = null;
    ent.webhookRegisteredAt = null;
    await ent.save();
  }

  return ok({ ok: true, removed: target });
});
