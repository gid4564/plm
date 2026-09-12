import mongoose, { Schema, model, models, type InferSchemaType } from "mongoose";

/* -------------------------------------------------------------------------- */
/* Enterprise — one row per Onshape enterprise/company this PLM serves.        */
/* -------------------------------------------------------------------------- */

const EnterpriseSchema = new Schema(
  {
    // Onshape company/enterprise id. This is the tenant key for everything else.
    onshapeCompanyId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    // e.g. "acme" for https://acme.onshape.com
    onshapeDomain: { type: String, default: "" },

    /** Which PLM user's Onshape tokens are used for background writes. */
    integrationUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },

    /**
     * Onshape custom-property definitions as last discovered.
     *
     * Cached rather than read on demand because the attribute-mapping screen
     * needs the whole list to populate its dropdowns, and Onshape has no
     * dependably documented company-level schema endpoint — the list is
     * assembled from /metadataschema plus whatever a sample part reports.
     */
    onshapePropertyDefs: {
      type: [{ propertyId: String, name: String, valueType: String, enumValues: [String] }],
      default: [],
    },
    onshapePropertyDefsCheckedAt: { type: Date, default: null },

    /**
     * The Onshape release workflow this enterprise releases through.
     *
     * Needed to create a release package, and to know which transitions exist
     * on it. Discovered from the company's policies; stored because the id is
     * stable and every release call needs it.
     */
    onshapeReleaseWorkflowId: { type: String, default: null },
    onshapeReleaseWorkflowName: { type: String, default: "" },

    /**
     * Whether PLM takes over releases started in Onshape.
     *
     * Off by default, and deliberately so — the same reasoning MOS applies to
     * release enrolment, but with higher stakes. Switched on, PLM begins
     * approving and rejecting real release packages on a shared tenant. That
     * has to be somebody's explicit decision, not a default.
     *
     * Enforced when the event arrives rather than by unsubscribing, so the
     * switch takes effect immediately and a failed re-registration cannot
     * leave the enterprise silently unsubscribed.
     */
    releaseTakeoverEnabled: { type: Boolean, default: false },

    /**
     * Capture a glTF of every part when a release completes.
     *
     * Off by default. It is an extra Onshape call per released item and it
     * stores a binary per revision, so it is a deliberate choice rather than
     * something that starts happening to a tenant on upgrade.
     *
     * Taken at the version the release produced, so what is stored is the
     * geometry as released — the point of keeping it at all.
     */
    releaseGltfEnabled: { type: Boolean, default: false },

    /** Release packages ignored while the switch was off, so the cost of enabling is visible. */
    releasesIgnored: { type: Number, default: 0 },
    lastReleaseIgnoredAt: { type: Date, default: null },

    /**
     * Collapse every configuration of a part into one PLM part.
     *
     * Onshape supplies the configuration string inconsistently — a panel
     * launch, a webhook and a manual sync can each report it differently for
     * the very same part, and because configuration is part of the identity key
     * that produces duplicate records with separate part numbers.
     *
     * Default on. Turn it off only if you genuinely need a distinct PLM part
     * per configuration.
     */
    ignoreConfigurations: { type: Boolean, default: true },

    webhookId: { type: String, default: null },
    webhookRegisteredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* User — local login, bound to exactly one enterprise.                        */
/*                                                                            */
/* Local accounts are kept rather than delegating sign-in to Onshape, because  */
/* a PLM approver is not necessarily an Onshape user: reviewing a release is   */
/* precisely the job someone without a CAD seat is likely to hold.             */
/* -------------------------------------------------------------------------- */

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: "" },

    /**
     * admin  — configures attributes, mapping, and the Onshape connection
     * approver — may approve or reject a release
     * user   — may sync parts and submit releases
     *
     * Separate from Onshape's own approver designation: Onshape decides who may
     * transition a release package there, PLM decides who may decide here.
     */
    role: { type: String, enum: ["admin", "approver", "user"], default: "user" },

    /*
     * The product this person is currently working in.
     *
     * Stored on the user rather than in the browser because it is not only a
     * view preference: a part synced from the panel is filed into it, so it
     * decides where new work lands. That has to be the same answer on their
     * laptop as on their desk machine, and has to be readable by the server
     * doing the filing.
     */
    currentProductId: { type: Schema.Types.ObjectId, ref: "Product", default: null },

    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },

    // Onshape OAuth linkage — PLM as OAuth *client*, for its own outbound reads
    // and writes. Distinct from the OAuth server models further down, which is
    // how Onshape authenticates itself when calling *us*.
    onshapeUserId: { type: String, default: null, index: true },
    /*
     * Who these tokens actually authenticate as, in Onshape's terms.
     *
     * Not the same person as the PLM account holding them, and the difference
     * is the point: to have PLM act as a dedicated Onshape service user, a PLM
     * user connects while their browser is signed in to Onshape as that
     * account. Storing only the id made that indistinguishable from connecting
     * your own account — the service-account picker could label candidates
     * only by their PLM login, which says nothing about which Onshape identity
     * would execute a release.
     */
    onshapeEmail: { type: String, default: null },
    onshapeName: { type: String, default: null },
    onshapeAccessToken: { type: String, default: null },
    onshapeRefreshToken: { type: String, default: null },
    onshapeTokenExpiresAt: { type: Date, default: null },
    onshapeConnectedAt: { type: Date, default: null },
    /*
     * Set when a token refresh has failed, cleared when one succeeds.
     *
     * Without it a dead connection still reads as "Connected" — the timestamp
     * above only records that it once worked. On the webhook path nobody sees
     * the failure, so syncing stops with the UI insisting everything is fine,
     * which is how it went unnoticed.
     */
    onshapeTokenFailedAt: { type: Date, default: null },
    onshapeTokenError: { type: String, default: null },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The PLM lifecycle every revisable object moves through.
 *
 * Fixed rather than configurable: the release flow is a single review step, and
 * the attribute metamodel already references these states by name in its
 * editability rules. Making the state list configurable too would mean every
 * attribute definition needed migrating whenever someone renamed a state.
 */
