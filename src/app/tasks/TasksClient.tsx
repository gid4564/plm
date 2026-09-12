"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Spinner, relTime } from "@/components/ui";
import { PriorityIcon } from "@/components/TaskPriority";
import { TaskPanel } from "./TaskPanel";

type Task = {
  id: string;
  onshapeTaskId: string;
  name: string;
  description: string;
  state: string;
  column: string;
  taskType: string;
  documentName: string;
  creatorEmail: string;
  creatorName: string;
  assignees: { email: string; name: string; acted: boolean }[];
  resolvedAt: string | null;
  resolvedByEmail: string;
  itemCount: number;
  linkedParts: number;
  commentCount: number;
  unsentComments: number;
  availableActions: { id: string; label: string; type: string }[];
  deletable: boolean;
  dueDate: string | null;
  priority: string;
  taskState: string;
  commentable: boolean;
  pushPending: boolean;
  lastPushError: string | null;
  lastSyncedFromOnshapeAt: string | null;
  updatedAt: string;
};

type Data = {
  tasks: Task[];
  columns: string[];
  counts: Record<string, number>;
  total: number;
  connected: boolean;
  myEmail: string;
  canDeleteInOnshape: boolean;
  hiddenClosed: number;
  closedWithinDays: number | null;
  logs?: {
    id: string; action: string; direction: string; ok: boolean;
    message: string; createdAt: string;
  }[];
};

/**
 * The task board.
 *
 * A board rather than a list by default, because a task's state is the thing
 * people scan for and columns show it without reading a word. The list view is
 * there for when the question is "what changed" rather than "what is where".
 */
