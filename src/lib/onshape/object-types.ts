/**
 * Onshape's numeric object-type codes.
 *
 * The comment API identifies what a comment is attached to by an integer, and
 * no schema in Onshape's OpenAPI definition declares that integer's values.
 * What it does declare is `BTMetadataObjectType` — an ordered string enum — and
 * these are its ordinals.
 *
 * That is an **inference from the declared ordering**, not a confirmed mapping,
 * and this project has been bitten by exactly that kind of inference before: a
 * positional read of Onshape's workflow states once showed a released part as
 * "Obsolete". So two things follow.
 *
 * First, a code observed on real data always wins. A comment Onshape itself
 * placed on an object carries the right code, and copying it needs no
 * inference at all — that path is tried first everywhere this is used.
 *
 * Second, each value is overridable, because being wrong here should cost a
 * line of configuration rather than a rebuild.
 */
const BT_METADATA_OBJECT_TYPE = [
  "GLOBAL", "DOCUMENT", "PART", "ASSEMBLY", "DRAWING", "PART_STUDIO",
  "BLOB_ELEMENT", "APP_ELEMENT", "VERSION", "WORKSPACE", "PROJECT", "ITEM",
  "FEATURE_STUDIO", "CHANGE_REQUEST", "TASK", "CHANGE_ORDER", "CHANGE_TASK",
  "VARIABLE_STUDIO", "DRAWING_ANNOTATIONS", "FOLDER",
] as const;

export type OnshapeObjectTypeName = (typeof BT_METADATA_OBJECT_TYPE)[number];

/** The ordinal Onshape's own enum gives a name, or null if it is not in it. */
export function objectTypeCode(name: OnshapeObjectTypeName): number | null {
  const i = BT_METADATA_OBJECT_TYPE.indexOf(name);
  return i < 0 ? null : i;
}

/** The name for a code, for saying what PLM thinks it sent. */
export function objectTypeName(code: number | null | undefined): string {
  if (code == null) return "(none)";
  return BT_METADATA_OBJECT_TYPE[code] ?? `unknown (${code})`;
}

/**
 * The code to use for a task comment.
 *
 * `ONSHAPE_COMMENT_OBJECT_TYPE_TASK` overrides it. The default is TASK's
 * ordinal in the declared enum — 14 — which is an inference, and is why the
 * override exists.
 */
export function taskCommentObjectType(): { code: number; inferred: boolean } {
  const configured = Number(process.env.ONSHAPE_COMMENT_OBJECT_TYPE_TASK);
  if (Number.isInteger(configured)) return { code: configured, inferred: false };
  return { code: objectTypeCode("TASK")!, inferred: true };
}

/**
 * Fill in a task comment's context, so no caller has to know the codes.
 *
 * Shared by both clients deliberately. The live client had the defaulting and
 * the mock did not, which meant mock mode accepted a request the live client
 * would have completed differently — the two behaving differently is how a
 * mock stops being evidence about the real thing.
 *
 * `sibling` is a comment Onshape itself placed on the same object. Its code is
 * observed rather than inferred, so it wins.
 */
export function resolveTaskCommentContext(
  ctx: {
    objectType?: number | null;
    documentId?: string;
    workspaceId?: string;
    versionId?: string;
    elementId?: string;
  },
  sources: {
    sibling?: {
      objectType?: number | null;
      documentId?: string;
      workspaceId?: string;
      versionId?: string;
      elementId?: string;
    } | null;
    task?: {
      documentId?: string;
      workspaceId?: string | null;
      versionId?: string | null;
      elementId?: string;
    } | null;
  } = {}
): {
  objectType: number;
  documentId: string;
  workspaceId: string;
  versionId: string;
  elementId: string;
  inferredType: boolean;
} {
  const { sibling, task } = sources;

  let objectType = ctx.objectType ?? sibling?.objectType ?? null;
  let inferredType = false;
  if (objectType == null) {
    const t = taskCommentObjectType();
    objectType = t.code;
    inferredType = t.inferred;
  }

  return {
    objectType,
    inferredType,
    documentId: ctx.documentId || sibling?.documentId || task?.documentId || "",
    workspaceId: ctx.workspaceId || sibling?.workspaceId || task?.workspaceId || "",
    versionId: ctx.versionId || sibling?.versionId || task?.versionId || "",
    elementId: ctx.elementId || sibling?.elementId || task?.elementId || "",
  };
}