export const LIFECYCLE_STATES = [
  "In Work",
  "Under Review",
  "Approved",
  "Released",
  "Obsolete",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/* -------------------------------------------------------------------------- */
/* AttributeDefinition — the configurable metamodel.                           */
/*                                                                            */
/* This is what makes PLM attributes behave like PLM attributes rather than    */
/* like a bag of mirrored CAD properties: each one declares its type, whether  */
/* it is required to release, when it may be edited, whether it freezes at     */
/* release, and which system is allowed to change it.                          */
/* -------------------------------------------------------------------------- */

const AttributeDefinitionSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },

    /** Which object type this attribute belongs to. */
    objectType: { type: String, enum: ["PART", "DRAWING"], required: true },

    /**
     * Stable machine key, e.g. "material". Values are stored against this on
     * the object, so it is never renamed — the label is what changes when
     * someone wants different wording.
     */
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    dataType: {
      type: String,
      enum: ["STRING", "TEXT", "NUMBER", "INTEGER", "BOOLEAN", "DATE", "ENUM"],
      required: true,
    },
    /** Permitted values, for ENUM. Order is the order shown. */
    enumValues: { type: [String], default: [] },
    /** Unit of measure shown beside a NUMBER/INTEGER, e.g. "kg", "mm". Display only. */
    unit: { type: String, default: "" },
    defaultValue: { type: Schema.Types.Mixed, default: null },

    /* ---------------------------- PLM behaviours ---------------------------- */

    /** Must hold a value at all times, including while In Work. */
    required: { type: Boolean, default: false },

    /**
     * Must hold a value before the object may be submitted for release.
     *
     * The distinction from `required` is the whole point of having both: a
     * designer needs to be able to save a half-finished part, but a released
     * part with no material is a defect that PLM exists to prevent.
     */
    requiredForRelease: { type: Boolean, default: false },

    /**
     * States in which this attribute may be edited. Empty means every state.
     *
     * Expressed as a list rather than a single "locked" flag because real
     * governance is state-dependent: a due date may be editable Under Review
     * while the material is not.
     */
    editableInStates: { type: [String], default: [] },

    /**
     * Once released, the value can never change again on that revision.
     *
     * Stronger than editableInStates, and kept separate from it: the iteration
     * snapshot is what preserves the released value, so this flag is about
     * whether the *current* record may drift away from what was approved.
     */
    frozenAtRelease: { type: Boolean, default: false },

    /* --------------------------- Onshape mapping ---------------------------- */

    /**
     * Which system is the author of this attribute.
     *
     * "onshape" — a mirror of a CAD property; PLM shows it and does not invent it.
     * "plm"     — PLM's own data, with no CAD equivalent (owner, effectivity,
     *             classification). Onshape may still receive it, if a property
     *             has been set aside to hold it.
     */
    owner: { type: String, enum: ["plm", "onshape"], default: "onshape" },

    /**
     * The Onshape property this maps to.
     *
     * Held as id *and* name. The id is what the API needs; the name is what
     * makes a mapping that has silently broken — a property deleted and
     * recreated in Onshape gets a new id — legible to whoever has to fix it.
     */
    onshapePropertyId: { type: String, default: "" },
    onshapePropertyName: { type: String, default: "" },

    /**
     * Which way values move.
     *
     * "none"         — PLM-only, never touches Onshape
     * "from-onshape" — read on sync, never written back
     * "to-onshape"   — pushed out, never read in
     * "both"         — read and written, with `authority` breaking ties
     */
    syncDirection: {
      type: String,
      enum: ["none", "from-onshape", "to-onshape", "both"],
      default: "from-onshape",
    },

    /**
     * Who wins when both sides changed since the last sync.
     *
     * Only consulted for syncDirection "both". Without it, a bidirectional
     * attribute has no defined behaviour on conflict, which in practice means
     * whichever sync ran last silently overwrites the other system.
     */
    authority: { type: String, enum: ["plm", "onshape"], default: "onshape" },

    /** Sort order on forms and tables. */
    order: { type: Number, default: 100 },
    /** Grouping heading on the object page, e.g. "Identification", "Physical". */
    group: { type: String, default: "" },

    /**
     * Seeded with the enterprise and not deletable.
     *
     * The demo has to open with something to show, and a handful of attributes
     * (number, name, description, material) are assumed by the sync code
     * itself. Marking them rather than hard-coding them keeps them visible and
     * editable in the same table as everything else.
     */
    system: { type: Boolean, default: false },
  },
  { timestamps: true }
);
AttributeDefinitionSchema.index({ enterpriseId: 1, objectType: 1, key: 1 }, { unique: true });

/* -------------------------------------------------------------------------- */
/* Part — the PLM record for one Onshape part or assembly.                     */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Task — an Onshape task, mirrored and worked on in PLM.                     */
/* -------------------------------------------------------------------------- */

/**
 * One comment on a task.
 *
 * Embedded rather than its own collection: comments are read only with their
 * task, there are few of them, and a thread that arrives in one document
 * cannot be half-loaded.
 *
 * `onshapeCommentId` is what makes the sync idempotent — Onshape returns the
 * whole thread on every read, so a comment already held must be recognised
 * rather than appended again. A comment written in PLM has no id until Onshape
 * accepts it, which is also how an unsent one is identified.
 */
const TaskCommentSchema = new Schema(
  {
    onshapeCommentId: { type: String, default: null, index: true },
    message: { type: String, required: true },
    authorEmail: { type: String, default: "" },
    authorName: { type: String, default: "" },
    /** Which side it was written on, so the thread can say so. */
    origin: { type: String, enum: ["onshape", "plm"], default: "onshape" },
    createdAt: { type: Date, default: Date.now },
    /** Set when PLM wrote it and Onshape has not accepted it yet. */
    pushPending: { type: Boolean, default: false },
    pushError: { type: String, default: null },
    /**
     * Set when the comment will never go to Onshape.
     *
     * Distinct from `pushPending`: pending means "not yet", this means "not
     * possible" — the task is attached to no Onshape document, and Onshape's
     * comments are document-scoped. Marking it keeps the thread honest without
     * implying a retry will help.
     */
    plmOnly: { type: Boolean, default: false },
  },
  { _id: true }
);

const TaskSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },

    /** Onshape's task id — the identity, since PLM never originates a task. */
    onshapeTaskId: { type: String, required: true, index: true },

    name: { type: String, default: "" },
    description: { type: String, default: "" },

    /*
     * Onshape's state, and the transitions it currently offers.
     *
     * Held rather than recomputed because the task list shows both, and
     * re-reading every task from Onshape to draw a board would spend a tenant's
     * rate limit on a page view. Refreshed whenever a task is read or a
     * webhook arrives.
     */
    state: { type: String, default: "" },
    status: { type: Number, default: null },
    taskType: { type: String, default: "" },
    /*
     * The transitions Onshape currently offers, as {id, label, type}.
     *
     * `type` has to be written as `{ type: String }` here: Mongoose treats a
     * bare `type` key as the field's own type declaration, so
     * `{ id: String, label: String, type: String }` is read as "this field is
     * a String" and the whole subdocument collapses. It fails at cast time with
     * a message about `[string]` that says nothing about the cause.
     */
    availableActions: {
      type: [{
        _id: false,
        id: String,
        label: String,
        type: { type: String },
      }],
      default: [],
    },

    /** Where in Onshape it points, when it points anywhere. */
    documentId: { type: String, default: "" },
    documentName: { type: String, default: "" },
    elementId: { type: String, default: "" },
    workspaceId: { type: String, default: null },
    versionId: { type: String, default: null },
    /** The workflowable object the task is about, e.g. a release package. */
    objectId: { type: String, default: "" },

    creatorEmail: { type: String, default: "" },
    creatorName: { type: String, default: "" },
    /** Everyone Onshape lists on the task, by email where it gave one. */
    assignees: {
      type: [{ _id: false, onshapeUserId: String, email: String, name: String, acted: Boolean }],
      default: [],
    },

    resolvedAt: { type: Date, default: null },
    resolvedByEmail: { type: String, default: "" },

    /*
     * PLM parts the task's items resolve to.
     *
     * Onshape's taskItems name documents, elements and parts; the ones PLM
     * already tracks become links, and the rest are kept as labels so the task
     * still says what it is about.
     */
    items: {
      type: [{
        _id: false,
        partId: { type: Schema.Types.ObjectId, ref: "Part", default: null },
        label: String,
        documentId: String,
        elementId: String,
        onshapePartId: String,
      }],
      default: [],
    },

    /** Onshape's metadata properties, as read — the editable ones are the UI. */
    properties: {
      type: [{
        _id: false,
        propertyId: String,
        name: String,
        value: Schema.Types.Mixed,
        valueType: { type: String },
        editable: Boolean,
        required: Boolean,
        enumValues: [{ _id: false, value: String, label: String }],
      }],
      default: [],
    },
    /**
     * Whether Onshape will accept a comment on this task.
     *
     * False for a task attached to no document: Onshape's comments are
     * document-scoped, so there is nowhere to post one. PLM keeps the thread
     * locally and says so rather than failing on every comment.
     */
    commentable: { type: Boolean, default: false },
    /** Whether Onshape will delete it outright — its answer, not PLM's. */
    deletable: { type: Boolean, default: false },

    comments: { type: [TaskCommentSchema], default: [] },

    lastSyncedFromOnshapeAt: { type: Date, default: null },
    /** Set when a PLM-side action has not reached Onshape yet. */
    pushPending: { type: Boolean, default: false },
    lastPushError: { type: String, default: null },
    /** The whole payload, for diagnosing a field this schema does not cover. */
    raw: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);
TaskSchema.index({ enterpriseId: 1, onshapeTaskId: 1 }, { unique: true });
TaskSchema.index({ enterpriseId: 1, state: 1 });

/* -------------------------------------------------------------------------- */
/* Product — what a part is part of.                                          */
/* -------------------------------------------------------------------------- */

/**
 * A product every part and assembly belongs to.
 *
 * PLM's own concept, not Onshape's: Onshape organises by document, which is a
 * container for CAD, not a statement about what is being built. A product is
 * the grouping people actually work in — "the pump", "the Mk2 chassis" — and
 * one part can outlive several of them.
 */
const ProductSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
    name: { type: String, required: true, trim: true },
    /*
     * Case- and whitespace-collapsed form used for matching.
     *
     * Without it "Bracket Kit", "bracket kit" and "Bracket  Kit " fork into
     * three products the first time somebody's capitalisation slips — and a
     * product list nobody can untangle is worse than no grouping at all.
     */
    nameLower: { type: String, required: true, index: true },
    description: { type: String, default: "" },
    /** Optional short code for a product, e.g. "PMP" — free text, not issued. */
    code: { type: String, default: "" },
    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
ProductSchema.index({ enterpriseId: 1, nameLower: 1 }, { unique: true });

const PartSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },

    /*
     * Onshape identity. documentId+elementId+partId+configuration is the stable
     * key — part *numbers* and names are user-editable and cannot be trusted as
     * identity, even though PLM is the one issuing the numbers.
     */
    documentId: { type: String, required: true },
    elementId: { type: String, required: true },
    /**
     * Empty for an assembly. An assembly is an element, not a part inside one,
     * so there is no partId to key it by — and the identity index below still
     * distinguishes it, because its elementId is its own.
     */
    partId: { type: String, default: "" },
    configuration: { type: String, default: "default" },

    /*
     * Where to read, and where to write. Not part of identity.
     *
     * Deliberately separate. A released part belongs to the version the release
     * produced, while the workspace holds whatever is being worked on now.
     * Reads come from versionId when it is set; writes always go to
     * workspaceId, because a version is immutable.
     */
    workspaceId: { type: String, default: null },
    versionId: { type: String, default: null },
    documentName: { type: String, default: "" },
    elementName: { type: String, default: "" },

    /**
     * Part or assembly.
     *
     * One type with a discriminator rather than two collections: they carry the
     * same attributes, sit in the same lifecycle, and appear in the same BOM
     * structure on both sides of the link. The only real difference is that an
     * assembly has children.
     */
    kind: { type: String, enum: ["part", "assembly"], default: "part", index: true },

    /*
     * The product this part belongs to.
     *
     * Every part has one. Rather than allow null and special-case "no product"
     * at every filter, count and picker, an "Unassigned" product is an ordinary
     * product created on demand — see lib/products.ts. Nullable in the schema
     * only so rows that predate this field can be read and backfilled; nothing
     * writes null deliberately.
     */
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null, index: true },
    /*
     * Denormalised for display and grouping.
     *
     * A parts list shows the product name on every row, and the dashboard's
     * per-product counts are one aggregation over this collection. Both would
     * otherwise need a join per page. Renaming a product rewrites this, which
     * is the cost of the arrangement and is handled in lib/products.ts.
     */
    productName: { type: String, default: "" },

    /* ------------------------------ PLM identity ---------------------------- */

    /**
     * The PLM part number. PLM is the master: this is issued here, then written
     * to Onshape — including through Onshape's own part number generator
     * extension when someone opens the Release candidate dialog.
     */
    number: { type: String, default: null, index: true },
    name: { type: String, default: "" },

    lifecycleState: { type: String, enum: LIFECYCLE_STATES, default: "In Work", index: true },

    /**
     * The revision letter, owned by Onshape.
     *
     * Empty until the first release. Onshape's release workflow decides the
     * scheme (alphabetical, numeric, or custom) and assigns the value; PLM
     * records what it was told. Two systems generating revision identifiers
     * independently is how they end up disagreeing.
     */
    revision: { type: String, default: "" },

    /**
     * The PLM iteration counter, owned by PLM.
     *
     * Increments every time a sync brings in a real change while the part is
     * pre-release. This is the pre-release history Onshape does not keep for
     * a workspace — it has microversions, but nothing a reviewer can read.
     * Displayed with the revision once there is one: "A.3".
     */
    iteration: { type: Number, default: 1 },

    /**
     * Attribute values, keyed by AttributeDefinition.key.
     *
     * Mixed rather than typed because the schema is defined at runtime by the
     * metamodel. Validation happens on write against the definitions, which is
     * the only place that knows what the types currently are.
     */
    attributes: { type: Schema.Types.Mixed, default: {} },

    /**
     * Every property Onshape returned, name and value intact.
     *
     * `value` is what a person reads; `raw` is what Onshape actually sent; and
     * `options` is the choice list an enum value indexes into. All three are
     * kept because a label that resolved wrongly looks entirely correct on its
     * own — the code and the option list beside it are what make the mistake
     * visible. An unmapped property shows here rather than vanishing.
     */
    onshapeProperties: {
      type: [{
        propertyId: String,
        name: String,
        value: Schema.Types.Mixed,
        raw: Schema.Types.Mixed,
        options: { type: Schema.Types.Mixed, default: undefined },
      }],
      default: [],
    },
    /** Onshape's own lifecycle state, mirrored for comparison against ours. */
    onshapeState: { type: String, default: "" },

    /** The open release this part is part of, if any. */
    releaseId: { type: Schema.Types.ObjectId, ref: "Release", default: null, index: true },

    createdByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    createdByEmail: { type: String, default: null },

    // Sync bookkeeping
    firstSyncedAt: { type: Date, default: null },
    lastSyncedFromOnshapeAt: { type: Date, default: null },
    lastPushedToOnshapeAt: { type: Date, default: null },
    /** A write to Onshape is outstanding and might yet succeed. */
    pushPending: { type: Boolean, default: false },

    /**
     * Why this part can never be written back to, when it cannot.
     *
     * Kept apart from pushPending because the two mean opposite things to
     * whoever is reading the list. "Pending" says someone should look into it;
     * this says nothing is wrong and nothing will change — the part lives in
     * standard content, or in a document this enterprise cannot write to.
     *
     * Mutually exclusive with pushPending: a blocked part is never also
     * pending, and a successful write clears it.
     */
    writeBackBlocked: { type: String, default: null },
    lastPushError: { type: String, default: null },
  },
  { timestamps: true }
);

