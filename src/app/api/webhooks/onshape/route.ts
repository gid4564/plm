import { connectDb } from "@/lib/db";
import { ActivityLog, Enterprise, Part, Release, Task } from "@/lib/models";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { consumeSelfWriteMarker, syncPartFromOnshape } from "@/lib/sync";
import { refreshReleasedDrawings, scheduleDrawingRefresh, takeOverReleasePackage } from "@/lib/release";
import { upsertTask } from "@/lib/tasks";
import { objectTypeCode, objectTypeName } from "@/lib/onshape/object-types";
import { handler, ok } from "@/lib/api";
import type { PartCoords } from "@/lib/onshape/types";

/**
 * Onshape webhook receiver.
 *
 * Onshape validates a new registration by POSTing a `webhook.register` event
 * and requires a 200 back, so every path here returns 200 — a non-200 would
 * cancel the subscription. Problems are recorded in the activity log instead.
 *
 * Three events matter, and they mean three different things:
 *
 *   onshape.workflow.transition   a release package moved — PLM's cue to take
 *                                 the release over
 *   onshape.revision.created      Onshape finished creating revisions — PLM's
 *                                 cue to collect the released drawing sheets
 *   onshape.model.lifecycle.*     a designer edited something — keep the
 *                                 mirrored attributes current, create nothing
 */

/**
 * Find a release-package id in a workflow-transition payload.
 *
 * Onshape's webhook documentation shows no example payload for
 * `onshape.workflow.transition` and names no field distinguishing a release
 * package from a revision, so this looks for any of the plausible keys rather
 * than asserting one. See docs/ONSHAPE-INTEGRATION-SPEC.md, unknown U1 — the
 * receiver logs every payload's keys before routing precisely so the real
 * shape can be read off a live tenant and this narrowed.
 */
function releasePackageIdFrom(payload: Record<string, any>): string | null {
  const objectType = String(
    payload.objectType ?? payload.type ?? payload.workflowObjectType ?? ""
  ).toUpperCase();

  // An explicit type that says revision is a reliable negative: a revision
  // transition is not ours to act on, whatever ids the payload also carries.
  if (objectType === "REVISION") return null;

  for (const key of [
    "releasePackageId", "releasePackage", "rpid", "objectId",
    "workflowObjectId", "releaseId",
  ]) {
    const v = payload[key] ?? payload.data?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && typeof v.id === "string" && v.id.trim()) return v.id.trim();
  }
  return null;
}

/**
 * A task id in a workflow-transition payload.
 *
 * The same candidate keys as the release-package version, for the same reason:
 * the event names no field that says what kind of object transitioned, so the
 * plausible ids are tried and Onshape is asked which of them it recognises.
 */
function taskIdFrom(payload: Record<string, any>): string | null {
  for (const key of ["taskId", "objectId", "workflowObjectId", "id"]) {
    const v = payload[key] ?? payload.data?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && typeof v.id === "string" && v.id.trim()) return v.id.trim();
  }
  return null;
}

/**
 * Try an id as a task, returning what happened or null if it is not one.
 *
 * Shared by both routes into the task path — the objectType one and the
 * fallback after a release-package 404 — so the two cannot drift in how they
 * read a task or what they record.
 */
async function tryTask(
  enterpriseId: string,
  id: string,
  event: string
): Promise<{ task: string; state: string } | null> {
  try {
    const { client } = await clientForEnterprise(enterpriseId);
    const live = await client.getTask(id);
    if (!live.id) return null;
    await upsertTask(enterpriseId, live);
    return { task: live.id, state: live.state };
  } catch (err: any) {
    const message = String(err?.message ?? err);
    /*
     * A 404 means it is not a task either, which is ordinary — this event also
     * fires for revisions. Anything else is worth recording: a task PLM cannot
     * read is usually a visibility problem with the integration account, and
     * that needs a person.
     */
    if (!/\b404\b/.test(message)) {
      await ActivityLog.create({
        enterpriseId, direction: "onshape->plm", action: "error", trigger: event, ok: false,
        message: `Could not read ${id} as a task: ${message.slice(0, 300)}`,
      });
    }
    return null;
  }
}

