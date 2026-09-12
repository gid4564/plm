import type { BomTable } from "./bom";
import type { ExportFormat } from "./export-formats";
import type { MassProperties } from "./mass-properties";

/** Stable identity of a part inside Onshape. */
export type PartCoords = {
  documentId: string;
  elementId: string;
  partId: string;
  configuration?: string;
  /** Context for building URLs; not part of identity. */
  workspaceId?: string | null;
  versionId?: string | null;
};

/** One enterprise custom-property definition. */
export type PropertyDef = {
  propertyId: string;
  name: string;
  valueType: string;      // STRING | ENUM | BOOL | INT | DOUBLE | DATE ...
  /** Options whose stored value is the label itself. */
  enumValues?: string[];
  /**
   * Options as Onshape returns them for a coded enum: the value stored on the
   * part is the `value`, and the `label` is what a person reads. State is the
   * one that matters — Onshape stores it as an integer.
   */
  enumOptions?: { value: unknown; label: string }[];
  builtIn?: boolean;
};

/** Part metadata as PLM cares about it. */
export type PartMetadata = {
  coords: PartCoords;
  documentName: string;
  elementName: string;
  partName: string;
  partNumber: string;
  revision: string;
  description: string;
  material: string;
  state: string;
  vendor: string;
  project: string;
  /** propertyId -> value, verbatim. */
  raw: Record<string, unknown>;
  /**
   * Property definitions as reported on this part.
   *
   * Onshape returns name alongside propertyId on every metadata response, which
   * makes a real part the most reliable source of the enterprise's custom
   * property ids — there is no dependably documented company-level schema
   * endpoint.
   */
  definitions: PropertyDef[];
  /** Every property Onshape returned, name and value intact, for diagnostics. */
  properties: { propertyId: string; name: string; value: unknown }[];
};

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export type OnshapeUser = {
  id: string;
  email: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  /** The enterprise's own vanity URL (e.g. https://acme.onshape.com), if it has one. */
  companyDomain: string | null;
};

export type WebhookRegistration = {
  id: string;
  /** Events Onshape echoed back, which may be fewer than were requested. */
  events: string[];
};

export type WebhookSummary = {
  id: string;
  url: string;
  events: string[];
};

/**
 * Everything PLM needs from Onshape. The mock and live implementations are
 * interchangeable; nothing above this interface knows which one is in play.
 */
export type Thumbnail = {
  contentType: string;
  data: Buffer;
};

export type ElementPart = {
  partId: string;
  partNumber: string;
  name: string;
};

export type DocumentInfo = {
  name: string;
  /** Where writes must go: a version is immutable. */
  defaultWorkspaceId: string | null;
  /**
   * Why the document could not be read, when it could not be.
   *
   * A BOM can reference parts from documents the caller has no direct access
   * to — reachable through the version the assembly pins, but not openable in
   * their own right. Without the reason, that is indistinguishable from a
   * document that simply has no default workspace.
   */
  accessError: string | null;
  /**
   * Whether this account may write to the document. null when Onshape did not
   * say, in which case callers should try and handle the refusal.
   *
   * Standard content — the library screws and washers Onshape supplies — lives
   * in a document everyone can read and nobody can write. It resolves to a
   * perfectly good default workspace, so a workspace alone is not evidence that
   * a write will be accepted.
   */
  canWrite: boolean | null;
};

/** An assembly tab, addressed for a BOM read. */
export type AssemblyCoords = {
  documentId: string;
  elementId: string;
  workspaceId?: string | null;
  versionId?: string | null;
  configuration?: string | null;
};

export type ElementInfo = {
  id: string;
  name: string;
  /** PARTSTUDIO | ASSEMBLY | DRAWING | BLOB | ... */
  elementType: string;
};

/** A part exported to a neutral CAD format. */
export type PartExport = {
  data: Buffer;
  contentType: string;
  /** How Onshape produced it, for the audit trail. */
  via: "direct" | "translation";
  /** Present when a translation job was used; useful when one goes wrong. */
  translationId?: string;
  elapsedMs: number;
};

/* -------------------------------------------------------------------------- */
/* Release management                                                          */
/*                                                                            */
/* Shapes here follow Onshape's release-package API as far as it is publicly   */
/* documented. Two things are deliberately modelled as data rather than        */
/* assumed in code:                                                           */
/*                                                                            */
/*  - `availableActions` — which transitions a package currently offers. Only  */
/*    REASSIGN_TASK is confirmed in Onshape's changelog; the approve and       */
/*    reject action names come from the tenant's own workflow JSON, so they    */
/*    are read off the package rather than hard-coded. See docs/ONSHAPE-       */
/*    INTEGRATION-SPEC.md, unknown U2.                                        */
/*  - `raw` — the whole response, kept because this part of the API is thinly  */
/*    documented and a field we did not know to look for is otherwise lost.    */
/* -------------------------------------------------------------------------- */

