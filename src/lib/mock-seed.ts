import { connectDb } from "@/lib/db";
import { MockOnshapeDrawing, MockOnshapePart, MockOnshapeTask, MockPropertyDef } from "@/lib/models";

/**
 * Property ids are fixed 24-hex strings so they look like the real thing and
 * stay stable across reseeds (the enterprise propertyMap caches them).
 */
export const MOCK_PROPS = {
  name:        { propertyId: "57f3fb8efa3416c06701d60d", name: "Name", valueType: "STRING", builtIn: true },
  partNumber:  { propertyId: "57f3fb8efa3416c06701d60e", name: "Part number", valueType: "STRING", builtIn: true },
  revision:    { propertyId: "57f3fb8efa3416c06701d60f", name: "Revision", valueType: "STRING", builtIn: true },
  description: { propertyId: "57f3fb8efa3416c06701d610", name: "Description", valueType: "STRING", builtIn: true },
  material:    { propertyId: "57f3fb8efa3416c06701d611", name: "Material", valueType: "STRING", builtIn: true },
  state:       { propertyId: "57f3fb8efa3416c06701d612", name: "State", valueType: "ENUM", builtIn: true },
  vendor:      { propertyId: "57f3fb8efa3416c06701d613", name: "Vendor", valueType: "STRING", builtIn: false },
  project:     { propertyId: "57f3fb8efa3416c06701d614", name: "Project", valueType: "STRING", builtIn: false },
};

/**
 * The simulator's workflow states.
 *
 * Held as code/label pairs because that is the shape Onshape returns an enum
 * in — the stored value is an integer and the label lives in the option list.
 * The seed data below stores these codes, so the code→label resolution PLM
 * does for a live tenant is exercised by the simulator too.
 */
export const MOCK_STATES = [
  { value: 0, label: "In Progress" },
  { value: 1, label: "Pending" },
  { value: 2, label: "Released" },
  { value: 3, label: "Obsolete" },
];

/**
 * Drawing tabs, so the release flow has sheets to capture.
 *
 * Each names the parts it draws. Onshape does not expose that relationship
 * outside a release package, and the mock supplies it the same way Onshape
 * effectively does — by adding the drawing to the package alongside the parts.
 */
const SEED_DRAWINGS = [
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e8a2b3c4d5e6f70819202131", elementName: "Housing Drawing",
    partIds: ["JHD", "JHE"],
  },
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e8a2b3c4d5e6f70819202132", elementName: "Output Shaft Drawing",
    partIds: ["KTF"],
  },
  {
    documentId: "d3a2b3c4d5e6f70819202125", documentName: "Chassis Frame",
    elementId: "e8a2b3c4d5e6f70819202133", elementName: "Frame Rail Drawing",
    partIds: ["MQZ", "MRA"],
  },
];

const P = MOCK_PROPS;

