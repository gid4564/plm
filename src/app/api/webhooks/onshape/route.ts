import { connectDb } from "@/lib/db";
import { Enterprise, ManufacturingItem, SyncLog } from "@/lib/models";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { consumeSelfWriteMarker, syncPartFromOnshape } from "@/lib/sync";
import { handler, ok } from "@/lib/api";
import type { PartCoords } from "@/lib/onshape/types";

/**
 * Onshape webhook receiver.
 *
 * Onshape validates a new registration by POSTing a `webhook.register` event and
 * requires a 200 back, so every path here returns 200 — a non-200 would cancel
 * the subscription. Problems are recorded in the SyncLog instead.
 */
export const POST = handler(async (req: Request) => {
  const payload = (await req.json().catch(() => ({}))) as Record<string, any>;
  const event = String(payload.event ?? "");

  // Shared-secret check. Onshape cannot send custom headers on a webhook, so the
  // token rides in the registered callback URL as a query parameter. The header
  // form is still accepted for the built-in simulator and for manual testing.
  const expected = process.env.ONSHAPE_WEBHOOK_SECRET;
  if (expected) {
    const fromQuery = new URL(req.url).searchParams.get("token");
    const fromHeader = req.headers.get("x-mos-webhook-secret");
    if (fromQuery !== expected && fromHeader !== expected) {
      // Recorded rather than only logged: a silently-dropped webhook is the
      // hardest possible failure to diagnose from the Onshape side.
      console.warn("[MOS] webhook rejected: bad or missing token");
      await connectDb();
      await SyncLog.create({
        direction: "onshape->mos", action: "error", trigger: "webhook", ok: false,
        message:
          "Webhook rejected: token missing or wrong. Re-register the webhook in " +
          "Settings so the callback URL carries the current ONSHAPE_WEBHOOK_SECRET.",
      });
      return ok({ received: true, handled: false, reason: "bad-token" });
    }
  }

  // Log every delivery before any routing decision. Without this an event type
  // we do not handle vanishes silently, which is indistinguishable from Onshape
  // never having sent it — the two need very different fixes.
  console.log(
    `[MOS] webhook in: event=${event || "(none)"} ` +
    `doc=${payload.documentId ?? "-"} el=${payload.elementId ?? "-"} ` +
    `part=${payload.partId ?? "-"} keys=[${Object.keys(payload).join(",")}]`
  );

  // Lifecycle handshakes — acknowledge and do nothing.
  if (event === "webhook.register" || event === "webhook.unregister" || event === "webhook.ping") {
    return ok({ received: true, handled: false, reason: event });
  }

  /**
   * Two events, two intents.
   *
   * A metadata change means "this part's details moved" — it keeps an existing
   * item current but must never bring a new part in, or every property a
   * designer edits would allocate an MO number they never asked for.
   *
   * A revision means the part has been released, which is a deliberate act and
   * a good reason to start tracking it.
   */
  const INTENT: Record<string, { create: boolean; initialStatus?: string }> = {
    "onshape.model.lifecycle.metadata": { create: false },
    // Both are emitted around a release. Which one a tenant actually sees
    // depends on its release workflow, so subscribe to both and let creation
    // idempotency sort out any overlap.
    "onshape.revision.created": { create: true, initialStatus: "Released" },
    "onshape.workflow.transition": { create: true, initialStatus: "Released" },
  };

  const intent = INTENT[event];

  const isReleaseEvent =
    event === "onshape.revision.created" || event === "onshape.workflow.transition";

  if (!intent) {
    // Surface anything release-shaped that we are not handling: that is the
    // signal that this tenant emits a different event than we subscribed to.
    if (/revision|release|workflow|lifecycle/i.test(event)) {
      await connectDb();
      await SyncLog.create({
        direction: "onshape->mos", action: "skipped", trigger: "webhook", ok: true,
        message:
          `Received an unhandled event "${event}". If releases are not reaching the ` +
          `MOS, this is likely the event your workflow emits. Payload keys: ` +
          `[${Object.keys(payload).join(",")}]`,
      });
    }
    return ok({ received: true, handled: false, reason: `ignored event ${event || "(none)"}` });
  }

  await connectDb();

  /**
   * Resolve the tenant.
   *
   * Preference order matters. Onshape does not reliably send companyId — many
   * event types omit it entirely — and matching on webhookId fails as soon as a
   * stale subscription is still live, which is exactly when you least want the
   * lookup to break. The enterprise id embedded in the registered callback URL
   * is the only signal that is always present and always correct.
   */
  const url = new URL(req.url);
  const entParam = url.searchParams.get("ent");
  const companyId = String(payload.companyId ?? payload.company ?? "");
  const payloadWebhookId = String(payload.webhookId ?? "");

  let enterprise: any = null;
  let resolvedBy = "none";

  if (entParam) {
    enterprise = await Enterprise.findById(entParam).catch(() => null);
    if (enterprise) resolvedBy = "callback-url";
  }
  if (!enterprise && companyId) {
    enterprise = await Enterprise.findOne({ onshapeCompanyId: companyId });
    if (enterprise) resolvedBy = "companyId";
  }
  if (!enterprise && payloadWebhookId) {
    enterprise = await Enterprise.findOne({ webhookId: payloadWebhookId });
    if (enterprise) resolvedBy = "webhookId";
  }
  if (!enterprise) {
    // A single-tenant install has an unambiguous answer; use it rather than
    // discarding real events over a missing identifier.
    const all = await Enterprise.find().limit(2).lean();
    if (all.length === 1) {
      enterprise = await Enterprise.findById(all[0]._id);
      resolvedBy = "sole-enterprise";
    }
  }

  if (!enterprise) {
    // Record what actually arrived — "unknown enterprise" alone is not enough to
    // act on, and this is the failure most likely to be a stale subscription.
    const detail =
      `event=${event} companyId=${companyId || "(absent)"} ` +
      `webhookId=${payloadWebhookId || "(absent)"} ent=${entParam || "(absent)"} ` +
      `payloadKeys=[${Object.keys(payload).join(",")}]`;
    console.warn(`[MOS] webhook for unknown enterprise — ${detail}`);
    await connectDb();
    await SyncLog.create({
      direction: "onshape->mos", action: "error", trigger: "webhook", ok: false,
      message:
        `Webhook could not be matched to an enterprise. This is usually a stale ` +
        `Onshape subscription left behind by an earlier registration — remove and ` +
        `re-register the webhook in Settings. Details: ${detail}`,
    });
    return ok({ received: true, handled: false, reason: "unknown-enterprise" });
  }

  const enterpriseId = String(enterprise._id);

  /*
   * Honour the release switch here — before a single Onshape call.
   *
   * This check used to sit further down, after the part number had been
   * resolved to a part id. That resolution costs a /parts call and often a
   * /documents call on top, so every release spent two calls from a rate limit
   * shared with everyone on the tenant, only to be discarded a moment later.
   *
   * "Off" means do not *enrol* new parts. It does not mean ignore the release
   * of a part already being manufactured: the MOS tracks the latest released
   * version of what it holds, and a release is the only thing that moves it.
   * Dropping those outright left tracked items pinned to a revision Onshape had
   * since superseded — and a superseded revision reports as Obsolete, which is
   * precisely how a released part comes to look obsolete in the MOS.
   *
   * So the event is downgraded rather than discarded, and only for parts in a
   * document this enterprise already tracks. That check is a database lookup,
   * so a release anywhere else still costs nothing at all.
   */
  let effectiveIntent = intent;

  if (isReleaseEvent && enterprise.releaseSyncEnabled !== true) {
    const tracksThisElement = await ManufacturingItem.exists({
      enterpriseId,
      documentId: String(payload.documentId ?? ""),
      elementId: String(payload.elementId ?? ""),
    });

    if (!tracksThisElement) {
      await Enterprise.updateOne(
        { _id: enterpriseId },
        { $inc: { releasesIgnored: 1 }, $set: { lastReleaseIgnoredAt: new Date() } }
      );
      return ok({
        received: true,
        handled: false,
        reason: "release-sync-disabled",
        hint: "Enable 'Enrol parts when they are released' in MOS Settings to change this.",
      });
    }

    // Refresh what we already hold; never bring anything new in.
    effectiveIntent = { create: false, initialStatus: intent.initialStatus };
  }

  // Onshape's metadata event does not name the part, so a payload without one
  // means "something in this element changed" — the sender must tell us which
  // part. The simulator and the panel both supply partId.
  let partId = String(
    payload.partId ?? payload.data?.partId ?? payload.partIds?.[0] ?? payload.itemId ?? ""
  );

  /**
   * A revision event names the part by number, not id:
   *
   *   keys=[documentId, elementId, elementType, partNumber, releaseId,
   *         revisionId, versionId, webhookId, ...]
   *
   * The id is the MOS's identity key, so it has to be resolved by listing the
   * element's parts at that version and matching the number. It also carries a
   * versionId rather than a workspaceId — versions are immutable, so any
   * write-back has to be aimed at the document's default workspace instead.
   */
  let resolvedWorkspaceId: string | null = payload.workspaceId ? String(payload.workspaceId) : null;

  if (!partId && payload.partNumber && enterprise) {
    const partNumber = String(payload.partNumber);
    try {
      const { client } = await clientForEnterprise(String(enterprise._id));
      const versionId = payload.versionId ? String(payload.versionId) : null;

      const parts = await client.listElementParts({
        documentId: String(payload.documentId ?? ""),
        elementId: String(payload.elementId ?? ""),
        partId: "",
        workspaceId: resolvedWorkspaceId,
        versionId,
      });

      const match = parts.find((p) => p.partNumber && p.partNumber === partNumber);
      if (match) {
        partId = match.partId;
        // Point subsequent reads and the MO write-back at a workspace.
        if (!resolvedWorkspaceId) {
          const doc = await client.getDocumentInfo(String(payload.documentId ?? ""));
          resolvedWorkspaceId = doc.defaultWorkspaceId;
        }
      } else {
        await SyncLog.create({
          enterpriseId: String(enterprise._id),
          direction: "onshape->mos", action: "skipped", trigger: event, ok: true,
          message:
            `Revision of part number "${partNumber}" could not be matched to a part in ` +
            `element ${payload.elementId}. ${parts.length} part(s) were found there` +
            (parts.length ? `: ${parts.map((p) => p.partNumber || "(no number)").join(", ")}` : "") + ".",
        });
      }
    } catch (err: any) {
      await SyncLog.create({
        enterpriseId: String(enterprise._id),
        direction: "onshape->mos", action: "error", trigger: event, ok: false,
        message: `Could not resolve part number "${partNumber}" to a part id: ${err?.message ?? err}`,
      });
    }
  }

  if (!partId) {
    // Revision payloads are not well documented; record the keys we did get so an
    // unhandled shape is diagnosable rather than silently dropped.
    if (event === "onshape.revision.created") {
      await SyncLog.create({
        enterpriseId: enterprise ? String(enterprise._id) : null,
        direction: "onshape->mos", action: "skipped", trigger: "webhook:revision", ok: true,
        message:
          `Revision event carried no recognisable partId. Payload keys: ` +
          `${Object.keys(payload).join(", ")}.`,
      });
      return ok({ received: true, handled: false, reason: "revision-without-partId" });
    }
    await SyncLog.create({
      enterpriseId, direction: "onshape->mos", action: "skipped", trigger: "webhook", ok: true,
      message: `Metadata event for element ${payload.elementId ?? "?"} carried no partId; nothing to sync.`,
    });
    return ok({ received: true, handled: false, reason: "no-partId" });
  }

  /*
   * Make sure there is a workspace, whichever branch got us here.
   *
   * Only the part-number path resolved one, so a metadata event that already
   * named a partId and carried a versionId arrived with no workspace at all —
   * and was then read against that version. During a release that meant reading
   * the revision the release had just obsoleted.
   *
   * The document lookup is cached for five minutes, so a burst of events around
   * one release costs a single call.
   */
  if (!resolvedWorkspaceId && payload.documentId) {
    try {
      const { client } = await clientForEnterprise(enterpriseId);
      const doc = await client.getDocumentInfo(String(payload.documentId));
      resolvedWorkspaceId = doc.defaultWorkspaceId;
    } catch {
      // Leave it null; the sync falls back to what the item already records.
    }
  }

  const coords: PartCoords = {
    documentId: String(payload.documentId ?? ""),
    elementId: String(payload.elementId ?? ""),
    partId,
    configuration: String(payload.configuration ?? "default"),
    // Both, deliberately.
    //
    // The workspace is where the MO number has to be written, because a version
    // is immutable. The version is what the order is *for* — a release event
    // means "this revision is approved to make". Discarding it here used to
    // leave the item reading from the workspace, so the next re-sync replaced
    // revision A with "-" and Released with In Progress.
    workspaceId: resolvedWorkspaceId,
    versionId: payload.versionId ? String(payload.versionId) : null,
  };

  if (!coords.documentId || !coords.elementId) {
    return ok({ received: true, handled: false, reason: "incomplete-coords" });
  }

  // Note whether this looks like the echo of our own write-back. We still run
  // the sync — see consumeSelfWriteMarker for why dropping it loses real edits.
  const likelyEcho = await consumeSelfWriteMarker(enterpriseId, coords);

  try {
    const { client } = await clientForEnterprise(enterpriseId);
    const result = await syncPartFromOnshape(enterpriseId, coords, {
      trigger: likelyEcho ? `${event} (echo of our write)` : event,
      client,
      create: effectiveIntent.create,
      initialStatus: effectiveIntent.initialStatus,
      // Only a release may move the revision, and it reads its own version to
      // find it. A metadata event — including the one Onshape emits for the
      // revision a release has just obsoleted — never touches it.
      fromRelease: isReleaseEvent,
    });
    return ok({ received: true, handled: result.action !== "skipped-unknown", likelyEcho, ...result });
  } catch (err: any) {
    const message = String(err?.message ?? err);
    console.error("[MOS] webhook sync failed:", message);
    await SyncLog.create({
      enterpriseId, direction: "onshape->mos", action: "error", trigger: "webhook", ok: false, message,
    });
    // Still 200 — see note above.
    return ok({ received: true, handled: false, error: message });
  }
});

/** Some tools probe the URL with GET before registering. */
export const GET = handler(async () =>
  ok({ ok: true, endpoint: "onshape-webhook-receiver", expects: "POST" })
);