/** One transition a release package currently offers. */
export type WorkflowAction = {
  /** The identifier the transition call needs. */
  id: string;
  /** Human label, when Onshape supplies one. */
  label: string;
  /**
   * The action's type as the workflow declares it — APPROVE, REJECT, SUBMIT,
   * REASSIGN_TASK and so on. This is what the release logic matches on, rather
   * than the id, because ids are per-tenant but the types are the workflow
   * vocabulary.
   */
  type: string;
  /**
   * Onshape's own conditions on who may perform this action.
   *
   * Needed because Onshape *lists* an action it will not perform for the
   * calling account, then accepts the POST and ignores it — no error, no state
   * change. `isApproverAction` with neither override means a designated
   * approver and nobody else, including the account that raised the package.
   * A live enterprise's RELEASE carries exactly that, while its REJECT carries
   * `isCreatorOverride: true` — which is why one would work and the other
   * silently would not.
   */
  isApproverAction?: boolean;
  allowIfNoApprovers?: boolean;
  alwaysAllow?: boolean;
  isAdminOverride?: boolean;
  isCreatorOverride?: boolean;
  /**
   * Package property ids this transition will not proceed without.
   *
   * Onshape's release-management guide is explicit that these have to be set in
   * the request body's `properties` array — the SUBMIT transition on the stock
   * workflow requires the Approvers property, for instance. An action whose
   * requirements are unmet is a transition that cannot succeed, and saying so
   * beats waiting for a state change that will never come.
   */
  requiredProperties?: string[];
};

/** One item inside a release package. */
export type ReleasePackageItem = {
  /** Onshape's id for the item within the package. */
  id: string;
  documentId: string;
  elementId: string;
  /** Empty for a drawing or an assembly tab: those are elements, not parts. */
  partId: string;
  /** PARTSTUDIO | ASSEMBLY | DRAWING */
  elementType: string;
  name: string;
  partNumber: string;
  /** Onshape's revision record id for this item, present from rel-1.192. */
  revisionId: string;
  /** The revision letter, once the release has completed. Empty before that. */
  revision: string;
  /** The version the release produced, needed to export the released drawing. */
  versionId: string;
};

export type ReleasePackage = {
  /** Release package id (rpid). */
  id: string;
  /** Workflow id (wfid) the package runs on. */
  workflowId: string;
  /** Onshape's state name, e.g. PENDING, RELEASED, REJECTED. */
  state: string;
  /** The caller-supplied tracking id, which is how PLM finds its own release. */
  changeOrderId: string;
  items: ReleasePackageItem[];
  /** Workflow properties, keyed by property id. */
  properties: Record<string, unknown>;
  availableActions: WorkflowAction[];
  /**
   * Who Onshape will let act on this package.
   *
   * Onshape lists an action it will not perform for the calling account and
   * then accepts the POST and ignores it, so without this there is no way to
   * tell "not permitted" from "still working on it".
   */
  permissions: {
    /** Onshape user ids designated as approvers on this package's state. */
    approverIds: string[];
    /** Whether the calling account raised the package. */
    isCreator: boolean;
    /** The account that raised it, when reported. */
    createdById: string;
  };
  /**
   * Onshape's account of the transition it is processing, if any.
   *
   * A live package carries this, and its presence is why a transition cannot be
   * assumed to have finished by the time the POST returns: it reports a
   * `summaryState`, the `lastStage` reached, and an `errorMessage` when a stage
   * fails. PLM used to ignore it entirely and treat the POST's own response as
   * the outcome.
   */
  transitionStatus: {
    summaryState: string;
    lastStage: string;
    errorMessage: string;
    sequenceNumber: number | null;
    lastUpdatedAt: string;
  }[];
  /** Onshape's own marker that a PLM system is handling this package. */
  syncedWithPLM: boolean;
  /** The complete response, for diagnosing a field this type does not cover. */
  raw: Record<string, unknown>;
};

/** The release workflow an enterprise releases through. */
export type ReleaseWorkflow = {
  id: string;
  name: string;
};