// One PLM part per Onshape part per enterprise.
PartSchema.index(
  { enterpriseId: 1, documentId: 1, elementId: 1, partId: 1, configuration: 1 },
  { unique: true }
);
// Supports the parts list's cursor pagination: scoped to one enterprise,
// sorted newest-updated-first.
PartSchema.index({ enterpriseId: 1, updatedAt: -1 });

/* -------------------------------------------------------------------------- */
/* PartIteration — the pre-release history.                                    */
/*                                                                            */
/* One snapshot per iteration, so "what did this look like when it was         */
/* approved" and "what changed between .2 and .3" are answerable. Onshape      */
/* keeps microversions, but nothing a reviewer can read or a release can cite. */
/* -------------------------------------------------------------------------- */

const PartIterationSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
    partId: { type: Schema.Types.ObjectId, ref: "Part", required: true, index: true },

    iteration: { type: Number, required: true },
    /** Stamped when a release completes and Onshape reports the letter it assigned. */
    revision: { type: String, default: "" },
    lifecycleState: { type: String, enum: LIFECYCLE_STATES, required: true },

    /** Attribute values as they stood at this iteration. */
    attributes: { type: Schema.Types.Mixed, default: {} },
    /** The Onshape version this iteration was read from, when there was one. */
    onshapeVersionId: { type: String, default: null },

    /** What caused the iteration: sync | edit | release. */
    cause: { type: String, default: "sync" },
    /** Which attribute keys actually changed, so a diff needs no recomputation. */
    changedKeys: { type: [String], default: [] },

    createdByEmail: { type: String, default: null },
    releaseId: { type: Schema.Types.ObjectId, ref: "Release", default: null },
  },
  { timestamps: true }
);
PartIterationSchema.index({ enterpriseId: 1, partId: 1, iteration: -1 }, { unique: true });

/* -------------------------------------------------------------------------- */
/* BomLink — one parent/child edge of the product structure.                   */
/*                                                                            */
/* A real edge collection rather than an array embedded on the parent, because */
/* PLM has to answer "where is this used" as cheaply as "what is in this" —    */
/* and a where-used query over embedded arrays across every assembly is        */
/* exactly the query that gets slow first.                                     */
/* -------------------------------------------------------------------------- */

const BomLinkSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
    parentId: { type: Schema.Types.ObjectId, ref: "Part", required: true, index: true },
    childId: { type: Schema.Types.ObjectId, ref: "Part", required: true, index: true },

    quantity: { type: Number, default: 1 },
    /** Find number / item number as the CAD BOM reported it, when it did. */
    findNumber: { type: String, default: "" },

    /*
     * Effectivity of this component *in this assembly*, which is a different
     * question from whether the part itself is current.
     *
     * A substitution needs both parts to stay valid: the old bolt is still a
     * perfectly good part, it is simply no longer what this assembly uses after
     * a date. Part-level effectivity cannot say that — retiring the part would
     * remove it from every other assembly too.
     *
     * Open at both ends, like the part's own: empty `from` means this component
     * always has been in the assembly, empty `to` means it still is. Both empty
     * is the normal case, which is why an empty end must never read as a closed
     * boundary.
     *
     * PLM's own, never Onshape's — a CAD BOM has no notion of a date — so a
     * re-import must leave these alone. See the `$set` in lib/bom-import.ts,
     * which names its fields for that reason.
     */
    effectiveFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },

    /** Which Onshape assembly tab this edge was read from. Provenance only. */
    sourceDocumentId: { type: String, default: "" },
    sourceElementId: { type: String, default: "" },
    lastImportedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
BomLinkSchema.index({ enterpriseId: 1, parentId: 1, childId: 1 }, { unique: true });

/* -------------------------------------------------------------------------- */
/* Drawing — a drawing document, and the versioned PDFs it holds.              */
/* -------------------------------------------------------------------------- */

const DrawingSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },

    // Onshape identity. A drawing is a tab, so there is no partId in the key.
    documentId: { type: String, required: true },
    elementId: { type: String, required: true },
    workspaceId: { type: String, default: null },
    versionId: { type: String, default: null },
    documentName: { type: String, default: "" },
    elementName: { type: String, default: "" },

    number: { type: String, default: null, index: true },
    name: { type: String, default: "" },

    lifecycleState: { type: String, enum: LIFECYCLE_STATES, default: "In Work", index: true },
    revision: { type: String, default: "" },
    iteration: { type: Number, default: 1 },

    attributes: { type: Schema.Types.Mixed, default: {} },

    /**
     * The parts and assemblies this drawing documents.
     *
     * Populated from the release package, which is the only place that reliably
     * says which drawings belong to which items — Onshape adds active drawings
     * to a package itself, so the association arrives for free at exactly the
     * moment it matters.
     */
    partIds: { type: [{ type: Schema.Types.ObjectId, ref: "Part" }], default: [], index: true },

    /** The PDF a person should be looking at now. */
    currentFileId: { type: Schema.Types.ObjectId, ref: "DrawingFile", default: null },

    releaseId: { type: Schema.Types.ObjectId, ref: "Release", default: null, index: true },
  },
  { timestamps: true }
);
DrawingSchema.index({ enterpriseId: 1, documentId: 1, elementId: 1 }, { unique: true });

