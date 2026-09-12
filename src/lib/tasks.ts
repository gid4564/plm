import { connectDb } from "@/lib/db";
import { ActivityLog, Enterprise, Part, Task, User } from "@/lib/models";
import { clientForEnterprise, clientForUser } from "@/lib/onshape/factory";
import type { OnshapeClient, OnshapeTask } from "@/lib/onshape/types";
import { findTransitionFor } from "@/lib/onshape/workflow-snapshot";
import { formatPropertyValue } from "@/lib/onshape/task-values";

/**
 * Tasks, mirrored from Onshape and worked on in PLM.
 *
 * Onshape owns a task: it is created there, its workflow is defined there, and
 * its state is whatever Onshape says it is. PLM does not keep a second opinion
 * — there is no PLM-side status field to disagree with Onshape's, because two
 * systems each holding a status is how they come to differ with nothing to
 * arbitrate between them.
 *
 * What PLM adds is a place to *work*: a board, the parts a task is about
 * resolved to real PLM parts, and a comment box. Completing and commenting are
 * pushed to Onshape, and the result is read back rather than assumed — the
 * lesson of the release transition, which reported success for a POST Onshape
 * had quietly ignored.
 */

/** Which PLM lifecycle a task's state corresponds to, for grouping on a board. */
/**
 * Which Onshape task types PLM mirrors onto its board.
 *
 * `RELEASE` is excluded on purpose. Those are release-package workflows, which
 * PLM already mirrors as releases with their own page, numbers and states — on
 * a live tenant they were 143 of 174 tasks, so including them would bury the
 * real work and show the same record twice under two names.
 *
 * Overridable: ONSHAPE_TASK_TYPES=GENERAL,TODO,RELEASE for a tenant that does
 * want them on one board.
 */
export const TASK_TYPES_PULLED = new Set(
  (process.env.ONSHAPE_TASK_TYPES || "GENERAL,TODO")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
);

/**
 * How far back closed tasks are shown by default, in days.
 *
 * A mirror accumulates: a tenant's board filled with tasks completed in 2021
 * and 2024, and the handful closed this week were lost among them. Two months
 * is the default window because it covers the work somebody might still be
 * asked about while keeping the board about now.
 *
 * Only CLOSED tasks are ever hidden. An open task from 2021 is not clutter —
 * it is the most interesting row on the board.
 */
export const CLOSED_TASK_WINDOW_DAYS = Number(
  process.env.PLM_CLOSED_TASK_WINDOW_DAYS || 60
);

/**
 * Read a `closedWithin` parameter into a number of days.
 *
 * `all` (or anything unparseable) means no window, since a filter nobody can
 * turn off is worse than a long list — the old task somebody needs is still in
 * there, and they must be able to reach it.
 */
export function parseClosedWithin(raw: string | null | undefined): number | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return CLOSED_TASK_WINDOW_DAYS;
  if (v === "all" || v === "0") return null;
  const n = Number(v.replace(/d$/, ""));
  return Number.isFinite(n) && n > 0 ? n : CLOSED_TASK_WINDOW_DAYS;
}

/**
 * When a task was closed, as far as anything reliable knows.
 *
 * `resolvedAt` is Onshape's own answer and is what this uses. PLM's
 * `updatedAt` is NOT usable for this and is the trap worth naming: every sync
 * writes every task, so all of a tenant's tasks carried the same `updatedAt`
 * — the moment of the last sync — and an age filter built on it would hide
 * everything or nothing depending on which side of the cutoff that moment fell.
 *
 * Null when nothing dates it, and a caller must then keep the task: hiding a
 * row because its age is unknown loses it for good.
 */