/** What PLM supplies when it raises a release package itself. */
export type CreateReleasePackageInput = {
  items: {
    documentId: string;
    elementId: string;
    partId?: string;
    revisionId?: string;
    versionId?: string;
    workspaceId?: string;
    /** Item property values, keyed by property id. */
    properties?: Record<string, unknown>;
  }[];
};

/*
 * `changeOrderId` deliberately absent.
 *
 * It used to be here, described as "PLM's own release number, so the package
 * can be traced back here" — but it is a **read-only** field: present on the
 * release package response and not on the create request. PLM was sending it
 * and Onshape was discarding it, so nothing was ever traceable that way.
 *
 * The link between a package and a PLM release is the package id, stored on
 * the release as `onshapeReleasePackageId` and indexed for the reverse lookup.
 * That has always been what actually did the work.
 */

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

/** One comment as Onshape reports it. */
export type OnshapeComment = {
  id: string;
  message: string;
  authorEmail: string;
  authorName: string;
  createdAt: string;
  /** Onshape's numeric object-type code, echoed so a reply can be addressed. */
  objectType: number | null;
  objectId: string;
  /*
   * The document a comment lives in.
   *
   * A comment is not a free-standing object: `createComment` is documented as
   * "Update a document with a new comment", and `getComments` is queried by
   * `did`. Kept so a new comment can be anchored the same way Onshape anchored
   * the ones it already has, rather than by guessing which ids matter.
   */
  documentId: string;
  workspaceId: string;
  versionId: string;
  elementId: string;
};

/** Where a comment is anchored, for posting a new one alongside. */
export type CommentContext = {
  objectType?: number | null;
  documentId?: string;
  workspaceId?: string;
  versionId?: string;
  elementId?: string;
};

/** An Onshape task, as PLM cares about it. */
/**
 * One row of `POST /tasks/find` — a search projection, deliberately not an
 * `OnshapeTask`.
 *
 * Only the fields PLM decides with are lifted. `taskType` is the one that
 * matters most: on a live tenant 143 of 174 rows were `RELEASE`, which are
 * release packages PLM already mirrors through its release module. Mixing
 * those into a task board buries the 31 real tasks.
 */
export type FoundTask = {
  id: string;
  name: string;
  /** `GENERAL`, `TODO` or `RELEASE`. */
  taskType: string;
  /** A display string here, not a workflow state — hence not `state`. */
  displayState: string;
  documentId: string;
};

export type OnshapeTask = {
  id: string;
  name: string;
  description: string;
  /** Display state where Onshape gives one. */
  state: string;
  /** Onshape's numeric status. An undocumented enum — kept, not interpreted. */
  status: number | null;
  taskType: string;
  documentId: string;
  documentName: string;
  elementId: string;
  workspaceId: string | null;
  versionId: string | null;
  /** The workflowable object the task concerns, when it concerns one. */
  objectId: string;
  creatorEmail: string;
  creatorName: string;
  assignees: { onshapeUserId: string; email: string; name: string; acted: boolean }[];
  resolvedAt: string | null;
  resolvedByEmail: string;
  items: {
    label: string;
    documentId: string;
    elementId: string;
    partId: string;
    elementType: string;
  }[];
  comments: OnshapeComment[];
  /** Transitions the calling account is offered, from the workflow snapshot. */
  availableActions: { id: string; label: string; type: string }[];
  /**
   * The task's metadata properties — where the interesting fields actually are.
   *
   * A task has no top-level due date or priority: they are properties, with
   * ids, types and their own editability, alongside Name, Description,
   * Category and the two states. They are written back through `updateTask`'s
   * `propertyValues`, and they are the difference between a task list and
   * something anybody would manage work in.
   */
  properties: {
    propertyId: string;
    name: string;
    value: unknown;
    valueType: string;
    editable: boolean;
    required: boolean;
    enumValues: { value: string; label: string }[];
  }[];
  /**
   * Whether a comment can be posted to Onshape for this task.
   *
   * Onshape's comments are document-scoped — `GET /comments` is queried by
   * `did` — and a GENERAL task belongs to no document. For such a task the
   * comment API answers 404 for a read and 400 for a write, whatever
   * objectType is offered. So PLM keeps the thread locally and says so rather
   * than failing on every comment.
   */
  commentable: boolean;
  /**
   * Whether Onshape will delete this task outright.
   *
   * Onshape reports it per task, and it is not the same as being able to
   * *discard* one: a live task came back `deletable: false` with
   * `canBeDiscarded: true`, meaning the way to be rid of it is the workflow's
   * DISCARD transition rather than the delete endpoint. Both are offered, and
   * which applies is Onshape's call rather than PLM's.
   */
  deletable: boolean;
  raw: Record<string, unknown>;
};