const SEED_PARTS = [
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e1a2b3c4d5e6f70819202123", elementName: "Housing Part Studio",
    partId: "JHD", props: {
      [P.name.propertyId]: "Gearbox Housing",
      [P.partNumber.propertyId]: "GB-1001",
      [P.description.propertyId]: "Cast aluminium main housing, 6 bolt flange",
      // Onshape returns material as an object, not a string — mirrored here so the
      // display path is exercised the way a real tenant exercises it.
      [P.material.propertyId]: { id: "6061", libraryName: "Onshape Material Library", displayName: "Aluminium 6061-T6" },
      [P.state.propertyId]: 0,
      [P.vendor.propertyId]: "Precision Castings Ltd",
      [P.project.propertyId]: "Falcon",
    },
  },
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e1a2b3c4d5e6f70819202123", elementName: "Housing Part Studio",
    partId: "JHE", props: {
      [P.name.propertyId]: "Housing Cover",
      [P.partNumber.propertyId]: "GB-1002",
      [P.description.propertyId]: "Stamped cover plate with gasket groove",
      [P.material.propertyId]: "Steel 1018",
      [P.state.propertyId]: 0,
      [P.vendor.propertyId]: "",
      [P.project.propertyId]: "Falcon",
    },
  },
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e2a2b3c4d5e6f70819202124", elementName: "Shaft Part Studio",
    partId: "KTF", props: {
      [P.name.propertyId]: "Output Shaft",
      [P.partNumber.propertyId]: "GB-2001",
      [P.description.propertyId]: "Splined output shaft, hardened and ground",
      [P.material.propertyId]: "4340 Alloy Steel",
      [P.state.propertyId]: 2,
      [P.vendor.propertyId]: "Turned Parts Co",
      [P.project.propertyId]: "Falcon",
    },
  },
  {
    documentId: "d3a2b3c4d5e6f70819202125", documentName: "Chassis Frame",
    elementId: "e3a2b3c4d5e6f70819202126", elementName: "Frame Part Studio",
    partId: "MQZ", props: {
      [P.name.propertyId]: "Lower Frame Rail",
      [P.partNumber.propertyId]: "CH-3001",
      [P.description.propertyId]: "Welded box section rail, 1200mm",
      [P.material.propertyId]: "Steel S355",
      [P.state.propertyId]: 0,
      [P.vendor.propertyId]: "",
      [P.project.propertyId]: "Kestrel",
    },
  },
  {
    documentId: "d3a2b3c4d5e6f70819202125", documentName: "Chassis Frame",
    elementId: "e3a2b3c4d5e6f70819202126", elementName: "Frame Part Studio",
    partId: "MRA", props: {
      [P.name.propertyId]: "Cross Member",
      [P.partNumber.propertyId]: "CH-3002",
      [P.description.propertyId]: "Bolt-in cross member with jacking points",
      [P.material.propertyId]: "Steel S355",
      [P.state.propertyId]: 0,
      [P.vendor.propertyId]: "",
      [P.project.propertyId]: "Kestrel",
    },
  },
];

/*
 * Assembly tabs, one per document.
 *
 * Stored in the same collection as parts, with elementType ASSEMBLY and an
 * empty partId — which is exactly how Onshape presents one, an element rather
 * than a part inside an element. The identity index is
 * (company, document, element, part, configuration), so an empty partId
 * coexists with the parts perfectly well.
 *
 * These exist because the mock could not model an assembly at all, and that is
 * why every assembly-shaped bug in the live client reached a real tenant before
 * being noticed: a part-scoped URL degenerating to a wildcard, a thumbnail
 * endpoint that needs a partId, mass properties filtered by a part that does
 * not exist. None of it was reachable locally.
 */
const SEED_ASSEMBLIES = [
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e7a2b3c4d5e6f70819202141", elementName: "Gearbox Assembly",
    props: {
      [P.name.propertyId]: "Gearbox Assembly",
      [P.description.propertyId]: "Complete gearbox, housing and shaft",
    },
  },
  {
    documentId: "d3a2b3c4d5e6f70819202125", documentName: "Chassis Frame",
    elementId: "e7a2b3c4d5e6f70819202142", elementName: "Chassis Frame Assembly",
    props: {
      [P.name.propertyId]: "Chassis Frame Assembly",
      [P.description.propertyId]: "Welded frame, rails and cross members",
    },
  },
  /*
   * A subassembly, so an indented BOM has more than one level to show.
   *
   * Without it the simulator could only ever produce a one-level BOM, and the
   * structured import — which reconstructs hierarchy from indent levels, brings
   * subassemblies in as PLM assemblies, and reconciles each parent's own edges
   * — had no local shape to be exercised against. That is the same gap that let
   * the assembly URL bugs and the numeric elementType reach a live tenant.
   */
  {
    documentId: "d1a2b3c4d5e6f70819202122", documentName: "Gearbox Assembly",
    elementId: "e7a2b3c4d5e6f70819202143", elementName: "Shaft Subassembly",
    isSubassembly: true,
    props: {
      [P.name.propertyId]: "Shaft Subassembly",
      [P.description.propertyId]: "Shaft, bearings and retaining ring",
    },
  },
];

