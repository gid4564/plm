import { connectDb } from "@/lib/db";
import {
  ActivityLog, Drawing, Enterprise, Part, PartIteration, Release,
} from "@/lib/models";
import { clientForEnterprise, clientForUser } from "@/lib/onshape/factory";
import { listDefinitions, missingForRelease } from "@/lib/attributes";
import { nextNumber } from "@/lib/numbering";
import { plainAttributes, syncPartFromOnshape } from "@/lib/sync";
import { captureDrawingPdf, coordsForStage, upsertDrawingFromPackageItem } from "@/lib/drawings";
import type { OnshapeClient, ReleasePackage, WorkflowAction } from "@/lib/onshape/types";

/**
 * The release process.
 *
 * PLM takes over the release that Onshape started. Onshape's own workflow
 * engine has no concept of an external approver — its custom-workflow
 * documentation describes only internal users, teams and roles — so PLM cannot
 * insert itself as a workflow step. What it can do is act on the package over
 * the API: catch the transition, run its own review, then perform the approve
 * or reject transition itself.
 *
 * The flow, end to end:
 *
 *   1. Designer raises a release candidate in Onshape. Onshape creates a
 *      release package and puts it in its first state.
 *   2. onshape.workflow.transition reaches PLM. PLM reads the package,
 *      brings every item into PLM, and captures the as-submitted drawing PDFs.
 *   3. PLM validates its own release-required attributes and opens a release
 *      in Under Review.
 *   4. A PLM approver approves or rejects. PLM performs the matching
 *      transition on the Onshape package.
 *   5. Onshape creates revisions. onshape.revision.created reaches PLM, which
 *      re-captures each drawing at the released version — now watermarked,
 *      revision-stamped and with its title block filled in.
 *
 * Step 4 is the one thing that has to be verified against a live tenant: an
 * approve transition is restricted to designated approvers, so PLM's service
 * account has to be one. See docs/ONSHAPE-INTEGRATION-SPEC.md, unknown U3.
 */

/* -------------------------------------------------------------------------- */
/* Choosing a transition                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Find the transition on a package that means "approve" or "reject".
 *
 * Matched on the action *type* the workflow declares, never on a hard-coded id
 * or label: ids are per-tenant, and a constant "APPROVE" would work on one
 * enterprise and silently do nothing on the next. Returns null rather than
 * guessing — a release that cannot be transitioned has to say so, because the
 * alternative is a PLM decision that never reaches Onshape while both systems
 * look fine.
 */