export const POST = handler(async (req: Request) => {
  const payload = (await req.json().catch(() => ({}))) as Record<string, any>;
  const event = String(payload.event ?? "");

  // Shared-secret check. Onshape cannot send custom headers on a webhook, so
  // the token rides in the registered callback URL as a query parameter.
  //
  // This is the one place PLM still uses a shared secret: Onshape's External
  // OAuth covers extension action URLs, but webhook registration accepts no
  // headers and offers no signature scheme, so there is nowhere to put a
  // bearer token. The header form is accepted too, for the simulator.
  const expected = process.env.ONSHAPE_WEBHOOK_SECRET;
  if (expected) {
    const fromQuery = new URL(req.url).searchParams.get("token");
    const fromHeader = req.headers.get("x-plm-webhook-secret");
    if (fromQuery !== expected && fromHeader !== expected) {
      // Recorded rather than only logged: a silently-dropped webhook is the
      // hardest possible failure to diagnose from the Onshape side.
      console.warn("[PLM] webhook rejected: bad or missing token");
      await connectDb();
      await ActivityLog.create({
        direction: "onshape->plm", action: "error", trigger: "webhook", ok: false,
        message:
          "Webhook rejected: token missing or wrong. Re-register the webhook in " +
          "Settings so the callback URL carries the current ONSHAPE_WEBHOOK_SECRET.",
      });
      return ok({ received: true, handled: false, reason: "bad-token" });
    }
  }

  // Log every delivery before any routing decision. Without this an event type
  // PLM does not handle vanishes silently, which is indistinguishable from
  // Onshape never having sent it — and the two need very different fixes.
  console.log(
    `[PLM] webhook in: event=${event || "(none)"} ` +
    `doc=${payload.documentId ?? "-"} el=${payload.elementId ?? "-"} ` +
    `part=${payload.partId ?? "-"} ` +
    /*
     * objectType and transitionName logged by value, not just by name.
     *
     * A real payload turned out to carry `objectType` — the discriminator this
     * receiver had been working around by trying each kind of object in turn
     * (unknown U1 in the integration spec). The name was all that log line
     * showed, so the field was there for weeks before anybody noticed it.
     * Its VALUES are still unknown, and logging them is how they stop being.
     */
    `objectType=${payload.objectType ?? "-"}` +
    `${payload.objectType != null ? `(${objectTypeName(Number(payload.objectType))})` : ""} ` +
    `transition=${payload.transitionName ?? "-"} ` +
    `keys=[${Object.keys(payload).join(",")}]`
  );

  // Lifecycle handshakes — acknowledge and do nothing.
  if (event === "webhook.register" || event === "webhook.unregister" || event === "webhook.ping") {
    return ok({ received: true, handled: false, reason: event });
  }

  const HANDLED = new Set([
    "onshape.workflow.transition",
    "onshape.revision.created",
    "onshape.model.lifecycle.metadata",
    /*
     * Comments, which is how a comment written in Onshape reaches a PLM task.
     *
     * There is no task-specific webhook event in Onshape's published API. A
     * task is a workflowable object, so a task transition arrives on
     * `onshape.workflow.transition` — the same event as a release package,
     * with the same unknown discriminator (U1). The handler therefore tries a
     * release package first and falls back to a task, rather than assuming
     * which it has.
     */
    "onshape.comment.create",
    "onshape.comment.update",
  ]);

  if (!HANDLED.has(event)) {
    await connectDb();
    // Surface anything release-shaped that PLM is not handling: that is the
    // signal that this tenant emits a different event than was subscribed to.
    if (/revision|release|workflow|lifecycle/i.test(event)) {
      await ActivityLog.create({
        direction: "onshape->plm", action: "skipped", trigger: "webhook", ok: true,
        message:
          `Received an unhandled event "${event}". If releases are not reaching PLM, this ` +
          `is likely the event your workflow emits. Payload keys: ` +
          `[${Object.keys(payload).join(",")}]`,
      });
    }
    return ok({ received: true, handled: false, reason: `ignored event ${event || "(none)"}` });
  }

  await connectDb();

  /*
   * Resolve the tenant.
   *
   * Preference order matters. Onshape does not reliably send companyId — many
   * event types omit it entirely — and matching on webhookId fails as soon as
   * a stale subscription is still live, which is exactly when you least want
   * the lookup to break. The enterprise id embedded in the registered callback
   * URL is the only signal that is always present and always correct.
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
    const detail =
      `event=${event} companyId=${companyId || "(absent)"} ` +
      `webhookId=${payloadWebhookId || "(absent)"} ent=${entParam || "(absent)"} ` +
      `payloadKeys=[${Object.keys(payload).join(",")}]`;
    console.warn(`[PLM] webhook for unknown enterprise — ${detail}`);
    await ActivityLog.create({
      direction: "onshape->plm", action: "error", trigger: "webhook", ok: false,
      message:
        `Webhook could not be matched to an enterprise. This is usually a stale Onshape ` +
        `subscription left behind by an earlier registration — remove and re-register the ` +
        `webhook in Settings. Details: ${detail}`,
    });
    return ok({ received: true, handled: false, reason: "unknown-enterprise" });
  }

  const enterpriseId = String(enterprise._id);

  /* ===================================================================== */
  /* A release package moved                                               */
  /* ===================================================================== */

  if (event === "onshape.workflow.transition") {
    const rpid = releasePackageIdFrom(payload);

    /*
     * Before giving up on the event, try it as a task.
     *
     * A task is a workflowable object, so its transitions arrive on this same
     * event, and Onshape names no field that says which kind of object moved.
     * Asking Onshape whether the id is a task is cheap and definitive, and it
     * is the only way to tell without the discriminator U1 is about.
     */
    /*
     * Route by objectType when the payload names one.
     *
     * `objectType` is the discriminator U1 was about, and a real payload
     * carries it. Where it says TASK, the task path is taken directly instead
     * of asking Onshape to identify the id by trial — one fewer call, and one
     * fewer way to act on the wrong kind of object.
     *
     * The codes are `BTMetadataObjectType` ordinals as far as anything here can
     * tell, which is an inference from a declared ordering rather than a
     * documented mapping. So a mismatch falls through to the old behaviour
     * rather than refusing the event: being wrong about the code must cost a
     * wasted lookup, not a dropped transition.
     */
    const payloadType =
      payload.objectType != null && Number.isFinite(Number(payload.objectType))
        ? Number(payload.objectType)
        : null;
    const looksLikeTask = payloadType != null && payloadType === objectTypeCode("TASK");

    if (looksLikeTask) {
      const taskId = taskIdFrom(payload);
      if (taskId) {
        const r = await tryTask(enterpriseId, taskId, event);
        if (r) return ok({ received: true, handled: true, ...r, routedBy: "objectType" });
      }
    }

    if (!rpid) {
      const maybeTaskId = taskIdFrom(payload);
      if (maybeTaskId) {
        const r = await tryTask(enterpriseId, maybeTaskId, event);
        if (r) return ok({ received: true, handled: true, ...r, routedBy: "probe" });
      }
    }

    if (!rpid) {
      // Not necessarily wrong — this event also fires for revision
      // transitions, which are not PLM's to act on. Recorded with the keys so
      // a tenant whose payload shape differs is diagnosable rather than silent.
      await ActivityLog.create({
        enterpriseId, direction: "onshape->plm", action: "skipped", trigger: event, ok: true,
        message:
          `A workflow transition arrived with no release-package id. If this was a release, ` +
          `the payload names the package under a key PLM does not yet read — keys were: ` +
          `[${Object.keys(payload).join(",")}].`,
      });
      return ok({ received: true, handled: false, reason: "no-release-package-id" });
    }

    /*
     * A package PLM already knows about is a progress report, not a new
     * release. Onshape fires this event on every transition, including the one
     * PLM itself performed a moment ago, so without this the approval would
     * loop straight back into a fresh takeover attempt.
     */
    const known: any = await Release.findOne({
      enterpriseId,
      onshapeReleasePackageId: rpid,
    }).lean();

    if (known) {
      try {
        const { client } = await clientForEnterprise(enterpriseId);
        const pkg = await client.getReleasePackage(rpid);
        await Release.updateOne({ _id: known._id }, { $set: { onshapeState: pkg.state } });

        // A package that has reached a released state while PLM still has
        // drawings outstanding is the second half of requirement 5 becoming
        // possible. Onshape's own revision event usually arrives too, but this
        // is the earlier of the two signals and costs nothing to act on.
        if (known.drawingRefreshPending) {
          const refresh = await refreshReleasedDrawings(String(known._id), { client, trigger: event });
          // The earlier of the two signals, and therefore the more likely to be
          // premature — so it schedules the same retry chain.
          const retry = refresh.stillPending
            ? scheduleDrawingRefresh(String(known._id), { trigger: event })
            : null;
          return ok({
            received: true, handled: true, release: known.number, refresh,
            ...(retry ? { retry } : {}),
          });
        }

        return ok({ received: true, handled: true, release: known.number, onshapeState: pkg.state });
      } catch (err: any) {
        await ActivityLog.create({
          enterpriseId, releaseId: known._id, direction: "onshape->plm",
          action: "error", trigger: event, ok: false,
          message: `Could not re-read release package ${rpid}: ${String(err?.message ?? err).slice(0, 400)}`,
        });
        return ok({ received: true, handled: false, error: String(err?.message ?? err) });
      }
    }

    try {
      const result = await takeOverReleasePackage(enterpriseId, rpid, { trigger: event });
      return ok({ received: true, handled: result.action === "opened", ...result });
    } catch (err: any) {
      const message = String(err?.message ?? err);

      /*
       * A 404 here means "not a release package", not "something went wrong".
       *
       * This event fires for revisions and tasks as well, and the id is tried
       * as a release package before anything else. Onshape answering "Not
       * found." is that attempt being ruled out — which is the mechanism
       * working, not failing. Logged as an error it filled the server log with
       * "release takeover failed" for every task transition, and put an error
       * on the enterprise's activity trail for each one.
       *
       * So a 404 is reported as what it is, and the event falls through to the
       * task path below rather than ending here.
       */
      const notFound = /\b404\b/.test(message);
      if (notFound) {
        console.log(
          `[PLM] ${rpid} is not a release package (404) — trying it as a task. ` +
          `event=${event} objectType=${payload.objectType ?? "-"}`
        );
        const asTask = await tryTask(enterpriseId, rpid, event);
        if (asTask) return ok({ received: true, handled: true, ...asTask, routedBy: "fallback" });
        return ok({
          received: true, handled: false,
          reason: "neither a release package nor a task PLM can read",
        });
      }

      console.error("[PLM] release takeover failed:", message);
      await ActivityLog.create({
        enterpriseId, direction: "onshape->plm", action: "error", trigger: event, ok: false,
        message: `Could not take over release package ${rpid}: ${message}`,
      });
      return ok({ received: true, handled: false, error: message });
    }
  }

  /* ===================================================================== */
  /* Onshape created revisions                                             */
  /* ===================================================================== */

  if (event === "onshape.revision.created") {
    /*
     * The trigger for collecting the released drawing sheets.
     *
     * Onshape applies the revision, the watermark and the title-block fields
     * as it completes the release, so this is the first moment the controlled
     * document exists. The event fires once per item, so several arrive for
     * one release — refreshReleasedDrawings is idempotent for that reason.
     */
    const pending: any[] = await Release.find({
      enterpriseId,
      drawingRefreshPending: true,
    }).sort({ updatedAt: -1 }).limit(5).lean();

    const refreshes: unknown[] = [];
    if (pending.length) {
      const { client } = await clientForEnterprise(enterpriseId);
      for (const rel of pending) {
        const result = await refreshReleasedDrawings(String(rel._id), { client, trigger: event });

        /*
         * Onshape fires this event before it has finished applying the
         * revision, the watermark and the title-block fields, so the attempt
         * above is the earliest possible moment and often too early. What
         * used to happen then was nothing: the release stayed pending for
         * "the next revision event", and a single-item release produces no
         * next one — so somebody had to press Collect drawings by hand.
         *
         * Scheduled rather than awaited. Onshape re-delivers a webhook that
         * does not answer promptly, so waiting minutes here would earn a
         * duplicate delivery per retry.
         */
        const retry = result.stillPending
          ? scheduleDrawingRefresh(String(rel._id), { trigger: event })
          : null;

        refreshes.push({ release: rel.number, ...result, ...(retry ? { retry } : {}) });
      }
    }

    // Also bring the released part itself up to date, so its revision and
    // state reflect what Onshape just did — but only for parts PLM already
    // holds. A revision elsewhere in the tenant is not PLM's business.
    const sync = await syncReleasedPart(enterpriseId, payload, event);

    return ok({ received: true, handled: refreshes.length > 0 || Boolean(sync), refreshes, sync });
  }

  /* ===================================================================== */
  /* A designer edited metadata                                            */
  /* ===================================================================== */
  /* A comment was written in Onshape                                       */
  /* ===================================================================== */

  if (event === "onshape.comment.create" || event === "onshape.comment.update") {
    /*
     * The comment's own object is what matters, not the comment.
     *
     * Onshape's comment events carry the commented object's id, and PLM only
     * cares when that object is a task it mirrors. Re-reading the task brings
     * the whole thread — which is also how the merge stays idempotent, since
     * Onshape returns every comment on every read.
     */
    const objectId = String(
      payload.objectId ?? payload.data?.objectId ?? payload.taskId ?? ""
    ).trim();

    if (!objectId) {
      return ok({ received: true, handled: false, reason: "comment-without-object" });
    }

    const known: any = await Task.findOne({ enterpriseId, onshapeTaskId: objectId }).lean();
    if (!known) {
      // A comment on something else entirely — a part, a drawing, a release.
      // Not PLM's to act on, and not worth a log entry per comment.
      return ok({ received: true, handled: false, reason: "not-a-task-plm-mirrors" });
    }

    try {
      const { client } = await clientForEnterprise(enterpriseId);
      const live = await client.getTask(objectId);
      const r = await upsertTask(enterpriseId, live);
      return ok({ received: true, handled: true, task: objectId, commentsAdded: r.commentsAdded });
    } catch (err: any) {
      await ActivityLog.create({
        enterpriseId, direction: "onshape->plm", action: "error", trigger: event, ok: false,
        message:
          `A comment arrived for task ${objectId}, but PLM could not re-read it: ` +
          `${String(err?.message ?? err).slice(0, 300)}`,
      });
      return ok({ received: true, handled: false, reason: "task-read-failed" });
    }
  }

  /* ===================================================================== */

  const partId = String(
    payload.partId ?? payload.data?.partId ?? payload.partIds?.[0] ?? payload.itemId ?? ""
  );

  if (!partId) {
    await ActivityLog.create({
      enterpriseId, direction: "onshape->plm", action: "skipped", trigger: "webhook", ok: true,
      message:
        `Metadata event for element ${payload.elementId ?? "?"} carried no partId; ` +
        `nothing to sync.`,
    });
    return ok({ received: true, handled: false, reason: "no-partId", resolvedBy });
  }

  /*
   * Make sure there is a workspace.
   *
   * A metadata event can carry a versionId and no workspaceId, and reading
   * against that version during a release means reading the revision the
   * release has just obsoleted. The document lookup is cached for five
   * minutes, so a burst of events around one release costs a single call.
   */
  let workspaceId: string | null = payload.workspaceId ? String(payload.workspaceId) : null;
  if (!workspaceId && payload.documentId) {
    try {
      const { client } = await clientForEnterprise(enterpriseId);
      const doc = await client.getDocumentInfo(String(payload.documentId));
      workspaceId = doc.defaultWorkspaceId;
    } catch {
      // Leave it null; the sync falls back to what the part already records.
    }
  }

  const coords: PartCoords = {
    documentId: String(payload.documentId ?? ""),
    elementId: String(payload.elementId ?? ""),
    partId,
    configuration: String(payload.configuration ?? "default"),
    workspaceId,
    versionId: payload.versionId ? String(payload.versionId) : null,
  };

  if (!coords.documentId || !coords.elementId) {
    return ok({ received: true, handled: false, reason: "incomplete-coords" });
  }

  // Note whether this looks like the echo of PLM's own write-back. The sync
  // still runs — see consumeSelfWriteMarker for why dropping it loses real
  // designer edits that land inside the TTL window.
  const likelyEcho = await consumeSelfWriteMarker(enterpriseId, coords);

  try {
    const { client } = await clientForEnterprise(enterpriseId);
    const result = await syncPartFromOnshape(enterpriseId, coords, {
      trigger: likelyEcho ? `${event} (echo of our write)` : event,
      client,
      // A metadata edit never brings a new part in. Creation is deliberate:
      // someone presses Sync in the panel, or a release package names it.
      // Otherwise every property a designer touched would allocate a PLM
      // number nobody asked for.
      create: false,
    });
    return ok({ received: true, handled: result.action !== "skipped-unknown", likelyEcho, ...result });
  } catch (err: any) {
    const message = String(err?.message ?? err);
    console.error("[PLM] webhook sync failed:", message);
    await ActivityLog.create({
      enterpriseId, direction: "onshape->plm", action: "error", trigger: "webhook", ok: false, message,
    });
    // Still 200 — see the note at the top.
    return ok({ received: true, handled: false, error: message });
  }
});