/** A drawing tab, addressed for a PDF export. */
export type DrawingCoords = {
  documentId: string;
  elementId: string;
  workspaceId?: string | null;
  versionId?: string | null;
};

/** A file Onshape produced from an element. */
export type FileExport = {
  data: Buffer;
  contentType: string;
  /** How Onshape produced it, for the audit trail. */
  via: "direct" | "translation";
  /** Present when a translation job was used; useful when one goes wrong. */
  translationId?: string;
  elapsedMs: number;
};

export interface OnshapeClient {
  readonly mode: "mock" | "live";

  /** Identify what kind of tab an element is, before assuming it holds parts. */
  getElementInfo(coords: PartCoords): Promise<ElementInfo | null>;

  /**
   * Exploded bill of materials for an assembly.
   *
   * multiLevel walks subassemblies and rolls their quantities up, which is the
   * total a manufacturing order actually needs; the top-level-only view is
   * offered for assemblies that are bought or built as units.
   */
  getAssemblyBom(coords: AssemblyCoords, opts?: { multiLevel?: boolean }): Promise<BomTable>;

  /** Parts in an element, used to resolve a part number to a part id. */
  listElementParts(coords: PartCoords): Promise<ElementPart[]>;

  /** Document name and its default workspace. */
  getDocumentInfo(documentId: string): Promise<DocumentInfo>;

  /**
   * Export one part to a neutral CAD format.
   *
   * Some formats come straight off the part; the rest are produced by Onshape's
   * translation service, which is a job to be submitted and waited on. The
   * client hides that difference — callers ask for a format and get bytes.
   */
  exportPart(coords: PartCoords, format: ExportFormat): Promise<PartExport>;

  /** Mass, volume, surface area and centroid for one part. */
  getMassProperties(coords: PartCoords): Promise<MassProperties>;

  /** Rendered image of the part, or null when one cannot be produced. */
  getPartThumbnail(coords: PartCoords, size: number): Promise<Thumbnail | null>;

  getAuthenticatedUser(): Promise<OnshapeUser>;

  /** Enterprise custom-property definitions, used for name-based discovery. */
  listPropertyDefinitions(companyId: string): Promise<PropertyDef[]>;

  getPartMetadata(coords: PartCoords): Promise<PartMetadata>;

  /** Write propertyId -> value pairs onto a part. */
  updatePartProperties(coords: PartCoords, values: Record<string, unknown>): Promise<void>;

  registerWebhook(companyId: string, callbackUrl: string, events: string[]): Promise<WebhookRegistration>;
  /** Every webhook Onshape currently holds for this company. */
  listWebhooks(companyId: string): Promise<WebhookSummary[]>;
  unregisterWebhook(webhookId: string): Promise<void>;

  /* ----------------------------- Release management ---------------------- */

  /**
   * The release workflow this enterprise releases through.
   *
   * Needed before a package can be created or its transitions understood.
   * Returns null when the tenant has no custom workflow published, which is
   * a normal state and not an error — it just means releases cannot be taken
   * over yet.
   */
  getReleaseWorkflow(companyId: string): Promise<ReleaseWorkflow | null>;

  /** Read a release package, including the transitions it currently offers. */
  getReleasePackage(rpid: string): Promise<ReleasePackage>;

  /**
   * Perform a transition on a release package.
   *
   * `actionId` comes from the package's own availableActions — never from a
   * constant here. The tenant's workflow JSON decides what those are, and a
   * hard-coded "APPROVE" would work on one enterprise and fail silently on the
   * next. `properties` carries any workflow fields the transition requires,
   * such as the approver field an APPROVE transition reads.
   */
  transitionReleasePackage(
    rpid: string,
    actionId: string,
    opts?: { properties?: Record<string, unknown>; note?: string }
  ): Promise<ReleasePackage>;

  /** Raise a release package from PLM, rather than reacting to one. */
  createReleasePackage(wfid: string, input: CreateReleasePackageInput): Promise<ReleasePackage>;

  /**
   * Export a part or assembly as glTF (GLB), for the record kept at release.
   *
   * A part is synchronous — one GET returns the bytes. An assembly is a
   * translation job, and comes back through the same poll-and-collect path as
   * any other translation. Callers do not need to know which; they differ only
   * in how long they take.
   */
  exportGltf(coords: PartCoords, opts?: { isAssembly?: boolean }): Promise<FileExport>;

  /* ----------------------------------- Tasks ------------------------------ */

