import { describeShape } from "./describe-payload";

/**
 * Onshape's workflow snapshot, wherever it appears.
 *
 * A release package and a task both carry a `BTWorkflowSnapshotInfo` — the
 * same object, with the same `state`, the same `actions`, and the same
 * approver fields. That is worth having in one place: the release-package
 * version of this took four wrong hypotheses and a read of Onshape's OpenAPI
 * definition to get right, and a second copy for tasks would have been a
 * second chance to get it wrong in a different way.
 *
 * Two things it knows that cost real time to learn:
 *
 *   `state` is an OBJECT — {name, displayName, approverSourceProperty} — not a
 *   string. Reading it as a string is what produced a release refused with
 *   `state ""`.
 *
 *   An action's `type` and the id you POST are DIFFERENT values: approve is
 *   `{type: "APPROVE", action: "RELEASE"}`, and it is `action` that goes on the
 *   wire.
 */

export type WorkflowAction = {
  id: string;
  label: string;
  type: string;
  isApproverAction?: boolean;
  allowIfNoApprovers?: boolean;
  alwaysAllow?: boolean;
  isAdminOverride?: boolean;
  isCreatorOverride?: boolean;
  requiredProperties?: string[];
};

export type WorkflowSnapshot = {
  /** Display name where there is one, else the internal name. Empty if absent. */
  state: string;
  /** Which field it was read from, for diagnosing a tenant that differs. */
  stateFrom: string | null;
  actions: WorkflowAction[];
  actionsFrom: string | null;
  permissions: { approverIds: string[]; isCreator: boolean };
};

/** Candidate paths for the state, most specific first. */
function statePaths(wf: any, root: any): [string, unknown][] {
  return [
    ["workflow.state.displayName", wf?.state?.displayName],
    ["workflow.currentStateDisplayName", wf?.currentStateDisplayName],
    ["workflow.state.name", wf?.state?.name],
    ["workflow.metadataState", wf?.metadataState],
    ["workflow.state", typeof wf?.state === "string" ? wf.state : undefined],
    // A task reports its own state alongside the snapshot's.
    ["state", typeof root?.state === "string" ? root.state : undefined],
    ["workflowState", typeof root?.workflowState === "string" ? root.workflowState : undefined],
    ["stateName", root?.stateName],
  ];
}

function actionPaths(wf: any, root: any): [string, unknown][] {
  return [
    ["workflow.actions", wf?.actions],
    ["workflow.transitions", wf?.transitions],
    ["workflow.availableActions", wf?.availableActions],
    ["workflowActions", root?.workflowActions],
    ["actions", root?.actions],
    ["availableActions", root?.availableActions],
    ["transitions", root?.transitions],
  ];
}

/** Shapes already reported, so a log line appears once rather than per call. */
const reported = new Set<string>();

/**
 * Read a snapshot out of whatever object carries it.
 *
 * `root` is the release package or task; `wf` is located within it. On a miss
 * the payload's shape is logged once — the same instrumentation that turned
 * four hypotheses about release packages into one read of a real payload.
 */
export function parseWorkflowSnapshot(
  root: any,
  opts: { label?: string; wf?: any } = {}
): WorkflowSnapshot {
  const wf = opts.wf ?? root?.workflow ?? root?.workflowInfo?.workflow ?? null;
  const label = opts.label ?? "object";

  const stateHit = statePaths(wf, root).find(([, v]) => typeof v === "string" && v !== "");
  /*
   * Any real array counts, empty or not.
   *
   * A finished task — Complete, frozen, nothing left to do — genuinely has
   * zero actions: `workflow.actions` is `[]`, not absent. Requiring a
   * non-empty array to count as "found" treated that correct, empty answer
   * as a miss, so every closed task fell through every candidate and logged
   * a "NO actions found" warning with a full shape dump — once per task,
   * since the dedup key includes the task id. The outcome was never wrong
   * (`actions` still ended up `[]` either way); only the diagnostic was.
   */
  const actionHit = actionPaths(wf, root).find(([, v]) => Array.isArray(v));

  const actions: WorkflowAction[] = ((actionHit?.[1] as any[]) ?? [])
    .map((a: any) => {
      if (typeof a === "string") return { id: a, label: a, type: a.toUpperCase() };
      return {
        /*
         * `action` before `id`. The value that goes on the wire is `action`,
         * and it differs from `type` — a release's approve is
         * {type: "APPROVE", action: "RELEASE"}.
         */
        id: String(a?.action ?? a?.id ?? a?.actionId ?? a?.name ?? ""),
        label: String(a?.label ?? a?.name ?? a?.action ?? ""),
        type: String(a?.type ?? a?.actionType ?? a?.action ?? "").toUpperCase(),
        isApproverAction: Boolean(a?.isApproverAction),
        allowIfNoApprovers: Boolean(a?.allowIfNoApprovers),
        alwaysAllow: Boolean(a?.alwaysAllow),
        isAdminOverride: Boolean(a?.isAdminOverride),
        isCreatorOverride: Boolean(a?.isCreatorOverride),
        requiredProperties: (Array.isArray(a?.requiredProperties) ? a.requiredProperties : [])
          .map((x: unknown) => String(x))
          .filter(Boolean),
      };
    })
    .filter((a) => a.id);

  if (!stateHit || !actionHit) {
    const key = `wf-miss|${label}|${Boolean(stateHit)}|${Boolean(actionHit)}`;
    if (!reported.has(key)) {
      reported.add(key);
      console.warn(
        `[PLM] ${label}: ${stateHit ? `state from "${stateHit[0]}"` : "NO state found"}, ` +
        `${actionHit ? `actions from "${actionHit[0]}"` : "NO actions found"}. ` +
        `Shape: ${describeShape(wf ?? root, 3)}`
      );
    }
  }

  return {
    state: String(stateHit?.[1] ?? ""),
    stateFrom: stateHit?.[0] ?? null,
    actions,
    actionsFrom: actionHit?.[0] ?? null,
    permissions: {
      approverIds: (Array.isArray(wf?.approverIds) ? wf.approverIds : []).map((x: unknown) => String(x)),
      isCreator: Boolean(wf?.isCreator),
    },
  };
}

/**
 * Pick the transition that means a given intent.
 *
 * Matches on the action's declared `type` first, then on the word appearing in
 * its label or id — whole-word, so "reject" does not match "Rejected by
 * manufacturing" and "approve" does not match "unapproved".
 */
export function findTransitionFor(
  actions: WorkflowAction[],
  intent: string,
  types: string[]
): WorkflowAction | null {
  for (const t of types) {
    const hit = actions.find((a) => a.type === t);
    if (hit) return hit;
  }
  const word = new RegExp(`\\b${intent}\\b`, "i");
  return actions.find((a) => word.test(a.label) || word.test(a.id)) ?? null;
}
