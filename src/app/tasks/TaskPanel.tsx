"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, FavoriteButton, KV, PartThumb, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";
import { formatPropertyValue, isStructuredValue } from "@/lib/onshape/task-values";
import { PriorityIcon } from "@/components/TaskPriority";

type Comment = {
  id: string;
  message: string;
  authorEmail: string;
  authorName: string;
  origin: "onshape" | "plm";
  createdAt: string;
  pushPending: boolean;
  pushError: string | null;
  /** Will never reach Onshape — the task has no document to hold a comment. */
  plmOnly: boolean;
  inOnshape: boolean;
};

/**
 * One task, open for work.
 *
 * The three things a task interface has to do are here and nowhere else: read
 * the thread, say something, and move the task on. The transitions offered are
 * the task's own — Onshape's workflow decides them, and PLM shows what it is
 * given rather than a fixed set of buttons that might not apply.
 */
export function TaskPanel({
  taskId, onClose, onChanged,
}: {
  taskId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [propDraft, setPropDraft] = useState<Record<string, unknown>>({});

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/tasks/${taskId}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load that task");
      setData(j);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId) { setData(null); setDraft(""); setPropDraft({}); setNotice(null); setError(null); return; }
    void load();
  }, [taskId, load]);

  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      // Not while typing a comment — Escape in a textarea should not close the
      // panel and lose it.
      const typing = ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName ?? "");
      if (e.key === "Escape" && !typing && !draft.trim()) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [taskId, onClose, draft]);

  async function act(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`/api/tasks/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");
      setNotice(j.message ?? "Done.");
      if (body.action === "comment") setDraft("");
      if (body.action === "update") setPropDraft({});
      await load();
      onChanged();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  if (!taskId) return null;
  const t = data?.task;

  return (
    <>
      <div
        onClick={() => { if (!draft.trim()) onClose(); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.28)", zIndex: 40 }}
      />
      <aside
        role="dialog"
        aria-label="Task"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: "min(520px, 96vw)",
          background: "var(--surface)", borderLeft: "1px solid var(--border)",
          boxShadow: "-8px 0 32px rgba(0,0,0,.18)", zIndex: 41,
          overflowY: "auto", padding: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <strong style={{ fontSize: 13 }}>Task</strong>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => act({ action: "refresh" }, "refresh")}
            disabled={busy != null}>
            {busy === "refresh" ? <Spinner size={11} /> : "Refresh from Onshape"}
          </button>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>

        {loading && !t && <div style={{ padding: 24, textAlign: "center" }}><Spinner size={18} /></div>}
        {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
        {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

        {t && (
          <div style={{ display: "grid", gap: 15 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <FavoriteButton kind="task" targetId={taskId} active={Boolean(t.isFavorite)} size={18} />
                <h2 style={{ margin: 0, fontSize: 16 }}>{t.name || "(untitled task)"}</h2>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
                <span className="badge">{t.state || "no state"}</span>
                {/*
                  * Beside the state, because the two together are the whole
                  * "where is this and how much does it matter" question.
                  * Read off the Priority property, which is where it lives.
                  */}
                <PriorityIcon
                  value={formatPropertyValue(
                    (t.properties ?? []).find((p: any) => /^priority/i.test(String(p.name ?? "")))?.value,
                    {
                      enumValues: (t.properties ?? [])
                        .find((p: any) => /^priority/i.test(String(p.name ?? "")))?.enumValues,
                      empty: "",
                    }
                  )}
                  withLabel
                />
                {t.taskType && <span className="badge">{t.taskType}</span>}
                {t.pushPending && (
                  <span className="badge" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>
                    unsent changes
                  </span>
                )}
              </div>
              {t.description && (
                <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {t.description}
                </p>
              )}
            </div>

            {t.lastPushError && (
              <Alert kind="warn">
                Onshape refused the last change PLM sent: {t.lastPushError}
              </Alert>
            )}

            {/* ------------------------------ Actions ------------------------------ */}
            <div>
              <div className="label">Move this task on</div>
              {t.availableActions.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-faint)" }}>
                  Onshape offers this account no transitions from{" "}
                  <strong>{t.state || "its current state"}</strong>. Its workflow decides what is
                  available and to whom — refreshing will pick up a change made elsewhere.
                </p>
              ) : (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {t.availableActions.map((a: any) => (
                    <button
                      key={a.id}
                      className={`btn btn-sm${/APPROVE|RESOLVE|COMPLETE/.test(a.type) ? " btn-primary" : ""}`}
                      onClick={() => act({ action: "transition", transition: a.id }, a.id)}
                      disabled={busy != null}
                      title={`Onshape calls this "${a.id}" (${a.type})`}
                    >
                      {busy === a.id ? <Spinner size={11} /> : a.label || a.id}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* ----------------------------- Properties ---------------------------- */}
            {t.properties?.length > 0 && (
              <div>
                <div className="label">Details</div>
                {/*
                  A task's due date, priority and task state are metadata
                  PROPERTIES, not fields — they arrive with ids, types and their
                  own editability. Onshape decides what may be changed, so what
                  is offered here is what it said, and a read-only property is
                  shown as a value rather than a disabled box.
                */}
                <div style={{ display: "grid", gap: 8 }}>
                  {t.properties
                    .filter((pr: any) => !/^name$|^description$/i.test(pr.name))
                    .map((pr: any) => (
                      <TaskProperty
                        key={pr.propertyId}
                        prop={pr}
                        value={pr.propertyId in propDraft ? propDraft[pr.propertyId] : pr.value}
                        onChange={(v: unknown) =>
                          setPropDraft((prev) => ({ ...prev, [pr.propertyId]: v }))}
                      />
                    ))}
                </div>

                {Object.keys(propDraft).length > 0 && (
                  <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => act({ action: "update", propertyValues: propDraft }, "props")}
                      disabled={busy != null}
                    >
                      {busy === "props" ? <Spinner size={11} /> : "Save to Onshape"}
                    </button>
                    <button className="btn btn-sm" onClick={() => setPropDraft({})} disabled={busy != null}>
                      Discard
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ------------------------------- Items ------------------------------- */}
            {t.items.length > 0 && (
              <div>
                <div className="label">What it is about</div>
                <div style={{ display: "grid", gap: 6 }}>
                  {t.items.map((i: any, n: number) => (
                    <div key={`${i.partId ?? i.label}-${n}`}
                      style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {i.partId ? <PartThumb partId={i.partId} size={30} alt="" /> : null}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {i.partId ? (
                          <Link href={`/parts/${i.partId}`} className="mono" style={{ fontSize: 12.5 }}>
                            {i.number ?? i.label}
                          </Link>
                        ) : (
                          <span style={{ fontSize: 12.5 }}>{i.label}</span>
                        )}
                        <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                          {i.partId
                            ? i.name
                            : /*
                                An item PLM does not track is still named. A task
                                about something outside PLM is a normal thing,
                                and a blank row would read as a bug.
                              */
                              "not tracked in PLM"}
                        </div>
                      </div>
                      {i.partId && <RevChip revision={i.revision} iteration={i.iteration} />}
                      {i.lifecycleState && <StatusBadge status={i.lifecycleState} />}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <KV k="Raised by" v={t.creatorName || t.creatorEmail || "—"} />
              <KV
                k="Assigned to"
                v={
                  t.assignees.length
                    ? t.assignees.map((a: any) => a.name || a.email).join(", ")
                    : "nobody"
                }
              />
              {t.documentName && <KV k="Onshape document" v={t.documentName} />}
              {t.resolvedAt && (
                <KV k="Resolved" v={`${relTime(t.resolvedAt)}${t.resolvedByEmail ? ` by ${t.resolvedByEmail}` : ""}`} />
              )}
              <KV k="Last read from Onshape" v={relTime(t.lastSyncedFromOnshapeAt)} />
            </div>

            {/* ------------------------------ Comments ----------------------------- */}
            <div>
              <div className="label">
                Comments {t.comments.length > 0 && `(${t.comments.length})`}
              </div>

              <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                {t.comments.length === 0 && (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--text-faint)" }}>
                    Nothing yet. A comment written here is posted to the task in Onshape.
                  </p>
                )}
                {t.comments.map((c: Comment) => (
                  <div
                    key={c.id}
                    style={{
                      border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
                      background: c.origin === "plm" ? "var(--accent-soft)" : "transparent",
                    }}
                  >
                    <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 12 }}>{c.authorName || c.authorEmail || "someone"}</strong>
                      <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                        {relTime(c.createdAt)}
                      </span>
                      <span className="badge" style={{ fontSize: 10 }}>
                        {c.origin === "plm" ? "from PLM" : "from Onshape"}
                      </span>
                      {/*
                        A PLM comment Onshape has not accepted is marked rather
                        than hidden or silently dropped — somebody typed it, and
                        they should be able to see both that it is kept and that
                        it has not arrived.
                      */}
                      {c.pushPending && (
                        <span className="badge" style={{ color: "var(--warn)", borderColor: "var(--warn)", fontSize: 10 }}>
                          not sent to Onshape
                        </span>
                      )}
                      {/*
                        "Not possible" rather than "not yet" — implying a retry
                        would help would be the wrong kind of hopeful.
                      */}
                      {c.plmOnly && (
                        <span className="badge" style={{ fontSize: 10 }} title="This task has no Onshape document to hold a comment">
                          PLM only
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 3, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                      {c.message}
                    </div>
                    {c.pushError && (
                      <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>
                        Onshape said: {c.pushError}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/*
                Said before they type, not after they press send.
                Onshape's comments are document-scoped, so a task attached to
                no document has nowhere to put one — established by probing a
                live tenant, where every candidate body was refused.
              */}
              {t.commentable === false && (
                <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginBottom: 5 }}>
                  This task is not attached to an Onshape document, so a comment stays in PLM —
                  Onshape&rsquo;s comments belong to a document and it has nowhere to put one.
                </div>
              )}

              <textarea
                className="input"
                rows={3}
                style={{ width: "100%", resize: "vertical" }}
                placeholder={
                  t.commentable === false
                    ? "Add a comment — kept in PLM"
                    : "Add a comment — it is posted to Onshape too"
                }
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter sends, which is what anyone tries in a
                  // comment box they intend to use repeatedly.
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && draft.trim()) {
                    void act({ action: "comment", message: draft }, "comment");
                  }
                }}
              />
              <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => act({ action: "comment", message: draft }, "comment")}
                  disabled={busy != null || !draft.trim()}
                >
                  {busy === "comment" ? <Spinner size={11} /> : "Comment"}
                </button>
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>⌘/Ctrl + Enter</span>
              </div>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

/**
 * One task property, rendered from what Onshape said about it.
 *
 * A task's due date, priority and task state are metadata PROPERTIES rather
 * than fields — they arrive with ids, value types and their own editability.
 * Onshape decides what may be changed, so this makes no judgement of its own:
 * a read-only property is shown as a value with the reason, never a greyed-out
 * box, because a disabled input invites clicking and explains nothing.
 */
function TaskProperty({
  prop, value, onChange,
}: {
  prop: {
    propertyId: string; name: string; valueType: string;
    editable: boolean; required: boolean;
    enumValues: { value: string; label: string }[];
  };
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <label className="label" style={{ fontSize: 11 }}>
      {prop.name}
      {prop.required && <span style={{ color: "var(--warn)" }}> *</span>}
    </label>
  );

  if (!prop.editable) {
    /*
     * Formatted rather than stringified. Category and Assigned to are arrays
     * of objects, and String() on those renders "[object Object]" — which is
     * exactly what this panel used to show for both.
     */
    const shown =
      prop.valueType === "DATE"
        ? dateOnly(value) ?? "—"
        : formatPropertyValue(value, { valueType: prop.valueType, enumValues: prop.enumValues });
    return (
      <div>
        {label}
        <div style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
          <span>{shown}</span>
          <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
            set by Onshape&rsquo;s workflow
          </span>
        </div>
      </div>
    );
  }

  /*
   * An enum stores a code and carries its own labels, so the raw value is a
   * number nobody recognises — Priority reads "0", not "Low".
   */
  if (prop.enumValues.length) {
    return (
      <div>
        {label}
        <select
          className="select"
          style={{ width: "100%" }}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {prop.enumValues.map((e) => (
            <option key={e.value} value={e.value}>{e.label}</option>
          ))}
        </select>
      </div>
    );
  }

  if (prop.valueType === "DATE") {
    return (
      <div>
        {label}
        <input
          className="input"
          type="date"
          style={{ width: "100%" }}
          value={dateOnly(value) ?? ""}
          // Empty clears it, which is how "no due date" is said.
          onChange={(e) => onChange(e.target.value || null)}
        />
      </div>
    );
  }

  /*
   * CATEGORY and anything else structured is shown, not edited: its value is a
   * nested object of category ids, and a text box over that is a way to
   * corrupt it rather than change it.
   */
  /*
   * Structured, so shown rather than edited — but SHOWN, which it was not.
   *
   * This said "CATEGORY — edit this in Onshape" and withheld the value
   * entirely, so a reader could not see who a task was assigned to even
   * though PLM had it. The value is the useful half; the note about where to
   * change it is the footnote.
   */
  if (prop.valueType !== "STRING" || isStructuredValue(value)) {
    return (
      <div>
        {label}
        <div style={{ fontSize: 12.5, display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
          <span>
            {formatPropertyValue(value, { valueType: prop.valueType, enumValues: prop.enumValues })}
          </span>
          <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
            change this in Onshape
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      {label}
      <input
        className="input"
        style={{ width: "100%" }}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** A date value as YYYY-MM-DD, or null when there is not one. */
function dateOnly(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