/*
 * Tasks, so the task board has something to show without an Onshape tenant.
 *
 * One in each state the stock workflow uses, because the board is the thing
 * being demonstrated and an empty column reads as a broken feature. The first
 * carries a comment so PLM's "copy the objectType off an existing comment"
 * path is exercised rather than falling back to a configured guess.
 */
/*
 * The properties a real Onshape task carries, read off a live tenant.
 *
 * A task's due date, priority and task state are metadata properties rather
 * than fields — which is why PLM's first task UI had no due date at all. The
 * two states are separate and one of them is read-only: `State` is the
 * workflow's and Onshape owns it, `Task State` is editable.
 */
const TASK_PROPS = (over: Record<string, unknown> = {}) => [
  { propertyId: "57f3fb8efa3416c06701d60d", name: "Name", valueType: "STRING",
    editable: true, required: true, enumValues: [], value: over.name ?? "" },
  { propertyId: "57f3fb8efa3416c06701d60e", name: "Description", valueType: "STRING",
    editable: true, required: false, enumValues: [], value: over.description ?? "" },
  { propertyId: "57f3fb8efa3416c06701d611", name: "State", valueType: "ENUM",
    editable: false, required: true, value: over.state ?? "1",
    enumValues: [
      /* The live tenant's labels — a release-shaped enum, not a task one. */
      { value: "0", label: "In progress" }, { value: "1", label: "Pending" },
      { value: "2", label: "Released" }, { value: "3", label: "Obsolete" },
      { value: "4", label: "Rejected" }, { value: "5", label: "Discarded" },
    ] },
  { propertyId: "57f3fb8efa3416c06701d621", name: "Due date", valueType: "DATE",
    editable: true, required: false, enumValues: [], value: over.dueDate ?? null },
  { propertyId: "57f3fb8efa3416c06701d622", name: "Completed date", valueType: "DATE",
    editable: false, required: false, enumValues: [], value: over.completedDate ?? null },
  { propertyId: "57f3fb8efa3416c06701d62c", name: "Priority", valueType: "ENUM",
    editable: true, required: false, value: over.priority ?? "0",
    enumValues: [
      /* The live tenant's labels. */
      { value: "0", label: "Low" }, { value: "1", label: "Medium" },
      { value: "2", label: "High" }, { value: "3", label: "Very high" },
    ] },
  /*
   * The workflow's own properties, which live in `workflowInfo.properties` on
   * a real task rather than alongside the metadata ones.
   *
   * `Comment` is the one that matters: a comment on a task is a write to it,
   * not a POST to the comment API. Its absence from the simulator is what let
   * three impossible attempts ship.
   */
  /*
   * Task State — Onshape's OTHER notion of progress, and the one a board's
   * "In Progress" column actually corresponds to.
   *
   * The stock task workflow has no in-progress STATE: an open task offers only
   * COMPLETE and OS_DISCARD. Work under way is recorded here instead. The
   * simulator not carrying this property is why PLM looked for a "start"
   * transition, found none, and reported that as the task's fault.
   *
   * The codes are the live tenant's, including the gap at 4 — they are a
   * published list, not a dense range.
   */
  { propertyId: "57f3fb8efa3416c06701d62d", name: "Task State", valueType: "ENUM",
    editable: true, required: false, value: over.taskState ?? "1",
    enumValues: [
      { value: "0", label: "New" }, { value: "1", label: "Assigned" },
      { value: "2", label: "In Work" }, { value: "3", label: "Completed" },
      { value: "5", label: "Closed" }, { value: "6", label: "Canceled" },
    ] },
  { propertyId: "594964df040fc85d2b418145", name: "Comment", valueType: "STRING",
    editable: true, required: false, enumValues: [], value: "" },
  /*
   * Assigned to and Category, in the shapes Onshape actually sends: ARRAYS OF
   * OBJECTS, not scalars.
   *
   * The simulator used to hold a bare array, so every screen that rendered a
   * property with String() looked fine here and printed "[object Object]" on
   * a real tenant. Each element carries a human `name` and a pile of
   * bookkeeping; the name is the part anybody wants to read.
   */
  { propertyId: "TASK_APPROVERS", name: "Assigned to", valueType: "USER",
    editable: false, required: true, enumValues: [],
    value: over.assigned ?? [
      {
        name: "Des Designer", id: "mock-user-1", email: "designer@mockenterprise.test",
        approverName: "Des Designer", approvalDate: null, rejectionDate: null,
        isExternal: false, entryType: 0, removable: true,
      },
    ] },
  { propertyId: "57f3fb8efa3416c06701d62e", name: "Category", valueType: "CATEGORY",
    editable: false, required: false, enumValues: [],
    value: over.category ?? [
      {
        name: "Task", id: "60faf6369115147ace681ce6",
        description: "Default category for object type Task",
        ownerType: 1, publishState: 1, objectTypes: [14], defaultObjectType: 14,
        memberCategoryIds: ["5f9890b7ed9a851c835da15a"],
        memberCategories: [
          { name: "Onshape Task", id: "5f9890b7ed9a851c835da15a", ownerType: 2, objectTypes: [14] },
        ],
      },
    ] },
];

