import { connectDb } from "@/lib/db";
import {
  ActivityLog, Drawing, Enterprise, Part, PartIteration, Release, User,
} from "@/lib/models";
import { clientForEnterprise, clientForUser } from "@/lib/onshape/factory";
import { listDefinitions, missingForRelease } from "@/lib/attributes";
import { nextNumber } from "@/lib/numbering";
import { plainAttributes, syncPartFromOnshape } from "@/lib/sync";
import { captureReleasedGeometry, geometryCaptureEnabled } from "@/lib/geometry";
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

/**
 * Wait for Onshape to actually leave the state it was in.
 *
 * PLM used to take the POST's own response as the outcome: it stamped
 * `transitionedOnshapeAt`, recorded `after.state`, and told the user the
 * release was done. But a live package carries a `transitionStatus` array with
 * a `lastStage` and a `summaryState`, which only makes sense if the transition
 * is processed after the call returns — so the response can perfectly well
 * report the old state, and PLM would claim a release Onshape had not performed.
 * That is the "the release in Onshape is not being completed" report: PLM said
 * done, the package stayed put, and nothing looked wrong from here.
 *
 * Three honest outcomes rather than an assumed one:
 *   "moved"      the state changed, or revisions were assigned
 *   "processing" Onshape accepted it and is still working; the webhook will
 *                finish the job, so this is not a failure
 *   "failed"     a transition stage reported an error
 *
 * Polls with a growing delay, which is the point: an immediate re-read would
 * almost always land before Onshape has done anything.
 */
export async function waitForTransition(
  client: OnshapeClient,
  rpid: string,
  fromState: string,
  opts: { delaysMs?: number[]; actorOnshapeUserId?: string | null } = {}
): Promise<{ outcome: "moved" | "processing" | "failed"; pkg: ReleasePackage; detail: string }> {
  const actorOnshapeUserId = opts.actorOnshapeUserId ?? null;
  // Roughly twelve seconds in total. Long enough for Onshape to finish a small
  // package, short enough not to hold a request open while it chews a big one —
  // the webhook is what covers the slow case.
  const delays = opts.delaysMs ?? [400, 800, 1500, 2500, 3000, 3000];

  let pkg = await client.getReleasePackage(rpid);
  const same = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

  for (let attempt = 0; ; attempt++) {
    const failure = pkg.transitionStatus.find((t) => t.errorMessage);
    if (failure) {
      return {
        outcome: "failed",
        pkg,
        detail:
          `Onshape reported an error at stage "${failure.lastStage || "unknown"}": ` +
          `${failure.errorMessage}`,
      };
    }

    // Revisions are the unambiguous signal that a release completed, and they
    // can appear while the state string still reads as the old one.
    const revised = pkg.items.some((i) => i.revision);
    if (!same(pkg.state, fromState) || revised) {
      return {
        outcome: "moved",
        pkg,
        detail: revised && same(pkg.state, fromState)
          ? `Onshape assigned revisions while still reporting state "${pkg.state}".`
          : `Onshape moved the package from "${fromState}" to "${pkg.state}".`,
      };
    }

    if (attempt >= delays.length) break;
    await new Promise((r) => setTimeout(r, delays[attempt]));
    pkg = await client.getReleasePackage(rpid);
  }

  const busy = pkg.transitionStatus.map((t) => t.summaryState || t.lastStage).filter(Boolean);
  const waited = (delays.reduce((a, b) => a + b, 0) / 1000).toFixed(1);

  /*
   * Before blaming slowness, check whether Onshape was ever going to do it.
   *
   * Onshape *lists* an action the calling account may not perform, accepts the
   * POST, and ignores it: 200, no error, `transitionStatus` still HEALTHY, and
   * the state unchanged. Reported as "Onshape is slow, the webhook will finish
   * it", which sends somebody to wait for an event that is never coming.
   *
   * The package says who may act. A live enterprise's RELEASE carries
   * `isApproverAction: true` with neither `isCreatorOverride` nor
   * `isAdminOverride`, so a designated approver and nobody else — and the
   * account PLM acts as had raised the package itself (`isCreator: true`),
   * which is a different thing.
   */
  const blocked = describePermissionBlock(pkg, actorOnshapeUserId);
  if (blocked) {
    return { outcome: "failed", pkg, detail: blocked };
  }

  return {
    outcome: "processing",
    pkg,
    detail:
      `Onshape accepted the transition but the package still reports state ` +
      `"${pkg.state}" after ${waited}s` +
      `${busy.length ? ` (transition status: ${busy.join(", ")})` : ""}. ` +
      `If Onshape is simply slow, the workflow webhook will complete this release; ` +
      `if it never arrives, the transition did not take effect.`,
  };
}

