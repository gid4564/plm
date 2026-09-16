/**
 * Tasks, synced both ways with Onshape.
 *
 * Onshape owns a task: it is created there, its workflow is defined there, and
 * its state is whatever Onshape says. PLM holds no competing status field —
 * two systems each keeping one is how they come to disagree with nothing to
 * arbitrate. What PLM adds is somewhere to work: the parts a task is about
 * resolved to real PLM parts, a thread, and the transitions the task itself
 * offers.
 *
 * So these tests are mostly about the seams:
 *
 *   Onshape's answer wins on a re-read, and the thread is MERGED rather than
 *   replaced — Onshape returns every comment on every read, so appending
 *   blindly duplicates the conversation, and replacing loses a PLM comment
 *   Onshape has not accepted yet.
 *
 *   A transition is never invented. The id comes from the task's own workflow
 *   snapshot, and the id differs from the type — the distinction that made the
 *   release transition fail silently for a day.
 *
 *   A comment is kept even when Onshape refuses it. Somebody typed it.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, Enterprise, MockOnshapeTask, Part, Task, User,
} from "../src/lib/models";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import {
  closedAt, columnFor, columnForTask, commentOnTask, CLOSED_TASK_WINDOW_DAYS, hiddenAsOldClosed,
  isClosed, moveTaskToColumn, parseClosedWithin, pullTasks, removeTasks,
  taskCountsForParts, tasksForPart, taskStateOptionFor, TASK_TYPES_PULLED, transitionTask,
  updateTaskFields, upsertTask,
} from "../src/lib/tasks";
import { parseWorkflowSnapshot, findTransitionFor } from "../src/lib/onshape/workflow-snapshot";
import { formatPropertyValue, isStructuredValue } from "../src/lib/onshape/task-values";
import { priorityRank, priorityWeight } from "../src/components/TaskPriority";
import {
  objectTypeCode, objectTypeName, resolveTaskCommentContext, taskCommentObjectType,
} from "../src/lib/onshape/object-types";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-tasks";

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [Task, Part, User, ActivityLog]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }
  await MockOnshapeTask.deleteMany({ companyId: COMPANY });

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Task Co" });
  const eid = String(ent._id);
  const user: any = await User.create({
    enterpriseId: ent._id, email: "worker@test", passwordHash: "x", name: "Wendy", role: "admin",
  });

  /* A part the task can be about, so the item resolution has something to find. */
  const part: any = await Part.create({
    enterpriseId: ent._id, documentId: "dTask", elementId: "eTask", partId: "TP1",
    number: "PN-09001", name: "Bracket", kind: "part", lifecycleState: "In Work",
  });

  /*
   * The properties a live task carries, in the two places Onshape keeps them.
   *
   * Comment and Assigned to are in `workflowInfo.properties`; the rest are in
   * `properties`. PLM merges them, and the simulator holds the merged set —
   * which is how a comment can be written at all, since it is a write to the
   * workflow's Comment property.
   */
  const LIVE_PROPS = (over = {}) => [
    { propertyId: "57f3fb8efa3416c06701d60d", name: "Name", valueType: "STRING",
      editable: true, required: true, enumValues: [], value: "" },
    { propertyId: "57f3fb8efa3416c06701d611", name: "State", valueType: "ENUM",
      editable: false, required: true, value: "1",
      enumValues: [{ value: "1", label: "Pending" }, { value: "2", label: "Released" }] },
    { propertyId: "57f3fb8efa3416c06701d62c", name: "Priority", valueType: "ENUM",
      editable: true, required: false, value: "0",
      enumValues: [
        { value: "0", label: "Low" }, { value: "1", label: "Medium" },
        { value: "2", label: "High" }, { value: "3", label: "Very high" },
      ] },
    /*
     * Task State — the property Onshape records progress in, since its task
     * workflow has no in-progress state. The live tenant's exact options,
     * including the gap at 4.
     */
    { propertyId: "57f3fb8efa3416c06701d62d", name: "Task State", valueType: "ENUM",
      editable: true, required: false, value: "1",
      enumValues: [
        { value: "0", label: "New" }, { value: "1", label: "Assigned" },
        { value: "2", label: "In Work" }, { value: "3", label: "Completed" },
        { value: "5", label: "Closed" }, { value: "6", label: "Canceled" },
      ] },
    /* The workflow's, and the one a comment is written to. */
    { propertyId: "594964df040fc85d2b418145", name: "Comment", valueType: "STRING",
      editable: true, required: false, enumValues: [], value: "" },
    { propertyId: "TASK_APPROVERS", name: "Assigned to", valueType: "USER",
      editable: true, required: true, enumValues: [], value: [] },
    ...(Array.isArray(over) ? over : []),
  ];

  await MockOnshapeTask.create({
    companyId: COMPANY, taskId: "t-1", name: "Check the bracket", properties: LIVE_PROPS(),
    description: "Wall is thin", state: "Open", status: 2, taskType: "GENERAL",
    /*
     * A tenant whose task workflow DOES define a start transition. Onshape's
     * stock one does not — see workflowStyle on the model — and this task
     * exists to exercise the intent matching that keeps "start" from being
     * treated as "reopen" when both are SUBMIT.
     */
    workflowStyle: "extended",
    documentId: "dTask", documentName: "Bracket Doc", elementId: "eTask",
    creatorEmail: "des@test", creatorName: "Des",
    assignees: [{ onshapeUserId: "u1", email: "worker@test", name: "Wendy", acted: false }],
    items: [{ label: "Bracket", documentId: "dTask", elementId: "eTask", partId: "TP1" }],
    comments: [{
      id: "c-1", message: "From Onshape", authorEmail: "des@test", authorName: "Des",
      createdAt: new Date(Date.now() - 1000), objectType: 14,
    }],
  });
  /* A task about nothing PLM tracks, which is a normal thing. */
  await MockOnshapeTask.create({
    companyId: COMPANY, taskId: "t-2", name: "Tidy the document", state: "Resolved",
    properties: LIVE_PROPS(),
    documentId: "dOther", documentName: "Other Doc",
    items: [{ label: "Some tab", documentId: "dOther", elementId: "eOther", partId: "" }],
  });

  const client = new MockOnshapeClient(COMPANY, {
    id: "u-svc", email: "svc@test", name: "Service",
  });

  console.log("\nThe workflow snapshot is read by the shared parser");
  {
    const live = await client.getTask("t-1");
    check("the state comes through", live.state === "Open", live.state);
    check("so do the transitions", live.availableActions.length > 0,
      JSON.stringify(live.availableActions));
    /*
     * The id and the type differ, deliberately. A caller that posts the type
     * gets nothing — which is exactly how the release transition failed, and
     * why the simulator mirrors the distinction.
     */
    /*
     * The real tenant's ids: COMPLETE (type APPROVE) and OS_DISCARD (type
     * DELETE). Pinned against what a live task actually offers, rather than
     * against ids this test invented — matching is by type, so an invented id
     * would pass while hiding a client that conflates the two.
     */
    const complete = live.availableActions.find((a) => a.type === "APPROVE");
    check("an action's id differs from its type",
      complete?.id === "COMPLETE" && complete?.type === "APPROVE",
      JSON.stringify(complete));
    check("findTransitionFor picks it by type",
      findTransitionFor(live.availableActions.map((a) => ({ ...a })), "complete", ["APPROVE"])?.id === "COMPLETE");
    check("and a discard is offered as OS_DISCARD",
      live.availableActions.some((a) => a.id === "OS_DISCARD" && a.type === "DELETE"),
      JSON.stringify(live.availableActions.map((a) => a.id)));

    /* The same parser handles a release package's snapshot shape. */
    const snap = parseWorkflowSnapshot({
      workflow: { state: { displayName: "Pending" }, actions: [{ type: "APPROVE", action: "RELEASE", label: "Release" }] },
    });
    check("and it still reads a release package's shape",
      snap.state === "Pending" && snap.actions[0].id === "RELEASE",
      JSON.stringify(snap));

    /*
     * A finished task's `workflow.actions` is genuinely `[]` — Complete,
     * frozen, nothing left to do — not an absent field. Requiring a
     * non-empty array to count as "found" used to treat that correct answer
     * as a miss and fall through every candidate, logging a false "NO
     * actions found" warning (with a full shape dump) for every closed task
     * an import brought in.
     */
    const finished = parseWorkflowSnapshot(
      { workflow: { state: { displayName: "Complete" }, actions: [] } },
      { label: "finished-task-probe" }
    );
    check("an empty actions array is read as the real answer, not a miss",
      finished.actionsFrom === "workflow.actions" && finished.actions.length === 0,
      JSON.stringify(finished));
  }

  console.log("\nPulling brings tasks in, with their items resolved");
  {
    const r = await pullTasks(eid, { client, trigger: "test" });
    check("both tasks came in", r.pulled === 2, JSON.stringify(r));
    check("both were created", r.created === 2, String(r.created));

    const t: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    check("the state is Onshape's", t.state === "Open", t.state);
    check("the item resolved to a PLM part",
      String(t.items[0].partId) === String(part._id), JSON.stringify(t.items[0]));
    check("the comment came with it", t.comments.length === 1, String(t.comments.length));
    check("marked as having come from Onshape", t.comments[0].origin === "onshape");

    const t2: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-2" }).lean();
    /*
     * An item PLM does not track is kept as a label rather than dropped. A task
     * about something outside PLM is normal, and an empty item list would read
     * as a parsing failure.
     */
    check("an item PLM does not track is still named",
      t2.items[0].partId === null && t2.items[0].label === "Some tab",
      JSON.stringify(t2.items[0]));
  }

  console.log("\nRe-reading merges the thread rather than duplicating it");
  {
    const before: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    await pullTasks(eid, { client, trigger: "test" });
    const after: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    check("the comment count did not grow", after.comments.length === before.comments.length,
      `${before.comments.length} -> ${after.comments.length}`);
    check("and the task was updated, not recreated",
      String(after._id) === String(before._id));
  }

  console.log("\nCommenting from PLM reaches Onshape");
  {
    const t: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    const r = await commentOnTask(eid, String(t._id), "Checked — 3mm is fine", {
      userId: String(user._id), email: user.email, name: user.name,
    });
    check("it was accepted", r.ok && r.pushed, JSON.stringify(r));

    const after: any = await Task.findOne({ _id: t._id }).lean();
    const mine = after.comments.find((c: any) => c.origin === "plm");
    check("it is in the thread", !!mine);
    check("attributed to the person who wrote it", mine.authorEmail === "worker@test",
      mine.authorEmail);
    check("no longer pending", mine.pushPending === false, String(mine.pushPending));
    check("and it carries Onshape's id, which is what stops it duplicating",
      !!mine.onshapeCommentId, String(mine.onshapeCommentId));

    /* Onshape has it too, and a re-read must not add a second copy. */
    const live = await client.getTask("t-1");
    check("Onshape has the comment",
      live.comments.some((c) => c.message.includes("3mm")),
      JSON.stringify(live.comments.map((c) => c.message)));
    await pullTasks(eid, { client, trigger: "test" });
    const merged: any = await Task.findOne({ _id: t._id }).lean();
    check("re-reading does not duplicate it",
      merged.comments.filter((c: any) => c.message.includes("3mm")).length === 1,
      JSON.stringify(merged.comments.map((c: any) => c.message)));
  }

  console.log("\nA comment is a write to the workflow's Comment property");
  {
    /*
     * The mechanism, read off a live tenant's network traffic:
     *
     *   POST /tasks/{tid}
     *   { propertyValues: [{ propertyId: <Comment>, value: "<text>" }] }
     *
     * and the task comes back with the message appended to its `comments`.
     *
     * Three rounds went into `POST /comments` before this — 500, then 404,
     * then 400 for every objectType tried — because the Comment property
     * lives in `workflowInfo.properties` and PLM was reading only the
     * top-level `properties`. Nothing was wrong with the request except the
     * endpoint.
     */
    const t: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    check("PLM sees the workflow's Comment property",
      (t.properties ?? []).some((p: any) => p.name === "Comment"),
      JSON.stringify((t.properties ?? []).map((p: any) => p.name)));
    check("and knows the task is commentable", t.commentable === true, String(t.commentable));

    const before = (await client.getTask("t-1")).comments.length;
    const posted = await client.commentOnTask("t-1", "via the property", {});
    check("the comment is created", posted.message === "via the property", posted.message);

    const live = await client.getTask("t-1");
    check("it is on the task's thread", live.comments.length === before + 1,
      `${before} -> ${live.comments.length}`);
    /*
     * 10, which is what a live tenant returned — not 14. This is the evidence
     * that BTMetadataObjectType's ordinals are not the comment API's codes,
     * and the reason that inference is gone.
     */
    check("Onshape's own objectType for it is 10, not 14",
      posted.objectType === 10, String(posted.objectType));
    check("the Comment property is left empty afterwards",
      live.properties.find((p) => p.name === "Comment")?.value === "",
      String(live.properties.find((p) => p.name === "Comment")?.value));

    /* A workflow with no Comment property has nowhere to put one. */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-nocomment", name: "No comment property",
      state: "Open", documentId: "dX",
      properties: [
        { propertyId: "p-n", name: "Name", valueType: "STRING", editable: true,
          required: true, enumValues: [], value: "x" },
      ],
    });
    let refused: string | null = null;
    try {
      await client.commentOnTask("t-nocomment", "nowhere to go", {});
    } catch (e: any) {
      refused = String(e?.message ?? e);
    }
    check("a workflow without one refuses the comment", !!refused, "it was accepted");
    check("and says a comment is a property write",
      /property/i.test(refused ?? ""), String(refused));
  }

  console.log("\nA comment Onshape refuses is kept, not lost");
  {
    const t: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    /*
     * Removing the task from the simulator makes the push fail the way an
     * unreachable or unauthorised Onshape would. What must not happen is that
     * the text somebody typed disappears with the error.
     */
    const backup: any = await MockOnshapeTask.findOne({ companyId: COMPANY, taskId: "t-1" }).lean();
    await MockOnshapeTask.deleteOne({ companyId: COMPANY, taskId: "t-1" });

    const r = await commentOnTask(eid, String(t._id), "This one cannot be sent", {
      userId: String(user._id), email: user.email,
    });
    check("the call reports success for the local save", r.ok, JSON.stringify(r));
    check("but says it was not pushed", !r.pushed, String(r.pushed));
    check("and names the reason", !!r.error, String(r.error));

    const after: any = await Task.findOne({ _id: t._id }).lean();
    const unsent = after.comments.find((c: any) => c.message === "This one cannot be sent");
    check("the comment is still there", !!unsent);
    check("marked unsent, so the thread does not lie about it",
      unsent.pushPending === true, String(unsent.pushPending));
    check("the task records the failure", after.pushPending === true);

    delete (backup as any)._id;
    await MockOnshapeTask.create(backup);
  }

  console.log("\nCompleting a task transitions it in Onshape");
  {
    const t: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    const r = await transitionTask(eid, String(t._id), {
      intent: "complete", actor: { email: user.email },
    });
    check("it succeeded", r.ok, r.message);
    check("the id used was the action's, not its type", r.used === "COMPLETE", String(r.used));
    check("the state moved", r.state === "Resolved", r.state);

    const live = await client.getTask("t-1");
    check("Onshape agrees", live.state === "Resolved", live.state);
    const after: any = await Task.findOne({ _id: t._id }).lean();
    check("and PLM's copy was updated from Onshape, not assumed",
      after.state === "Resolved", after.state);
    check("the resolver is recorded", !!after.resolvedAt);

    /* The transitions on offer changed with the state. */
    check("a resolved task offers reopen",
      after.availableActions.some((a: any) => a.id === "REOPEN"),
      JSON.stringify(after.availableActions));
  }

  console.log("\nA transition the task does not offer is refused with what is");
  {
    const t: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    const r = await transitionTask(eid, String(t._id), {
      intent: "start", actor: { email: user.email },
    });
    /*
     * `start` and `reopen` both correspond to a SUBMIT transition, so matching
     * on type alone made them the same request — and "start" on a Resolved
     * task reopened it. That is a lot of consequence for a word, so the intent
     * is refused rather than reinterpreted.
     */
    check("it is refused", !r.ok, JSON.stringify(r));
    check("the message says there is nothing to start",
      /nothing to start/i.test(r.message), r.message);
    check("and lists what is available", /Reopen/i.test(r.message), r.message);
    /*
     * Refusing must not leave PLM's copy stale: the refusal came from a fresh
     * read, and that read is worth keeping.
     */
    check("the state is still right", r.state === "Resolved", r.state);

    const untouched: any = await Task.findOne({ _id: t._id }).lean();
    check("and the task was not reopened behind the refusal",
      untouched.state === "Resolved", untouched.state);

    /* Reopen, asked for as itself, works. */
    const re = await transitionTask(eid, String(t._id), {
      intent: "reopen", actor: { email: user.email },
    });
    check("reopen does what it says", re.ok && re.state === "Open", JSON.stringify(re));
    check("using the reopen action", re.used === "REOPEN", String(re.used));

    /* And now start is a sensible request. */
    const st = await transitionTask(eid, String(t._id), {
      intent: "start", actor: { email: user.email },
    });
    check("start works on an open task", st.ok && st.state === "In Progress", JSON.stringify(st));
    check("using the start action, not reopen", st.used === "START", String(st.used));
  }

  console.log("\nA task's due date and priority are properties, not fields");
  {
    /*
     * Read off a live tenant: a task has no top-level due date or priority.
     * They are metadata properties, with ids, value types and their own
     * editability — which is why PLM's first task UI had no due date at all,
     * and why editing one goes through updateTask's propertyValues.
     */
    await MockOnshapeTask.updateOne(
      { companyId: COMPANY, taskId: "t-1" },
      { $set: { properties: [
        { propertyId: "p-due", name: "Due date", valueType: "DATE",
          editable: true, required: false, enumValues: [], value: null },
        { propertyId: "p-pri", name: "Priority", valueType: "ENUM",
          editable: true, required: false, value: "0",
          enumValues: [{ value: "0", label: "Normal" }, { value: "1", label: "High" }] },
        { propertyId: "p-state", name: "State", valueType: "ENUM",
          editable: false, required: true, value: "1",
          enumValues: [{ value: "1", label: "Open" }] },
      ] } }
    );
    await pullTasks(eid, { client, trigger: "test" });

    const t: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-1" }).lean();
    check("the properties came in", (t.properties ?? []).length === 3,
      String((t.properties ?? []).length));
    check("an enum property carries its labels",
      t.properties.find((p: any) => p.propertyId === "p-pri")?.enumValues?.length === 2);
    check("and Onshape's own editability", 
      t.properties.find((p: any) => p.propertyId === "p-state")?.editable === false);

    const due = new Date("2026-12-01").toISOString();
    const r = await updateTaskFields(
      eid, String(t._id), { propertyValues: { "p-due": due, "p-pri": "1" } },
      { email: user.email }
    );
    check("editable properties can be set", r.ok, r.message);
    check("and the message names them by name, not by id",
      /Due date/.test(r.message) && !/p-due/.test(r.message), r.message);

    const after: any = await Task.findOne({ _id: t._id }).lean();
    check("the due date is stored",
      String(after.properties.find((p: any) => p.propertyId === "p-due")?.value).startsWith("2026-12-01"),
      String(after.properties.find((p: any) => p.propertyId === "p-due")?.value));
    check("and Onshape has it", (await client.getTask("t-1")).properties
      .find((p) => p.propertyId === "p-pri")?.value === "1");

    /*
     * A read-only property is refused with its NAME. Onshape would refuse it
     * too, but its message names an id rather than the field somebody was
     * looking at — and a UI that offers an edit it cannot make is worse than
     * one that does not offer it.
     */
    const ro = await updateTaskFields(
      eid, String(t._id), { propertyValues: { "p-state": "2" } }, { email: user.email }
    );
    check("a read-only property is refused", !ro.ok, ro.message);
    check("by name, and saying who owns it",
      /"State" is read-only/.test(ro.message) && /workflow/i.test(ro.message), ro.message);

    const unknown = await updateTaskFields(
      eid, String(t._id), { propertyValues: { "p-nope": "x" } }, { email: user.email }
    );
    check("an unknown property is refused too", !unknown.ok, unknown.message);
  }

  console.log("\nA task whose workflow has no Comment property keeps it in PLM");
  {
    /*
     * This used to test "no Onshape document", which was the wrong rule: a
     * comment is a workflow property write, so what decides it is whether the
     * workflow declares a Comment property — not whether the task belongs to a
     * document. The GENERAL task that started all of this has no document and
     * comments perfectly well.
     */
    await pullTasks(eid, { client, trigger: "test" });
    const t: any = await Task.findOne({
      enterpriseId: ent._id, onshapeTaskId: "t-nocomment",
    }).lean();
    check("PLM knows it cannot be commented on", t.commentable === false,
      String(t.commentable));

    const r = await commentOnTask(eid, String(t._id), "kept locally", {
      userId: String(user._id), email: user.email,
    });
    check("the comment is accepted", r.ok, JSON.stringify(r));
    check("but not pushed", !r.pushed);
    check("and it is not reported as an error", r.error === null, String(r.error));

    const after: any = await Task.findOne({ _id: t._id }).lean();
    const c = after.comments.find((x: any) => x.message === "kept locally");
    check("the comment is kept", !!c);
    check("marked PLM-only rather than pending",
      c.plmOnly === true && c.pushPending === false,
      JSON.stringify({ plmOnly: c.plmOnly, pushPending: c.pushPending }));
    check("and the task is not left looking broken", !after.pushPending);
  }

  console.log("\nDropping a card on a column moves it in Onshape");
  {
    /*
     * A column groups states rather than being one, so a drop asks for
     * "whatever transition lands it there" — and Onshape's workflow decides
     * whether there is one. What matters is that a refusal is honest: a card
     * left in the new column after a refused move would be a lie about
     * Onshape's state.
     */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-drag", name: "Draggable", state: "Open",
      documentId: "dX", properties: LIVE_PROPS(),
    });
    await pullTasks(eid, { client, trigger: "test" });
    const t: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-drag" }).lean();

    /*
     * t-drag follows Onshape's STOCK workflow, which has no start transition —
     * so this is the exact move that failed on a live tenant with "Onshape
     * offers no start transition on this task from state Open. Available:
     * Complete, Discard." It is a property write, not a transition.
     */
    const offered = (await client.getTask("t-drag")).availableActions.map((a: any) => a.id);
    check("the stock workflow really has no start transition",
      !offered.includes("START"), offered.join(","));

    const toProgress = await moveTaskToColumn(eid, String(t._id), "In Progress", { email: user.email });
    check("Open -> In Progress works anyway", toProgress.ok, toProgress.message);
    check("and reports the column it landed in", toProgress.column === "In Progress",
      String(toProgress.column));

    /*
     * The workflow state is UNCHANGED — that is the point. Onshape's task
     * workflow has one open state, and progress within it lives in the Task
     * State property.
     */
    const live = await client.getTask("t-drag");
    check("the workflow state is untouched", live.state === "Open", live.state);
    const stateProp = live.properties.find((p: any) => /task state/i.test(p.name));
    check("and Onshape recorded it in the Task State property",
      String(stateProp?.value) === "2",
      `${stateProp?.name}=${stateProp?.value}`);

    /*
     * And the board must READ it the same way, or the card springs back to
     * Open the moment the page refreshes and the move looks like it failed.
     */
    const stored: any = await Task.findOne({ _id: t._id }).lean();
    check("the board reads the card as In Progress", columnForTask(stored) === "In Progress",
      columnForTask(stored));
    check("even though its workflow state still says Open", stored.state === "Open", stored.state);

    /* Dropping it back on Open returns the property, not the workflow. */
    const back = await moveTaskToColumn(eid, String(t._id), "Open", { email: user.email });
    check("and it can be moved back to Open", back.ok && back.column === "Open",
      `${back.ok} ${back.column} ${back.message}`);
    const backProp = (await client.getTask("t-drag")).properties
      .find((p: any) => /task state/i.test(p.name));
    check("which sets Task State back to Assigned", String(backProp?.value) === "1",
      String(backProp?.value));

    await moveTaskToColumn(eid, String(t._id), "In Progress", { email: user.email });
    const toResolved = await moveTaskToColumn(eid, String(t._id), "Resolved", { email: user.email });
    check("In Progress -> Resolved works", toResolved.ok, toResolved.message);
    check("via the APPROVE transition", toResolved.state === "Resolved", toResolved.state);

    /*
     * A move the workflow does not offer. From Resolved the only action is
     * REOPEN, so there is no route to Rejected — and saying which actions ARE
     * available is the difference between a card that springs back for a
     * reason and one that springs back mysteriously.
     */
    const impossible = await moveTaskToColumn(eid, String(t._id), "Rejected", { email: user.email });
    check("a move the workflow has no transition for is refused", !impossible.ok,
      impossible.message);
    check("and the refusal lists what is available",
      /Reopen/i.test(impossible.message), impossible.message);
    check("the task is left where it was",
      (await client.getTask("t-drag")).state === "Resolved");

    /* Dropping on the column it is already in does nothing. */
    const same = await moveTaskToColumn(eid, String(t._id), "Resolved", { email: user.email });
    check("dropping on its own column is not an error", same.ok || /no .*transition/i.test(same.message),
      same.message);
  }

  console.log("\nDeleting tasks, in PLM and in Onshape");
  {
    /*
     * Two separate things, deliberately. Removing PLM's copy tidies a mirror
     * and a sync brings it back; deleting in Onshape destroys a record and
     * cannot be undone.
     */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-del1", name: "Delete me", state: "Open",
      documentId: "dX", properties: LIVE_PROPS(),
    });
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-del2", name: "Tidy me", state: "Open",
      documentId: "dX", properties: LIVE_PROPS(),
    });
    /* A task Onshape refuses to delete — a live one reported exactly this. */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-keep", name: "Not deletable", state: "Open",
      documentId: "dX", deletable: false, properties: LIVE_PROPS(),
    });
    await pullTasks(eid, { client, trigger: "test" });

    const tidy: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-del2" }).lean();
    const plmOnly = await removeTasks(eid, [String(tidy._id)], {
      alsoOnshape: false, actor: { email: user.email },
    });
    check("removing from PLM only works", plmOnly.removedFromPlm === 1, JSON.stringify(plmOnly));
    check("nothing was deleted in Onshape", plmOnly.deletedInOnshape === 0);
    check("it is gone from PLM",
      !(await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-del2" }).lean()));
    /*
     * And Onshape still has it, which is the whole point of offering the two
     * separately — this is a tidy-up, not a deletion.
     */
    check("but Onshape still has it", !!(await client.getTask("t-del2")));
    await pullTasks(eid, { client, trigger: "test" });
    check("so a sync brings it back",
      !!(await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-del2" }).lean()));

    const del: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-del1" }).lean();
    const keep: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-keep" }).lean();
    check("PLM knows which one Onshape will not delete",
      del.deletable === true && keep.deletable === false,
      `${del.deletable}/${keep.deletable}`);

    const both = await removeTasks(eid, [String(del._id), String(keep._id)], {
      alsoOnshape: true, actor: { email: user.email },
    });
    check("the deletable one is deleted in Onshape", both.deletedInOnshape === 1,
      JSON.stringify(both));
    /*
     * The undeletable one is DISCARDED rather than refused.
     *
     * This is the behaviour that changed after a live tenant reported
     * `deletable: false` for every one of its 18 tasks: PLM used to refuse,
     * name the workflow's discard transition in the message, and leave the
     * person to go and run it by hand. Naming the way out and not taking it is
     * a worse answer than taking it, so PLM now runs that transition — and
     * counts it separately, because a discard is not a deletion.
     */
    check("the undeletable one is discarded instead of refused",
      both.discardedInOnshape === 1, JSON.stringify(both));
    check("so nothing was refused", both.failures.length === 0,
      JSON.stringify(both.failures));
    check("both left PLM", both.removedFromPlm === 2, String(both.removedFromPlm));
    check("the deleted one is gone from Onshape",
      !(await client.getTask("t-del1").catch(() => null)));
    /*
     * The discarded one still EXISTS in Onshape — that is the difference from
     * a deletion — but it is in a terminal state and off the board.
     */
    const discarded = await client.getTask("t-keep").catch(() => null);
    check("the discarded one still exists in Onshape", !!discarded);
    check("but in a state that closes it", isClosed(discarded!.state),
      discarded!.state);
    check("and PLM's copy is gone",
      !(await Task.findOne({ _id: keep._id }).lean()));
    check("the discard is on the record",
      !!(await ActivityLog.findOne({
        enterpriseId: ent._id, trigger: "task", action: "transitioned",
        message: { $regex: "discarded" },
      }).lean()));
  }

  console.log("\nWhen Onshape will do nothing, the refusal says which case it is");
  {
    /*
     * Three different dead ends, three different things to tell somebody.
     * They were one message — "Onshape reports this task as not deletable" —
     * which was true and useless, and was shown in a slot the next board
     * refresh wiped a moment later.
     */

    /* Closed, so the workflow offers nothing at all. */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-closed", name: "Long since done",
      state: "Resolved", deletable: false, properties: LIVE_PROPS(),
    });
    /* Lists but will not open — 6 of the live tenant's 18 were like this. */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-unopenable", name: "Orphaned record",
      state: "Open", deletable: false, hydrateFails: true, properties: LIVE_PROPS(),
      taskType: "GENERAL",
    });
    await upsertTask(eid, {
      ...(await client.getTask("t-closed")),
    } as any);
    /*
     * Stored directly, since the point is a task PLM holds and Onshape will
     * not open — which is exactly what the sync now refuses to create.
     */
    await Task.create({
      enterpriseId: ent._id, onshapeTaskId: "t-unopenable", name: "Orphaned record",
      state: "Open", taskType: "GENERAL", deletable: false, availableActions: [],
    });

    const closed: any = await Task.findOne({
      enterpriseId: ent._id, onshapeTaskId: "t-closed",
    }).lean();
    const orphan: any = await Task.findOne({
      enterpriseId: ent._id, onshapeTaskId: "t-unopenable",
    }).lean();

    const r = await removeTasks(eid, [String(closed._id), String(orphan._id)], {
      alsoOnshape: true, actor: { email: user.email },
    });

    check("neither could be removed", r.removedFromPlm === 0, JSON.stringify(r));
    check("both are reported", r.failures.length === 2, JSON.stringify(r.failures));

    const closedFail = r.failures.find((f) => f.name === "Long since done")!;
    const orphanFail = r.failures.find((f) => f.name === "Orphaned record")!;

    check("a closed task says the workflow offers no way out",
      /offers no way to discard/i.test(closedFail.reason), closedFail.reason);
    check("and names the state it is stuck in",
      /Resolved/.test(closedFail.reason), closedFail.reason);
    check("an unopenable task says Onshape cannot open it",
      /can no longer open/i.test(orphanFail.reason), orphanFail.reason);
    /*
     * And tells them the thing that actually works. Removing PLM's copy is
     * permanent for this one, because the sync skips what Onshape will not
     * open — the opposite of what the old blanket wording promised.
     */
    check("and that removing PLM's copy will stick",
      /clear it for good/i.test(orphanFail.reason), orphanFail.reason);

    /* The refusal reaches the log, which is where it was missing entirely. */
    const logged: any = await ActivityLog.findOne({
      enterpriseId: ent._id, trigger: "task", action: "deleted", ok: false,
    }).sort({ createdAt: -1 }).lean();
    check("the refusal is written to the log", !!logged);
    check("with the reasons in it, not just a count",
      /can no longer open|offers no way/i.test(logged?.message ?? ""),
      String(logged?.message).slice(0, 160));

    /* Cleared by hand, and it stays cleared. */
    const plmOnly = await removeTasks(eid, [String(orphan._id)], {
      alsoOnshape: false, actor: { email: user.email },
    });
    check("removing PLM's copy works", plmOnly.removedFromPlm === 1);
    check("and says a task Onshape cannot open stays out",
      /stays out|stay out of PLM/i.test(plmOnly.message), plmOnly.message);
    await pullTasks(eid, { client, trigger: "test" });
    check("a sync does not bring the unopenable one back",
      !(await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-unopenable" }).lean()));
  }

  console.log("\nA discarded task does not come back as outstanding work");
  {
    /*
     * `columnFor` matched nothing on a discarded state and defaulted to Open,
     * so a task PLM had just discarded reappeared on the board as work to do.
     */
    check("Discarded is a closed column", columnFor("Discarded") === "Rejected");
    check("and isClosed agrees", isClosed("Discarded"));
    check("Onshape's own wording too", isClosed("OS_DISCARDED"));
  }

  console.log("\nBoard grouping is by meaning, not by exact state name");
  {
    check("Open", columnFor("Open") === "Open");
    check("In Progress", columnFor("In Progress") === "In Progress");
    check("Resolved", columnFor("Resolved") === "Resolved");
    check("Rejected", columnFor("Rejected") === "Rejected");
    /*
     * A tenant's workflow can name states anything, so the mapping is by word
     * rather than by exact match — and an unrecognised state lands in Open
     * rather than disappearing from the board.
     */
    check("a tenant's own wording still groups", columnFor("Pending review") === "In Progress");
    check("'Complete' groups with resolved", columnFor("Complete") === "Resolved");
    check("something unrecognised is visible rather than lost",
      columnFor("Awaiting foundry") === "Open");
    check("an empty state does not vanish", columnFor("") === "Open");
    check("isClosed agrees", isClosed("Resolved") && isClosed("Rejected") && !isClosed("Open"));
  }

  console.log("\nThe page size respects Onshape's maximum, and pages are followed");
  {
    /*
     * Onshape caps this endpoint at 100 per page and enforces it: asking for
     * 200 earned a 400 naming `BTRestTask.getActionItems.limit`. The maximum
     * was declared in the OpenAPI definition all along — the inspection that
     * set 200 read the parameter's default and not its maximum.
     *
     * The clamp on its own would trade a loud failure for a quiet one, so what
     * matters more is the second half: an enterprise with more tasks than fit
     * in a page must not mirror the first hundred and never mention the rest.
     */
    /*
     * `getTask` must not go through `listTasks`, or the page log is polluted:
     * pullTasks reads every task individually, and the first version of this
     * stub counted each of those as another page request.
     */
    const bare = (id: string) => ({
      id, name: `Paged ${id}`, description: "",
      state: "Open", status: 2, taskType: "", documentId: "", documentName: "",
      elementId: "", workspaceId: null, versionId: null, objectId: "",
      creatorEmail: "", creatorName: "", assignees: [], resolvedAt: null,
      resolvedByEmail: "", items: [], comments: [], availableActions: [], raw: {},
    });

    const pages: { limit?: number; offset?: number }[] = [];
    let total = 0;

    const stub = {
      async listTasks(o: { limit?: number; offset?: number } = {}) {
        pages.push({ limit: o.limit, offset: o.offset });
        if ((o.limit ?? 0) > 100) {
          // What the real endpoint does, so a regression fails here rather
          // than in somebody's server log.
          throw new Error("Onshape GET /tasks -> 400: must be less than or equal to 100");
        }
        const from = o.offset ?? 0;
        const size = o.limit ?? 50;
        return Array.from(
          { length: Math.max(0, Math.min(size, total - from)) },
          (_, i) => bare(`paged-${from + i}`)
        );
      },
      async getTask(id: string) {
        return bare(id);
      },
    } as unknown as import("../src/lib/onshape/types").OnshapeClient;

    /* One short page: a single request, and no 400. */
    total = 7;
    pages.length = 0;
    const small = await pullTasks(eid, { client: stub, trigger: "test" });
    check("a small tenant takes one page", pages.length === 1, JSON.stringify(pages));
    check("and never asks for more than 100",
      pages.every((c) => (c.limit ?? 0) <= 100), JSON.stringify(pages));
    check("all of them came in", small.pulled === 7, String(small.pulled));

    /* More than a page: the offsets must advance. */
    total = 230;
    pages.length = 0;
    const big = await pullTasks(eid, { client: stub, trigger: "test" });
    check("more than one page is fetched", pages.length === 3,
      JSON.stringify(pages.map((c) => c.offset)));
    check("the offsets advance by the page size",
      JSON.stringify(pages.map((c) => c.offset)) === "[0,100,200]",
      JSON.stringify(pages.map((c) => c.offset)));
    check("nothing is silently dropped", big.pulled === 230, String(big.pulled));

    /*
     * Exactly a multiple of the page size needs one more request to learn it
     * has ended — a loop that stopped on "a full page" would drop the tail.
     */
    total = 200;
    pages.length = 0;
    const exact = await pullTasks(eid, { client: stub, trigger: "test" });
    check("an exact multiple takes one extra request to terminate",
      pages.length === 3, String(pages.length));
    check("with the right count", exact.pulled === 200, String(exact.pulled));

    await Task.deleteMany({ enterpriseId: ent._id, onshapeTaskId: /^paged-/ });
  }

  console.log("\nA task with no assignee or items does not break anything");
  {
    /*
     * Counted as a delta, not against a fixed total. An absolute count here
     * breaks whenever a section above adds a task — which it did, and the
     * failure said nothing about this test's actual subject.
     */
    const before = (await pullTasks(eid, { client, trigger: "test" })).pulled;
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-3", name: "Bare task", state: "Open",
    });
    const r = await pullTasks(eid, { client, trigger: "test" });
    check("it came in", r.pulled === before + 1, `${before} -> ${r.pulled}`);
    const bare: any = await Task.findOne({ enterpriseId: ent._id, onshapeTaskId: "t-3" }).lean();
    check("with no assignees", (bare.assignees ?? []).length === 0);
    check("no items", (bare.items ?? []).length === 0);
    check("and no comments", (bare.comments ?? []).length === 0);
  }

  /* ====================================================================== */
  /* The wider view: POST /tasks/find                                        */
  /*                                                                        */
  /* getActionItems answers "what is on my plate", which is narrower than a  */
  /* board asks. On the live tenant it returned 8 tasks where the search     */
  /* returned 174 — so PLM syncing only the first was not a small gap, it    */
  /* was most of the data. These tests are about the union, and about the    */
  /* two things the search drags in that must NOT reach the board.          */
  /* ====================================================================== */

  console.log("\nThe search sees tasks the action-item list does not");
  {
    /* Assigned to nobody PLM syncs as: only the search will find it. */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-unassigned", name: "Found by search only",
      state: "Open", taskType: "GENERAL", properties: LIVE_PROPS(),
      visibleAsActionItem: false,
      documentId: "dTask", documentName: "Bracket Doc", elementId: "eTask",
      items: [{ label: "Bracket", documentId: "dTask", elementId: "eTask", partId: "TP1" }],
    });

    const listed = await client.listTasks({ limit: 100 });
    const found = await client.findTasks();
    check("the action-item list omits it",
      !listed.some((t) => t.id === "t-unassigned"),
      listed.map((t) => t.id).join(","));
    check("but the search returns it", found.some((f) => f.id === "t-unassigned"));
    check("and the search is a superset", found.length > listed.length,
      `find ${found.length} vs list ${listed.length}`);
    /*
     * The projection is not a task. The live search returns no workflow
     * snapshot at all, so promoting a row to an OnshapeTask would invent a
     * state and a set of transitions — which is why findTasks returns
     * FoundTask and anything needing those has to call getTask.
     */
    const row = found.find((f) => f.id === "t-unassigned")!;
    check("the row carries a type to filter on", row.taskType === "GENERAL", row.taskType);
    check("and a display state, not a workflow state",
      typeof (row as any).state === "undefined", JSON.stringify(Object.keys(row)));

    const r = await pullTasks(eid, { client, trigger: "test" });
    const stored: any = await Task.findOne({
      enterpriseId: ent._id, onshapeTaskId: "t-unassigned",
    }).lean();
    check("the sync stores it", Boolean(stored));
    /* Hydrated, not left as a projection — so it has usable transitions. */
    check("hydrated to a real state", stored?.state === "Open", stored?.state);
    check("with the transitions its state offers",
      (stored?.availableActions ?? []).length > 0);
    check("and the sync says where it came from",
      /found by search/i.test(r.message), r.message);
  }

  console.log("\nRelease packages stay off the task board");
  {
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-release", name: "REL-00009 approval",
      state: "Pending", taskType: "RELEASE", properties: LIVE_PROPS(),
      visibleAsActionItem: false,
      documentId: "dTask", documentName: "Bracket Doc",
    });

    check("RELEASE is not a mirrored type", !TASK_TYPES_PULLED.has("RELEASE"));
    check("GENERAL and TODO are",
      TASK_TYPES_PULLED.has("GENERAL") && TASK_TYPES_PULLED.has("TODO"));

    const found = await client.findTasks();
    check("the search does return it", found.some((f) => f.id === "t-release"));

    await pullTasks(eid, { client, trigger: "test" });
    const stored: any = await Task.findOne({
      enterpriseId: ent._id, onshapeTaskId: "t-release",
    }).lean();
    /*
     * 143 of the live tenant's 174 tasks were these. PLM already mirrors them
     * as releases, with their own page and numbering, so a board that listed
     * them too would bury the real work and show one record under two names.
     */
    check("but the sync leaves it out", !stored);
  }

  console.log("\nA task that lists but will not open is skipped, not stored blank");
  {
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-orphan", name: "", state: "",
      taskType: "GENERAL", visibleAsActionItem: false, hydrateFails: true,
    });

    let threw = false;
    try { await client.getTask("t-orphan"); } catch { threw = true; }
    check("reading it fails the way the live one does", threw);

    const r = await pullTasks(eid, { client, trigger: "test" });
    const stored: any = await Task.findOne({
      enterpriseId: ent._id, onshapeTaskId: "t-orphan",
    }).lean();
    /*
     * Seven of the live tenant's 31 real tasks were exactly this: orphaned
     * records with a null name that answer a read with a 500. Storing one puts
     * a nameless, actionless card on the board, which reads as a PLM bug
     * rather than as damaged data in Onshape.
     */
    check("it is not stored", !stored);
    check("and the sync says so rather than failing",
      /would not open/i.test(r.message), r.message);
  }

  /* ====================================================================== */
  /* Tasks in the context of a part                                          */
  /* ====================================================================== */

  console.log("\nA part knows the tasks against it");
  {
    const rows = await tasksForPart(eid, String(part._id));
    check("the task naming the part is found", rows.some((t) => t.onshapeTaskId === "t-1"),
      rows.map((t) => t.onshapeTaskId).join(","));
    check("the one about another document is not",
      !rows.some((t) => t.onshapeTaskId === "t-2"));
    check("it is marked as an item-level match",
      rows.find((t) => t.onshapeTaskId === "t-1")?.via === "item");
    /* Open before closed: the question is what is outstanding. */
    const opens = rows.map((t) => t.open);
    check("open tasks sort first", opens.slice().sort((a, b) => (a === b ? 0 : a ? -1 : 1)).join() === opens.join(),
      opens.join());

    const counts = await taskCountsForParts(eid, [String(part._id)]);
    const c = counts.get(String(part._id));
    check("the badge count agrees with the list",
      c?.total === rows.length, `${c?.total} vs ${rows.length}`);
    check("and counts only the open ones as open",
      c?.open === rows.filter((t) => t.open).length, JSON.stringify(c));
  }

  console.log("\nA task that arrived before its part still finds it");
  {
    /*
     * The ordinary order of events, and the case a resolved-link-only query
     * gets wrong: tasks are raised on CAD long before anybody files the part
     * in PLM, so `items.partId` is null for ever on those rows.
     */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-early", name: "Raised before PLM knew the part",
      state: "Open", taskType: "GENERAL", properties: LIVE_PROPS(),
      documentId: "dLate", documentName: "Late Doc", elementId: "eLate",
      items: [{ label: "Latecomer", documentId: "dLate", elementId: "eLate", partId: "LP1" }],
    });
    await pullTasks(eid, { client, trigger: "test" });

    const unresolved: any = await Task.findOne({
      enterpriseId: ent._id, onshapeTaskId: "t-early",
    }).lean();
    check("its link is unresolved, as expected",
      !unresolved.items[0].partId, String(unresolved.items[0].partId));

    /* Now the part shows up in PLM, as it eventually does. */
    const late: any = await Part.create({
      enterpriseId: ent._id, documentId: "dLate", elementId: "eLate", partId: "LP1",
      number: "PN-09002", name: "Latecomer", kind: "part", lifecycleState: "In Work",
    });

    const rows = await tasksForPart(eid, String(late._id));
    check("the part finds the task anyway",
      rows.some((t) => t.onshapeTaskId === "t-early"),
      rows.map((t) => t.onshapeTaskId).join(","));

    const counts = await taskCountsForParts(eid, [String(late._id)]);
    check("and so does the badge count", (counts.get(String(late._id))?.open ?? 0) === 1,
      JSON.stringify(counts.get(String(late._id))));

    /*
     * A sibling part in the SAME element must not inherit it. Document and
     * element alone would attach a task about one part in a Part Studio to
     * every part in it — the Onshape part id is what separates them.
     */
    const sibling: any = await Part.create({
      enterpriseId: ent._id, documentId: "dLate", elementId: "eLate", partId: "LP2",
      number: "PN-09003", name: "Sibling", kind: "part", lifecycleState: "In Work",
    });
    const sibRows = await tasksForPart(eid, String(sibling._id));
    check("a sibling in the same element does not inherit it",
      !sibRows.some((t) => t.onshapeTaskId === "t-early"),
      sibRows.map((t) => t.onshapeTaskId).join(","));
  }

  console.log("\nCounting is per part, not per mention");
  {
    /* Two items pointing at one part, plus a resolved link that also hits. */
    await MockOnshapeTask.create({
      companyId: COMPANY, taskId: "t-twice", name: "Names the bracket twice",
      state: "Open", taskType: "GENERAL", properties: LIVE_PROPS(),
      documentId: "dTask", documentName: "Bracket Doc", elementId: "eTask",
      items: [
        { label: "Bracket", documentId: "dTask", elementId: "eTask", partId: "TP1" },
        { label: "Bracket again", documentId: "dTask", elementId: "eTask", partId: "TP1" },
      ],
    });
    await pullTasks(eid, { client, trigger: "test" });

    const counts = await taskCountsForParts(eid, [String(part._id)]);
    const rows = await tasksForPart(eid, String(part._id));
    check("a task naming a part twice counts once",
      counts.get(String(part._id))?.total === rows.length,
      `${counts.get(String(part._id))?.total} counted vs ${rows.length} listed`);
    check("and appears once in the list",
      rows.filter((t) => t.onshapeTaskId === "t-twice").length === 1);
  }

  console.log("\nThe count query stays one read for a whole page");
  {
    const many = await Part.find({ enterpriseId: ent._id }).select("_id").lean();
    const counts = await taskCountsForParts(eid, many.map((p: any) => String(p._id)));
    check("every part with tasks is represented", counts.size >= 2, String(counts.size));
    check("a part with none is absent rather than zero",
      ![...counts.values()].some((v) => v.total === 0));
    /* Nothing asked for, nothing read — the empty-page case. */
    const none = await taskCountsForParts(eid, []);
    check("an empty page needs no query at all", none.size === 0);
  }

  console.log("\nPriority reads as a rank, by word before code");
  {
    /* The live tenant's list: 0=Low, 1=Medium, 2=High, 3=Very high. */
    check("Low", priorityRank("Low") === "low");
    check("Medium", priorityRank("Medium") === "medium");
    check("High", priorityRank("High") === "high");
    /*
     * "Very high" CONTAINS "high", so it has to be tested first — a naive
     * check ranks the most urgent tasks as merely high, which is the one
     * mistake a priority icon must not make.
     */
    check("Very high is not mistaken for High", priorityRank("Very high") === "very-high");
    check("nor is 'very high' in any casing", priorityRank("VERY HIGH") === "very-high");

    /* Another tenant's vocabulary still ranks. */
    check("Urgent ranks top", priorityRank("Urgent") === "very-high");
    check("Critical does too", priorityRank("Critical") === "very-high");
    check("Normal is the middle", priorityRank("Normal") === "medium");
    check("Trivial is the bottom", priorityRank("Trivial") === "low");

    /* A bare code, for a tenant whose labels did not come through. */
    check("code 3 is very high", priorityRank("3") === "very-high");
    check("code 0 is low", priorityRank("0") === "low");

    /* Nothing is nothing — no icon rather than a grey placeholder on every card. */
    check("no value ranks as nothing", priorityRank(null) === null);
    check("an empty string too", priorityRank("") === null);
    check("and an unrecognised word rather than a wrong guess",
      priorityRank("bananas") === null);

    /* The ordering the glyphs imply has to be the ordering the weights give. */
    const order = ["Very high", "High", "Medium", "Low", null]
      .map((v) => priorityWeight(v as any));
    check("weights descend with rank",
      order.every((w, i) => i === 0 || w < order[i - 1]), order.join(">"));
  }

  console.log("\nA property value is never rendered as [object Object]");
  {
    /* The two shapes a live task actually sends, verbatim. */
    const assignedTo = [
      { name: "Dan Designer", id: "6218ff92", approverName: "Gideon Paull",
        approvalDate: "2026-09-11T18:13:04.363+00:00", removable: true },
    ];
    const category = [
      { name: "Task", id: "60faf636", description: "Default category for object type Task",
        memberCategories: [{ name: "Onshape Task", id: "5f9890b7" }] },
    ];

    check("a USER array reads as the person's name",
      formatPropertyValue(assignedTo, { valueType: "USER" }) === "Dan Designer",
      formatPropertyValue(assignedTo, { valueType: "USER" }));
    check("a CATEGORY array reads as the category's name",
      formatPropertyValue(category, { valueType: "CATEGORY" }) === "Task",
      formatPropertyValue(category, { valueType: "CATEGORY" }));
    check("several people are joined",
      formatPropertyValue([{ name: "A" }, { name: "B" }]) === "A, B");

    /* The whole point: no path produces the string that started this. */
    for (const v of [assignedTo, category, { name: "x" }, [{ id: "only-an-id" }], [{}], {}]) {
      check(`no [object Object] for ${JSON.stringify(v).slice(0, 28)}`,
        !formatPropertyValue(v).includes("[object"), formatPropertyValue(v));
    }

    check("an empty array is a dash, not blank braces",
      formatPropertyValue([]) === "—");
    check("an object with nothing nameable is a dash too",
      formatPropertyValue([{}]) === "—", formatPropertyValue([{}]));
    check("an id is used when there is no name",
      formatPropertyValue([{ id: "abc" }]) === "abc");

    /* Scalars keep working exactly as before. */
    check("an enum still resolves to its label",
      formatPropertyValue("2", { enumValues: [{ value: "2", label: "In Work" }] }) === "In Work");
    check("a plain string is itself", formatPropertyValue("hello") === "hello");
    check("null is the empty marker", formatPropertyValue(null) === "—");
    check("and the marker is overridable", formatPropertyValue(null, { empty: "" }) === "");
    check("a boolean reads as a word", formatPropertyValue(true) === "Yes");

    /* And the structured check that decides input vs read-only line. */
    check("an array counts as structured", isStructuredValue(assignedTo));
    check("a string does not", !isStructuredValue("hello"));
    check("null does not", !isStructuredValue(null));
  }

  console.log("\nA task has two notions of progress, and the board reads both");
  {
    const LIVE_ENUM = [
      { value: "0", label: "New" }, { value: "1", label: "Assigned" },
      { value: "2", label: "In Work" }, { value: "3", label: "Completed" },
      { value: "5", label: "Closed" }, { value: "6", label: "Canceled" },
    ];
    const withState = (v: string, state = "Open") => ({
      state,
      properties: [{ propertyId: "p1", name: "Task State", value: v, editable: true, enumValues: LIVE_ENUM }],
    });

    /*
     * The workflow state says whether it is finished; the Task State property
     * says how far along it is. Onshape's stock task workflow has only OPEN
     * and COMPLETE, so a board that read the workflow alone had no way to
     * show "in progress" at all.
     */
    check("In Work reads as In Progress", columnForTask(withState("2")) === "In Progress");
    check("Assigned stays in Open", columnForTask(withState("1")) === "Open");
    check("New stays in Open", columnForTask(withState("0")) === "Open");

    /*
     * The workflow wins on whether a task is FINISHED. A property left at
     * "In Work" on a completed task must not drag it back onto the board as
     * outstanding work.
     */
    check("a completed task stays Resolved whatever the property says",
      columnForTask(withState("2", "Complete")) === "Resolved");
    check("and a rejected one stays Rejected",
      columnForTask(withState("2", "Rejected")) === "Rejected");

    /* No property at all: fall back to the workflow, as before. */
    check("a task with no Task State falls back to its workflow state",
      columnForTask({ state: "Open" }) === "Open");
    check("an unset value falls back too",
      columnForTask(withState("")) === "Open");

    /*
     * Matching is by LABEL first, so a tenant that numbers its states
     * differently still works — the thing being asked for is "in work", not
     * the number 2.
     */
    const oddCodes = {
      state: "Open",
      properties: [{ propertyId: "p1", name: "Task State", value: "77", editable: true,
        enumValues: [{ value: "77", label: "In Progress" }, { value: "88", label: "Assigned" }] }],
    };
    check("a tenant's own codes work, because labels are matched",
      columnForTask(oddCodes) === "In Progress");

    /*
     * The preference-order trap. A single alternation tests the OPTIONS in
     * order, so asking for "assigned" against (New, Assigned, …) returned New
     * — which would silently un-assign a task moved back from In Work.
     */
    const prop = { value: "2", enumValues: LIVE_ENUM };
    check("asking for in-work finds In Work", taskStateOptionFor(prop, "in-work") === "2");
    check("asking for assigned finds Assigned, not New",
      taskStateOptionFor(prop, "assigned") === "1",
      String(taskStateOptionFor(prop, "assigned")));
    check("a property with no usable option says so",
      taskStateOptionFor({ value: "", enumValues: [{ value: "9", label: "Whatever" }] }, "in-work") === null);
    check("and no property at all does too",
      taskStateOptionFor(undefined, "in-work") === null);
  }

  console.log("\nOld closed tasks are hidden, and only those");
  {
    const now = new Date("2026-09-11T12:00:00Z");
    const daysAgo = (n: number) => new Date(now.getTime() - n * 864e5);

    const W = 60;
    const open = { state: "Open", resolvedAt: daysAgo(900) };
    const recent = { state: "Resolved", resolvedAt: daysAgo(10) };
    const old = { state: "Resolved", resolvedAt: daysAgo(400) };
    const oldReject = { state: "Rejected", resolvedAt: daysAgo(400) };

    check("an open task is never hidden, however old",
      !hiddenAsOldClosed(open, W, now));
    check("a recently closed one is kept", !hiddenAsOldClosed(recent, W, now));
    check("an old resolved one is hidden", hiddenAsOldClosed(old, W, now));
    check("an old rejected one too", hiddenAsOldClosed(oldReject, W, now));
    check("and nothing is hidden with no window",
      !hiddenAsOldClosed(old, null, now));

    /*
     * Undated and closed: KEPT. Hiding a row because its age cannot be
     * established loses it with no way to ask for it back — the window has to
     * fail towards showing things.
     */
    check("a closed task nothing dates is kept",
      !hiddenAsOldClosed({ state: "Resolved" }, W, now));

    /* Onshape's read-only Completed date stands in when resolvedAt is absent. */
    check("the Completed date property is used when resolvedAt is missing",
      hiddenAsOldClosed(
        { state: "Resolved", properties: [{ name: "Completed date", value: daysAgo(400).toISOString() }] },
        W, now
      ));
    check("and it is read as a date, not just truthy",
      closedAt({ properties: [{ name: "Completed date", value: "not a date" }] }) === null);

    /*
     * The trap this filter was almost built on. Every sync writes every task,
     * so a tenant's rows all carry the same `updatedAt` — the moment of the
     * last sync. A window measured on it hides everything or nothing, and the
     * live tenant proved it: 23 tasks, one distinct updatedAt day between them.
     */
    const sameSyncMoment = { state: "Resolved", updatedAt: now, resolvedAt: daysAgo(400) };
    check("age comes from resolvedAt, not from when PLM last wrote the row",
      hiddenAsOldClosed(sameSyncMoment as any, W, now));
  }

  console.log("\nThe window parameter is forgiving but never traps anybody");
  {
    check("a plain number is days", parseClosedWithin("30") === 30);
    check("a trailing d is tolerated", parseClosedWithin("30d") === 30);
    check("'all' means no window", parseClosedWithin("all") === null);
    check("'0' does too", parseClosedWithin("0") === null);
    check("nothing given falls back to the default",
      parseClosedWithin(null) === CLOSED_TASK_WINDOW_DAYS);
    check("and so does nonsense, rather than hiding everything",
      parseClosedWithin("last tuesday") === CLOSED_TASK_WINDOW_DAYS);
    check("a negative is not taken literally",
      parseClosedWithin("-5") === CLOSED_TASK_WINDOW_DAYS);
    check("the default is two months", CLOSED_TASK_WINDOW_DAYS === 60);
  }

  for (const M of [Task, Part, User, ActivityLog]) {
    await (M as any).deleteMany({ enterpriseId: ent._id });
  }
  await Enterprise.deleteOne({ _id: ent._id });
  await MockOnshapeTask.deleteMany({ companyId: COMPANY });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