/**
 * One PDF of one drawing, at one point in the release.
 *
 * Both the as-submitted and the as-released sheet are kept. They are genuinely
 * different documents: the submitted one is what the approvers actually looked
 * at, and the released one carries the revision, the watermark, and the
 * title-block fields Onshape only fills in once the release has completed.
 * Discarding the first would throw away the evidence of what was approved.
 *
 * Bytes live in the document, as thumbnails do. That caps a sheet at Mongo's
 * 16MB document limit, which is ample for a drawing PDF and avoids standing up
 * GridFS for a demo. A sheet that exceeds it is recorded as a failure with the
 * reason, rather than silently truncated.
 */
const DrawingFileSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
    drawingId: { type: Schema.Types.ObjectId, ref: "Drawing", required: true, index: true },

    /** 1, 2, 3 … within one drawing. */
    version: { type: Number, required: true },

    /**
     * Which side of the release this sheet came from.
     *
     * "as-submitted" — exported when the release was raised: no revision, no
     *                  watermark, title-block fields unfilled.
     * "as-released"  — exported after the release completed, from the version
     *                  the release produced. This is the controlled document.
     */
    stage: { type: String, enum: ["as-submitted", "as-released"], required: true },

    contentType: { type: String, default: "application/pdf" },
    data: { type: Buffer, default: null },
    size: { type: Number, default: 0 },

    /** The Onshape version the export was taken from. */
    onshapeVersionId: { type: String, default: null },
    /** The revision this sheet carries. Empty for as-submitted. */
    revision: { type: String, default: "" },
    releaseId: { type: Schema.Types.ObjectId, ref: "Release", default: null, index: true },

    /** Onshape's translation job, kept for when one goes wrong. */
    translationId: { type: String, default: null },
    fetchedAt: { type: Date, default: null },
    /** Set when the export could not be produced, so it is not retried on every view. */
    failedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true }
);
DrawingFileSchema.index({ enterpriseId: 1, drawingId: 1, version: -1 }, { unique: true });

/* -------------------------------------------------------------------------- */
/* PartGeometry — the 3D of a part, as it was released.                        */
/* -------------------------------------------------------------------------- */

/**
 * A glTF capture of one part at one revision.
 *
 * One row per (part, revision), which is what makes it a record rather than a
 * cache: revision B's geometry does not overwrite revision A's, so what was
 * approved stays recoverable after the model moves on. That is the same rule
 * DrawingFile follows for sheets.
 *
 * Stored as GLB — the binary glTF container — rather than the JSON form,
 * because GLB is one self-contained file. The JSON form can reference external
 * buffers, and half a model in a database is worse than none.
 */
const PartGeometrySchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
    partId: { type: Schema.Types.ObjectId, ref: "Part", required: true, index: true },

    /** The revision this geometry IS. Empty only for an unreleased capture. */
    revision: { type: String, default: "" },

    contentType: { type: String, default: "model/gltf-binary" },
    data: { type: Buffer, default: null },
    size: { type: Number, default: 0 },

    /** The Onshape version it was taken from — the one the release produced. */
    onshapeVersionId: { type: String, default: null },
    releaseId: { type: Schema.Types.ObjectId, ref: "Release", default: null, index: true },
    /** Set for an assembly, which exports through a translation job. */
    translationId: { type: String, default: null },

    capturedAt: { type: Date, default: null },
    /**
     * Why there are no bytes, when there are none.
     *
     * Kept rather than discarded: "Onshape refused this" and "nobody has asked
     * for it yet" look identical on a part page otherwise, and the first is
     * something somebody should act on.
     */
    failureReason: { type: String, default: null },
  },
  { timestamps: true }
);
PartGeometrySchema.index({ enterpriseId: 1, partId: 1, revision: 1 }, { unique: true });

/* -------------------------------------------------------------------------- */
/* Release — the PLM release process, and its link to the Onshape package.     */
/* -------------------------------------------------------------------------- */

const ReleaseItemSchema = new Schema(
  {
    kind: { type: String, enum: ["part", "drawing"], required: true },
    partId: { type: Schema.Types.ObjectId, ref: "Part", default: null },
    drawingId: { type: Schema.Types.ObjectId, ref: "Drawing", default: null },

    /** The Onshape element/part this item is, as the release package named it. */
    onshapeItemId: { type: String, default: "" },
    /** Onshape's own revision id for the item, present from rel-1.192 onward. */
    onshapeRevisionId: { type: String, default: "" },
    /** The revision Onshape assigned once the release completed. */
    revision: { type: String, default: "" },
    /**
     * The version the release produced.
     *
     * Recorded here as well as on the object, because the released drawing
     * export needs it and re-reading the Onshape package to find it again is a
     * call that can fail long after the release itself succeeded.
     */
    versionId: { type: String, default: "" },
  },
  { _id: false }
);

const ReleaseSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },

    /** PLM release number, issued from the same numbering machinery as parts. */
    number: { type: String, default: null, index: true },
    title: { type: String, default: "" },
    description: { type: String, default: "" },

    /**
     * Where the release began.
     *
     * "onshape" is the takeover case and the normal one: a designer opened the
     * Release candidate dialog, Onshape created a package, and PLM picked it up
     * from the workflow-transition webhook. "plm" is a release raised here,
     * which then creates the Onshape package.
     */
    origin: { type: String, enum: ["onshape", "plm"], default: "onshape", index: true },

    state: {
      type: String,
      enum: ["Under Review", "Approved", "Rejected", "Released", "Cancelled"],
      default: "Under Review",
      index: true,
    },

    items: { type: [ReleaseItemSchema], default: [] },

    /* --------------------------- Onshape linkage ---------------------------- */

    /** Release package id (rpid). The handle for every transition call. */
    onshapeReleasePackageId: { type: String, default: null, index: true },
    /** Workflow id (wfid) the package runs on. */
    onshapeWorkflowId: { type: String, default: null },
    /** Onshape's own state for the package, mirrored for comparison. */
    onshapeState: { type: String, default: "" },
    /** The changeOrderId given to Onshape, so a package can be traced back here. */
    onshapeChangeOrderId: { type: String, default: null },

    /* ------------------------------ Decision -------------------------------- */

    submittedByEmail: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    decidedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedByEmail: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: "" },

    /**
     * Attribute values missing at submission, per item.
     *
     * Recorded rather than merely blocking, because "why can I not submit this"
     * has to be answerable after the fact — and because a release raised in
     * Onshape cannot be blocked at source: PLM finds out about it only once the
     * package already exists.
     */
    validationFailures: {
      type: [{ itemLabel: String, missing: [String] }],
      default: [],
    },

    /* ------------------- Pushing the decision back to Onshape --------------- */

    /** The transition action name PLM used, e.g. the workflow's approve action. */
    onshapeTransitionAction: { type: String, default: null },
    transitionedOnshapeAt: { type: Date, default: null },
    transitionError: { type: String, default: null },
    /*
     * When the refusal above happened.
     *
     * Without it a stored error is indistinguishable from a current one: the
     * release page rendered "refused: ..." on every load, so an error from a
     * failed attempt days earlier read as a fresh failure — which is exactly
     * how a fixed problem came to look unfixed.
     */
    transitionErrorAt: { type: Date, default: null },

    /**
     * The released drawing sheets still need collecting.
     *
     * Set when the decision goes to Onshape, cleared once every drawing has an
     * as-released PDF. Kept as state rather than done inline because the
     * watermark and title-block fields only exist after Onshape has finished
     * creating revisions — which is a separate event, arriving later.
     */
    drawingRefreshPending: { type: Boolean, default: false, index: true },
    drawingRefreshedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