/**
 * Whether the acting account is one Onshape would refuse, and why.
 *
 * Returns null when nothing on the package rules the account out — which is not
 * a guarantee it is permitted, only that Onshape has not said otherwise here.
 * Stated that way round deliberately: the alternative is asserting permission
 * PLM cannot verify, which is how the first version of this message came to
 * blame approver configuration for an unparsed payload.
 */
function describePermissionBlock(
  pkg: ReleasePackage,
  actorOnshapeUserId: string | null
): string | null {
  const action = pkg.availableActions.find((a) => a.type === "APPROVE");
  if (!action) return null;

  // Onshape will perform it for anyone.
  if (action.alwaysAllow) return null;
  // Not restricted to approvers, so nothing here rules the account out.
  if (!action.isApproverAction) return null;

  const approvers = pkg.permissions.approverIds;
  // With no approvers named, this flag is what lets the action through.
  if (approvers.length === 0 && action.allowIfNoApprovers) return null;

  const isApprover = !!actorOnshapeUserId && approvers.includes(actorOnshapeUserId);
  if (isApprover) return null;

  // A creator override would let the raiser act despite not being an approver.
  if (pkg.permissions.isCreator && action.isCreatorOverride) return null;

  /*
   * Only say this when the account is positively known not to be an approver.
   * Without the acting id there is nothing to compare, and guessing here is
   * exactly the mistake being fixed.
   */
  if (!actorOnshapeUserId) return null;

  return (
    `Onshape accepted the transition and did not perform it, and the package explains ` +
    `why: its "${action.label || action.id}" action is restricted to designated ` +
    `approvers (isApproverAction, with no creator or admin override), and the Onshape ` +
    `account PLM acts as (${actorOnshapeUserId}) is not among the ` +
    `${approvers.length} approver(s) named on this package` +
    `${pkg.permissions.isCreator ? " — it raised the package, which is not the same thing" : ""}. ` +
    `Onshape reports no error for this; it simply ignores the action. Add that account as ` +
    `a designated approver in the release workflow, or nominate an account that already is ` +
    `as the enterprise's service account in Settings.`
  );
}

/**
 * Why no usable transition was found, distinguishing causes PLM can tell apart.
 *
 * The previous message asserted one cause for all of them — that the Onshape
 * service account is not a designated approver — and a live enterprise hit it
 * reporting state `""` with no actions at all. That is not a permissions
 * symptom: a package whose transitions are merely out of this account's reach
 * still reports the state it is in. PLM had failed to read the workflow
 * information out of the payload, and the message sent somebody to reconfigure
 * a workflow that may well have been correct.
 *
 * So each case now says only what the evidence supports, and the case that
 * cannot be diagnosed from here says so and points at the log line that
 * carries the payload's shape.
 */