const SEED_TASKS = [
  {
    taskId: "task-1a2b3c4d5e6f708192021",
    name: "Check wall thickness on the housing",
    description:
      "The cast wall is 2.5mm in two places and the foundry has asked for 3mm minimum. " +
      "Confirm the change does not foul the bearing boss.",
    state: "Open",
    documentId: "d1a2b3c4d5e6f70819202122",
    documentName: "Gearbox Assembly",
    elementId: "e1a2b3c4d5e6f70819202123",
    creatorEmail: "designer@mockenterprise.test",
    creatorName: "Des Designer",
    assignees: [
      { onshapeUserId: "mock-user-1", email: "designer@mockenterprise.test", name: "Des Designer", acted: false },
    ],
    items: [
      { label: "Gearbox Housing", documentId: "d1a2b3c4d5e6f70819202122", elementId: "e1a2b3c4d5e6f70819202123", partId: "JHD" },
    ],
    comments: [
      {
        id: "mock-comment-seed-1",
        message: "Foundry drawing attached to the RFQ — 3mm is what they quoted against.",
        authorEmail: "designer@mockenterprise.test",
        authorName: "Des Designer",
        createdAt: new Date(Date.now() - 36e5 * 30),
        objectType: 14,
      },
    ],
  },
  {
    taskId: "task-2a2b3c4d5e6f708192022",
    name: "Approve material change to 6061-T6",
    description: "Moving the cover from 5052 to 6061-T6 for the anodising spec.",
    state: "In Progress",
    dueDate: new Date(Date.now() + 36e5 * 24 * 5),
    priority: "1",
    taskState: "1",
    documentId: "d1a2b3c4d5e6f70819202122",
    documentName: "Gearbox Assembly",
    elementId: "e1a2b3c4d5e6f70819202123",
    creatorEmail: "approver@mockenterprise.test",
    creatorName: "Ann Approver",
    assignees: [
      { onshapeUserId: "mock-user-2", email: "approver@mockenterprise.test", name: "Ann Approver", acted: false },
    ],
    items: [
      { label: "Housing Cover", documentId: "d1a2b3c4d5e6f70819202122", elementId: "e1a2b3c4d5e6f70819202123", partId: "JHE" },
    ],
    comments: [],
  },
  {
    taskId: "task-3a2b3c4d5e6f708192023",
    name: "Add a chamfer to the output shaft",
    description: "0.5mm lead-in so the seal does not roll on assembly.",
    state: "Resolved",
    documentId: "d1a2b3c4d5e6f70819202122",
    documentName: "Gearbox Assembly",
    elementId: "e2a2b3c4d5e6f70819202124",
    creatorEmail: "designer@mockenterprise.test",
    creatorName: "Des Designer",
    assignees: [
      { onshapeUserId: "mock-user-1", email: "designer@mockenterprise.test", name: "Des Designer", acted: true },
    ],
    items: [
      { label: "Output Shaft", documentId: "d1a2b3c4d5e6f70819202122", elementId: "e2a2b3c4d5e6f70819202124", partId: "KTF" },
    ],
    comments: [],
  },
  {
    /*
     * A GENERAL task attached to no document.
     *
     * Kept because it is a real shape — Onshape's task list is full of them —
     * and because PLM once believed such a task could not be commented on.
     * It can: a comment is a write to the workflow's Comment property, and a
     * document has nothing to do with it.
     */
    taskId: "task-4a2b3c4d5e6f708192024",
    name: "Decide on the anodising supplier",
    description: "Not tied to a document — three quotes to compare.",
    state: "Open",
    priority: "2",
    documentId: "",
    documentName: "",
    elementId: "",
    creatorEmail: "approver@mockenterprise.test",
    creatorName: "Ann Approver",
    assignees: [
      { onshapeUserId: "mock-user-2", email: "approver@mockenterprise.test", name: "Ann Approver", acted: false },
    ],
    items: [],
    comments: [],
  },
  {
    /*
     * A task the integration account would NOT be shown.
     *
     * `getActionItems` returns what the caller created or was assigned; this
     * one is neither, so only the search finds it. It is the case PLM was
     * blind to — on a live tenant 166 of 174 tasks were like this — and a
     * simulator without one cannot tell whether the search is wired up.
     */
    taskId: "task-5a2b3c4d5e6f708192025",
    name: "Re-check the bearing fit tolerances",
    description: "Raised by manufacturing against the housing bore.",
    state: "Open",
    priority: "2",
    dueDate: new Date(Date.now() - 36e5 * 24 * 3),
    visibleAsActionItem: false,
    documentId: "d1a2b3c4d5e6f70819202122",
    documentName: "Gearbox Assembly",
    elementId: "e1a2b3c4d5e6f70819202123",
    creatorEmail: "manufacturing@mockenterprise.test",
    creatorName: "Mo Manufacturing",
    assignees: [
      { onshapeUserId: "mock-user-3", email: "manufacturing@mockenterprise.test", name: "Mo Manufacturing", acted: false },
    ],
    items: [
      { label: "Gearbox Housing", documentId: "d1a2b3c4d5e6f70819202122", elementId: "e1a2b3c4d5e6f70819202123", partId: "JHD" },
    ],
    comments: [],
  },
  {
    /*
     * A release-package task, which must NOT reach the board.
     *
     * `taskType: RELEASE` is 143 of 174 tasks on a live tenant. PLM already
     * mirrors these as releases, with their own page and numbering, so a board
     * that also listed them would bury the real work and show one record twice.
     */
    taskId: "task-6a2b3c4d5e6f708192026",
    name: "REL-00007 approval",
    description: "A release workflow, not a task somebody works on.",
    state: "Pending",
    taskType: "RELEASE",
    visibleAsActionItem: false,
    documentId: "d1a2b3c4d5e6f70819202122",
    documentName: "Gearbox Assembly",
    elementId: "",
    creatorEmail: "approver@mockenterprise.test",
    creatorName: "Ann Approver",
    assignees: [],
    items: [],
    comments: [],
  },
  {
    /*
     * A task that lists but will not open.
     *
     * Seven of the live tenant's tasks were orphaned records with a null name
     * that answer `GET /tasks/{tid}` with a 500. They come back from the
     * search, so the sync has to survive them — and must not leave a nameless
     * card with no state and no transitions sitting on the board.
     */
    taskId: "task-7a2b3c4d5e6f708192027",
    name: "",
    description: "",
    state: "",
    visibleAsActionItem: false,
    hydrateFails: true,
    documentId: "",
    documentName: "",
    elementId: "",
    creatorEmail: "",
    creatorName: "",
    assignees: [],
    items: [],
    comments: [],
  },
];