ReleaseSchema.index({ enterpriseId: 1, updatedAt: -1 });

/* -------------------------------------------------------------------------- */
/* OAuth server — how Onshape authenticates itself when calling PLM.           */
/*                                                                            */
/* This is the inverse of the User.onshape* fields above. Onshape's extension  */
/* action URLs use "External OAuth", in which Onshape is the client and this   */
/* application is the authorization server: it obtains a token from PLM via    */
/* the authorization-code grant and presents it as a bearer token on each      */
/* call. Modelled on onshape-public/inventory-oauth2-app.                      */
/*                                                                            */
/* Note this does NOT cover webhooks. Onshape's webhook registration accepts   */
/* no custom headers and offers no signature scheme, so webhook callbacks      */
/* still carry a shared secret in the registered URL.                          */
/* -------------------------------------------------------------------------- */

const OAuthClientSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", default: null, index: true },
    name: { type: String, required: true },

    clientId: { type: String, required: true, unique: true, index: true },
    /**
     * bcrypt hash. The secret is shown once, at creation, and never again —
     * it is pasted into Onshape's Developer Portal and has no reason to be
     * readable here afterwards.
     */
    clientSecretHash: { type: String, required: true },

    /** Exact redirect URIs permitted. Matched verbatim, never by prefix. */
    redirectUris: { type: [String], default: [] },

    lastUsedAt: { type: Date, default: null },
    disabledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * A one-time authorization code.
 *
 * TTL-expired rather than swept, and marked used on redemption: a code that is
 * presented twice is a replay, and has to be distinguishable from one that
 * simply expired.
 */
const OAuthAuthCodeSchema = new Schema({
  code: { type: String, required: true, unique: true, index: true },
  clientId: { type: String, required: true },
  redirectUri: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true },
  scope: { type: String, default: "" },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, expires: 600 }, // TTL: 10 minutes
});

/**
 * An issued access/refresh token pair.
 *
 * Stored as SHA-256 hashes, not plaintext: these are bearer credentials, and
 * the database is the one place they should not be readable. SHA-256 rather
 * than bcrypt because this is verified on every inbound extension call, where
 * a deliberately slow hash would be the request's dominant cost — and unlike a
 * password, the token is high-entropy, so there is nothing to brute-force.
 */
const OAuthTokenSchema = new Schema({
  accessTokenHash: { type: String, required: true, index: true },
  refreshTokenHash: { type: String, default: null, index: true },

  clientId: { type: String, required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
  scope: { type: String, default: "" },

  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

/* -------------------------------------------------------------------------- */
/* Numbering — PLM is the number master.                                       */
/*                                                                            */
/* One sequence per element type per enterprise. Onshape's own part number     */
/* generator extension calls in for a number, which is what puts a PLM number  */
/* on a part at exactly the moment a release candidate is raised.              */
/* -------------------------------------------------------------------------- */

const NumberingSequenceSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
    type: { type: String, enum: ["PART", "ASSEMBLY", "DRAWING", "RELEASE"], required: true },
    prefix: { type: String, default: "" },
    suffix: { type: String, default: "" },
    /** Digits the counter is padded to — 5 → 00042. */
    padding: { type: Number, default: 5 },
    /** The last number issued. The next one is this plus one. */
    counter: { type: Number, default: 0 },
  },
  { timestamps: true }
);
NumberingSequenceSchema.index({ enterpriseId: 1, type: 1 }, { unique: true });

/**
 * A record of every number this system has handed out.
 *
 * A number is never reused, even when the write that follows it fails: a number
 * that might have leaked into a drawing, a quote or a spreadsheet is worse to
 * reissue than to leave looking unused.
 */
const NumberIssuedLogSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
    type: { type: String, enum: ["PART", "ASSEMBLY", "DRAWING", "RELEASE"], required: true },
    number: { type: String, required: true },
    /** "plm": issued from PLM's own UI. "onshape": Onshape's generator extension asked. */
    source: { type: String, enum: ["plm", "onshape"], default: "plm" },
    issuedByEmail: { type: String, default: "" },
    documentId: { type: String, default: "" },
    elementId: { type: String, default: "" },
    partId: { type: String, default: "" },
  },
  { timestamps: true }
);

/* -------------------------------------------------------------------------- */
/* ActivityLog — append-only audit of every sync and release decision.         */
/* -------------------------------------------------------------------------- */

const ActivityLogSchema = new Schema(
  {
    enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", index: true },
    partId: { type: Schema.Types.ObjectId, ref: "Part", default: null, index: true },
    drawingId: { type: Schema.Types.ObjectId, ref: "Drawing", default: null, index: true },
    releaseId: { type: Schema.Types.ObjectId, ref: "Release", default: null, index: true },

    direction: {
      type: String,
      enum: ["onshape->plm", "plm->onshape", "plm"],
      required: true,
    },
    /** created | updated | unchanged | pushed | skipped | submitted | approved
     *  | rejected | released | transitioned | error */
    action: { type: String, required: true },
    /** webhook | manual | panel | extension | oauth-connect | release */
    trigger: { type: String, default: "" },
    message: { type: String, default: "" },
    changes: { type: Schema.Types.Mixed, default: null },
    ok: { type: Boolean, default: true },
  },
  { timestamps: true }
);
ActivityLogSchema.index({ enterpriseId: 1, createdAt: -1 });

/* -------------------------------------------------------------------------- */
/* SelfWrite — echo suppression.                                               */
/*                                                                            */
/* Writing a property back into Onshape fires onshape.model.lifecycle.metadata */
/* right back at us. Before each push we record a fingerprint; the webhook     */
/* receiver drops any event matching a fingerprint younger than the TTL.       */
/* -------------------------------------------------------------------------- */