export function closedAt(task: {
  resolvedAt?: Date | string | null;
  properties?: { name?: string; value?: unknown }[];
}): Date | null {
  if (task.resolvedAt) {
    const d = new Date(task.resolvedAt as any);
    if (!Number.isNaN(d.getTime())) return d;
  }
  /*
   * Onshape also carries a read-only "Completed date" property, which is the
   * same fact by another route — used when resolvedAt is absent.
   */
  const prop = (task.properties ?? []).find((p) =>
    /completed\s*date/i.test(String(p?.name ?? ""))
  );
  if (prop?.value) {
    const d = new Date(String(prop.value));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Whether a task should be hidden as an old closed one.
 *
 * Three ways to be kept: it is not closed, there is no window, or nothing
 * dates it. Only a task that is closed, dated, and older than the window goes.
 */
export function hiddenAsOldClosed(
  task: { state?: string; resolvedAt?: Date | string | null; properties?: any[] },
  windowDays: number | null,
  now: Date = new Date()
): boolean {
  if (windowDays == null) return false;
  if (!isClosed(String(task.state ?? ""))) return false;
  const when = closedAt(task);
  if (!when) return false;
  return now.getTime() - when.getTime() > windowDays * 24 * 60 * 60 * 1000;
}

export const TASK_COLUMNS = ["Open", "In Progress", "Resolved", "Rejected"] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];

/**
 * Group a task's Onshape state into a board column.
 *
 * Onshape's task states are workflow-defined, so a tenant can name them
 * anything. This maps the ones the stock workflow uses and puts anything else
 * in "Open" rather than inventing a column per tenant — with the real state
 * still shown on the card, so nothing is hidden by the grouping.
 */
export function columnFor(state: string): TaskColumn {
  const s = String(state ?? "").trim().toUpperCase();
  if (!s) return "Open";
  if (/RESOLV|COMPLET|CLOSED|DONE/.test(s)) return "Resolved";
  /*
   * DISCARD belongs here. Onshape's stock task workflow ends a discarded task
   * in a state named for it, and without this it matched nothing and landed in
   * "Open" — so a task PLM had just discarded came straight back onto the
   * board as outstanding work.
   */
  if (/REJECT|CANCEL|DISCARD/.test(s)) return "Rejected";
  if (/PROGRESS|REVIEW|PENDING|ACTIVE|WORK/.test(s)) return "In Progress";
  return "Open";
}

/* -------------------------------------------------------------------------- */
/* Task State — Onshape's OTHER notion of where a task is                     */
/* -------------------------------------------------------------------------- */

/**
 * An Onshape task has two separate notions of progress, and they do different
 * jobs.
 *
 * The **workflow state** says whether the task is open or finished. Onshape's
 * stock task workflow has exactly two — `OPEN` and `COMPLETE` — joined by a
 * `COMPLETE(APPROVE)` transition, with `OS_DISCARD(DELETE)` to throw it away.
 * There is **no in-progress state and no transition that starts work**.
 *
 * The **"Task State" property** is where progress lives: an editable enum of
 * New, Assigned, In Work, Completed, Closed, Canceled. Moving a task to "in
 * progress" is a write to that property, not a transition.
 *
 * PLM's board asked for a "start" transition and was told, correctly, that the
 * task offered none — the error named the right facts and drew the wrong
 * conclusion, because it was looking at the wrong one of the two.
 */
export const TASK_STATE_PROPERTY = /task\s*state/i;

/**
 * The enum codes Onshape's stock task workflow uses, read off a live task.
 *
 * Note 4 is absent — the values run 0,1,2,3,5,6 — which is a reminder that
 * these are a tenant's published list rather than a dense range, so they are
 * matched by label as well as by code.
 */
export const TASK_STATE_IN_WORK = "2";
export const TASK_STATE_ASSIGNED = "1";

/** The Task State property on a task, if it carries one. */
export function taskStateProperty(task: {
  properties?: { propertyId?: string; name?: string; value?: unknown; editable?: boolean; enumValues?: { value: string; label: string }[] }[];
}) {
  return (task.properties ?? []).find((p) => TASK_STATE_PROPERTY.test(String(p?.name ?? "")));
}

/**
 * Find the enum option meaning "work is under way", by label then by code.
 *
 * By label first because the code is a tenant's own: another enterprise's
 * workflow may number its states differently, and "In Work" is the thing being
 * asked for rather than the number 2.
 */
export function taskStateOptionFor(
  prop: { value?: unknown; enumValues?: { value: string; label: string }[] } | undefined,
  intent: "in-work" | "assigned"
): string | null {
  if (!prop) return null;
  const options = prop.enumValues ?? [];
  /*
   * Patterns in PREFERENCE order, not the enum's order.
   *
   * A plain `find` over the options returns whichever the tenant happened to
   * list first — on the live enum (New, Assigned, In Work, …) asking for
   * "assigned" matched **New** at position 0, because a single alternation
   * tests options in list order rather than testing preferences in turn. A
   * task coming back from In Work is still assigned to somebody; New would
   * quietly un-assign it.
   */
  const wanted = intent === "in-work"
    ? [/in\s*work/i, /in\s*progress/i, /started|doing|active/i]
    : [/assigned/i, /not\s*started|to\s*do/i, /^\s*new\s*$/i];

  for (const pattern of wanted) {
    const hit = options.find((o) => pattern.test(String(o.label ?? "")));
    if (hit) return String(hit.value);
  }

  const fallback = intent === "in-work" ? TASK_STATE_IN_WORK : TASK_STATE_ASSIGNED;
  return options.some((o) => String(o.value) === fallback) ? fallback : null;
}

/**
 * Which column a task belongs in, reading both notions of progress.
 *
 * The workflow state decides whether it is finished, because that is the thing
 * the workflow is authoritative about. Only among unfinished tasks does the
 * Task State property get a say, and only to promote one to In Progress —
 * without this a task moved to In Work would be written to Onshape correctly
 * and then snap back to Open on the next refresh, which reads as the move
 * having failed.
 */
export function columnForTask(task: {
  state?: string;
  properties?: { name?: string; value?: unknown; enumValues?: { value: string; label: string }[] }[];
}): TaskColumn {
  const byWorkflow = columnFor(String(task.state ?? ""));
  if (byWorkflow === "Resolved" || byWorkflow === "Rejected") return byWorkflow;

  const prop = taskStateProperty(task);
  if (!prop || prop.value == null || prop.value === "") return byWorkflow;

  const current = String(prop.value);
  const option = (prop.enumValues ?? []).find((o) => String(o.value) === current);
  const label = String(option?.label ?? current);

  if (/in\s*work|in\s*progress|started|active/i.test(label)) return "In Progress";
  return byWorkflow;
}

/** Whether a task's state means there is nothing left to do. */
export function isClosed(state: string): boolean {
  const c = columnFor(state);
  return c === "Resolved" || c === "Rejected";
}

export type TaskSyncResult = {
  pulled: number;
  created: number;
  updated: number;
  commentsAdded: number;
  message: string;
};

/**
 * Bring one Onshape task into PLM, or bring it up to date.
 *
 * Onshape's fields overwrite PLM's copy without ceremony: PLM holds no
 * competing opinion about a task's name, state or assignees. Comments are
 * merged rather than replaced — a comment written in PLM and not yet accepted
 * by Onshape is not in Onshape's thread, and replacing the thread would delete
 * it.
 */
export async function upsertTask(
  enterpriseId: string,
  incoming: OnshapeTask
): Promise<{ created: boolean; commentsAdded: number; taskId: string }> {
  await connectDb();

  const existing: any = await Task.findOne({ enterpriseId, onshapeTaskId: incoming.id });

  /*
   * The task's items, resolved to PLM parts where PLM has them.
   *
   * Onshape names a document, an element and sometimes a part; a task about
   * something PLM already tracks should link to it, and one about something
   * PLM has never seen should still say what it is about rather than showing a
   * blank.
   */
  const items: any[] = [];
  for (const it of incoming.items) {
    let partId: string | null = null;
    if (it.documentId && it.elementId) {
      const part: any = await Part.findOne({
        enterpriseId,
        documentId: it.documentId,
        elementId: it.elementId,
        partId: it.partId || "",
      })
        .select("_id")
        .lean();
      partId = part ? String(part._id) : null;
    }
    items.push({
      partId,
      label: it.label,
      documentId: it.documentId,
      elementId: it.elementId,
      onshapePartId: it.partId,
    });
  }

  const fields = {
    enterpriseId,
    onshapeTaskId: incoming.id,
    name: incoming.name,
    description: incoming.description,
    state: incoming.state,
    status: incoming.status,
    taskType: incoming.taskType,
    availableActions: incoming.availableActions,
    properties: incoming.properties,
    commentable: incoming.commentable,
    deletable: incoming.deletable,
    documentId: incoming.documentId,
    documentName: incoming.documentName,
    elementId: incoming.elementId,
    workspaceId: incoming.workspaceId,
    versionId: incoming.versionId,
    objectId: incoming.objectId,
    creatorEmail: incoming.creatorEmail,
    creatorName: incoming.creatorName,
    assignees: incoming.assignees,
    resolvedAt: incoming.resolvedAt ? new Date(incoming.resolvedAt) : null,
    resolvedByEmail: incoming.resolvedByEmail,
    items,
    lastSyncedFromOnshapeAt: new Date(),
    raw: incoming.raw,
  };

  if (!existing) {
    const created: any = await Task.create({
      ...fields,
      comments: incoming.comments.map((c) => ({
        onshapeCommentId: c.id,
        message: c.message,
        authorEmail: c.authorEmail,
        authorName: c.authorName,
        origin: "onshape",
        createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
      })),
    });
    return { created: true, commentsAdded: incoming.comments.length, taskId: String(created._id) };
  }

  Object.assign(existing, fields);

  /*
   * Merge the thread by Onshape's comment id.
   *
   * Onshape returns the whole thread on every read, so a comment already held
   * must be recognised rather than appended — otherwise every sync duplicates
   * the conversation. A PLM comment that Onshape has since accepted is matched
   * on its id and stops being pending.
   */
  let commentsAdded = 0;
  const held = new Set(
    (existing.comments ?? []).map((c: any) => c.onshapeCommentId).filter(Boolean)
  );
  for (const c of incoming.comments) {
    if (c.id && held.has(c.id)) continue;
    existing.comments.push({
      onshapeCommentId: c.id,
      message: c.message,
      authorEmail: c.authorEmail,
      authorName: c.authorName,
      origin: "onshape",
      createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
    });
    commentsAdded++;
  }
  existing.comments.sort(
    (a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  await existing.save();
  return { created: false, commentsAdded, taskId: String(existing._id) };
}

/**
 * Pull the tasks Onshape will show the enterprise's integration account.
 *
 * What comes back depends on who that account is. Onshape's own documentation
 * is explicit: only a company admin sees tasks they neither created nor were
 * assigned. A service account that is not an admin mirrors its own tasks and
 * nothing else — which is a setup fact worth reporting rather than a shortfall
 * to paper over.
 */
export async function pullTasks(
  enterpriseId: string,
  opts: { client?: OnshapeClient; documentId?: string; trigger?: string } = {}
): Promise<TaskSyncResult> {
  await connectDb();

  const client = opts.client ?? (await clientForEnterprise(enterpriseId)).client;

  /*
   * Paged, because Onshape caps a page at 100.
   *
   * Asking for 200 earned a 400. Clamping to 100 fixes that, but on its own it
   * would trade a loud error for a quiet one: an enterprise with more than 100
   * tasks would mirror the first hundred and never mention the rest. So the
   * pages are followed until one comes back short.
   *
   * Bounded at a few thousand so a tenant that keeps returning full pages —
   * or an endpoint that ignores `offset` — cannot spin here for ever. Hitting
   * the bound is reported rather than passed over.
   */
  const PAGE = 100;
  const MAX_PAGES = 30;
  const summaries: OnshapeTask[] = [];
  let truncated = false;

  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) { truncated = true; break; }
    const batch = await client.listTasks({
      ...(opts.documentId ? { documentId: opts.documentId } : {}),
      limit: PAGE,
      offset: page * PAGE,
    });
    summaries.push(...batch);
    if (batch.length < PAGE) break;
  }

  /*
   * Then the tasks `getActionItems` does not show, via the internal search.
   *
   * These are two different questions. `getActionItems` answers "what is on my
   * plate", which is narrower than a task board asks: unless the integration
   * account is a company admin it sees only what it created or was assigned.
   * On the tenant this was built against that was 8 tasks against the search's
   * 174 — a board built on the first would look empty and be believed.
   *
   * Release packages are left out. 143 of those 174 were `taskType: RELEASE`,
   * which are the release workflows PLM already mirrors as releases, with
   * their own page and their own states. Listing them here would bury the 31
   * real tasks and duplicate a record PLM already holds. `TASK_TYPES_PULLED`
   * says which types do come in, and is overridable for a tenant that wants
   * them.
   */
  const known = new Set(summaries.map((t) => t.id));
  const discovered: string[] = [];
  let searchable = true;
  try {
    const found = await client.findTasks();
    /* Nothing found at all reads as "no search here", not "no tasks". */
    searchable = found.length > 0;
    for (const f of found) {
      if (known.has(f.id)) continue;
      if (!TASK_TYPES_PULLED.has(f.taskType.toUpperCase())) continue;
      known.add(f.id);
      discovered.push(f.id);
    }
  } catch {
    /*
     * Unpublished, so a tenant without it is a normal outcome. The action
     * items still arrived, and the message below says the view is narrow.
     */
    searchable = false;
  }

  let created = 0;
  let updated = 0;
  let commentsAdded = 0;
  /* Tasks Onshape listed but will not open — reported, not stored. */
  let unreadable = 0;

  /*
   * Every task is read individually, listed or discovered.
   *
   * Neither the list nor the search promises the full object: the search is a
   * projection with no workflow snapshot at all, and a board built from one
   * would offer transitions the task does not have. One call per task is the
   * price of a board that works.
   */
  const incoming: OnshapeTask[] = [];

  for (const t of summaries) {
    try {
      incoming.push(await client.getTask(t.id));
    } catch {
      /*
       * Skipped, not stored from the summary.
       *
       * This used to fall back with "the summary is better than nothing", and
       * that fallback is what filled a live tenant with junk: a task Onshape
       * will not open has no name, no workflow state and no transitions, so
       * the row PLM kept was a blank card in a raw state like "TASK_OPEN"
       * that could not be acted on and — because Onshape would not delete it
       * either — could not be got rid of. Six of that tenant's eighteen tasks
       * were these, and they are why the delete looked broken.
       *
       * A transient failure costs nothing here: the row is left alone rather
       * than removed, and the next sync picks it up.
       */
      unreadable++;
    }
  }

  for (const id of discovered) {
    try {
      incoming.push(await client.getTask(id));
    } catch {
      /*
       * Skipped outright, because there is no summary worth keeping.
       *
       * A discovered task that will not read has only a search projection
       * behind it — no state, no transitions. Seven of the live tenant's tasks
       * were exactly this: orphaned records with a null name that answer a
       * read with a 500. Storing one puts a blank, actionless card on the
       * board, which looks like a PLM bug rather than damaged data in Onshape.
       */
      unreadable++;
    }
  }

  for (const full of incoming) {
    const r = await upsertTask(enterpriseId, full);
    if (r.created) created++; else updated++;
    commentsAdded += r.commentsAdded;
  }

  await ActivityLog.create({
    enterpriseId,
    direction: "onshape->plm",
    action: "synced",
    trigger: opts.trigger || "tasks",
    ok: true,
    message:
      `Synced ${incoming.length} task(s) from Onshape: ${created} new, ${updated} updated` +
      (commentsAdded ? `, ${commentsAdded} new comment(s)` : "") + ".",
  });

  return {
    pulled: incoming.length,
    created,
    updated,
    commentsAdded,
    message: incoming.length
      ? `${incoming.length} task(s): ${created} new, ${updated} updated` +
        (commentsAdded ? `, ${commentsAdded} new comment(s)` : "") + "." +
        (discovered.length
          ? ` ${discovered.length} of them were found by search rather than assigned to ` +
            `the integration account.`
          : "") +
        (unreadable
          ? ` ${unreadable} task(s) Onshape listed but would not open were skipped — ` +
            `they carry no state or transitions, so PLM keeps no blank row for them.`
          : "") +
        (searchable
          ? ""
          : " Onshape's task search was unavailable, so this is only what the " +
            "integration account was assigned or created.") +
        (truncated
          ? ` Stopped after ${MAX_PAGES} pages — there may be more in Onshape.`
          : "")
      : "Onshape returned no tasks for the account PLM syncs as. Only a company admin can " +
        "see tasks they did not create and were not assigned — check which account is set " +
        "as the integration account in Settings.",
  };
}

/**
 * Comment on a task from PLM, and push it to Onshape.
 *
 * Stored first and marked pending, then pushed. That order is deliberate: a
 * comment somebody typed must not be lost because Onshape was unreachable, and
 * a pending comment shown in the thread with a marker is more honest than an
 * error that discards what they wrote.
 */
export async function commentOnTask(
  enterpriseId: string,
  taskId: string,
  message: string,
  author: { userId: string; email: string; name?: string }
): Promise<{ ok: boolean; pushed: boolean; error: string | null; message: string }> {
  await connectDb();

  const task: any = await Task.findOne({ _id: taskId, enterpriseId });
  if (!task) return { ok: false, pushed: false, error: null, message: "Task not found." };

  const text = String(message ?? "").trim();
  if (!text) return { ok: false, pushed: false, error: null, message: "A comment needs some text." };

  task.comments.push({
    onshapeCommentId: null,
    message: text,
    authorEmail: author.email,
    authorName: author.name ?? author.email,
    origin: "plm",
    createdAt: new Date(),
    pushPending: true,
  });
  await task.save();
  const local = task.comments[task.comments.length - 1];

  /*
   * A task with no Onshape document has no thread to post into.
   *
   * Onshape's comments are document-scoped, so a GENERAL task cannot be
   * commented on through the API — established by probing a live tenant with
   * six candidate bodies, every one refused. The comment is kept, marked as
   * PLM-only, and the reason says why rather than relaying "An illegal
   * argument was provided" from a call that could never have worked.
   */
  if (!task.commentable) {
    local.pushPending = false;
    local.pushError = null;
    local.plmOnly = true;
    await task.save();

    await ActivityLog.create({
      enterpriseId, direction: "plm", action: "commented", trigger: "task", ok: true,
      message:
        `${author.email} commented on task "${task.name}". Kept in PLM: the task is not ` +
        `attached to an Onshape document, and Onshape's comments are document-scoped.`,
    });
    return {
      ok: true,
      pushed: false,
      error: null,
      message:
        "Comment added. It stays in PLM — this task is not attached to an Onshape " +
        "document, and Onshape has nowhere to put a comment on it.",
    };
  }

  /*
   * Pushed as the person who wrote it where they have connected Onshape, and
   * as the integration account otherwise.
   *
   * A comment attributed to the wrong person is worse than one attributed to a
   * service account: the first is misleading, the second is merely impersonal,
   * and PLM records the real author either way.
   */
  let client: OnshapeClient;
  try {
    client = await clientForUser(author.userId);
  } catch {
    client = (await clientForEnterprise(enterpriseId)).client;
  }

  try {
    /*
     * The anchor comes from the task PLM already holds.
     *
     * A comment belongs to a document, not just to the object it is on, and
     * omitting that earned a 500 with only a support code. The live client
     * re-reads the task to find it, but passing what PLM already knows saves
     * the round trip and works even if the read fails.
     */
    const posted = await client.commentOnTask(task.onshapeTaskId, text, {
      documentId: task.documentId || undefined,
      workspaceId: task.workspaceId || undefined,
      versionId: task.versionId || undefined,
      elementId: task.elementId || undefined,
    });
    local.onshapeCommentId = posted.id || null;
    local.pushPending = false;
    local.pushError = null;
    await task.save();

    await ActivityLog.create({
      enterpriseId, direction: "plm->onshape", action: "commented", trigger: "task", ok: true,
      message: `${author.email} commented on task "${task.name}".`,
    });
    return { ok: true, pushed: true, error: null, message: "Comment added and sent to Onshape." };
  } catch (err: any) {
    local.pushError = String(err?.message ?? err);
    task.pushPending = true;
    task.lastPushError = local.pushError;
    await task.save();

    await ActivityLog.create({
      enterpriseId, direction: "plm->onshape", action: "error", trigger: "task", ok: false,
      message:
        `${author.email} commented on task "${task.name}", but Onshape would not accept it: ` +
        `${local.pushError.slice(0, 300)}`,
    });
    return {
      ok: true,
      pushed: false,
      error: local.pushError,
      message: "Comment saved in PLM, but Onshape would not accept it — it is marked unsent.",
    };
  }
}

/**
 * Perform a transition on a task, in Onshape, and read back what happened.
 *
 * The transition id comes from the task's own workflow snapshot — never
 * invented. `intent` lets a caller ask for "complete" without knowing what
 * this tenant's workflow calls it, and the refusal names what *was* on offer,
 * which is the difference between a dead end and something a person can act on.
 */
export async function transitionTask(
  enterpriseId: string,
  taskId: string,
  opts: { transition?: string; intent?: "complete" | "reject" | "reopen" | "start"; actor: { email: string } }
): Promise<{ ok: boolean; state: string; used: string | null; message: string }> {
  await connectDb();

  const task: any = await Task.findOne({ _id: taskId, enterpriseId });
  if (!task) return { ok: false, state: "", used: null, message: "Task not found." };

  const { client } = await clientForEnterprise(enterpriseId);

  /*
   * Re-read before acting. Which transitions a task offers depends on the
   * state it is in *now*, and a board is exactly the kind of page that sits
   * open while somebody else moves things.
   */
  let live: OnshapeTask;
  try {
    live = await client.getTask(task.onshapeTaskId);
  } catch (err: any) {
    return {
      ok: false, state: task.state, used: null,
      message: `Could not read the task from Onshape: ${String(err?.message ?? err).slice(0, 300)}`,
    };
  }

  const actions = live.availableActions.map((a) => ({ ...a, requiredProperties: [] }));

  /*
   * Starting a finished task is not a thing; reopening one is.
   *
   * `start` and `reopen` both correspond to a SUBMIT-type transition, so
   * matching on type alone made them indistinguishable — and asking to "start"
   * a Resolved task reopened it, which is a surprising amount of consequence
   * for a word. The intent is refused rather than quietly reinterpreted.
   */
  if (opts.intent === "start" && isClosed(live.state)) {
    await upsertTask(enterpriseId, live);
    return {
      ok: false,
      state: live.state,
      used: null,
      message:
        `This task is ${live.state}, so there is nothing to start. Reopen it first — ` +
        `available: ${actions.map((a) => a.label || a.id).join(", ") || "none"}.`,
    };
  }

  /*
   * The word before the type, because two intents share a type.
   *
   * `findTransitionFor` tries the listed types first and falls back to the
   * word, which is right where types are unambiguous (a release package's
   * APPROVE). Here `reopen` and `start` are both SUBMIT, so the word is the
   * more specific signal and goes first.
   */
  const INTENTS: Record<string, { words: string[]; types: string[] }> = {
    complete: { words: ["complete", "resolve", "done", "finish"], types: ["APPROVE"] },
    reject: { words: ["reject", "decline"], types: ["REJECT"] },
    reopen: { words: ["reopen", "re-open"], types: ["SUBMIT"] },
    start: { words: ["start", "begin"], types: ["SUBMIT"] },
  };

  let wanted: { id: string; label: string; type: string } | null = opts.transition
    ? actions.find((a) => a.id === opts.transition) ?? null
    : null;

  if (!wanted && opts.intent) {
    const spec = INTENTS[opts.intent];
    for (const w of spec.words) {
      const re = new RegExp(`\\b${w}\\b`, "i");
      wanted = actions.find((a) => re.test(a.label) || re.test(a.id)) ?? null;
      if (wanted) break;
    }
    if (!wanted) wanted = findTransitionFor(actions, opts.intent, spec.types);
  }

  if (!wanted) {
    await upsertTask(enterpriseId, live);
    return {
      ok: false,
      state: live.state,
      used: null,
      message:
        `Onshape offers no ${opts.intent ?? opts.transition ?? "matching"} transition on this ` +
        `task from state "${live.state}". Available: ` +
        `${actions.map((a) => `${a.label || a.id}`).join(", ") || "none"}.`,
    };
  }

  try {
    const after = await client.transitionTask(task.onshapeTaskId, wanted.id);
    await upsertTask(enterpriseId, after);

    await ActivityLog.create({
      enterpriseId, direction: "plm->onshape", action: "transitioned", trigger: "task", ok: true,
      message:
        `${opts.actor.email} performed "${wanted.label || wanted.id}" on task "${task.name}"; ` +
        `it is now ${after.state || "(state not reported)"}.`,
    });

    /*
     * The state is reported rather than asserted. If Onshape accepted the call
     * and did not move the task, saying so beats claiming a change that did not
     * happen — the release transition made exactly that mistake.
     */
    const moved = after.state && after.state !== live.state;
    return {
      ok: true,
      state: after.state,
      used: wanted.id,
      message: moved
        ? `Task is now ${after.state}.`
        : `Onshape accepted "${wanted.label || wanted.id}" but the task still reports ` +
          `"${after.state || live.state}".`,
    };
  } catch (err: any) {
    const detail = String(err?.message ?? err);
    task.pushPending = true;
    task.lastPushError = detail;
    await task.save();

    await ActivityLog.create({
      enterpriseId, direction: "plm->onshape", action: "error", trigger: "task", ok: false,
      message: `${opts.actor.email} could not transition task "${task.name}": ${detail.slice(0, 300)}`,
    });
    return { ok: false, state: task.state, used: wanted.id, message: detail };
  }
}

/**
 * Change a task's own fields, in Onshape.
 *
 * A task's due date, priority and task state are metadata *properties*, not
 * top-level fields — they arrive with ids, types and their own editability,
 * and go back through `updateTask`'s `propertyValues`. Onshape decides what is
 * editable; PLM offers what it is told and refuses the rest rather than
 * sending a write that will bounce.
 */
export async function updateTaskFields(
  enterpriseId: string,
  taskId: string,
  patch: { name?: string; description?: string; propertyValues?: Record<string, unknown> },
  actor: { email: string }
): Promise<{ ok: boolean; message: string }> {
  await connectDb();

  const task: any = await Task.findOne({ _id: taskId, enterpriseId });
  if (!task) return { ok: false, message: "Task not found." };

  const wanted = patch.propertyValues ?? {};
  const held: any[] = task.properties ?? [];

  /*
   * Refuse a read-only property here, with its name.
   *
   * Onshape would refuse it too, but its message names an id rather than the
   * field somebody was looking at — and a UI that offers an edit it cannot
   * make is worse than one that does not offer it.
   */
  for (const propertyId of Object.keys(wanted)) {
    const def = held.find((p) => p.propertyId === propertyId);
    if (!def) {
      return { ok: false, message: `This task has no property ${propertyId}.` };
    }
    if (!def.editable) {
      return {
        ok: false,
        message: `"${def.name}" is read-only on this task — Onshape's workflow decides it.`,
      };
    }
  }

  const { client } = await clientForEnterprise(enterpriseId);
  try {
    const after = await client.updateTask(task.onshapeTaskId, patch);
    await upsertTask(enterpriseId, after);

    const changed = [
      ...(patch.name != null ? ["name"] : []),
      ...(patch.description != null ? ["description"] : []),
      ...Object.keys(wanted).map((id) => held.find((p) => p.propertyId === id)?.name ?? id),
    ];
    await ActivityLog.create({
      enterpriseId, direction: "plm->onshape", action: "updated", trigger: "task", ok: true,
      message: `${actor.email} changed ${changed.join(", ")} on task "${task.name}".`,
    });
    return { ok: true, message: `Saved ${changed.join(", ")}.` };
  } catch (err: any) {
    const detail = String(err?.message ?? err);
    task.pushPending = true;
    task.lastPushError = detail;
    await task.save();
    await ActivityLog.create({
      enterpriseId, direction: "plm->onshape", action: "error", trigger: "task", ok: false,
      message: `${actor.email} could not change task "${task.name}": ${detail.slice(0, 300)}`,
    });
    return { ok: false, message: detail };
  }
}

/**
 * Move a task to a board column.
 *
 * A column groups states rather than being one, so a drop is a request for
 * "whatever transition lands it there" — and Onshape's workflow decides
 * whether there is one. Refusing names what IS available, because a card that
 * springs back with no explanation is the worst version of this interaction.
 */
export async function moveTaskToColumn(
  enterpriseId: string,
  taskId: string,
  column: TaskColumn,
  actor: { email: string }
): Promise<{ ok: boolean; state: string; column: TaskColumn | null; message: string }> {
  await connectDb();

  /*
   * In Progress is a PROPERTY write, not a transition.
   *
   * Onshape's stock task workflow has no in-progress state to transition to —
   * an open task offers only COMPLETE and OS_DISCARD. Progress is carried by
   * the "Task State" property, so dropping a card here writes that. PLM used
   * to look for a "start" transition and report, accurately and uselessly,
   * that the task offered none.
   *
   * Open is the same move in reverse: a task already In Work goes back to
   * Assigned rather than being "reopened", since its workflow never left OPEN.
   */
  if (column === "In Progress" || column === "Open") {
    const task: any = await Task.findOne({ _id: taskId, enterpriseId }).lean();
    if (!task) return { ok: false, state: "", column: null, message: "Task not found." };

    const closed = isClosed(String(task.state ?? ""));
    const prop = taskStateProperty(task);

    /*
     * A closed task dropped on an open column is a different act: it has to
     * come back through the workflow first, and on a tenant whose completed
     * tasks offer no actions at all that is simply not possible. Handled by
     * the transition path below, which says so properly.
     */
    if (!closed && prop?.editable) {
      const target = taskStateOptionFor(prop, column === "In Progress" ? "in-work" : "assigned");
      if (target == null) {
        return {
          ok: false, state: String(task.state ?? ""), column: columnForTask(task),
          message:
            `This task's "Task State" has no option for ${column.toLowerCase()} — it offers ` +
            `${(prop.enumValues ?? []).map((o: any) => o.label).join(", ") || "nothing"}.`,
        };
      }

      /* Already there: a no-op is a success, not an error. */
      if (String(prop.value ?? "") === target) {
        return {
          ok: true, state: String(task.state ?? ""), column,
          message: `Already ${column.toLowerCase()}.`,
        };
      }

      const r = await updateTaskFields(
        enterpriseId, taskId, { propertyValues: { [String(prop.propertyId)]: target } }, actor
      );
      if (!r.ok) {
        return { ok: false, state: String(task.state ?? ""), column: columnForTask(task), message: r.message };
      }

      const after: any = await Task.findOne({ _id: taskId, enterpriseId }).lean();
      const landed = after ? columnForTask(after) : column;
      return {
        ok: true,
        state: String(after?.state ?? task.state ?? ""),
        column: landed,
        message:
          landed === column
            ? `Moved to ${column} in Onshape.`
            : `Onshape recorded the change, but the task still reads as ${landed}.`,
      };
    }

    /*
     * No editable Task State, and the task is not closed: there is nothing to
     * move. Saying which of the two notions of progress is missing is the
     * difference between a useful message and the one that started this.
     */
    if (!closed) {
      return {
        ok: false, state: String(task.state ?? ""), column: columnForTask(task),
        message:
          `This task has no editable "Task State" property, and Onshape's task workflow has ` +
          `no ${column.toLowerCase()} state to move it to — its only transitions are ` +
          `${(task.availableActions ?? []).map((a: any) => a.label || a.id).join(", ") || "none"}.`,
      };
    }
  }

  const intent =
    column === "Resolved" ? "complete"
      : column === "Rejected" ? "reject"
        : column === "In Progress" ? "start"
          : "reopen";

  const r = await transitionTask(enterpriseId, taskId, { intent, actor });
  const landed = r.state ? columnFor(r.state) : null;

  /*
   * Say so when it lands somewhere other than the column it was dropped on.
   *
   * A workflow can route a transition through a state PLM groups elsewhere —
   * dropping on Rejected might leave the task In Progress. Silently redrawing
   * the card in a third column would look like a bug in the board rather than
   * the workflow doing what it does.
   */
  if (r.ok && landed && landed !== column) {
    return {
      ok: true,
      state: r.state,
      column: landed,
      message:
        `Onshape moved it to "${r.state}", which sits under ${landed} rather than ` +
        `${column} — its workflow decides where a transition leads.`,
    };
  }

  return { ok: r.ok, state: r.state, column: landed, message: r.message };
}

export type RemoveTaskResult = {
  removedFromPlm: number;
  deletedInOnshape: number;
  /**
   * Tasks got rid of through the workflow rather than by deletion.
   *
   * Counted separately because it is a different act: `DELETE /tasks/{tid}`
   * destroys the record, while a DELETE-type workflow transition (Onshape's
   * stock one is `OS_DISCARD`) moves the task to a discarded state. Both take
   * it off the board; only one is a deletion, and a report that conflated them
   * would overstate what happened.
   */
  discardedInOnshape: number;
  failures: { taskId: string; name: string; reason: string }[];
  message: string;
};

/**
 * Get tasks out of PLM, and optionally out of Onshape.
 *
 * Two separate things, deliberately offered separately. Removing PLM's copy
 * tidies a mirror and costs nothing — the next sync brings it back if Onshape
 * still has it. Deleting in Onshape destroys somebody's record and cannot be
 * undone.
 *
 * Not all-or-nothing: a task Onshape refuses to delete must not stop the rest,
 * and "nine deleted, one refused because Onshape says it is not deletable" is
 * the useful outcome.
 */
export async function removeTasks(
  enterpriseId: string,
  taskIds: string[],
  opts: { alsoOnshape: boolean; actor: { email: string } }
): Promise<RemoveTaskResult> {
  await connectDb();

  const tasks: any[] = await Task.find({ enterpriseId, _id: { $in: taskIds } });
  const failures: RemoveTaskResult["failures"] = [];
  let deletedInOnshape = 0;
  let discardedInOnshape = 0;
  const removable: any[] = [];

  const client = opts.alsoOnshape
    ? (await clientForEnterprise(enterpriseId)).client
    : null;

  for (const t of tasks) {
    if (!client) { removable.push(t); continue; }

    const label = t.name || t.onshapeTaskId;

    /*
     * Onshape's own answer on whether it can be deleted, taken fresh.
     *
     * The stored flag is from the last sync and is the wrong thing to refuse
     * on: it can be stale, and it cannot tell "Onshape will not delete this"
     * apart from "Onshape can no longer read this at all" — which on a live
     * tenant was 6 of 18 tasks, all answering a read with a 500. Those two
     * cases need different things said about them, so the task is re-read and
     * the failure to re-read is itself an answer.
     */
    let live: OnshapeTask | null = null;
    let readError: string | null = null;
    try {
      live = await client.getTask(t.onshapeTaskId);
    } catch (err: any) {
      readError = String(err?.message ?? err);
    }

    if (live?.deletable) {
      try {
        await client.deleteTask(t.onshapeTaskId);
        deletedInOnshape++;
        removable.push(t);
      } catch (err: any) {
        failures.push({
          taskId: String(t._id), name: label,
          reason: String(err?.message ?? err).slice(0, 300),
        });
      }
      continue;
    }

    /*
     * Not deletable, so try the workflow's own way out.
     *
     * A task can refuse deletion and still offer a DELETE-type transition —
     * Onshape's stock task workflow calls it `OS_DISCARD`. That is the route
     * that actually works on a live tenant: every one of its 18 tasks came
     * back `deletable: false`, and the ones still open offered OS_DISCARD.
     * PLM used to name this transition in a refusal and leave the person to
     * go and do it by hand, which is a worse answer than doing it.
     */
    const discard = (live?.availableActions ?? t.availableActions ?? []).find(
      (a: any) => String(a.type).toUpperCase() === "DELETE"
    );

    if (discard && !readError) {
      try {
        const after = await client.transitionTask(t.onshapeTaskId, discard.id);
        discardedInOnshape++;
        removable.push(t);
        /*
         * Recorded before PLM's copy goes, so the log says what Onshape did
         * with it rather than only that PLM stopped showing it.
         */
        await ActivityLog.create({
          enterpriseId, direction: "plm->onshape", action: "transitioned",
          trigger: "task", ok: true,
          message:
            `${opts.actor.email} discarded task "${label}" in Onshape via ` +
            `"${discard.label || discard.id}" — it is now ${after.state || "discarded"}.`,
        });
      } catch (err: any) {
        failures.push({
          taskId: String(t._id), name: label,
          reason:
            `Onshape will not delete this task, and its "${discard.label || discard.id}" ` +
            `transition was refused: ${String(err?.message ?? err).slice(0, 160)}`,
        });
      }
      continue;
    }

    /*
     * Nothing Onshape will do with it. The reason says which of the three
     * cases this is, because the way forward differs for each.
     */
    failures.push({
      taskId: String(t._id),
      name: label,
      reason: readError
        ? `Onshape can no longer open this task (${readError.slice(0, 120)}). It cannot be ` +
          `deleted there, but removing PLM's copy will clear it for good — the sync skips ` +
          `tasks Onshape will not open.`
        : `Onshape reports this task as not deletable and its workflow offers no way to ` +
          `discard it${live?.state ? ` from "${live.state}"` : ""}. Removing PLM's copy is ` +
          `the only option.`,
    });
  }

  if (removable.length) {
    await Task.deleteMany({
      enterpriseId,
      _id: { $in: removable.map((t) => t._id) },
    });
  }

  const missing = taskIds.filter((id) => !tasks.some((t) => String(t._id) === id));
  for (const id of missing) {
    failures.push({ taskId: id, name: id, reason: "not found in PLM" });
  }

  const inOnshape = [
    deletedInOnshape ? `deleted ${deletedInOnshape} in Onshape` : "",
    discardedInOnshape ? `discarded ${discardedInOnshape} in Onshape` : "",
  ].filter(Boolean).join(" and ");

  await ActivityLog.create({
    enterpriseId,
    direction: opts.alsoOnshape ? "plm->onshape" : "plm",
    action: "deleted",
    trigger: "task",
    ok: failures.length === 0,
    message:
      `${opts.actor.email} removed ${removable.length} task(s) from PLM` +
      (inOnshape ? ` and ${inOnshape}` : "") +
      (failures.length
        ? `; ${failures.length} refused: ` +
          failures.slice(0, 5).map((f) => `${f.name} — ${f.reason}`).join("; ")
        : "") + ".",
  });

  return {
    removedFromPlm: removable.length,
    deletedInOnshape,
    discardedInOnshape,
    failures,
    message:
      (removable.length
        ? opts.alsoOnshape
          ? `Removed ${removable.length} task(s) from PLM${inOnshape ? ` and ${inOnshape}` : ""}.`
          : `Removed ${removable.length} task(s) from PLM. ` + willTheyReturn(removable)
        : "Nothing was removed.") +
      (failures.length
        ? ` ${failures.length} refused: ` +
          failures.slice(0, 3).map((f) => `${f.name} — ${f.reason}`).join("; ")
        : ""),
  };
}

/**
 * Whether a PLM-only removal will stay removed.
 *
 * This used to be stated flatly as "a sync will bring them back", and that is
 * now wrong for most of what people want to clear: the sync mirrors only
 * `TASK_TYPES_PULLED` and skips tasks Onshape will not open, so a release task
 * or an orphan removed from PLM stays gone. Saying otherwise talked people out
 * of the one action that solved their problem.
 */
function willTheyReturn(removed: any[]): string {
  const returning = removed.filter((t) =>
    TASK_TYPES_PULLED.has(String(t.taskType ?? "").toUpperCase())
  );

  if (returning.length === 0) {
    return "They are untouched in Onshape, but the sync does not mirror this kind of task, " +
      "so they will stay out of PLM.";
  }
  if (returning.length === removed.length) {
    return "They are untouched in Onshape, so the next sync will bring back any it can " +
      "open — a task Onshape no longer opens stays out.";
  }
  return `They are untouched in Onshape; ${returning.length} of them will come back on the ` +
    `next sync and the rest will not, since the sync does not mirror their type.`;
}

/** Bring one task up to date from Onshape, by PLM id. */
export async function refreshTask(
  enterpriseId: string,
  taskId: string
): Promise<{ ok: boolean; message: string }> {
  await connectDb();
  const task: any = await Task.findOne({ _id: taskId, enterpriseId }).lean();
  if (!task) return { ok: false, message: "Task not found." };

  const { client } = await clientForEnterprise(enterpriseId);
  try {
    const live = await client.getTask(task.onshapeTaskId);
    const r = await upsertTask(enterpriseId, live);
    return {
      ok: true,
      message: r.commentsAdded
        ? `Up to date; ${r.commentsAdded} new comment(s).`
        : "Up to date.",
    };
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}

/** Whether this enterprise has an Onshape connection tasks could sync through. */
export async function tasksAvailable(enterpriseId: string): Promise<boolean> {
  await connectDb();
  const ent: any = await Enterprise.findById(enterpriseId).select("integrationUserId").lean();
  if (ent?.integrationUserId) return true;
  return Boolean(
    await User.exists({ enterpriseId, onshapeAccessToken: { $nin: [null, ""] } })
  );
}

/* -------------------------------------------------------------------------- */
/* Tasks in the context of a part                                             */
/* -------------------------------------------------------------------------- */

/**
 * A task summarised for display beside a part, rather than on the board.
 *
 * Deliberately small: a part page is about the part, and a task shown there
 * needs to say what it is, whether it is still open, and who has it — enough
 * to decide whether to go and look at it.
 */
export type PartTaskSummary = {
  id: string;
  onshapeTaskId: string;
  name: string;
  state: string;
  column: TaskColumn;
  open: boolean;
  assignees: string[];
  dueDate: string | null;
  priority: string | null;
  /** How this task was tied to the part, since the two are not equally strong. */
  via: "item" | "document";
  updatedAt: Date | null;
};

/**
 * The filter matching every task that names a part.
 *
 * Two clauses, because one is not enough:
 *
 *  - `items.partId` is the resolved link, written by `upsertTask` when the
 *    part already existed in PLM.
 *  - the raw Onshape identity catches the rest. Resolution happens when a task
 *    is synced, so a task that arrived before its part was ever pushed to PLM
 *    has a null `partId` for ever — and a part page that showed nothing in
 *    that case would be wrong in the ordinary order of events, since tasks are
 *    usually raised on CAD before anybody files it in PLM.
 *
 * Matching the raw identity needs all three fields. Document and element alone
 * would attach a task about one part in a Part Studio to every part in it —
 * `onshapePartId` is what distinguishes them, and it is the empty string for
 * an assembly, which is why it is compared rather than skipped when blank.
 */
function partTaskFilter(part: {
  _id: unknown;
  documentId?: string;
  elementId?: string;
  partId?: string;
}): Record<string, unknown> {
  const or: Record<string, unknown>[] = [{ "items.partId": part._id }];

  if (part.documentId && part.elementId) {
    or.push({
      items: {
        $elemMatch: {
          documentId: part.documentId,
          elementId: part.elementId,
          onshapePartId: part.partId || "",
        },
      },
    });
  }

  return { $or: or };
}

/** A named property off a task, by any of several names Onshape might use. */
function taskProp(task: any, pattern: RegExp): string | null {
  const hit = (task?.properties ?? []).find((p: any) => pattern.test(String(p?.name ?? "")));
  if (!hit || hit.value == null || hit.value === "") return null;
  /*
   * Formatted, not stringified: several of a task's properties hold arrays of
   * objects, and String() on one of those yields "[object Object]".
   */
  const text = formatPropertyValue(hit.value, {
    valueType: hit.valueType, enumValues: hit.enumValues, empty: "",
  });
  return text || null;
}

/**
 * Every task that names this part, open ones first.
 *
 * Open before closed rather than newest first: the reason to show tasks on a
 * part is to answer "is there anything outstanding against this", and a
 * resolved task from last year above an open one today answers it badly.
 */
export async function tasksForPart(
  enterpriseId: string,
  partId: string
): Promise<PartTaskSummary[]> {
  await connectDb();

  const part: any = await Part.findOne({ _id: partId, enterpriseId })
    .select("_id documentId elementId partId")
    .lean();
  if (!part) return [];

  const rows: any[] = await Task.find({ enterpriseId, ...partTaskFilter(part) })
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();

  const summaries = rows.map((t: any) => {
    const state = String(t.state ?? "");
    /*
     * "Via" is read off the task, not assumed from which clause matched it —
     * Mongo does not report that, and re-deriving it here keeps the label
     * honest.
     */
    const byItem = (t.items ?? []).some(
      (i: any) =>
        String(i?.partId ?? "") === String(part._id) ||
        (i?.documentId === part.documentId &&
          i?.elementId === part.elementId &&
          String(i?.onshapePartId ?? "") === String(part.partId || ""))
    );

    return {
      id: String(t._id),
      onshapeTaskId: String(t.onshapeTaskId ?? ""),
      name: String(t.name ?? "") || "(untitled task)",
      state,
      /* The same reading the board uses, so the two never disagree. */
      column: columnForTask(t),
      open: !isClosed(state),
      assignees: (t.assignees ?? [])
        .map((a: any) => String(a?.name || a?.email || ""))
        .filter(Boolean),
      dueDate: taskProp(t, /due/i),
      priority: taskProp(t, /priority/i),
      via: (byItem ? "item" : "document") as "item" | "document",
      updatedAt: t.updatedAt ?? null,
    };
  });

  return summaries.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
  });
}

