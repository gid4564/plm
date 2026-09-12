"use client";

import React from "react";
import { relTime } from "@/components/ui";
import { PriorityIcon } from "@/components/TaskPriority";

/**
 * Onshape's open work, shown where the part is.
 *
 * A task lives in Onshape and is worked on the task board, so this is not a
 * second place to edit one — it answers the question a part page raises and
 * cannot otherwise answer: is anybody being asked to change this right now?
 * Everything here therefore reads, and links out to the board to act.
 */

export type PartTask = {
  id: string;
  onshapeTaskId: string;
  name: string;
  state: string;
  column: string;
  open: boolean;
  assignees: string[];
  dueDate: string | null;
  priority: string | null;
  via: "item" | "document";
  updatedAt: string | Date | null;
};

/** Whether a due date has passed, for a task still open. */
function overdue(t: PartTask): boolean {
  if (!t.open || !t.dueDate) return false;
  const d = new Date(t.dueDate);
  if (Number.isNaN(d.getTime())) return false;
  /* Compared by day: a task due today is not late until today is over. */
  const endOfDay = new Date(d);
  endOfDay.setHours(23, 59, 59, 999);
  return endOfDay.getTime() < Date.now();
}

function dueLabel(due: string): string {
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return due;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The count badge, for a list row or a heading.
 *
 * Silent when there is nothing open. A badge reading "0" on every row is noise
 * that trains people to stop seeing the ones that read "2".
 */
export function TaskCountBadge({
  open,
  total,
  onClick,
  withLabel = false,
}: {
  open: number;
  total?: number;
  onClick?: () => void;
  /**
   * Spell out "task"/"tasks" beside the count.
   *
   * Worth the width wherever the badge sits near quantity columns: on a BOM
   * row a bare number is assumed to be a quantity, whatever icon precedes it.
   */
  withLabel?: boolean;
}) {
  if (!open) return null;

  const title =
    `${open} open task${open === 1 ? "" : "s"} in Onshape against this part` +
    (total && total > open ? ` (${total} in all, including closed)` : "");

  return (
    <span
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className="badge"
      title={title}
      aria-label={title}
      style={{
        background: "var(--warn-soft)",
        color: "var(--warn)",
        borderColor: "var(--warn)",
        cursor: onClick ? "pointer" : "default",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        whiteSpace: "nowrap",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {open}
      {withLabel && <span>&nbsp;open task{open === 1 ? "" : "s"}</span>}
    </span>
  );
}

/**
 * The task list itself.
 *
 * Open tasks first and closed ones collapsed behind a count: the closed ones
 * are history and matter far less than the two things somebody is waiting on,
 * but hiding them entirely would lose the record of what was already asked.
 */
export function PartTasks({ tasks }: { tasks: PartTask[] }) {
  const [showClosed, setShowClosed] = React.useState(false);

  const open = tasks.filter((t) => t.open);
  const closed = tasks.filter((t) => !t.open);
  const shown = showClosed ? [...open, ...closed] : open;

  if (!tasks.length) {
    return (
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
        No Onshape tasks name this part.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {open.length === 0 && !showClosed && (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
          Nothing open. {closed.length} closed task{closed.length === 1 ? "" : "s"} name this part.
        </p>
      )}

      {shown.map((t) => (
        <div
          key={t.id}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderLeft: `3px solid ${
              t.open
                ? overdue(t)
                  ? "var(--danger)"
                  : "var(--warn)"
                : "var(--border)"
            }`,
            borderRadius: 6,
            background: t.open ? "var(--surface)" : "var(--surface-2)",
            opacity: t.open ? 1 : 0.75,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <a
                href={`/tasks?task=${encodeURIComponent(t.id)}`}
                style={{ fontWeight: 600, fontSize: 13 }}
                title="Open on the task board"
              >
                {t.name}
              </a>
              <span
                className="badge"
                style={{
                  background: t.open ? "var(--surface-2)" : "var(--ok-soft)",
                  color: t.open ? "var(--text-muted)" : "var(--ok)",
                  borderColor: t.open ? "var(--border)" : "var(--ok)",
                }}
              >
                {t.state || t.column}
              </span>
              <PriorityIcon value={t.priority} withLabel />
              {/*
                * A document-level task is a weaker claim than an item-level
                * one, and saying so stops it reading as "this part is named in
                * a task" when Onshape only pointed at the document.
                */}
              {t.via === "document" && (
                <span
                  className="badge"
                  title="Onshape attached this task to the document, not to this part specifically."
                  style={{ background: "var(--surface-2)", color: "var(--text-faint)" }}
                >
                  document
                </span>
              )}
            </div>

            <div
              style={{
                fontSize: 12, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap",
                color: "var(--text-muted)",
              }}
            >
              {t.dueDate && (
                <span style={overdue(t) ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
                  {overdue(t) ? "Overdue — due " : "Due "}
                  {dueLabel(t.dueDate)}
                </span>
              )}
              {t.assignees.length > 0 && <span>{t.assignees.join(", ")}</span>}
              {t.updatedAt && <span>updated {relTime(t.updatedAt)}</span>}
            </div>
          </div>
        </div>
      ))}

      {closed.length > 0 && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setShowClosed((v) => !v)}
          style={{ alignSelf: "flex-start" }}
        >
          {showClosed
            ? "Hide closed tasks"
            : `Show ${closed.length} closed task${closed.length === 1 ? "" : "s"}`}
        </button>
      )}
    </div>
  );
}