const SelfWriteSchema = new Schema({
  key: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now, expires: 90 }, // TTL: 90s
});

/* -------------------------------------------------------------------------- */
/* PartThumbnail — cached rendering of a part.                                 */
/*                                                                            */
/* Rendering is slow and rate-limited, and a list asks for many at once, so    */
/* images are fetched once and served from here afterwards.                    */
/* -------------------------------------------------------------------------- */

const PartThumbnailSchema = new Schema({
  partId: { type: Schema.Types.ObjectId, ref: "Part", required: true, unique: true, index: true },
  enterpriseId: { type: Schema.Types.ObjectId, ref: "Enterprise", required: true, index: true },
  contentType: { type: String, required: true },
  data: { type: Buffer, required: true },
  size: { type: Number, default: 300 },
  fetchedAt: { type: Date, default: Date.now },
  // Set when Onshape could not render, so failures are not retried on every view.
  failedAt: { type: Date, default: null },
  failureReason: { type: String, default: null },
});

/* -------------------------------------------------------------------------- */
/* Mock backing store for ONSHAPE_MODE=mock.                                   */
/*                                                                            */
/* Stands in for Onshape's own database so the simulator can edit properties,  */
/* raise release candidates and complete releases, and the mock API client     */
/* reads the same state a real tenant would return. This is what lets the      */
/* whole release takeover be demonstrated with no Onshape enterprise at all.   */
/* -------------------------------------------------------------------------- */

const MockOnshapePartSchema = new Schema(
  {
    companyId: { type: String, required: true, index: true },
    documentId: { type: String, required: true },
    documentName: { type: String, default: "" },
    workspaceId: { type: String, default: "w1" },
    elementId: { type: String, required: true },
    elementName: { type: String, default: "" },
    elementType: { type: String, default: "PARTSTUDIO" },
    /*
     * Empty for an assembly, which is an element rather than a part inside
     * one — the same rule as the real Part schema.
     *
     * `required` would reject that: Mongoose treats an empty string as absent,
     * so `required: true` here failed validation on every assembly write while
     * letting the upsert that created it through, because an upsert does not
     * run document validators. A default of "" says the field is always
     * present and may legitimately be empty, and keeps it in the identity
     * index, where an assembly's empty partId distinguishes it from the parts
     * in the same element.
     */
    partId: { type: String, default: "" },
    configuration: { type: String, default: "default" },
    /**
     * Marks a seeded assembly that stands in for a subassembly.
     *
     * Only the simulator needs this: a real tenant's structure comes from the
     * assembly's own BOM, where being a subassembly is a matter of where a row
     * sits rather than a property of the element.
     */
    isSubassembly: { type: Boolean, default: false },
    // propertyId -> value, mirroring Onshape's metadata property bag.
    properties: { type: Schema.Types.Mixed, default: {} },
    /** Revisions the mock tenant has created, so a released part reads back correctly. */
    revisions: { type: [{ revision: String, versionId: String, createdAt: Date }], default: [] },
  },
  { timestamps: true }
);
MockOnshapePartSchema.index(
  { companyId: 1, documentId: 1, elementId: 1, partId: 1, configuration: 1 },
  { unique: true }
);

/**
 * A task in the simulator's Onshape.
 *
 * Modelled with a real state and a real transition set rather than stubbed,
 * because the whole point of the simulator is that the demo works without a
 * tenant — and a task interface with no workflow to drive is a screenshot.
 */
const MockOnshapeTaskSchema = new Schema(
  {
    companyId: { type: String, required: true, index: true },
    taskId: { type: String, required: true, index: true },
    name: { type: String, default: "" },
    description: { type: String, default: "" },
    /** Onshape's own state names for its stock task workflow. */
    state: { type: String, default: "Open" },
    status: { type: Number, default: 2 },
    taskType: { type: String, default: "GENERAL" },
    /** Onshape reports this per task; false means discard rather than delete. */
    deletable: { type: Boolean, default: true },
    /*
     * Which task workflow this follows.
     *
     * "stock" is Onshape's own and is the default because it is what a real
     * tenant has: OPEN and COMPLETE, joined by COMPLETE(APPROVE), with
     * OS_DISCARD(DELETE) — and **no transition that starts work**. The
     * simulator used to offer an invented START from Open, which is why a
     * board column that cannot work looked like it did.
     *
     * "extended" keeps that invented transition, for exercising the intent
     * matching that distinguishes start from reopen when both are SUBMIT.
     */
    workflowStyle: { type: String, default: "stock" },
    /*
     * Whether `getActionItems` shows this task, as opposed to only the search.
     *
     * The gap is the whole reason `findTasks` exists: Onshape shows the calling
     * account the tasks it created or was assigned, and nothing else unless it
     * is a company admin. On the tenant this was built against that was 8 tasks
     * where the search returned 174. A simulator where every task is visible
     * both ways cannot exercise the union, so this models it.
     */
    visibleAsActionItem: { type: Boolean, default: true },
    /*
     * Whether reading this task individually fails.
     *
     * Not a hypothetical: 7 of the 31 real tasks on the live tenant were
     * orphaned records with a null name that answer `GET /tasks/{tid}` with a
     * 500. They come back from the search, so any code that trusts the search
     * and then hydrates has to survive them — and must not leave a nameless
     * blank card on the board.
     */
    hydrateFails: { type: Boolean, default: false },
    documentId: { type: String, default: "" },
    documentName: { type: String, default: "" },
    elementId: { type: String, default: "" },
    objectId: { type: String, default: "" },
    creatorEmail: { type: String, default: "" },
    creatorName: { type: String, default: "" },
    assignees: {
      type: [{ _id: false, onshapeUserId: String, email: String, name: String, acted: Boolean }],
      default: [],
    },
    resolvedAt: { type: Date, default: null },
    resolvedByEmail: { type: String, default: "" },
    items: {
      type: [{ _id: false, label: String, documentId: String, elementId: String, partId: String }],
      default: [],
    },
    /*
     * The metadata properties a task carries — where the due date, priority
     * and task state actually are. Note `type` written as `{ type: String }`:
     * a bare `type` key is read by Mongoose as the field's own type.
     */
    properties: {
      type: [{
        _id: false,
        propertyId: String,
        name: String,
        value: Schema.Types.Mixed,
        valueType: { type: String },
        editable: Boolean,
        required: Boolean,
        enumValues: [{ _id: false, value: String, label: String }],
      }],
      default: [],
    },
    comments: {
      type: [{
        _id: false,
        id: String,
        message: String,
        authorEmail: String,
        authorName: String,
        createdAt: Date,
        /*
         * A real numeric code, so PLM's "copy the objectType off an existing
         * comment" path is exercised. The value is arbitrary here — what
         * matters is that one exists to be copied.
         */
        objectType: { type: Number, default: 14 },
      }],
      default: [],
    },
  },
  { timestamps: true }
);
MockOnshapeTaskSchema.index({ companyId: 1, taskId: 1 }, { unique: true });