/**
 * Idempotent: upserts definitions, parts, assemblies, drawings and tasks
 * without clobbering anything since edited in the simulator.
 *
 * Revision is deliberately absent from the seeded properties. In PLM, Onshape
 * owns the revision and assigns it at release — a mock tenant whose parts
 * arrived already at revision A would hide the whole pre-release lifecycle,
 * which is the thing worth demonstrating.
 */
export async function seedMockOnshape(
  companyId: string
): Promise<{ properties: number; parts: number; assemblies: number; drawings: number; tasks: number }> {
  await connectDb();

  const defs = Object.values(MOCK_PROPS);
  for (const d of defs) {
    await MockPropertyDef.updateOne(
      { companyId, propertyId: d.propertyId },
      {
        $set: {
          companyId,
          propertyId: d.propertyId,
          name: d.name,
          valueType: d.valueType,
          builtIn: d.builtIn,
          enumValues: [],
          /*
           * Codes, not labels, matching how the parts below store their state
           * and how a real tenant reports it. The mapping is not a guess about
           * Onshape — the simulator authors both halves, so these codes mean
           * what this list says they mean.
           */
          enumOptions: d.valueType === "ENUM" ? MOCK_STATES : [],
        },
      },
      { upsert: true }
    );
  }

  for (const p of SEED_PARTS) {
    await MockOnshapePart.updateOne(
      { companyId, documentId: p.documentId, elementId: p.elementId, partId: p.partId, configuration: "default" },
      {
        $set: {
          companyId, documentId: p.documentId, documentName: p.documentName,
          workspaceId: "w1a2b3c4d5e6f70819202199",
          elementId: p.elementId, elementName: p.elementName,
          partId: p.partId, configuration: "default",
          elementType: "PARTSTUDIO",
        },
        $setOnInsert: { properties: p.props },
      },
      { upsert: true }
    );
  }

  for (const a of SEED_ASSEMBLIES) {
    await MockOnshapePart.updateOne(
      { companyId, documentId: a.documentId, elementId: a.elementId, partId: "", configuration: "default" },
      {
        $set: {
          companyId, documentId: a.documentId, documentName: a.documentName,
          workspaceId: "w1a2b3c4d5e6f70819202199",
          elementId: a.elementId, elementName: a.elementName,
          partId: "", configuration: "default",
          elementType: "ASSEMBLY",
          isSubassembly: Boolean((a as { isSubassembly?: boolean }).isSubassembly),
        },
        $setOnInsert: { properties: a.props },
      },
      { upsert: true }
    );
  }

  for (const d of SEED_DRAWINGS) {
    await MockOnshapeDrawing.updateOne(
      { companyId, documentId: d.documentId, elementId: d.elementId },
      {
        $set: {
          companyId, documentId: d.documentId, documentName: d.documentName,
          workspaceId: "w1a2b3c4d5e6f70819202199",
          elementId: d.elementId, elementName: d.elementName,
          partIds: d.partIds,
        },
      },
      { upsert: true }
    );
  }

  for (const t of SEED_TASKS) {
    await MockOnshapeTask.updateOne(
      { companyId, taskId: t.taskId },
      {
        $set: { companyId, taskId: t.taskId, documentId: t.documentId, documentName: t.documentName,
                elementId: t.elementId, creatorEmail: t.creatorEmail, creatorName: t.creatorName,
                assignees: t.assignees, items: t.items,
                /*
                 * Visibility and readability are $set, not $setOnInsert: they
                 * describe what Onshape would do with the task, not the state
                 * of somebody's demo, so a reseed should correct them.
                 */
                visibleAsActionItem: (t as any).visibleAsActionItem !== false,
                hydrateFails: Boolean((t as any).hydrateFails) },
        /*
         * The state, the description and the thread are $setOnInsert: they are
         * what a demo changes, and a reseed that reset them would undo the
         * walkthrough somebody was halfway through.
         */
        $setOnInsert: {
          name: t.name, description: t.description, state: t.state,
          comments: t.comments, status: 2, taskType: (t as any).taskType ?? "GENERAL",
          properties: TASK_PROPS({
            name: t.name,
            description: t.description,
            dueDate: t.dueDate ?? null,
            priority: t.priority ?? "0",
            taskState: t.taskState ?? "0",
          }),
        },
      },
      { upsert: true }
    );
  }

  return {
    properties: defs.length,
    parts: SEED_PARTS.length,
    assemblies: SEED_ASSEMBLIES.length,
    drawings: SEED_DRAWINGS.length,
    tasks: SEED_TASKS.length,
  };
}
