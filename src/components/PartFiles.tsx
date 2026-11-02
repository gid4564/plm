"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Spinner, relTime } from "@/components/ui";

export type PartAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  uploadedByEmail: string;
  isCad: boolean;
  onshapeElementId: string | null;
  onshapeError: string | null;
};

type Body = { elementId: string; elementName: string; partId: string; name: string };

export type PlanEntry = {
  key: string; fileName: string; name: string;
  instances: number; bodiesPerInstance: number;
  include: boolean; primary: boolean;
  plmPartId: string | null; number: string | null; bodyCount: number;
};

export type OnshapeCreate = {
  state: "review" | "running" | "map" | "failed" | "done";
  step: string;
  error: string | null;
  warnings: string[];
  attachmentId: string | null;
  planFrom: "file" | "import" | null;
  plan: PlanEntry[];
  unassignedBodies: Body[];
  startedAt: string | null;
  finishedAt: string | null;
} | null;

/** How often to re-read the part while an import runs. */
const POLL_MS = 3000;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * A part's attached files, and — for a PLM-only part — the button that
 * creates it in Onshape from one of them. See lib/onshape-create.ts.
 *
 * Follows a running import by re-reading the part every few seconds, through
 * the page's own `onChanged`, so the rest of the page (the Onshape link, the
 * thumbnail, the PLM-only badge) changes the moment the part is linked.
 */