const MockPropertyDefSchema = new Schema({
  companyId: { type: String, required: true, index: true },
  propertyId: { type: String, required: true },
  name: { type: String, required: true },
  valueType: { type: String, default: "STRING" },
  /** Option labels, for an enum whose stored value IS the label. */
  enumValues: { type: [String], default: [] },
  /*
   * Options as Onshape actually returns them: a code and a separate label.
   *
   * Needed because the simulator stores State as a numeric code — which is
   * what a real tenant sends — while its option list held only label strings.
   * The code could then never be matched against the options, so every part
   * displayed "Unknown (0)" or "Unknown (2)", and the code→label path that
   * exists for live Onshape was unreachable locally. This is the same gap as
   * the assembly one: a mock that cannot express the shape that breaks cannot
   * show whether the handling for it works.
   */
  enumOptions: {
    type: [{ _id: false, value: Schema.Types.Mixed, label: String }],
    default: [],
  },
  builtIn: { type: Boolean, default: false },
});

/**
 * A release package in the mock tenant.
 *
 * Shaped after what GET /releasepackages/{rpid} returns, including the list of
 * available workflow actions — because which action names exist is the one
 * thing the real integration has to read rather than assume, and a mock that
 * hard-coded "APPROVE" would hide exactly that.
 */
const MockReleasePackageSchema = new Schema(
  {
    companyId: { type: String, required: true, index: true },
    rpid: { type: String, required: true, unique: true, index: true },
    wfid: { type: String, default: "mock-workflow" },
    changeOrderId: { type: String, default: "" },
    state: { type: String, default: "PENDING" },
    /** Action names this package currently offers, as Onshape reports them. */
    availableActions: { type: [String], default: [] },
    items: {
      type: [{
        id: String,
        documentId: String,
        elementId: String,
        partId: String,
        elementType: String,
        name: String,
        partNumber: String,
        revisionId: String,
        revision: String,
        /**
         * The version a completed release produced.
         *
         * Must be declared: Mongoose silently discards a field absent from the
         * sub-schema, which is what it did here — the released drawing then had
         * no version to be exported from, and the refresh waited for one
         * forever while everything else looked correct.
         */
        versionId: String,
      }],
      default: [],
    },
    properties: { type: Schema.Types.Mixed, default: {} },
    syncedWithPLM: { type: Boolean, default: false },
    createdByEmail: { type: String, default: "" },
  },
  { timestamps: true }
);

/** A drawing tab in the mock tenant, so drawing PDFs can be exported in mock mode. */
const MockOnshapeDrawingSchema = new Schema(
  {
    companyId: { type: String, required: true, index: true },
    documentId: { type: String, required: true },
    documentName: { type: String, default: "" },
    workspaceId: { type: String, default: "w1" },
    elementId: { type: String, required: true },
    elementName: { type: String, default: "" },
    /** Part ids this sheet draws, so the mock can associate drawings with items. */
    partIds: { type: [String], default: [] },
    properties: { type: Schema.Types.Mixed, default: {} },
    revisions: { type: [{ revision: String, versionId: String, createdAt: Date }], default: [] },
  },
  { timestamps: true }
);
MockOnshapeDrawingSchema.index({ companyId: 1, documentId: 1, elementId: 1 }, { unique: true });

/* -------------------------------------------------------------------------- */

export type EnterpriseDoc = InferSchemaType<typeof EnterpriseSchema> & { _id: mongoose.Types.ObjectId };
export type UserDoc = InferSchemaType<typeof UserSchema> & { _id: mongoose.Types.ObjectId };
export type PartDoc = InferSchemaType<typeof PartSchema> & { _id: mongoose.Types.ObjectId };
export type DrawingDoc = InferSchemaType<typeof DrawingSchema> & { _id: mongoose.Types.ObjectId };
export type ReleaseDoc = InferSchemaType<typeof ReleaseSchema> & { _id: mongoose.Types.ObjectId };
export type AttributeDefinitionDoc = InferSchemaType<typeof AttributeDefinitionSchema> & { _id: mongoose.Types.ObjectId };

export const Enterprise = models.Enterprise || model("Enterprise", EnterpriseSchema);
export const User = models.User || model("User", UserSchema);
export const AttributeDefinition =
  models.AttributeDefinition || model("AttributeDefinition", AttributeDefinitionSchema);
export const Product = models.Product || model("Product", ProductSchema);
export const Task = models.Task || model("Task", TaskSchema);
export const Part = models.Part || model("Part", PartSchema);
export const PartIteration = models.PartIteration || model("PartIteration", PartIterationSchema);
export const BomLink = models.BomLink || model("BomLink", BomLinkSchema);
export const Drawing = models.Drawing || model("Drawing", DrawingSchema);
export const DrawingFile = models.DrawingFile || model("DrawingFile", DrawingFileSchema);
export const PartGeometry =
  models.PartGeometry || model("PartGeometry", PartGeometrySchema);
export const Release = models.Release || model("Release", ReleaseSchema);
export const OAuthClient = models.OAuthClient || model("OAuthClient", OAuthClientSchema);
export const OAuthAuthCode = models.OAuthAuthCode || model("OAuthAuthCode", OAuthAuthCodeSchema);
export const OAuthToken = models.OAuthToken || model("OAuthToken", OAuthTokenSchema);
export const NumberingSequence = models.NumberingSequence || model("NumberingSequence", NumberingSequenceSchema);
export const NumberIssuedLog = models.NumberIssuedLog || model("NumberIssuedLog", NumberIssuedLogSchema);
export const ActivityLog = models.ActivityLog || model("ActivityLog", ActivityLogSchema);
export const SelfWrite = models.SelfWrite || model("SelfWrite", SelfWriteSchema);
export const PartThumbnail = models.PartThumbnail || model("PartThumbnail", PartThumbnailSchema);
export const MockOnshapePart = models.MockOnshapePart || model("MockOnshapePart", MockOnshapePartSchema);
export const MockPropertyDef = models.MockPropertyDef || model("MockPropertyDef", MockPropertyDefSchema);
export const MockOnshapeTask =
  models.MockOnshapeTask || model("MockOnshapeTask", MockOnshapeTaskSchema);
export const MockReleasePackage = models.MockReleasePackage || model("MockReleasePackage", MockReleasePackageSchema);
export const MockOnshapeDrawing = models.MockOnshapeDrawing || model("MockOnshapeDrawing", MockOnshapeDrawingSchema);