export function explainMissingTransition(
  pkg: ReleasePackage,
  intent: "approve" | "reject"
): string {
  const seen = pkg.availableActions.map((a) => `${a.label || a.id} (${a.type})`).join(", ");

  // Nothing at all: not a permissions problem, whatever else it is.
  if (!pkg.state && pkg.availableActions.length === 0) {
    return (
      `PLM could not read any workflow information from Onshape release package ` +
      `${pkg.id || "(no id)"} — it reports neither a state nor any transition. ` +
      `That is not an approver-permissions symptom: a package whose transitions are ` +
      `out of reach still reports its state. Either the package could not be read, ` +
      `or its payload puts the workflow somewhere PLM does not look. The server log ` +
      `carries a "release package ... NO state found" line with the payload's shape — ` +
      `that names the fields, and settles it.`
    );
  }

  // A state, but nothing offered.
  if (pkg.availableActions.length === 0) {
    /*
     * Check the raw payload before blaming configuration.
     *
     * This message once claimed a workflow offered nothing while the very same
     * package, dumped a minute later, listed three transitions — an
     * irreconcilable pair of reports, and the likeliest explanation was a stale
     * build rather than anything about the workflow. So the message now says
     * what was actually in the payload: if the actions were there and PLM read
     * none, that is a parsing or deployment problem and nothing to do with
     * approvers.
     */
    const rawWorkflow = (pkg.raw as Record<string, any>)?.workflow;
    const rawActions = Array.isArray(rawWorkflow?.actions) ? rawWorkflow.actions : null;
    if (rawActions?.length) {
      return (
        `PLM read no transitions from Onshape release package ${pkg.id}, but the payload ` +
        `does contain workflow.actions with ${rawActions.length} entry/entries ` +
        `(${rawActions.map((a: any) => a?.action ?? a?.type ?? "?").join(", ")}). ` +
        `That is a mismatch inside PLM, not a workflow or approver problem — most likely ` +
        `this build predates the fix that reads them. Check /api/version against the build ` +
        `you deployed.`
      );
    }

    return (
      `The Onshape release package is in state "${pkg.state}" and offers the account ` +
      `PLM is acting as no transitions at all. Onshape restricts approve and reject ` +
      `transitions to designated approvers, so the most likely cause is that the ` +
      `Onshape service account for this enterprise is not named as an approver on the ` +
      `release workflow. A workflow with no transition out of "${pkg.state}" would ` +
      `look the same from here.`
    );
  }

  // Transitions exist, but none reads as the one wanted. That is the unknown
  // action enum (U2 in the integration spec), not a permissions problem — the
  // actions are listed, so they are within reach.
  return (
    `The Onshape release package is in state "${pkg.state}" and offers ${seen}, but PLM ` +
    `could not tell which of those means "${intent}". The action names on this endpoint ` +
    `are undocumented, and PLM matches on an APPROVE/REJECT type or the word itself in ` +
    `the label. These transitions are available to the account PLM is acting as, so this ` +
    `is a naming mismatch rather than a permissions problem.`
  );
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
    /**
     * Package property values, keyed by property id, for a transition that
     * declares `requiredProperties`. The stock workflow's SUBMIT wants the
     * Approvers property this way; RELEASE on this enterprise's workflow
     * requires none, and takes an empty body.
     */
    properties?: Record<string, unknown>;
  }
): Promise<DecisionResult> {
  await connectDb();

  const release: any = await Release.findById(releaseId);
  if (!release) return failed("Release not found");

  /*
   * A decision already recorded, whose Onshape half never landed.
   *
   * `release.state` is saved before the transition is attempted, so a refusal
   * from Onshape left the two systems permanently divergent: PLM said Approved,
   * the Onshape package stayed Pending, and this guard then refused every
   * retry — "is Approved, so it cannot be decided again". The only way out was
   * editing the database. That happened for real, to REL-00002-PLM, when the
   * package's actions could not be read.
   *
   * Re-attempting the outstanding half is not re-deciding. The original
   * decision, its author and its timestamp all stand; only the transition runs
   * again. Reversing a decision is a different thing and is still refused.
   */
  const decidedState = decision.intent === "approve" ? "Approved" : "Rejected";
  const isRetry =
    release.state === decidedState &&
    !release.transitionedOnshapeAt &&
    !!release.onshapeReleasePackageId;

  if (release.state !== "Under Review" && !isRetry) {
    return failed(
      release.state === "Approved" || release.state === "Rejected"
        ? `Release ${release.number} is already ${release.state.toLowerCase()}` +
          `${release.transitionedOnshapeAt ? " and Onshape has been transitioned" : ""}, ` +
          `so it cannot be decided again.`
        : `Release ${release.number} is ${release.state}, so it cannot be decided again.`
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
  const { client, actingUserId } = await clientForEnterprise(enterpriseId);

  /*
   * The Onshape identity PLM is about to act as.
   *
   * Read so that a transition Onshape accepts and ignores can be attributed:
   * the package names its approvers by Onshape user id, and without this there
   * is nothing to compare them against.
   */
  const actor: any = actingUserId ? await User.findById(actingUserId).lean() : null;
  const actorOnshapeUserId: string | null = actor?.onshapeUserId
    ? String(actor.onshapeUserId)
    : null;

  // On a retry the decision already exists; overwriting it would rewrite the
  // audit trail to name whoever happened to click the button again.
  if (!isRetry) {
    release.decidedByUserId = decision.userId;
    release.decidedByEmail = decision.email;
    release.decidedAt = new Date();
    release.decisionNote = decision.note ?? "";
    release.state = decidedState;
    await release.save();
  }

  await ActivityLog.create({
    enterpriseId,
    releaseId: release._id,
    direction: "plm",
    action: decision.intent === "approve" ? "approved" : "rejected",
    trigger: "release",
    ok: true,
    message: isRetry
      ? `${decision.email} re-sent release ${release.number} to Onshape. The ` +
        `${decision.intent === "approve" ? "approval" : "rejection"} by ` +
        `${release.decidedByEmail || "an earlier reviewer"} stands; only the Onshape ` +
        `transition is being retried.`
      : `${decision.email} ${decision.intent === "approve" ? "approved" : "rejected"} ` +
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
  /*
   * Accepted by Onshape but not finished. Distinct from a refusal: telling
   * somebody Onshape "refused" a transition it accepted sends them looking for
   * a permissions problem that does not exist.
   */
  let transitionPending = false;
  const revisions: { itemLabel: string; revision: string }[] = [];

  /*
   * Forget the previous refusal before trying again.
   *
   * It was only ever set, never cleared, so a release that failed once carried
   * the message for good — including after a successful retry, where the page
   * went on reporting a refusal that had already been overcome.
   */
  if (release.transitionError) {
    release.transitionError = null;
    release.transitionErrorAt = null;
    await release.save();
  }

  try {
    // Re-read rather than trusting what was stored: which transitions a package
    // offers depends on the state it is in *now*, and someone may have moved it
    // in Onshape since PLM opened the review.
    const pkg = await client.getReleasePackage(rpid);
    const action = findTransition(pkg, decision.intent);

    if (!action) throw new Error(explainMissingTransition(pkg, decision.intent));

    /*
     * An action that declares requirements PLM has not supplied cannot succeed.
     *
     * Onshape's release-management guide is explicit that a transition's
     * `requiredProperties` must be set in the request body — SUBMIT on the
     * stock workflow requires the Approvers property. Sending the transition
     * without them earns the same silent nothing as any other malformed
     * request, so it is better to say which property is missing than to wait
     * for a state change that cannot happen.
     */
    const unmet = (action.requiredProperties ?? []).filter(
      (id) => !(decision.properties && id in decision.properties)
    );
    if (unmet.length) {
      throw new Error(
        `Onshape's "${action.label || action.id}" transition requires ` +
        `${unmet.length} package property/properties that PLM did not supply ` +
        `(${unmet.join(", ")}). Onshape would accept the request and do nothing. ` +
        `The property ids are from the package's own workflow.actions[].requiredProperties.`
      );
    }

    transitionUsed = `${action.label || action.id} (${action.type})`;

    console.log(
      `[PLM] release ${release.number}: POST /releasepackages/${rpid} ` +
      `action=${action.id} (type ${action.type}) from state "${pkg.state}"`
    );

    await client.transitionReleasePackage(rpid, action.id, {
      note: decision.note,
      ...(decision.properties ? { properties: decision.properties } : {}),
    });

    /*
     * Confirm it, rather than assume it.
     *
     * The POST's own response was previously taken as the outcome — see
     * waitForTransition for why that is not safe.
     */
    const verdict = await waitForTransition(client, rpid, pkg.state, { actorOnshapeUserId });
    const after = verdict.pkg;

    console.log(
      `[PLM] release ${release.number}: transition ${verdict.outcome} — ${verdict.detail}`
    );

    if (verdict.outcome === "failed") {
      // Not a transition PLM performed, so nothing is stamped as done.
      throw new Error(verdict.detail);
    }

    release.onshapeTransitionAction = action.id;
    release.onshapeState = after.state;

    /*
     * Only stamped when Onshape actually moved. Left unset while a transition
     * is still processing, which is what makes the retry panel offer itself and
     * keeps PLM from reporting a release Onshape has not performed.
     */
    if (verdict.outcome === "moved") {
      release.transitionedOnshapeAt = new Date();
    } else {
      transitionPending = true;
      transitionError = verdict.detail;
      release.transitionError = verdict.detail;
      release.transitionErrorAt = new Date();
    }

    /*
     * Record the outcome only for a transition that actually happened.
     *
     * This block used to run on the strength of the POST returning, so a
     * package Onshape had not moved still had PLM mark the release Released and
     * the parts released with it — two systems disagreeing, with PLM the one
     * telling the confident lie. While a transition is merely processing the
     * release stays Approved and the revisions stay unrecorded; the workflow
     * webhook completes it, and the retry panel is there if it never does.
     */
    if (decision.intent === "approve" && verdict.outcome === "moved") {
      /*
       * Onshape has now assigned the revisions. PLM records what it was told —
       * it does not compute them. Two systems generating revision identifiers
       * independently is how they come to disagree.
       */
      /*
       * Read once, not per item: it is one setting for the enterprise and a
       * lookup inside the loop would be a query per released part.
       */
      const captureGeometry = await geometryCaptureEnabled(enterpriseId);

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

          /*
           * The geometry as released, if the enterprise asked for it.
           *
           * Here rather than with the drawings, because unlike a drawing sheet
           * the model needs nothing applied to it — the version Onshape just
           * produced already IS the released geometry, so there is nothing to
           * wait for.
           *
           * Never allowed to affect the release. captureReleasedGeometry does
           * not throw, and the flag is read once outside the loop.
           */
          if (captureGeometry) {
            await captureReleasedGeometry(
              client,
              enterpriseId,
              String(part._id),
              {
                documentId: part.documentId,
                elementId: part.elementId,
                partId: part.partId || "",
                configuration: part.configuration || "default",
                /* Pinned to the released version, never the live workspace. */
                workspaceId: null,
                versionId: match.versionId || part.versionId || null,
              },
              {
                revision: part.revision || "",
                releaseId: String(release._id),
                isAssembly: part.kind === "assembly",
              }
            );
          }

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
    } else if (decision.intent === "reject" && verdict.outcome === "moved") {
      /*
       * A rejected release sends its parts back to work.
       *
       * Spelled out rather than left as a bare `else`, because the condition
       * above now also requires the transition to have moved — and a plain
       * `else` would catch an *approval* that Onshape is still processing and
       * send its parts back to In Work, which is the opposite of what happened.
       */
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
    release.transitionErrorAt = new Date();
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
    message: transitionPending
      ? `Onshape accepted the transition but has not completed it yet, so release ` +
        `${release.number} stays ${release.state.toLowerCase()} until it does. ` +
        `If Onshape's workflow webhook does not finish it, retry the Onshape half.`
      : transitionError
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
/**
 * How long to wait before each attempt at collecting the released sheets.
 *
 * Onshape applies the revision, the watermark and the title-block fields while
 * it completes the release, and it fires `onshape.revision.created` before that
 * work has finished. PLM used to collect the sheets synchronously inside that
 * webhook, so the first attempt was the *earliest* possible moment — often too
 * early. When it came up short the release was left pending for "the next
 * revision event", but that event fires once per item, so for a single-item
 * release there was no next one and somebody had to press Collect by hand.
 *
 * Overridable, because how long Onshape takes depends on the tenant and the
 * drawing: `PLM_DRAWING_REFRESH_RETRIES_MS=20000,60000,180000`.
 */
export const DRAWING_REFRESH_DEFAULT_MS = "15000,45000,120000,300000,600000";

/*
 * Read on each call rather than captured at import.
 *
 * A module-level constant is evaluated when the module first loads, which in an
 * ES module is *before* any statement in the importing file has run — so
 * anything setting the variable at the top of a script was too late, and the
 * value silently stayed at the default. That is a poor property for a knob
 * whose whole purpose is being changed, and it also means a deployment can
 * adjust it without a rebuild.
 */
export function drawingRefreshSchedule(): number[] {
  return (process.env.PLM_DRAWING_REFRESH_RETRIES_MS || DRAWING_REFRESH_DEFAULT_MS)
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Releases with a retry chain running in this process, so the several revision
 * events one release produces start one chain rather than one each.
 */
const refreshChains = new Map<string, { attempt: number; timer: NodeJS.Timeout }>();

/**
 * Keep trying to collect a release's drawings, in the background.
 *
 * Deliberately not awaited by the webhook: Onshape re-delivers a webhook that
 * does not answer promptly, and holding the request open for minutes would earn
 * a duplicate delivery for every retry. The work outlives the request instead —
 * this process is long-lived under pm2.
 *
 * A chain stops as soon as a refresh reports nothing pending, and gives up
 * after the schedule is exhausted, leaving `drawingRefreshPending` set so the
 * Collect button still works and the release page still shows it as
 * outstanding. Nothing here is load-bearing for correctness; it removes the
 * need for a person to press the button at the right moment.
 */
export function scheduleDrawingRefresh(
  releaseId: string,
  opts: { trigger?: string } = {}
): { scheduled: boolean; inMs: number | null; reason: string } {
  const existing = refreshChains.get(releaseId);
  if (existing) {
    return {
      scheduled: false,
      inMs: null,
      reason: `a retry chain is already running for this release (attempt ${existing.attempt + 1})`,
    };
  }
  // Captured once per chain: a chain that changed schedule halfway through
  // would be harder to reason about than one that finishes as it started.
  const schedule = drawingRefreshSchedule();
  if (!schedule.length) {
    return { scheduled: false, inMs: null, reason: "retries are disabled by configuration" };
  }

  const run = (attempt: number) => {
    const delay = schedule[attempt];
    const timer = setTimeout(async () => {
      try {
        const result = await refreshReleasedDrawings(releaseId, {
          trigger: `${opts.trigger || "webhook"}-retry-${attempt + 1}`,
        });

        if (!result.stillPending) {
          refreshChains.delete(releaseId);
          console.log(
            `[PLM] drawing refresh for release ${releaseId} finished on attempt ` +
            `${attempt + 1}: ${result.message}`
          );
          return;
        }

        if (attempt + 1 < schedule.length) {
          run(attempt + 1);
          return;
        }

        refreshChains.delete(releaseId);
        /*
         * Recorded, not silent. The release stays marked pending and the
         * Collect button still works, but somebody has to know the automatic
         * attempts are over — otherwise it looks like it is still coming.
         */
        await connectDb();
        const rel: any = await Release.findById(releaseId).lean();
        if (rel) {
          await ActivityLog.create({
            enterpriseId: rel.enterpriseId,
            releaseId,
            direction: "onshape->plm",
            action: "error",
            trigger: opts.trigger || "webhook",
            ok: false,
            message:
              `Gave up collecting the released drawings for ${rel.number} after ` +
              `${schedule.length} attempts over ` +
              `${Math.round(schedule.reduce((a, b) => a + b, 0) / 60000)} ` +
              `minutes. Last result: ${result.message} Use Collect drawings on the release ` +
              `to try again, or raise PLM_DRAWING_REFRESH_RETRIES_MS if Onshape needs longer ` +
              `on this tenant.`,
          });
        }
      } catch (err: any) {
        /*
         * A throw inside a timer is an unhandled rejection, which would take
         * the process down and with it every other release. Swallowed to a log.
         */
        refreshChains.delete(releaseId);
        console.warn(
          `[PLM] background drawing refresh for release ${releaseId} threw on attempt ` +
          `${attempt + 1}: ${err?.message ?? err}`
        );
      }
    }, delay);

    // Do not hold the process open for a pending retry: a shutdown should not
    // wait minutes for one, and `drawingRefreshPending` survives a restart.
    timer.unref?.();
    refreshChains.set(releaseId, { attempt, timer });
  };

  run(0);
  return {
    scheduled: true,
    inMs: schedule[0],
    reason:
      `will retry in ${Math.round(schedule[0] / 1000)}s, up to ` +
      `${schedule.length} attempts`,
  };
}

/** Stop a release's retry chain. Used when a refresh succeeds by another route. */
export function cancelDrawingRefresh(releaseId: string): boolean {
  const chain = refreshChains.get(releaseId);
  if (!chain) return false;
  clearTimeout(chain.timer);
  refreshChains.delete(releaseId);
  return true;
}

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

  /*
   * The drawings have to be named, because Onshape will not add them.
   *
   * A package raised from PLM came back with only the parts in it —
   * `addAllDrawingsActive: false` and no drawing item — so the released part
   * had no drawing to be associated with, and the part page's Drawings section
   * stayed empty. That looked like a broken association in PLM; the drawing was
   * simply never in the release.
   *
   * PLM's earlier note that "Onshape adds every active drawing to a package
   * itself" holds for a candidate raised in Onshape's own dialog, which is
   * where it was observed. It does not hold here: `addAllDrawingsActive` is a
   * read-only field on the response, and the create request accepts nothing but
   * `items` — so a drawing gets in only by being listed.
   *
   * Which drawings? Every drawing tab in the same document as a part being
   * released. Onshape does not state which parts a sheet documents, so this is
   * the same honest approximation the takeover already makes when it associates
   * a released drawing with the parts it arrived alongside. Naming the drawings
   * here keeps the two paths consistent, and the count is reported so the
   * scope of the release is visible rather than implied.
   */
  const drawingItems: { documentId: string; elementId: string }[] = [];
  const documentsSeen = new Map<string, string | null>();
  for (const part of parts) {
    if (!documentsSeen.has(part.documentId)) {
      documentsSeen.set(part.documentId, part.workspaceId ?? null);
    }
  }

  for (const [documentId, workspaceId] of documentsSeen) {
    try {
      const elements = await client.listElements({ documentId, workspaceId });
      for (const el of elements) {
        if (String(el.elementType).toUpperCase() !== "DRAWING") continue;
        drawingItems.push({ documentId, elementId: el.id });
      }
    } catch (err: any) {
      /*
       * Reported, not fatal. A release of the parts is still worth having, and
       * a silent omission is what caused this in the first place.
       */
      await ActivityLog.create({
        enterpriseId, direction: "plm->onshape", action: "error", trigger: "release", ok: false,
        message:
          `Release ${number}: could not list the drawings in document ${documentId}, so any ` +
          `drawing there is not included in this release ` +
          `(${String(err?.message ?? err).slice(0, 300)}).`,
      });
    }
  }

  const pkg = await client.createReleasePackage(wfid, {
    /*
     * PLM's number used to travel as `changeOrderId`, "which is what lets the
     * package be traced back here". It never did: the field is read-only on
     * Onshape's API — on the response, not the request — so it was discarded on
     * arrival. The real link is the package id stored on the release below.
     */
    items: [
      ...parts.map((p) => ({
        documentId: p.documentId,
        elementId: p.elementId,
        ...(p.partId ? { partId: p.partId } : {}),
      })),
      ...drawingItems,
    ],
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
    // Onshape's own id for the package, not PLM's number — the field cannot be
    // set by a caller, so recording PLM's number here claimed a link that did
    // not exist on the Onshape side.
    onshapeChangeOrderId: pkg.changeOrderId || null,
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
