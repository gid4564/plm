import { requireSession } from "@/lib/auth/session";
import { connectDb } from "@/lib/db";
import { ActivityLog, Task } from "@/lib/models";
import {
  columnForTask, hiddenAsOldClosed, parseClosedWithin, pullTasks, removeTasks,
  taskStateProperty, tasksAvailable, TASK_COLUMNS,
} from "@/lib/tasks";
import { handler, ok, fail } from "@/lib/api";
import { formatPropertyValue } from "@/lib/onshape/task-values";

/** The task board: everything PLM mirrors, grouped and filtered. */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  await connectDb();

  const url = new URL(req.url);
  const mine = url.searchParams.get("assignee") === "me";
  const column = url.searchParams.get("column") ?? "all";
  const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  /*
   * How far back to show closed tasks. Null means show them all.
   *
   * A search turns the window off. Typing a name is an explicit request for a
   * particular task, and a board that answered "no results" because the thing
   * you searched for was completed last year would be worse than the long list
   * this filter exists to shorten.
   */
  const closedWithin = q ? null : parseClosedWithin(url.searchParams.get("closedWithin"));

  const filter: Record<string, unknown> = { enterpriseId: s.enterpriseId };
  /*
   * "Assigned to me" matches on email rather than an Onshape user id: a PLM
   * account and an Onshape account are different things, and email is the only
   * identifier both sides reliably carry.
   */
  if (mine) filter["assignees.email"] = s.email;

  const rows: any[] = await Task.find(filter).sort({ updatedAt: -1 }).limit(500).lean();

  const tasks = rows
    .map((t) => ({
      id: String(t._id),
      onshapeTaskId: t.onshapeTaskId,
      name: t.name,
      description: t.description,
      state: t.state,
      /*
       * Both notions of progress, not just the workflow's. A task moved to
       * "In Work" never changes workflow state, so a column read from that
       * alone would put the card back in Open the moment the board refreshed.
       */
      column: columnForTask(t),
      taskType: t.taskType,
      documentName: t.documentName,
      creatorEmail: t.creatorEmail,
      creatorName: t.creatorName,
      assignees: t.assignees ?? [],
      resolvedAt: t.resolvedAt,
      resolvedByEmail: t.resolvedByEmail,
      itemCount: (t.items ?? []).length,
      /* Linked parts are what makes a task actionable inside PLM. */
      linkedParts: (t.items ?? []).filter((i: any) => i.partId).length,
      commentCount: (t.comments ?? []).length,
      unsentComments: (t.comments ?? []).filter((c: any) => c.pushPending).length,
      availableActions: t.availableActions ?? [],
      deletable: Boolean(t.deletable),
      /*
       * Due date and priority are pulled out by name for the board.
       *
       * They are metadata properties rather than fields, so a card cannot read
       * them off the task directly — and a task board without a due date is
       * not one anybody would plan with.
       */
      dueDate: propertyValue(t, /^due/i),
      priority: propertyLabel(t, /^priority/i),
      taskState: propertyLabel(t, /task state/i),
      commentable: Boolean(t.commentable),
      pushPending: Boolean(t.pushPending),
      lastPushError: t.lastPushError ?? null,
      lastSyncedFromOnshapeAt: t.lastSyncedFromOnshapeAt,
      updatedAt: t.updatedAt,
    }))
    .filter((t) => (column === "all" ? true : t.column === column))
    .filter((t) =>
      !q ||
      [t.name, t.description, t.documentName, t.state, t.creatorEmail]
        .some((v) => String(v ?? "").toLowerCase().includes(q))
    );

  /*
   * Old closed tasks, dropped from the board.
   *
   * Applied after the other filters so the count reported is what this window
   * actually hid, not what the column or the search had already removed.
   */
  const withinWindow = tasks.filter((t) => !hiddenAsOldClosed(t, closedWithin));
  const hiddenClosed = tasks.length - withinWindow.length;

  /*
   * Counted over what is shown, not over everything held.
   *
   * A "Resolved" column headed 143 above three visible cards reads as a bug in
   * the board. The tasks the window hid are reported separately, as their own
   * number with its own explanation.
   */
  const counts = Object.fromEntries(
    TASK_COLUMNS.map((c) => [c, withinWindow.filter((t) => t.column === c).length])
  );

  /*
   * Recent task activity, on the board.
   *
   * It was written to the log all along but reachable only inside an
   * individual task's panel — which is exactly where you cannot look after a
   * bulk removal, because the tasks it concerns are the ones that just went.
   * A removal that refused everything left no trace anybody could find.
   */
  const logs: any[] = await ActivityLog.find({
    enterpriseId: s.enterpriseId,
    trigger: "task",
  })
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();

  return ok({
    tasks: withinWindow,
    columns: TASK_COLUMNS,
    counts,
    /* What the window hid, so the board can say so and offer to widen it. */
    hiddenClosed,
    closedWithinDays: closedWithin,
    logs: logs.map((l: any) => ({
      id: String(l._id),
      action: l.action,
      direction: l.direction,
      ok: l.ok !== false,
      message: l.message ?? "",
      createdAt: l.createdAt,
    })),
    total: rows.length,
    /* So the page can explain an empty board rather than just showing one. */
    connected: await tasksAvailable(s.enterpriseId),
    myEmail: s.email,
    /* Deleting in Onshape is destructive, so the board only offers it to an admin. */
    canDeleteInOnshape: s.role === "admin",
  });
});