export function TasksClient() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  /*
   * Two separate error slots, because they have different lifetimes.
   *
   * `error` is the outcome of something the user did — a refused delete, a
   * transition Onshape would not accept. `loadError` is the board failing to
   * read itself. They were one slot, and every action ended by reloading the
   * board, whose success path cleared it: the refusal appeared and was wiped
   * a few hundred milliseconds later. A delete that refused every task looked
   * like a delete that silently did nothing.
   */
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /*
   * Refusals, per task, kept until dismissed.
   *
   * A joined one-line summary truncated to three was unreadable for the case
   * that actually happens — a tenant where Onshape refuses every task — and
   * it hid which task refused and why. These are the reasons a person needs
   * in order to do something else instead.
   */
  const [failures, setFailures] = useState<{ taskId: string; name: string; reason: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  /*
   * How far back to show closed tasks, in days — "all" for no window.
   *
   * Remembered per browser: somebody who widens the window to find an old task
   * has said what they want the board to be, and resetting it on every reload
   * would make them say it again each time.
   */
  const [closedWithin, setClosedWithin] = useState<string>(() => {
    if (typeof window === "undefined") return "60";
    try { return window.localStorage.getItem("plm.tasks.closedWithin") || "60"; }
    catch { return "60"; }
  });
  /*
   * The open task, which a link from a part can set.
   *
   * A part page lists the tasks against it and links each one here; arriving
   * at a board of fifty cards and being left to find the one you clicked would
   * make that link useless. Read once on mount rather than tracked: the board
   * owns this afterwards, and re-reading it would fight the user closing the
   * panel.
   */
  const [open, setOpen] = useState<string | null>(
    () => (typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("task")) || null
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  /*
   * The card being dragged, and the column under the cursor.
   *
   * Kept here rather than read off the drag event: `dataTransfer` is only
   * readable in `dragover` on some browsers, and a board that highlights the
   * wrong column is worse than one that does not highlight at all.
   */
  const [dragging, setDragging] = useState<Task | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  /* Cards mid-move, so an optimistic card can be told apart from a real one. */
  const [moving, setMoving] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (mine) p.set("assignee", "me");
      if (q.trim()) p.set("q", q.trim());
      p.set("closedWithin", closedWithin);
      const r = await fetch(`/api/tasks?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load tasks");
      setData(j);
      /*
       * Only the load's own error is cleared here. An action's result is not
       * this function's to discard — see the two slots above.
       */
      setLoadError(null);
    } catch (e: any) {
      setLoadError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [mine, q, closedWithin]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function sync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not sync");
      setNotice(j.message ?? "Synced.");
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSyncing(false);
    }
  }

  const byColumn = useMemo(() => {
    const out = new Map<string, Task[]>();
    for (const c of data?.columns ?? []) out.set(c, []);
    for (const t of data?.tasks ?? []) {
      /*
       * A card mid-move is drawn where it was dropped, not where the server
       * still says it is. Onshape's round trip is a second or two, and a card
       * that snaps back and then forward reads as a glitch.
       */
      const col = moving[t.id] ?? t.column;
      out.set(col, [...(out.get(col) ?? []), t]);
    }
    return out;
  }, [data, moving]);

  /**
   * A card dropped on a column.
   *
   * The column is a grouping of states rather than a state, so this asks the
   * server for "whatever transition lands it here" — Onshape's workflow
   * decides whether one exists, and the refusal says what does.
   */
  async function drop(task: Task, column: string) {
    setOverColumn(null);
    setDragging(null);
    if (column === task.column) return;

    setMoving((m) => ({ ...m, [task.id]: column }));
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/tasks/${task.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", column }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");
      if (!j.ok) {
        /*
         * Refused by the workflow. The optimistic card is put back where it
         * came from and the reason shown — a card that stays in the new column
         * would be a lie about Onshape's state.
         */
        setError(j.message);
      } else if (j.message) {
        setNotice(j.message);
      }
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setMoving((m) => {
        const next = { ...m };
        delete next[task.id];
        return next;
      });
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function remove(alsoOnshape: boolean) {
    const ids = [...selected];
    if (!ids.length) return;

    const names = (data?.tasks ?? [])
      .filter((t) => selected.has(t.id))
      .map((t) => t.name || "(untitled)");

    if (
      !confirm(
        alsoOnshape
          ? `Remove ${ids.length} task(s) in Onshape?\n\n${names.slice(0, 8).join("\n")}` +
            `${names.length > 8 ? `\n…and ${names.length - 8} more` : ""}` +
            `\n\nPLM deletes each one where Onshape allows it, and otherwise uses the ` +
            `workflow's discard transition. Either way it cannot be undone.`
          : `Remove ${ids.length} task(s) from PLM?\n\nThey are untouched in Onshape. The ` +
            `sync only mirrors some kinds of task, so some will stay gone and some will ` +
            `come back — PLM will tell you which once it is done.`
      )
    ) return;

    setRemoving(true);
    setError(null);
    setNotice(null);
    setFailures([]);
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", taskIds: ids, alsoOnshape }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");
      /*
       * Both, when both happened: some tasks can be removed in the same call
       * that refuses others, and reporting only the failure hides the part
       * that worked.
       */
      if (j.removedFromPlm > 0) setNotice(j.message);
      if (j.failures?.length) {
        setFailures(j.failures);
        if (!j.removedFromPlm) {
          setError(
            `Nothing was removed — Onshape refused all ${j.failures.length} of them. ` +
            `The reasons are below.`
          );
        }
      }
      /* Only what actually went is deselected, so a retry keeps the rest. */
      setSelected((prev) => {
        const failed = new Set((j.failures ?? []).map((f: any) => f.taskId));
        return new Set([...prev].filter((id) => failed.has(id)));
      });
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRemoving(false);
    }
  }

  const unsent = (data?.tasks ?? []).filter((t) => t.unsentComments > 0 || t.pushPending);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 19 }}>Tasks</h1>
        <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
          {loading && !data
            ? "loading…"
            : `${data?.total ?? 0} from Onshape` +
              ((data?.hiddenClosed ?? 0) > 0
                ? ` · ${data!.hiddenClosed} older closed hidden`
                : "")}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-sm" onClick={sync} disabled={syncing}>
          {syncing ? <Spinner size={12} /> : "Sync from Onshape"}
        </button>
      </div>

      {loadError && (
        <Alert kind="error" onDismiss={() => setLoadError(null)}>{loadError}</Alert>
      )}
      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {failures.length > 0 && (
        <Alert kind="warn" onDismiss={() => setFailures([])}>
          <div style={{ display: "grid", gap: 6 }}>
            <strong>
              {failures.length} task{failures.length === 1 ? "" : "s"} could not be removed
            </strong>
            {failures.map((f) => (
              <div key={f.taskId} style={{ fontSize: 12.5 }}>
                <span style={{ fontWeight: 600 }}>{f.name}</span> — {f.reason}
              </div>
            ))}
          </div>
        </Alert>
      )}

      {/*
        * The window says what it hid and offers to undo it.
        *
        * A filter that quietly drops rows is how somebody concludes their data
        * is missing. The count is a button, because the next thing a person
        * wants after reading it is to see them.
        */}
      {(data?.hiddenClosed ?? 0) > 0 && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            fontSize: 12.5, color: "var(--text-faint)",
          }}
        >
          <span>
            {data!.hiddenClosed} closed task{data!.hiddenClosed === 1 ? "" : "s"} older than{" "}
            {describeWindow(data!.closedWithinDays)} {data!.hiddenClosed === 1 ? "is" : "are"} hidden.
            Open tasks are always shown, however old.
          </span>
          <button
            className="btn btn-sm"
            onClick={() => {
              setClosedWithin("all");
              try { window.localStorage.setItem("plm.tasks.closedWithin", "all"); } catch {}
            }}
          >
            Show them
          </button>
        </div>
      )}

      {unsent.length > 0 && (
        <Alert kind="warn">
          {unsent.length} task(s) have changes PLM has not managed to send to Onshape. Open one to
          see what Onshape said.
        </Alert>
      )}

      {selected.size > 0 && (
        <div className="card" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 13 }}>{selected.size} selected</strong>
          <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
            Removing from PLM tidies this board and nothing else — tasks of a kind the sync
            mirrors come back, the rest stay gone. Acting in Onshape cannot be undone.
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn btn-sm" onClick={() => remove(false)} disabled={removing}>
            {removing ? <Spinner size={12} /> : "Remove from PLM"}
          </button>
          {/*
            Admin-only, and last in the row: it destroys somebody's record in
            Onshape, where the other button only tidies a mirror.
          */}
          {data?.canDeleteInOnshape && (
            <button className="btn btn-sm btn-danger" onClick={() => remove(true)} disabled={removing}>
              {/*
                * "Remove", not "Delete": Onshape refuses outright deletion for
                * most tasks, and PLM then uses the workflow's own discard
                * transition instead. Both take it off Onshape's list, but only
                * one is a deletion — and a button promising a delete it cannot
                * perform is how this looked broken in the first place.
                */}
              {removing ? <Spinner size={12} /> : `Remove ${selected.size} in Onshape`}
            </button>
          )}
        </div>
      )}

      {/* ------------------------------- Controls ------------------------------ */}
      <div className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <label className="label">View</label>
          <div style={{ display: "flex", gap: 4 }}>
            {(["board", "list"] as const).map((v) => (
              <button
                key={v}
                className="btn btn-sm"
                onClick={() => setView(v)}
                style={{
                  borderColor: view === v ? "var(--accent)" : undefined,
                  color: view === v ? "var(--accent)" : undefined,
                  fontWeight: view === v ? 600 : undefined,
                }}
              >
                {v === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">Assignee</label>
          <button
            className="btn btn-sm"
            onClick={() => setMine((v) => !v)}
            style={{
              borderColor: mine ? "var(--accent)" : undefined,
              color: mine ? "var(--accent)" : undefined,
              fontWeight: mine ? 600 : undefined,
            }}
            title={`Tasks Onshape lists ${data?.myEmail ?? "you"} on`}
          >
            {mine ? "Assigned to me" : "Everyone"}
          </button>
        </div>

        <div>
          <label className="label">Closed tasks</label>
          <select
            className="input"
            value={closedWithin}
            onChange={(e) => {
              setClosedWithin(e.target.value);
              try { window.localStorage.setItem("plm.tasks.closedWithin", e.target.value); }
              catch { /* a private window is not a reason to fail */ }
            }}
            title="Resolved and rejected tasks older than this are hidden. Open tasks are always shown, however old."
            style={{ fontSize: 12.5 }}
          >
            <option value="14">Closed in the last 2 weeks</option>
            <option value="30">Closed in the last month</option>
            <option value="60">Closed in the last 2 months</option>
            <option value="180">Closed in the last 6 months</option>
            <option value="365">Closed in the last year</option>
            <option value="all">All, however old</option>
          </select>
        </div>

        <div style={{ flex: 1, minWidth: 180 }}>
          <label className="label">Find</label>
          <input
            className="input"
            style={{ width: "100%" }}
            placeholder="Name, description, document, state…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {/* -------------------------------- Empty -------------------------------- */}
      {!loading && data && data.tasks.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <p style={{ margin: "0 0 8px", color: "var(--text-muted)" }}>
            {q || mine ? "No task matches that filter." : "No tasks yet."}
          </p>
          {!q && !mine && (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)", lineHeight: 1.6 }}>
              {data.connected
                ? /*
                    The likely cause, said plainly. Onshape's own API restricts
                    task visibility, and an empty board with no explanation
                    looks like a broken feature rather than a permission.
                  */
                  "Tasks are created in Onshape, and PLM mirrors what its integration account " +
                  "can see. Onshape only lets a company admin see tasks they did not create " +
                  "and were not assigned — so if there are tasks in Onshape but none here, " +
                  "that account is most likely not an admin. Press Sync from Onshape to try again."
                : "Connect an Onshape account in Settings first — tasks are created in Onshape " +
                  "and mirrored here."}
            </p>
          )}
        </div>
      ) : view === "board" ? (
        /*
         * Columns scroll horizontally as a group, and each scrolls its own
         * cards. Four states on a laptop is fine; a tenant with a longer
         * workflow should not push the page sideways.
         */
        <div style={{ display: "flex", gap: 12, overflowX: "auto", alignItems: "flex-start", paddingBottom: 6 }}>
          {(data?.columns ?? []).map((c) => {
            const items = byColumn.get(c) ?? [];
            return (
              <div
                key={c}
                /*
                 * The whole column is the drop target, including its empty
                 * space — aiming at a card would make an empty column
                 * impossible to drop into, which is the move people most want.
                 */
                onDragOver={(e) => {
                  if (!dragging) return;
                  // Without preventDefault the browser refuses the drop.
                  e.preventDefault();
                  if (overColumn !== c) setOverColumn(c);
                }}
                onDragLeave={(e) => {
                  // Only when leaving the column itself, not moving between
                  // the cards inside it.
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setOverColumn((x) => (x === c ? null : x));
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging) void drop(dragging, c);
                }}
                style={{
                  minWidth: 268, flex: "1 1 268px", borderRadius: 10, padding: 4,
                  background: overColumn === c && dragging?.column !== c
                    ? "var(--accent-soft)" : "transparent",
                  outline: overColumn === c && dragging?.column !== c
                    ? "1px dashed var(--accent)" : "1px solid transparent",
                  transition: "background 120ms",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "0 2px 6px" }}>
                  <strong style={{ fontSize: 12.5 }}>{c}</strong>
                  <span style={{ fontSize: 11.5, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                    {items.length}
                  </span>
                  {overColumn === c && dragging && dragging.column !== c && (
                    <span style={{ fontSize: 11, color: "var(--accent)" }}>drop to move</span>
                  )}
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {items.map((t) => (
                    <Card
                      key={t.id}
                      task={t}
                      onOpen={() => setOpen(t.id)}
                      selected={selected.has(t.id)}
                      onSelect={() => toggleSelect(t.id)}
                      moving={t.id in moving}
                      onDragStart={() => setDragging(t)}
                      onDragEnd={() => { setDragging(null); setOverColumn(null); }}
                    />
                  ))}
                  {items.length === 0 && (
                    <div
                      style={{
                        border: "1px dashed var(--border)", borderRadius: 8, padding: "14px 10px",
                        fontSize: 11.5, color: "var(--text-faint)", textAlign: "center",
                      }}
                    >
                      nothing here
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    aria-label="Select every task shown"
                    checked={(data?.tasks.length ?? 0) > 0 && (data?.tasks ?? []).every((t) => selected.has(t.id))}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set((data?.tasks ?? []).map((t) => t.id)) : new Set())}
                  />
                </th>
                <th>Task</th>
                <th style={{ width: 110 }}>Priority</th>
                <th style={{ width: 130 }}>State</th>
                <th style={{ width: 180 }}>Assigned to</th>
                <th style={{ width: 90, textAlign: "right" }}>Items</th>
                <th style={{ width: 90, textAlign: "right" }}>Comments</th>
                <th style={{ width: 120 }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {(data?.tasks ?? []).map((t) => (
                <tr key={t.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${t.name || "task"}`}
                      checked={selected.has(t.id)}
                      onChange={() => toggleSelect(t.id)}
                    />
                  </td>
                  <td>
                    <button
                      onClick={() => setOpen(t.id)}
                      style={{
                        background: "none", border: "none", padding: 0, cursor: "pointer",
                        font: "inherit", color: "var(--accent)", textAlign: "left",
                      }}
                    >
                      {t.name || "(untitled)"}
                    </button>
                    {t.documentName && (
                      <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{t.documentName}</div>
                    )}
                  </td>
                  <td>
                    {/* With the word here: a table row has room the card does not. */}
                    <PriorityIcon value={t.priority} withLabel />
                  </td>
                  <td><span className="badge">{t.state || "—"}</span></td>
                  <td style={{ fontSize: 12 }}>
                    {t.assignees.length
                      ? t.assignees.map((a) => a.name || a.email).join(", ")
                      : <span style={{ color: "var(--text-faint)" }}>nobody</span>}
                  </td>
                  <td style={{ fontSize: 12, textAlign: "right" }}>
                    {t.itemCount}
                    {t.linkedParts > 0 && t.linkedParts !== t.itemCount && (
                      <span style={{ color: "var(--text-faint)" }}> ({t.linkedParts} in PLM)</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, textAlign: "right" }}>
                    {t.commentCount}
                    {t.unsentComments > 0 && (
                      <span style={{ color: "var(--warn)" }}> · {t.unsentComments} unsent</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-faint)" }}>{relTime(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------- Activity ---------------------------
        * The task log, where it can actually be read.
        *
        * Everything PLM does to a task has been logged all along, but the only
        * view of it was inside a single task's panel — no use after a bulk
        * removal, since the tasks it describes are gone. A refusal now leaves
        * a trace that survives the page reload.
        */}
      {(data?.logs ?? []).length > 0 && (
        <details style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px" }}>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            Recent task activity
          </summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {(data?.logs ?? []).map((l) => (
              <div
                key={l.id}
                style={{
                  fontSize: 12, display: "flex", gap: 8, alignItems: "baseline",
                  paddingLeft: 8,
                  borderLeft: `2px solid ${l.ok ? "var(--ok)" : "var(--danger)"}`,
                }}
              >
                <span style={{ color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                  {relTime(l.createdAt)}
                </span>
                <span style={{ color: l.ok ? "var(--text)" : "var(--danger)" }}>{l.message}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <TaskPanel
        taskId={open}
        onClose={() => {
          setOpen(null);
          /*
           * Drop ?task= as the panel closes, so a reload or a shared link does
           * not reopen a task the reader has already dismissed. replaceState
           * rather than a router push: this is not a navigation, and it should
           * not land in the back history.
           */
          if (typeof window !== "undefined" && window.location.search.includes("task=")) {
            const u = new URL(window.location.href);
            u.searchParams.delete("task");
            window.history.replaceState(null, "", u.pathname + u.search);
          }
        }}
        onChanged={load}
      />
    </div>
  );
}

/**
 * One task as a board card.
 *
 * Draggable, but the panel's own transition buttons remain — drag and drop is
 * a shortcut, not the only way to move a task, and it is unusable by keyboard.
 */
function Card({
  task, onOpen, selected, onSelect, moving, onDragStart, onDragEnd,
}: {
  task: Task;
  onOpen: () => void;
  selected: boolean;
  onSelect: () => void;
  moving: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const overdue =
    task.dueDate && task.column !== "Resolved" && new Date(task.dueDate) < new Date();

  return (
    <div
      draggable={!moving}
      onDragStart={(e) => {
        /*
         * Some payload is required or Firefox refuses to start the drag; the
         * id is the useful thing to carry even though the component tracks it.
         */
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className="card"
      style={{
        padding: 11, border: "1px solid var(--border)",
        borderColor: selected ? "var(--accent)" : "var(--border)",
        opacity: moving ? 0.55 : 1,
        cursor: moving ? "progress" : "grab",
      }}
    >
      <div style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          aria-label={`Select ${task.name || "task"}`}
          checked={selected}
          onChange={onSelect}
          // Not the card's drag or its open action.
          onClick={(e) => e.stopPropagation()}
          style={{ marginTop: 2 }}
        />
        <button
          onClick={onOpen}
          style={{
            flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none",
            padding: 0, font: "inherit", cursor: "pointer",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4 }}>
            {task.name || "(untitled task)"}
          </div>
          {task.description && (
            <div
              style={{
                fontSize: 11.5, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.45,
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {task.description}
            </div>
          )}
        </button>
      </div>

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 7, alignItems: "center" }}>
        <span className="badge" style={{ fontSize: 10 }}>{task.state || "no state"}</span>
        {/*
          * The glyph alone on a card: the word is in the tooltip and the
          * aria-label, and thirty cards each carrying a neutral text chip is
          * what made priority unreadable at a glance.
          */}
        <PriorityIcon value={task.priority} />
        {task.dueDate && (
          <span
            className="badge"
            style={{
              fontSize: 10,
              ...(overdue ? { color: "var(--danger)", borderColor: "var(--danger)" } : {}),
            }}
            title={overdue ? "Past its due date" : "Due date"}
          >
            {new Date(task.dueDate).toISOString().slice(0, 10)}
          </span>
        )}
        {task.itemCount > 0 && (
          <span className="badge" style={{ fontSize: 10 }} title={`${task.linkedParts} tracked in PLM`}>
            {task.itemCount} item{task.itemCount === 1 ? "" : "s"}
          </span>
        )}
        {task.commentCount > 0 && (
          <span className="badge" style={{ fontSize: 10 }}>{task.commentCount} 💬</span>
        )}
        {(task.unsentComments > 0 || task.pushPending) && (
          <span
            className="badge"
            style={{ fontSize: 10, color: "var(--warn)", borderColor: "var(--warn)" }}
            title="PLM has a change Onshape has not accepted"
          >
            unsent
          </span>
        )}
        {moving && <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>moving…</span>}
      </div>

      {task.assignees.length > 0 && (
        <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 5 }}>
          {task.assignees.map((a) => a.name || a.email).join(", ")}
        </div>
      )}
    </div>
  );
}

/** A day count as the phrase the control uses for it. */
function describeWindow(days: number | null): string {
  if (days == null) return "any age";
  if (days % 365 === 0) return days === 365 ? "a year" : `${days / 365} years`;
  if (days % 30 === 0) return days === 30 ? "a month" : `${days / 30} months`;
  if (days % 7 === 0) return days === 7 ? "a week" : `${days / 7} weeks`;
  return `${days} days`;
}