  /**
   * Tasks visible to the calling account.
   *
   * Onshape's own endpoint is `getActionItems` — "tasks assigned to the userId
   * specified" — and its documentation is explicit that **only a company admin
   * can see tasks they neither created nor were assigned**. So what PLM can
   * mirror depends on what its service account is; that is a setup fact, not a
   * bug, and it is surfaced rather than worked around.
   */
  listTasks(opts?: {
    userId?: string;
    documentId?: string;
    status?: number;
    limit?: number;
    offset?: number;
  }): Promise<OnshapeTask[]>;

  /**
   * Every task in the enterprise, not only the caller's own.
   *
   * `POST /tasks/find` — `findTasks`, marked `x-BTVisibility: INTERNAL` and so
   * absent from the anonymous OpenAPI definition. It exists because
   * `getActionItems` answers a narrower question than a task board asks: on
   * the tenant this was built against it returned 8 tasks where `find`
   * returned 174.
   *
   * Three things about it are worth stating, because none are guessable:
   *
   *  - Paging is in the BODY (`from`, `size`), not the query. The `next` URL
   *    Onshape returns carries `offset`/`limit`, and both are IGNORED — a
   *    `limit=5` came back with 40 rows, and `offset=5` came back with the
   *    same rows as `offset=0`. Following that URL silently re-reads page one
   *    for ever.
   *  - The rows are a SEARCH PROJECTION, not `BTTaskInfo`: `taskItems` in
   *    place of `items`, `state` as a display string, and no `workflowInfo` at
   *    all. So the ids are what this is for; the task itself is then read with
   *    `getTask`, which keeps one parser rather than two.
   *  - `BTTaskSearchRequestParams.query` is self-referential in the definition
   *    (`{empty, field, querySupplier: Query}`) and cannot be constructed from
   *    it. It is left unsent: an empty body returns everything, which is what
   *    PLM wants anyway.
   *
   * Callers get raw rows rather than tasks, since a projection promoted to a
   * task would claim a state and a set of transitions it does not carry.
   */
  findTasks(opts?: { from?: number; size?: number }): Promise<FoundTask[]>;

  getTask(taskId: string): Promise<OnshapeTask>;

  /**
   * Perform a workflow transition on a task.
   *
   * The transition goes in the PATH — `POST /tasks/{tid}/{transition}` — and
   * the value is an action's `action` field from the task's own workflow
   * snapshot, not its `type`. The two differ, and that difference cost a day
   * on release packages.
   */
  transitionTask(taskId: string, transition: string): Promise<OnshapeTask>;

  /** Change a task's name or description. */
  updateTask(
    taskId: string,
    patch: {
      name?: string;
      description?: string;
      /** Property id -> value, for the metadata properties a task carries. */
      propertyValues?: Record<string, unknown>;
    }
  ): Promise<OnshapeTask>;

  /**
   * Comment on a task.
   *
   * Comments are not part of the task update body — they have their own
   * endpoint, and a comment is addressed by the object it is on plus that
   * object's numeric type code. The code is undocumented, so it is read off an
   * existing comment where there is one rather than assumed.
   */
  commentOnTask(
    taskId: string,
    message: string,
    opts?: CommentContext
  ): Promise<OnshapeComment>;

  /**
   * Delete a task in Onshape.
   *
   * `DELETE /tasks/{tid}` — `deleteTask`, tid in the path and no body. Absent
   * from the anonymous OpenAPI definition but present in the authenticated
   * one, which is why it reads as unpublished.
   *
   * Irreversible, and separate from removing PLM's copy: one is Onshape's
   * record, the other is a row in a mirror.
   */
  deleteTask(taskId: string): Promise<void>;

  /**
   * Lightweight state check on any workflow object.
   *
   * Onshape added this as an explicit alternative to re-reading a whole release
   * package just to see where it is, so it is what the post-release poll uses.
   */
  getWorkflowObjectState(objectId: string): Promise<string>;

  /* --------------------------------- Drawings ---------------------------- */

  /** Every tab in a document, used to find the drawings belonging to a part. */
  listElements(coords: { documentId: string; workspaceId?: string | null; versionId?: string | null }): Promise<ElementInfo[]>;

  /**
   * Export a drawing to PDF.
   *
   * Asynchronous, like a part translation: submit, poll, fetch. Which
   * workspace or version is addressed decides what comes back — the same sheet
   * exported from a workspace has no revision or watermark, and exported from
   * the version a release produced has both.
   */
  exportDrawingPdf(coords: DrawingCoords): Promise<FileExport>;
}