/**
 * Update the part a revision event names, if PLM holds it.
 *
 * A revision event names the part by *number*, not id — the payload carries
 * `partNumber`, `revisionId` and `versionId` but no partId — so the id has to
 * be resolved by listing the element's parts at that version and matching.
 * That costs a call, so it is only spent on an element PLM already tracks.
 */
async function syncReleasedPart(
  enterpriseId: string,
  payload: Record<string, any>,
  event: string
): Promise<unknown | null> {
  const documentId = String(payload.documentId ?? "");
  const elementId = String(payload.elementId ?? "");
  if (!documentId || !elementId) return null;

  const tracked = await Part.exists({ enterpriseId, documentId, elementId });
  if (!tracked) return null;

  let partId = String(payload.partId ?? "");
  const versionId = payload.versionId ? String(payload.versionId) : null;
  let workspaceId: string | null = payload.workspaceId ? String(payload.workspaceId) : null;

  const { client } = await clientForEnterprise(enterpriseId);

  if (!partId && payload.partNumber) {
    const partNumber = String(payload.partNumber);
    try {
      const parts = await client.listElementParts({
        documentId, elementId, partId: "", workspaceId, versionId,
      });
      const match = parts.find((p) => p.partNumber && p.partNumber === partNumber);
      if (match) partId = match.partId;
      else {
        await ActivityLog.create({
          enterpriseId, direction: "onshape->plm", action: "skipped", trigger: event, ok: true,
          message:
            `Revision of part number "${partNumber}" could not be matched to a part in ` +
            `element ${elementId}. ${parts.length} part(s) were found there` +
            (parts.length ? `: ${parts.map((p) => p.partNumber || "(no number)").join(", ")}` : "") + ".",
        });
        return null;
      }
    } catch (err: any) {
      await ActivityLog.create({
        enterpriseId, direction: "onshape->plm", action: "error", trigger: event, ok: false,
        message: `Could not resolve part number "${partNumber}" to a part id: ${err?.message ?? err}`,
      });
      return null;
    }
  }

  // Writes need a workspace: a version is immutable and cannot take the number.
  if (!workspaceId) {
    try {
      workspaceId = (await client.getDocumentInfo(documentId)).defaultWorkspaceId;
    } catch {
      // Fall back to whatever the part already records.
    }
  }

  try {
    return await syncPartFromOnshape(
      enterpriseId,
      { documentId, elementId, partId, configuration: "default", workspaceId, versionId },
      {
        trigger: event,
        client,
        create: false,
        // Only a release may move the revision, and it reads its own version to
        // find it. This is that case.
        fromRelease: true,
      }
    );
  } catch (err: any) {
    await ActivityLog.create({
      enterpriseId, direction: "onshape->plm", action: "error", trigger: event, ok: false,
      message: `Could not sync the released part: ${String(err?.message ?? err).slice(0, 400)}`,
    });
    return null;
  }
}

/** Some tools probe the URL with GET before registering. */
export const GET = handler(async () =>
  ok({ ok: true, endpoint: "onshape-webhook-receiver", expects: "POST" })
);