/** A property's raw value, by name. */
function propertyValue(t: any, match: RegExp): unknown {
  return (t.properties ?? []).find((p: any) => match.test(String(p.name ?? "")))?.value ?? null;
}

/**
 * A property's value as a person reads it.
 *
 * An enum property stores a code and carries its own label list, so the raw
 * value is a number nobody recognises — Priority reads "0", not "Low".
 */
function propertyLabel(t: any, match: RegExp): string {
  const p = (t.properties ?? []).find((x: any) => match.test(String(x.name ?? "")));
  if (!p) return "";
  /*
   * Through the shared formatter, so a structured value can never reach a
   * card as "[object Object]" — the bug the task panel had. Empty rather than
   * a dash here: a board card shows nothing at all for an absent property.
   */
  return formatPropertyValue(p.value, {
    valueType: p.valueType, enumValues: p.enumValues, empty: "",
  });
}

/** Pull from Onshape on demand. */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  const body = await req.json().catch(() => ({}));

  /*
   * Bulk removal, on the collection rather than one task at a time.
   *
   * The situation it exists for is a mirror full of tasks somebody does not
   * want to look at — a per-task delete would mean a click each, and the
   * refusals are only legible together.
   */
  if (body?.action === "remove") {
    const ids: string[] = Array.isArray(body.taskIds) ? body.taskIds.map(String) : [];
    if (!ids.length) return fail("No tasks were selected.", 400);
    if (ids.length > 200) return fail("Too many at once — 200 is the limit.", 400);

    const alsoOnshape = body.alsoOnshape === true;
    /*
     * Deleting in Onshape destroys somebody's record, so it is admin-only.
     * Tidying PLM's own mirror is not destructive — the next sync restores it
     * — and needs no special right.
     */
    if (alsoOnshape && s.role !== "admin") {
      return fail("Only an admin can delete a task in Onshape.", 403);
    }

    return ok(
      await removeTasks(s.enterpriseId, ids, { alsoOnshape, actor: { email: s.email } })
    );
  }

  if (body?.action !== "sync") return fail("Unknown action.", 400);
  if (!(await tasksAvailable(s.enterpriseId))) {
    return fail(
      "No Onshape account is connected for this enterprise, so there are no tasks to sync. " +
      "Connect one in Settings.",
      400
    );
  }

  const result = await pullTasks(s.enterpriseId, { trigger: "manual" });
  return ok(result);
});