/**
 * Open and total task counts for many parts at once.
 *
 * One query for the whole page rather than one per row: a parts list is the
 * hottest read in the application, and a badge is not worth fifty round trips.
 *
 * The counting is done here rather than in an aggregation because "open" is
 * `columnFor`, a regex-based grouping that has to agree with the board exactly.
 * Reimplementing it as a Mongo expression would be a second opinion about which
 * states are open, and the two would drift the first time a tenant named a
 * state something new.
 */
export async function taskCountsForParts(
  enterpriseId: string,
  partIds: string[]
): Promise<Map<string, { open: number; total: number }>> {
  const out = new Map<string, { open: number; total: number }>();
  if (!partIds.length) return out;

  await connectDb();

  const parts: any[] = await Part.find({ _id: { $in: partIds }, enterpriseId })
    .select("_id documentId elementId partId")
    .lean();
  if (!parts.length) return out;

  /*
   * Every task naming any of these parts, in one read.
   *
   * `items.partId` covers the resolved links in a single clause; the raw
   * identities are one clause each, which is the price of catching tasks that
   * predate their part. Bounded by the page's own size, so this grows with the
   * rows on screen and not with the tenant.
   */
  const or: Record<string, unknown>[] = [
    { "items.partId": { $in: parts.map((p) => p._id) } },
  ];
  for (const p of parts) {
    if (!p.documentId || !p.elementId) continue;
    or.push({
      items: {
        $elemMatch: {
          documentId: p.documentId,
          elementId: p.elementId,
          onshapePartId: p.partId || "",
        },
      },
    });
  }

  const tasks: any[] = await Task.find({ enterpriseId, $or: or })
    .select("state items")
    .lean();

  /* Index the page's parts by Onshape identity, to match a task's items back. */
  const byIdentity = new Map<string, string>();
  const byObjectId = new Map<string, string>();
  for (const p of parts) {
    byObjectId.set(String(p._id), String(p._id));
    if (p.documentId && p.elementId) {
      byIdentity.set(`${p.documentId}|${p.elementId}|${p.partId || ""}`, String(p._id));
    }
  }

  for (const t of tasks) {
    const open = !isClosed(String(t.state ?? ""));
    /*
     * A task can name the same part more than once — two items pointing at one
     * part, or a resolved link and a raw identity that both hit. Counted once
     * per part, or a badge reads "3 open" for one task.
     */
    const hit = new Set<string>();
    for (const i of t.items ?? []) {
      const direct = i?.partId ? byObjectId.get(String(i.partId)) : undefined;
      if (direct) hit.add(direct);
      const raw = byIdentity.get(
        `${i?.documentId ?? ""}|${i?.elementId ?? ""}|${String(i?.onshapePartId ?? "")}`
      );
      if (raw) hit.add(raw);
    }
    for (const id of hit) {
      const cur = out.get(id) ?? { open: 0, total: 0 };
      cur.total++;
      if (open) cur.open++;
      out.set(id, cur);
    }
  }

  return out;
}