export function findTransition(
  pkg: ReleasePackage,
  intent: "approve" | "reject"
): WorkflowAction | null {
  const wanted = intent === "approve" ? "APPROVE" : "REJECT";
  const exact = pkg.availableActions.find((a) => a.type === wanted);
  if (exact) return exact;

  // Some workflows name the action rather than typing it. Fall back to the
  // label, but only on a whole-word match — "reject" must not match
  // "Rejected by manufacturing", and "approve" must not match "unapproved".
  const word = new RegExp(`\\b${intent}\\b`, "i");
  return pkg.availableActions.find((a) => word.test(a.label) || word.test(a.id)) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type ItemValidation = { itemLabel: string; missing: string[] };

/**
 * Which release-required attributes are still empty across a release's items.
 *
 * Reported, not enforced as a block. PLM finds out about an Onshape-originated
 * release only once the package already exists, so there is nothing left to
 * prevent — the useful thing is to put the gaps in front of the approver, who
 * can then reject with a reason. A release raised from PLM itself is a
 * different matter, and `submitReleaseFromPlm` does refuse.
 */
export async function validateRelease(releaseId: string): Promise<ItemValidation[]> {
  await connectDb();

  const release: any = await Release.findById(releaseId).lean();
  if (!release) return [];

  const partDefs = await listDefinitions(String(release.enterpriseId), "PART");
  const drawingDefs = await listDefinitions(String(release.enterpriseId), "DRAWING");

  const failures: ItemValidation[] = [];

  for (const item of release.items ?? []) {
    if (item.kind === "part" && item.partId) {
      const part: any = await Part.findById(item.partId).lean();
      if (!part) continue;
      const missing = missingForRelease(partDefs, plainAttributes(part.attributes));
      if (missing.length) failures.push({ itemLabel: part.number || part.name || "part", missing });
    } else if (item.kind === "drawing" && item.drawingId) {
      const dwg: any = await Drawing.findById(item.drawingId).lean();
      if (!dwg) continue;
      const missing = missingForRelease(drawingDefs, plainAttributes(dwg.attributes));
      if (missing.length) failures.push({ itemLabel: dwg.number || dwg.name || "drawing", missing });
    }
  }

  return failures;
}

/* -------------------------------------------------------------------------- */
/* Taking over a release Onshape started                                       */
/* -------------------------------------------------------------------------- */

export type TakeoverResult = {
  action: "opened" | "already-open" | "ignored" | "not-a-package";
  releaseId: string | null;
  number: string | null;
  parts: number;
  drawings: number;
  validationFailures: ItemValidation[];
  message: string;
};

/**
 * Adopt an Onshape release package as a PLM release.
 *
 * Idempotent on the package id: a workflow-transition webhook can arrive more
 * than once for the same package, and creating a second release for it would
 * split the approval record in two.
 */
export async function takeOverReleasePackage(
  enterpriseId: string,
  rpid: string,
  opts: { trigger?: string; client?: OnshapeClient } = {}
): Promise<TakeoverResult> {
  await connectDb();

  const trigger = opts.trigger || "webhook";
  const ent: any = await Enterprise.findById(enterpriseId);
  if (!ent) throw new Error("Enterprise not found");

  /*
   * The opt-in switch, checked here rather than by unsubscribing.
   *
   * Taking over releases means PLM starts approving and rejecting real
   * packages on a shared tenant. That has to be somebody's explicit decision.
   * Enforcing it at the event means the switch takes effect immediately, and a
   * failed re-registration cannot leave the enterprise silently unsubscribed.
   */
  if (!ent.releaseTakeoverEnabled) {
    await Enterprise.findByIdAndUpdate(enterpriseId, {
      $inc: { releasesIgnored: 1 },
      $set: { lastReleaseIgnoredAt: new Date() },
    });
    await ActivityLog.create({
      enterpriseId, direction: "onshape->plm", action: "skipped", trigger, ok: true,
      message:
        `Release package ${rpid} was ignored: taking over releases is switched off for ` +
        `this enterprise. Turn it on in Settings to have PLM manage the release process.`,
    });
    return {
      action: "ignored", releaseId: null, number: null, parts: 0, drawings: 0,
      validationFailures: [],
      message: "Release takeover is switched off for this enterprise.",
    };
  }

  const existing: any = await Release.findOne({ enterpriseId, onshapeReleasePackageId: rpid });
  if (existing && existing.state !== "Rejected") {
    return {
      action: "already-open", releaseId: String(existing._id), number: existing.number,
      parts: (existing.items ?? []).filter((i: any) => i.kind === "part").length,
      drawings: (existing.items ?? []).filter((i: any) => i.kind === "drawing").length,
      validationFailures: existing.validationFailures ?? [],
      message: `Release ${existing.number} is already open for this package.`,
    };
  }

  const client = opts.client ?? (await clientForEnterprise(enterpriseId)).client;
  const pkg = await client.getReleasePackage(rpid);

  if (!pkg.id) {
    return {
      action: "not-a-package", releaseId: null, number: null, parts: 0, drawings: 0,
      validationFailures: [],
      message: `Onshape returned no release package for id ${rpid}.`,
    };
  }

  const { number } = await nextNumber(enterpriseId, "RELEASE");

  const release: any = await Release.create({
    enterpriseId,
    number,
    title: pkg.items.length === 1
      ? `Release of ${pkg.items[0].name || pkg.items[0].partNumber || "one item"}`
      : `Release of ${pkg.items.length} items`,
    origin: "onshape",
    state: "Under Review",
    onshapeReleasePackageId: pkg.id,
    onshapeWorkflowId: pkg.workflowId || ent.onshapeReleaseWorkflowId || null,
    onshapeState: pkg.state,
    onshapeChangeOrderId: pkg.changeOrderId || null,
    submittedAt: new Date(),
    items: [],
  });

  /*
   * Bring every item in. Parts first, so a drawing can be associated with the
   * PLM parts it documents rather than left floating.
   */
  const partIdsByElement = new Map<string, string[]>();
  let parts = 0;
  let drawings = 0;

  for (const item of pkg.items) {
    if (item.elementType === "DRAWING") continue;

    try {
      const sync = await syncPartFromOnshape(
        enterpriseId,
        {
          documentId: item.documentId,
          elementId: item.elementId,
          partId: item.partId || "",
          configuration: "default",
          workspaceId: null,
          versionId: item.versionId || null,
        },
        {
          trigger: "release",
          client,
          create: true,
          // Under Review, not Released: the release has not been decided yet,
          // and a part that reads as Released before anyone approved it is the
          // exact governance failure PLM is meant to prevent.
          initialState: "Under Review",
          releaseId: String(release._id),
          kind: item.elementType === "ASSEMBLY" ? "assembly" : "part",
        }
      );

      if (!sync.partId) continue;

      release.items.push({
        kind: "part",
        partId: sync.partId,
        onshapeItemId: item.id,
        onshapeRevisionId: item.revisionId,
        revision: "",
      });

      const list = partIdsByElement.get(item.elementId) ?? [];
      list.push(sync.partId);
      partIdsByElement.set(item.elementId, list);

      // Move the PLM object into review alongside the release.
      await Part.updateOne(
        { _id: sync.partId },
        { $set: { lifecycleState: "Under Review", releaseId: release._id } }
      );

      parts++;
    } catch (err: any) {
      await ActivityLog.create({
        enterpriseId, releaseId: release._id,
        direction: "onshape->plm", action: "error", trigger, ok: false,
        message:
          `Release ${number}: could not bring in "${item.name || item.id}" ` +
          `(${String(err?.message ?? err).slice(0, 300)})`,
      });
    }
  }

  /*
   * Drawings. Onshape adds every active drawing to a package itself — the
   * changelog deprecated the flag that used to request it — so the association
   * between a sheet and the items it documents arrives for free, at exactly the
   * moment it is needed.
   */
  for (const item of pkg.items) {
    if (item.elementType !== "DRAWING") continue;

    try {
      // A drawing in the same document as a released part is documenting it,
      // as far as anything available here can tell. Onshape does not state the
      // relationship on the package, so this is the honest approximation:
      // co-membership of one release package, in one document.
      const related = [...partIdsByElement.values()].flat();

      const drawing = await upsertDrawingFromPackageItem(enterpriseId, item, {
        partIds: related,
        releaseId: String(release._id),
      });

      release.items.push({
        kind: "drawing",
        drawingId: drawing._id,
        onshapeItemId: item.id,
        onshapeRevisionId: item.revisionId,
        revision: "",
      });

      // The as-submitted sheet: what the approvers actually review. Captured
      // now, because after the release completes it no longer exists anywhere.
      const wsId = await resolveDrawingWorkspace(client, item.documentId);
      drawing.workspaceId = wsId;
      await drawing.save();

      await captureDrawingPdf(
        client,
        String(drawing._id),
        "as-submitted",
        coordsForStage({ documentId: item.documentId, elementId: item.elementId, workspaceId: wsId }, "as-submitted"),
        { releaseId: String(release._id) }
      );

      drawings++;
    } catch (err: any) {
      await ActivityLog.create({
        enterpriseId, releaseId: release._id,
        direction: "onshape->plm", action: "error", trigger, ok: false,
        message:
          `Release ${number}: could not bring in drawing "${item.name || item.id}" ` +
          `(${String(err?.message ?? err).slice(0, 300)})`,
      });
    }
  }

  await release.save();

  const validationFailures = await validateRelease(String(release._id));
  release.validationFailures = validationFailures;
  await release.save();

  await ActivityLog.create({
    enterpriseId,
    releaseId: release._id,
    direction: "onshape->plm",
    action: "submitted",
    trigger,
    ok: true,
    message:
      `Opened release ${number} from Onshape package ${pkg.id}: ${parts} part(s), ` +
      `${drawings} drawing(s), state ${pkg.state}` +
      (validationFailures.length
        ? `. ${validationFailures.length} item(s) are missing attributes required to release.`
        : "."),
  });

  return {
    action: "opened",
    releaseId: String(release._id),
    number,
    parts,
    drawings,
    validationFailures,
    message: `Opened release ${number} for review.`,
  };
}

/**
 * The workspace a drawing's PDF should be exported from.
 *
 * A release package names the document but not a workspace, and an
 * as-submitted export has to come from one — a version would already carry a
 * revision, which is precisely what distinguishes the two stages.
 */
async function resolveDrawingWorkspace(
  client: OnshapeClient,
  documentId: string
): Promise<string | null> {
  try {
    const info = await client.getDocumentInfo(documentId);
    return info.defaultWorkspaceId;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Deciding a release                                                          */
/* -------------------------------------------------------------------------- */

export type DecisionResult = {
  ok: boolean;
  state: string;
  /** The transition PLM performed on Onshape, when it performed one. */
  transition: string | null;
  /** Set when PLM's own decision was recorded but Onshape refused the transition. */
  transitionError: string | null;
  revisions: { itemLabel: string; revision: string }[];
  message: string;
};

/**
 * Approve or reject a release, and carry that decision into Onshape.
 *
 * The order matters and is deliberate: PLM records its own decision first,
 * then transitions Onshape. If the transition fails, PLM's decision still
 * stands and is visibly un-pushed — recoverable by retrying. The other order
 * would leave Onshape released against a PLM release that says nothing, which
 * is not recoverable by anything except a person noticing.
 */
export async function decideRelease(
  releaseId: string,
  decision: {
    intent: "approve" | "reject";
    userId: string;
    email: string;
    note?: string;
  }
): Promise<DecisionResult> {
  await connectDb();

  const release: any = await Release.findById(releaseId);
  if (!release) return failed("Release not found");

  if (release.state !== "Under Review") {
    return failed(
      `Release ${release.number} is ${release.state}, so it cannot be decided again.`
    );
  }

  const enterpriseId = String(release.enterpriseId);

  /*
   * Two different actors, deliberately.
   *
   * The decision is recorded against the person who made it — that is the
   * audit trail, and it is the only account of who approved this. The Onshape
   * transition, though, is performed by the enterprise's service account,
   * because Onshape restricts an approve transition to designated approvers
   * and it is the service user that is named as one in the workflow.
   *
   * That split is the reason PLM keeps its own local accounts: a PLM approver
   * needs no Onshape seat at all, which is exactly the case for the reviewer
   * whose job is governance rather than CAD.
   */
  const { client } = await clientForEnterprise(enterpriseId);

  release.decidedByUserId = decision.userId;
  release.decidedByEmail = decision.email;
  release.decidedAt = new Date();
  release.decisionNote = decision.note ?? "";
  release.state = decision.intent === "approve" ? "Approved" : "Rejected";
  await release.save();

  await ActivityLog.create({
    enterpriseId,
    releaseId: release._id,
    direction: "plm",
    action: decision.intent === "approve" ? "approved" : "rejected",
    trigger: "release",
    ok: true,
    message:
      `${decision.email} ${decision.intent === "approve" ? "approved" : "rejected"} ` +
      `release ${release.number}${decision.note ? `: ${decision.note}` : ""}`,
  });

  /* ---------------------- Carry the decision to Onshape ------------------- */

  const rpid = release.onshapeReleasePackageId;
  if (!rpid) {
    // A PLM-only release, with no Onshape package to transition. Legitimate,
    // and not an error — there is simply nothing to push.
    return {
      ok: true, state: release.state, transition: null, transitionError: null,
      revisions: [],
      message: `Release ${release.number} ${release.state.toLowerCase()} in PLM.`,
    };
  }

  let transitionError: string | null = null;
  let transitionUsed: string | null = null;
  const revisions: { itemLabel: string; revision: string }[] = [];

  try {
    // Re-read rather than trusting what was stored: which transitions a package
    // offers depends on the state it is in *now*, and someone may have moved it
    // in Onshape since PLM opened the review.
    const pkg = await client.getReleasePackage(rpid);
    const action = findTransition(pkg, decision.intent);

    if (!action) {
      throw new Error(
        `The Onshape package offers no ${decision.intent} transition from state ` +
        `"${pkg.state}". Available: ` +
        `${pkg.availableActions.map((a) => `${a.label || a.id} (${a.type})`).join(", ") || "none"}. ` +
        `Onshape restricts an approve transition to designated approvers, so the Onshape ` +
        `service account configured for this enterprise has to be named as one in the ` +
        `release workflow.`
      );
    }

    transitionUsed = `${action.label || action.id} (${action.type})`;
    const after = await client.transitionReleasePackage(rpid, action.id, { note: decision.note });

    release.onshapeTransitionAction = action.id;
    release.transitionedOnshapeAt = new Date();
    release.onshapeState = after.state;

    if (decision.intent === "approve") {
      /*
       * Onshape has now assigned the revisions. PLM records what it was told —
       * it does not compute them. Two systems generating revision identifiers
       * independently is how they come to disagree.
       */
      for (const item of release.items) {
        const match = after.items.find((i) => i.id === item.onshapeItemId);
        if (!match) continue;
        item.revision = match.revision || "";
        item.versionId = match.versionId || "";

        if (item.kind === "part" && item.partId) {
          const part: any = await Part.findById(item.partId);
          if (!part) continue;
          part.lifecycleState = "Released";
          part.revision = match.revision || part.revision;
          part.versionId = match.versionId || part.versionId;
          part.iteration = (part.iteration ?? 1) + 1;
          await part.save();

          await PartIteration.create({
            enterpriseId: part.enterpriseId,
            partId: part._id,
            iteration: part.iteration,
            revision: part.revision,
            lifecycleState: "Released",
            attributes: plainAttributes(part.attributes),
            onshapeVersionId: part.versionId ?? null,
            cause: "release",
            changedKeys: [],
            createdByEmail: decision.email,
            releaseId: release._id,
          }).catch(() => {});

          revisions.push({ itemLabel: part.number || part.name, revision: part.revision });
        } else if (item.kind === "drawing" && item.drawingId) {
          await Drawing.updateOne(
            { _id: item.drawingId },
            {
              $set: {
                lifecycleState: "Released",
                revision: match.revision || "",
                versionId: match.versionId || null,
              },
            }
          );
          const dwg: any = await Drawing.findById(item.drawingId).lean();
          if (dwg) revisions.push({ itemLabel: dwg.number || dwg.name, revision: match.revision || "" });
        }
      }

      release.state = "Released";

      /*
       * The released drawings still need collecting.
       *
       * Marked pending rather than fetched inline, because the sheet PLM wants
       * does not exist yet in the form it wants: Onshape applies the revision,
       * the watermark and the title-block fields as part of completing the
       * release, and the version carrying them is what the next event
       * announces. Trying now would capture the same unwatermarked sheet twice.
       */
      release.drawingRefreshPending = release.items.some((i: any) => i.kind === "drawing");
    } else {
      // A rejected release sends its parts back to work.
      for (const item of release.items) {
        if (item.kind === "part" && item.partId) {
          await Part.updateOne(
            { _id: item.partId },
            { $set: { lifecycleState: "In Work" }, $unset: { releaseId: "" } }
          );
        } else if (item.kind === "drawing" && item.drawingId) {
          await Drawing.updateOne({ _id: item.drawingId }, { $set: { lifecycleState: "In Work" } });
        }
      }
    }

    await release.save();
  } catch (err: any) {
    transitionError = String(err?.message ?? err);
    release.transitionError = transitionError;
    await release.save();

    await ActivityLog.create({
      enterpriseId,
      releaseId: release._id,
      direction: "plm->onshape",
      action: "error",
      trigger: "release",
      ok: false,
      message:
        `Release ${release.number} was ${release.state.toLowerCase()} in PLM, but Onshape ` +
        `would not accept the transition: ${transitionError.slice(0, 400)}`,
    });
  }

  if (!transitionError) {
    await ActivityLog.create({
      enterpriseId,
      releaseId: release._id,
      direction: "plm->onshape",
      action: "transitioned",
      trigger: "release",
      ok: true,
      message:
        `Performed "${transitionUsed}" on Onshape package ${rpid}; it is now ` +
        `${release.onshapeState}` +
        (revisions.length
          ? `. Revisions: ${revisions.map((r) => `${r.itemLabel} ${r.revision}`).join(", ")}`
          : "."),
    });
  }

  return {
    ok: !transitionError,
    state: release.state,
    transition: transitionUsed,
    transitionError,
    revisions,
    message: transitionError
      ? `Recorded in PLM, but Onshape refused the transition. Retry once the cause is fixed.`
      : `Release ${release.number} is ${release.state.toLowerCase()}.`,
  };

  function failed(message: string): DecisionResult {
    return { ok: false, state: "", transition: null, transitionError: null, revisions: [], message };
  }
}

/* -------------------------------------------------------------------------- */
/* Collecting the released drawings                                            */
/* -------------------------------------------------------------------------- */

export type RefreshResult = {
  ok: boolean;
  captured: number;
  failed: number;
  stillPending: boolean;
  message: string;
};

/**
 * Re-capture every drawing in a completed release at its released version.
 *
 * This is the second half of requirement 5, and the reason a drawing has file
 * versions rather than a single PDF. Onshape only applies the revision, the
 * watermark and the release title-block fields once the release has completed,
 * so the sheet captured at submission and the controlled document are
 * different files. Both are kept: one is what the approvers saw, the other is
 * what manufacturing works to.
 *
 * Idempotent. It is driven by onshape.revision.created, which can arrive more
 * than once and once per item, so it re-reads the package each time and only
 * captures drawings that do not already have an as-released sheet.
 */
export async function refreshReleasedDrawings(
  releaseId: string,
  opts: { client?: OnshapeClient; trigger?: string } = {}
): Promise<RefreshResult> {
  await connectDb();

  const release: any = await Release.findById(releaseId);
  if (!release) return { ok: false, captured: 0, failed: 0, stillPending: false, message: "Release not found" };
  if (!release.drawingRefreshPending) {
    return { ok: true, captured: 0, failed: 0, stillPending: false, message: "Nothing pending." };
  }

  const enterpriseId = String(release.enterpriseId);
  const client = opts.client ?? (await clientForEnterprise(enterpriseId)).client;

  // The versions only exist on the package after the release completed, so this
  // read is what supplies them — the ones held from the decision may be blank
  // if Onshape had not finished when it answered.
  let pkg: ReleasePackage | null = null;
  if (release.onshapeReleasePackageId) {
    try {
      pkg = await client.getReleasePackage(release.onshapeReleasePackageId);
    } catch (err: any) {
      return {
        ok: false, captured: 0, failed: 0, stillPending: true,
        message: `Could not re-read the Onshape package: ${String(err?.message ?? err).slice(0, 300)}`,
      };
    }
  }

  let captured = 0;
  let failed = 0;
  let missingVersion = 0;

  for (const item of release.items ?? []) {
    if (item.kind !== "drawing" || !item.drawingId) continue;

    const drawing: any = await Drawing.findById(item.drawingId);
    if (!drawing) continue;

    // Already collected — the event fired again, or once per item.
    const { DrawingFile } = await import("@/lib/models");
    const already = await DrawingFile.exists({
      drawingId: drawing._id,
      releaseId: release._id,
      stage: "as-released",
      failedAt: null,
    });
    if (already) continue;

    const match = pkg?.items.find((i) => i.id === item.onshapeItemId);
    const versionId = match?.versionId || item.versionId || drawing.versionId || null;
    const revision = match?.revision || item.revision || drawing.revision || "";

    if (!versionId) {
      // Onshape has not finished creating the version yet. Leave it pending:
      // the next revision event will find it, and capturing from the workspace
      // instead would store an unwatermarked sheet as the controlled document.
      missingVersion++;
      continue;
    }

    const result = await captureDrawingPdf(
      client,
      String(drawing._id),
      "as-released",
      coordsForStage(drawing, "as-released", versionId),
      { releaseId: String(release._id), revision }
    );

    if (result.ok) captured++; else failed++;
  }

  const stillPending = missingVersion > 0 || failed > 0;
  release.drawingRefreshPending = stillPending;
  if (!stillPending) release.drawingRefreshedAt = new Date();
  await release.save();

  await ActivityLog.create({
    enterpriseId,
    releaseId: release._id,
    direction: "onshape->plm",
    action: captured ? "updated" : "skipped",
    trigger: opts.trigger || "webhook",
    ok: failed === 0,
    message:
      `Release ${release.number}: captured ${captured} released drawing sheet(s)` +
      (failed ? `, ${failed} failed` : "") +
      (missingVersion
        ? `, ${missingVersion} waiting for Onshape to finish creating the version`
        : "") + ".",
  });

  return {
    ok: failed === 0,
    captured,
    failed,
    stillPending,
    message: stillPending
      ? `Captured ${captured}; ${missingVersion + failed} still outstanding.`
      : `Captured ${captured} released sheet(s).`,
  };
}

/* -------------------------------------------------------------------------- */
/* Raising a release from PLM                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Raise a release from PLM, creating the Onshape package.
 *
 * The mirror image of the takeover, and the path that lets PLM refuse: here the
 * release does not exist yet, so a missing release-required attribute can
 * genuinely block it rather than merely being reported to an approver.
 */
export async function submitReleaseFromPlm(
  enterpriseId: string,
  partIds: string[],
  submitter: { userId: string; email: string },
  opts: { title?: string; description?: string } = {}
): Promise<TakeoverResult> {
  await connectDb();

  const ent: any = await Enterprise.findById(enterpriseId);
  if (!ent) throw new Error("Enterprise not found");

  const parts: any[] = await Part.find({ enterpriseId, _id: { $in: partIds } });
  if (!parts.length) throw new Error("No parts were selected for release.");

  const defs = await listDefinitions(enterpriseId, "PART");
  const validationFailures: ItemValidation[] = [];
  for (const part of parts) {
    const missing = missingForRelease(defs, plainAttributes(part.attributes));
    if (missing.length) validationFailures.push({ itemLabel: part.number || part.name, missing });
  }

  if (validationFailures.length) {
    return {
      action: "ignored", releaseId: null, number: null, parts: 0, drawings: 0,
      validationFailures,
      message:
        `Cannot raise this release: ${validationFailures.length} part(s) are missing ` +
        `attributes required to release.`,
    };
  }

  const { number } = await nextNumber(enterpriseId, "RELEASE");

  /*
   * Raise the package as the submitter, so Onshape attributes the release
   * candidate to the person who asked for it — Onshape restricts the *submit*
   * transition to the release creator, so this has to be them where possible.
   *
   * Falls back to the service account for a PLM user with no Onshape seat.
   * That is a real case here, not a defensive flourish: PLM keeps local
   * accounts precisely so governance staff need no CAD licence.
   */
  let client: OnshapeClient;
  try {
    client = await clientForUser(submitter.userId);
  } catch {
    client = (await clientForEnterprise(enterpriseId)).client;
  }

  const wfid = ent.onshapeReleaseWorkflowId
    ?? (await client.getReleaseWorkflow(ent.onshapeCompanyId))?.id;
  if (!wfid) {
    throw new Error(
      "This enterprise has no Onshape release workflow on record. Connect Onshape and run " +
      "workflow discovery in Settings first."
    );
  }

  const pkg = await client.createReleasePackage(wfid, {
    // PLM's own number travels as the changeOrderId, which is what lets the
    // package be traced back here from the Onshape side.
    changeOrderId: number,
    items: parts.map((p) => ({
      documentId: p.documentId,
      elementId: p.elementId,
      ...(p.partId ? { partId: p.partId } : {}),
    })),
  });

  const release: any = await Release.create({
    enterpriseId,
    number,
    title: opts.title || `Release of ${parts.length} item(s)`,
    description: opts.description || "",
    origin: "plm",
    state: "Under Review",
    onshapeReleasePackageId: pkg.id,
    onshapeWorkflowId: wfid,
    onshapeState: pkg.state,
    onshapeChangeOrderId: number,
    submittedByEmail: submitter.email,
    submittedAt: new Date(),
    items: parts.map((p) => ({
      kind: "part",
      partId: p._id,
      onshapeItemId: pkg.items.find(
        (i) => i.elementId === p.elementId && (!p.partId || i.partId === p.partId)
      )?.id ?? "",
      revision: "",
    })),
  });

  for (const part of parts) {
    part.lifecycleState = "Under Review";
    part.releaseId = release._id;
    await part.save();
  }

  // Onshape added the active drawings itself; adopt them so they are reviewed
  // and captured on the same footing as a release Onshape started.
  let drawings = 0;
  for (const item of pkg.items) {
    if (item.elementType !== "DRAWING") continue;
    try {
      const drawing = await upsertDrawingFromPackageItem(enterpriseId, item, {
        partIds: parts.map((p) => String(p._id)),
        releaseId: String(release._id),
      });
      release.items.push({
        kind: "drawing", drawingId: drawing._id, onshapeItemId: item.id, revision: "",
      });
      drawing.workspaceId = await resolveDrawingWorkspace(client, item.documentId);
      await drawing.save();
      await captureDrawingPdf(
        client, String(drawing._id), "as-submitted",
        coordsForStage(drawing, "as-submitted"),
        { releaseId: String(release._id) }
      );
      drawings++;
    } catch {
      // Recorded by captureDrawingPdf; one uncapturable sheet must not sink
      // the release.
    }
  }
  await release.save();

  await ActivityLog.create({
    enterpriseId,
    releaseId: release._id,
    direction: "plm->onshape",
    action: "submitted",
    trigger: "release",
    ok: true,
    message:
      `${submitter.email} raised release ${number} from PLM: ${parts.length} part(s), ` +
      `${drawings} drawing(s). Onshape package ${pkg.id} is ${pkg.state}.`,
  });

  return {
    action: "opened",
    releaseId: String(release._id),
    number,
    parts: parts.length,
    drawings,
    validationFailures: [],
    message: `Raised release ${number}.`,
  };
}
