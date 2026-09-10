"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";
import { AttributeInput, type Definition } from "@/components/AttributeInput";

type Sheet = {
  id: string; version: number; stage: "as-submitted" | "as-released";
  revision: string; size: number; onshapeVersionId: string | null;
  releaseId: string | null; fetchedAt: string | null;
  failedAt: string | null; failureReason: string | null; isCurrent: boolean;
};

type Data = {
  drawing: any;
  definitions: Definition[];
  missingForRelease: string[];
  files: Sheet[];
  parts: any[];
  release: { id: string; number: string; state: string } | null;
  logs: any[];
};

export function DrawingDetail({ id }: { id: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/drawings/${id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load this drawing");
      setData(j);
      setDraft({});
      setFieldErrors({});
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return <div className="card" style={{ padding: 40, textAlign: "center" }}><Spinner size={20} /></div>;
  }
  if (!data) return <Alert kind="error">{error ?? "Not found"}</Alert>;

  const d = data.drawing;
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    setSaving(true);
    setFieldErrors({});
    try {
      const r = await fetch(`/api/drawings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: draft }),
      });
      const j = await r.json();
      if (r.status === 422 && j.errors) {
        setFieldErrors(j.errors);
        return;
      }
      if (!r.ok) throw new Error(j.error || "Could not save");
      setNotice(j.changed ? `Saved as iteration ${j.drawing.iteration}.` : "Nothing had changed.");
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <h1 className="mono" style={{ margin: 0, fontSize: 19 }}>{d.number ?? "—"}</h1>
          <RevChip revision={d.revision} iteration={d.iteration} />
          <StatusBadge status={d.lifecycleState} />
          <span className="badge">drawing</span>
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 3 }}>{d.name}</div>
        <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 2 }}>
          {d.documentName}{d.elementName ? ` · ${d.elementName}` : ""}
        </div>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {data.release && (
        <Alert kind={data.release.state === "Under Review" ? "warn" : "info"}>
          In release{" "}
          <Link href={`/releases/${data.release.id}`} style={{ color: "inherit", fontWeight: 600 }}>
            {data.release.number}
          </Link>
          , which is {data.release.state.toLowerCase()}.
        </Alert>
      )}

      {data.missingForRelease.length > 0 && d.lifecycleState !== "Released" && (
        <Alert kind="warn">
          <strong>Not ready to release.</strong> Still needs {data.missingForRelease.join(", ")}.
        </Alert>
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)" }}>
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>Attributes</h2>
            <div style={{ flex: 1 }} />
            {dirty && (
              <>
                <button className="btn btn-sm" onClick={() => { setDraft({}); setFieldErrors({}); }}>
                  Discard
                </button>
                <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                  {saving ? <Spinner /> : "Save"}
                </button>
              </>
            )}
          </div>
          {data.definitions.map((def) => (
            <AttributeInput
              key={def.key}
              def={def}
              value={def.key in draft ? draft[def.key] : d.attributes?.[def.key] ?? null}
              error={fieldErrors[def.key]}
              onChange={(v) =>
                setDraft((prev) => {
                  const next = { ...prev };
                  const stored = d.attributes?.[def.key] ?? null;
                  if (String(v ?? "") === String(stored ?? "")) delete next[def.key];
                  else next[def.key] = v;
                  return next;
                })
              }
            />
          ))}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          <div className="card" style={{ display: "grid", gap: 10 }}>
            <div>
              <h2 style={{ margin: "0 0 3px", fontSize: 15 }}>Sheets</h2>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
                Both stages are kept. Onshape only applies the revision, the watermark and the
                title-block release fields once the release has completed, so the sheet the
                approvers reviewed and the controlled document are different files.
              </p>
            </div>

            {data.files.length === 0 && (
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
                No sheets captured yet. They are exported when a release is raised, and again once
                it completes.
              </p>
            )}

            {data.files.map((f) => (
              <div
                key={f.id}
                style={{
                  border: `1px solid ${f.failedAt ? "var(--danger)" : f.isCurrent ? "var(--accent)" : "var(--border)"}`,
                  background: f.isCurrent ? "var(--accent-soft)" : "var(--surface-2)",
                  borderRadius: 8, padding: "9px 11px",
                }}
              >
                <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 12.5 }}>
                    {f.stage === "as-released" ? "As released" : "As submitted"}
                  </strong>
                  <span style={{ fontSize: 11, color: "var(--text-faint)" }}>v{f.version}</span>
                  {f.revision && <span className="badge">{f.revision}</span>}
                  {f.isCurrent && <span className="badge">current</span>}
                  <div style={{ flex: 1 }} />
                  {f.releaseId && (
                    <Link href={`/releases/${f.releaseId}`} style={{ fontSize: 11 }}>release</Link>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 3 }}>
                  {f.revision ? `Revision ${f.revision}` : "No revision"}
                  {f.size ? ` · ${Math.round(f.size / 1024)} kB` : ""}
                  {f.onshapeVersionId ? ` · from version ${f.onshapeVersionId}` : " · from the workspace"}
                  {f.fetchedAt ? ` · ${relTime(f.fetchedAt)}` : ""}
                </div>
                {f.failedAt ? (
                  <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 5 }}>
                    {f.failureReason}
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
                    <a className="btn btn-sm" href={`/api/drawings/${id}/files/${f.id}`} target="_blank" rel="noreferrer">
                      View
                    </a>
                    <a className="btn btn-sm" href={`/api/drawings/${id}/files/${f.id}?download=1`}>
                      Download
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="card">
            <h2 style={{ margin: "0 0 8px", fontSize: 15 }}>Documents these parts</h2>
            {data.parts.length === 0 ? (
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
                Not linked to any part yet. The association arrives with a release package —
                Onshape adds the active drawings to it itself.
              </p>
            ) : (
              data.parts.map((p) => (
                <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", fontSize: 12.5 }}>
                  <Link href={`/parts/${p.id}`} className="mono">{p.number ?? "—"}</Link>
                  <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0 }}>{p.name}</span>
                  <RevChip revision={p.revision} iteration={p.iteration} />
                  <StatusBadge status={p.lifecycleState} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ margin: 0, fontSize: 15, padding: "13px 16px 10px" }}>Activity</h2>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Direction</th>
              <th style={{ width: 90 }}>Action</th>
              <th>Message</th>
              <th style={{ width: 110 }}>When</th>
            </tr>
          </thead>
          <tbody>
            {data.logs.map((l) => (
              <tr key={l.id}>
                <td className="mono" style={{ fontSize: 11 }}>{l.direction}</td>
                <td style={{ fontSize: 12, color: l.ok ? undefined : "var(--danger)" }}>{l.action}</td>
                <td style={{ fontSize: 12 }}>{l.message}</td>
                <td style={{ fontSize: 12, color: "var(--text-faint)" }} title={l.createdAt}>
                  {relTime(l.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