export function PartFiles({
  partId, partNumber, plmOnly, locked, attachments, run, onChanged,
}: {
  partId: string;
  partNumber: string | null;
  plmOnly: boolean;
  /** Released or obsolete: files are fixed. */
  locked: boolean;
  attachments: PartAttachment[];
  run: OnshapeCreate;
  onChanged: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string>("");
  const fileInput = useRef<HTMLInputElement>(null);

  const cad = attachments.filter((a) => a.isCad);
  const running = run?.state === "running";

  // Default the import source to the only CAD file, or the one last tried.
  useEffect(() => {
    if (source && cad.some((a) => a.id === source)) return;
    setSource(run?.attachmentId && cad.some((a) => a.id === run.attachmentId) ? run.attachmentId : cad[0]?.id ?? "");
  }, [cad, run?.attachmentId, source]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { void onChanged(); }, POLL_MS);
    return () => clearInterval(t);
  }, [running, onChanged]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy("upload");
    setError(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      const r = await fetch(`/api/parts/${partId}/attachments`, { method: "POST", body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
      await onChanged();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove(a: PartAttachment) {
    if (!confirm(`Remove ${a.filename} from this part?` +
      (a.onshapeElementId ? " The copy already in the Onshape document stays there." : ""))) return;
    setBusy(`remove:${a.id}`);
    setError(null);
    try {
      const r = await fetch(`/api/parts/${partId}/attachments/${a.id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not remove it");
      await onChanged();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const r = await fetch(`/api/parts/${partId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "That did not work");
      await onChanged();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>Files</h2>
        <div style={{ flex: 1 }} />
        {!locked && (
          <>
            <input
              ref={fileInput} type="file" multiple hidden
              onChange={(e) => upload(e.target.files)}
            />
            <button className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={busy === "upload"}>
              {busy === "upload" ? <Spinner /> : "Attach files…"}
            </button>
          </>
        )}
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {attachments.length === 0 ? (
        <p style={{ margin: 0, color: "var(--text-faint)", fontSize: 12.5 }}>
          No files attached.
          {plmOnly && " Attach a CAD file (STEP, Parasolid, SolidWorks…) to create this part in Onshape from it."}
        </p>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {attachments.map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <a
                href={`/api/parts/${partId}/attachments/${a.id}`}
                style={{ color: "var(--accent)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={`Uploaded ${relTime(a.uploadedAt)}${a.uploadedByEmail ? ` by ${a.uploadedByEmail}` : ""}`}
              >
                {a.filename}
              </a>
              <span style={{ color: "var(--text-faint)", fontSize: 11.5, whiteSpace: "nowrap" }}>{size(a.size)}</span>
              {a.isCad && <span className="badge">CAD</span>}
              {a.onshapeElementId && (
                <span className="badge" title="Also in the part's Onshape document">in Onshape</span>
              )}
              {a.onshapeError && (
                <span className="badge" style={{ color: "var(--warn)" }} title={a.onshapeError}>not sent</span>
              )}
              <div style={{ flex: 1 }} />
              {!locked && (
                <button
                  className="btn btn-sm" onClick={() => remove(a)}
                  disabled={busy === `remove:${a.id}` || (running && run?.attachmentId === a.id)}
                  aria-label={`Remove ${a.filename}`}
                >
                  {busy === `remove:${a.id}` ? <Spinner /> : "Remove"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---------------------------- Create in Onshape ---------------------- */}
      {plmOnly && !locked && (
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, display: "grid", gap: 8 }}>
          {running ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <Spinner /> <span>{run?.step || "Working"}…</span>
            </div>
          ) : run?.state === "review" ? (
            <PlanReview
              key={run.plan.map((x) => x.key).join()}
              run={run} partNumber={partNumber} busy={busy}
              onConfirm={(plan) => post({ action: "confirm-plan", plan }, "confirm")}
              onCancel={() => post({ action: "cancel-plan" }, "cancel")}
            />
          ) : run?.state === "map" ? (
            <BodyMap
              run={run} busy={busy}
              onAssign={(assignments) => post({ action: "assign-bodies", assignments }, "assign")}
            />
          ) : (
            <>
              {run?.state === "failed" && (
                <Alert kind="error">
                  <strong>Creating in Onshape failed.</strong> {run.error}
                  <span style={{ display: "block", marginTop: 4 }}>
                    Trying again reuses the document already made.
                  </span>
                </Alert>
              )}
              {cad.length === 0 ? (
                <p style={{ margin: 0, color: "var(--text-faint)", fontSize: 12.5 }}>
                  Attach a CAD file to create this part in Onshape.
                </p>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {cad.length > 1 && (
                    <select
                      value={source} onChange={(e) => setSource(e.target.value)}
                      aria-label="File to import" style={{ maxWidth: 220 }}
                    >
                      {cad.map((a) => <option key={a.id} value={a.id}>{a.filename}</option>)}
                    </select>
                  )}
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!source || busy !== null}
                    onClick={() => post({ action: "create-in-onshape", attachmentId: source }, "create")}
                    title="Make a company document, import this file into a Part Studio, and link this part to it"
                  >
                    {busy === "create" ? <Spinner /> : run?.state === "failed" ? "Try again" : "Create in Onshape"}
                  </button>
                  <span style={{ color: "var(--text-faint)", fontSize: 11.5 }}>
                    {cad.length === 1 ? `from ${cad[0].filename}` : ""}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {run?.state === "done" && run.plan.filter((x) => x.include && x.plmPartId && x.plmPartId !== partId).length > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Also created from this file:{" "}
          {run.plan
            .filter((x) => x.include && x.plmPartId && x.plmPartId !== partId)
            .map((x, i) => (
              <span key={x.key}>
                {i > 0 && ", "}
                <a href={`/parts/${x.plmPartId}`} style={{ color: "var(--accent)" }} className="mono">{x.number ?? "part"}</a>
                {" "}{x.name}
              </span>
            ))}
        </div>
      )}

      {run?.state === "done" && run.warnings.length > 0 && (
        <Alert kind="warn">
          <strong>Created in Onshape, with warnings.</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {run.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Alert>
      )}
    </div>
  );
}

/**
 * What a multi-part file is to become, for a person to confirm.
 *
 * One row per distinct part. The radio says which row is this PLM part; every
 * other ticked row becomes a new PLM part, with its own number, under the
 * name in its box. An unticked row is left in the document as geometry with no
 * PLM part behind it.
 */
function PlanReview({
  run, partNumber, busy, onConfirm, onCancel,
}: {
  run: NonNullable<OnshapeCreate>;
  partNumber: string | null;
  busy: string | null;
  onConfirm: (plan: { key: string; name: string; include: boolean; primary: boolean }[]) => void;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState(() =>
    run.plan.map((x) => ({ ...x, name: x.primary ? x.fileName : x.name }))
  );
  const set = (key: string, patch: Partial<(typeof rows)[number]>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const choosePrimary = (key: string) =>
    setRows((prev) => prev.map((r) => ({ ...r, primary: r.key === key, include: r.key === key ? true : r.include })));

  const creating = rows.filter((r) => r.include && !r.primary).length;
  const blank = rows.some((r) => r.include && !r.primary && !r.name.trim());
  const label = partNumber ?? "this part";

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13 }}>
        {run.step}.{" "}
        <span style={{ color: "var(--text-faint)" }}>
          {run.planFrom === "file"
            ? "Read from the file — nothing has been created yet."
            : "Already imported into Onshape; this decides which bodies get PLM parts."}
        </span>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "grid", gridTemplateColumns: "22px 22px 1fr auto", gap: 8, fontSize: 11, color: "var(--text-faint)" }}>
          <span title={`Which part is ${label}`}>is</span><span title="Create a PLM part">add</span><span>Name</span><span>Uses</span>
        </div>
        {rows.map((r) => (
          <div key={r.key} style={{ display: "grid", gridTemplateColumns: "22px 22px 1fr auto", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input
              type="radio" name="plan-primary" checked={r.primary}
              onChange={() => choosePrimary(r.key)}
              aria-label={`${r.fileName} is ${label}`}
            />
            <input
              type="checkbox" checked={r.include} disabled={r.primary}
              onChange={(e) => set(r.key, { include: e.target.checked })}
              aria-label={`Create a PLM part for ${r.fileName}`}
            />
            {r.primary ? (
              <span title={`Keeps ${label}'s own name and number`}>
                <strong className="mono">{label}</strong>{" "}
                <span style={{ color: "var(--text-faint)" }}>({r.fileName} in the file)</span>
              </span>
            ) : (
              <input
                className="input" value={r.name} disabled={!r.include}
                onChange={(e) => set(r.key, { name: e.target.value })}
                aria-label={`Name for ${r.fileName}`}
                style={{ minWidth: 0, opacity: r.include ? 1 : 0.5 }}
              />
            )}
            <span
              style={{ color: "var(--text-faint)", fontSize: 12, whiteSpace: "nowrap" }}
              title={r.bodiesPerInstance > 1 ? `${r.bodiesPerInstance} bodies each` : undefined}
            >
              ×{r.instances}{r.bodiesPerInstance > 1 ? ` · ${r.bodiesPerInstance} bodies` : ""}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="btn btn-primary btn-sm"
          disabled={busy !== null || blank}
          onClick={() => onConfirm(rows.map((r) => ({ key: r.key, name: r.name, include: r.include, primary: r.primary })))}
        >
          {busy === "confirm" ? <Spinner /> :
            `${creating ? `Create ${creating} more part${creating === 1 ? "" : "s"} and ` : ""}` +
            `${run.planFrom === "file" ? "import" : "link"}`}
        </button>
        <button className="btn btn-sm" disabled={busy !== null} onClick={onCancel}>
          {busy === "cancel" ? <Spinner /> : "Cancel"}
        </button>
        <span style={{ color: "var(--text-faint)", fontSize: 11.5 }}>
          Repeated uses of a part share one PLM part and number.
        </span>
      </div>
    </div>
  );
}

/**
 * Bodies the import made that no part could be matched to by name — Onshape
 * may name bodies "Part 1", "Part 2" rather than after the file. Each part
 * still without a body picks one.
 */
function BodyMap({
  run, busy, onAssign,
}: {
  run: NonNullable<OnshapeCreate>;
  busy: string | null;
  onAssign: (assignments: { key: string; elementId: string; partId: string }[]) => void;
}) {
  const waiting = run.plan.filter((x) => x.include && x.bodyCount === 0);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const id = (b: Body) => `${b.elementId}:${b.partId}`;
  const taken = new Set(Object.values(choice));
  const complete = waiting.every((x) => choice[x.key]);

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13 }}>{run.step}:</div>
      {waiting.map((x) => (
        <div key={x.key} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, flexWrap: "wrap" }}>
          <span style={{ minWidth: 120 }}>{x.number ? <span className="mono">{x.number} </span> : null}{x.name}</span>
          <select
            value={choice[x.key] ?? ""}
            onChange={(e) => setChoice((prev) => ({ ...prev, [x.key]: e.target.value }))}
            aria-label={`Body for ${x.name}`}
          >
            <option value="">Choose a body…</option>
            {run.unassignedBodies.map((b) => (
              <option key={id(b)} value={id(b)} disabled={taken.has(id(b)) && choice[x.key] !== id(b)}>
                {b.name || b.partId}
              </option>
            ))}
          </select>
        </div>
      ))}
      <button
        className="btn btn-primary btn-sm" style={{ justifySelf: "start" }}
        disabled={!complete || busy !== null}
        onClick={() => onAssign(waiting.map((x) => {
          const [elementId, partId] = choice[x.key].split(":");
          return { key: x.key, elementId, partId };
        }))}
      >
        {busy === "assign" ? <Spinner /> : "Link these"}
      </button>
    </div>
  );
}
