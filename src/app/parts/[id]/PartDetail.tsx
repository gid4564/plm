"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, KV, PartThumb, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";
import { AttributeInput, type Definition } from "@/components/AttributeInput";

type Data = {
  part: any;
  definitions: Definition[];
  missingForRelease: string[];
  structure: { children: any[]; usedIn: any[] };
  iterations: any[];
  drawings: any[];
  release: { id: string; number: string; state: string } | null;
  onshapeUrl: string | null;
  logs: any[];
};

export function PartDetail({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Pending edits, keyed by attribute. Empty means nothing is dirty. */
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [mass, setMass] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/parts/${id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load this part");
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
  if (!data) {
    return <Alert kind="error">{error ?? "Not found"}</Alert>;
  }

  const p = data.part;
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    setSaving(true);
    setFieldErrors({});
    setNotice(null);
    try {
      const r = await fetch(`/api/parts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: draft }),
      });
      const j = await r.json();

      if (r.status === 422 && j.errors) {
        // Per-field, because a governance refusal is about one attribute and
        // has a reason worth reading next to it.
        setFieldErrors(j.errors);
        return;
      }
      if (!r.ok) throw new Error(j.error || "Could not save");

      const push = j.push;
      setNotice(
        j.changed
          ? `Saved as iteration ${j.part.iteration}.` +
            (push?.ok
              ? ` ${Object.keys(push.written ?? {}).length} value(s) written to Onshape.`
              : push?.error
                ? ` Onshape was not updated: ${push.error}`
                : "")
          : "Nothing had changed."
      );
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function act(action: string) {
    setBusy(action);
    setNotice(null);
    try {
      const r = await fetch(`/api/parts/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");

      if (action === "pull") {
        const n = Object.keys(j.pull?.changes ?? {}).length;
        setNotice(n ? `Re-read from Onshape: ${n} value(s) changed.` : "Re-read from Onshape: nothing had changed.");
      } else if (action === "push") {
        setNotice(j.push?.ok ? "Written to Onshape." : `Onshape refused the write: ${j.push?.error}`);
      } else if (action === "obsolete") {
        setNotice("Obsoleted.");
      }
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function loadMass() {
    setBusy("mass");
    try {
      const r = await fetch(`/api/parts/${id}/mass-properties`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Onshape could not measure this part");
      setMass(j);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirm(`Remove ${p.number} from PLM? Its PLM values will be cleared in Onshape.`)) return;
    setBusy("delete");
    try {
      const r = await fetch(`/api/parts/${id}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not remove this part");
      router.push("/dashboard");
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(null);
    }
  }

  // Grouped in the order the schema declares, so an admin's grouping and
  // ordering is what a reader sees.
  const groups: { name: string; defs: Definition[] }[] = [];
  for (const d of data.definitions) {
    const name = d.group || "Other";
    const g = groups.find((x) => x.name === name);
    if (g) g.defs.push(d);
    else groups.push({ name, defs: [d] });
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <PartThumb partId={id} size={64} radius={8} alt="" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <h1 className="mono" style={{ margin: 0, fontSize: 19 }}>{p.number ?? "—"}</h1>
            <RevChip revision={p.revision} iteration={p.iteration} />
            <StatusBadge status={p.lifecycleState} />
            {p.kind === "assembly" && <span className="badge">assembly</span>}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 3 }}>{p.name}</div>
          <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 2 }}>
            {p.documentName}{p.elementName ? ` · ${p.elementName}` : ""}
            {p.partIdInOnshape ? ` · part ${p.partIdInOnshape}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {data.onshapeUrl && (
            <a className="btn" href={data.onshapeUrl} target="_blank" rel="noreferrer">Open in Onshape</a>
          )}
          <button className="btn" onClick={() => act("pull")} disabled={busy === "pull"}>
            {busy === "pull" ? <Spinner /> : "Re-read from Onshape"}
          </button>
          {p.pushPending && (
            <button className="btn" onClick={() => act("push")} disabled={busy === "push"}>
              {busy === "push" ? <Spinner /> : "Retry write"}
            </button>
          )}
          {isAdmin && p.lifecycleState === "Released" && (
            <button className="btn" onClick={() => act("obsolete")} disabled={busy === "obsolete"}>
              {busy === "obsolete" ? <Spinner /> : "Obsolete"}
            </button>
          )}
          {p.lifecycleState !== "Released" && p.lifecycleState !== "Obsolete" && (
            <button className="btn btn-danger" onClick={remove} disabled={busy === "delete"}>
              {busy === "delete" ? <Spinner /> : "Remove"}
            </button>
          )}
        </div>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {data.release && (
        <Alert kind={data.release.state === "Under Review" ? "warn" : "info"}>
          This part is in release{" "}
          <Link href={`/releases/${data.release.id}`} style={{ color: "inherit", fontWeight: 600 }}>
            {data.release.number}
          </Link>
          , which is {data.release.state.toLowerCase()}.
        </Alert>
      )}

      {p.writeBackBlocked && (
        <Alert kind="info">
          <strong>Nothing is written to Onshape for this part.</strong> {p.writeBackBlocked}
        </Alert>
      )}
      {p.pushPending && p.lastPushError && (
        <Alert kind="warn"><strong>A write to Onshape is outstanding.</strong> {p.lastPushError}</Alert>
      )}

      {data.missingForRelease.length > 0 && p.lifecycleState !== "Released" && (
        <Alert kind="warn">
          <strong>Not ready to release.</strong> These attributes must hold a value first:{" "}
          {data.missingForRelease.join(", ")}.
        </Alert>
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
        {/* ------------------------------- Attributes -------------------------- */}
        <div className="card" style={{ display: "grid", gap: 14 }}>
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

          {groups.map((g) => (
            <div key={g.name} style={{ display: "grid", gap: 10 }}>
              <div
                style={{
                  fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em",
                  color: "var(--text-faint)", borderBottom: "1px solid var(--border)", paddingBottom: 4,
                }}
              >
                {g.name}
              </div>
              {g.defs.map((d) => (
                <AttributeInput
                  key={d.key}
                  def={d}
                  value={d.key in draft ? draft[d.key] : p.attributes?.[d.key] ?? null}
                  error={fieldErrors[d.key]}
                  onChange={(v) =>
                    setDraft((prev) => {
                      const next = { ...prev };
                      // Reverting a field to its stored value should leave the
                      // form clean, not merely equal — otherwise Save stays lit
                      // with nothing to do.
                      const stored = p.attributes?.[d.key] ?? null;
                      if (String(v ?? "") === String(stored ?? "")) delete next[d.key];
                      else next[d.key] = v;
                      return next;
                    })
                  }
                />
              ))}
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          {/* ------------------------------ Drawings --------------------------- */}
          <div className="card">
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Drawings</h2>
            {data.drawings.length === 0 ? (
              <p style={{ margin: 0, color: "var(--text-faint)", fontSize: 12.5 }}>
                None yet. Drawings reach PLM with a release package — Onshape adds the active
                sheets to it itself.
              </p>
            ) : (
              data.drawings.map((d) => (
                <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0" }}>
                  <Link href={`/drawings/${d.id}`} className="mono" style={{ fontSize: 12.5 }}>
                    {d.number}
                  </Link>
                  <span style={{ fontSize: 12.5, color: "var(--text-muted)", flex: 1 }}>{d.name}</span>
                  {d.revision && <span className="badge">{d.revision}</span>}
                  {d.currentFileId && (
                    <a
                      className="btn btn-sm"
                      href={`/api/drawings/${d.id}/files/${d.currentFileId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      PDF
                    </a>
                  )}
                </div>
              ))
            )}
          </div>

          {/* ------------------------------ Structure -------------------------- */}
          <div className="card">
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>
              {p.kind === "assembly" ? "Components" : "Structure"}
            </h2>
            {data.structure.children.length === 0 && data.structure.usedIn.length === 0 ? (
              <p style={{ margin: 0, color: "var(--text-faint)", fontSize: 12.5 }}>
                No structure recorded. Importing an assembly&rsquo;s BOM is what creates it.
              </p>
            ) : (
              <>
                {data.structure.children.length > 0 && (
                  <>
                    <div style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "0 0 4px" }}>
                      Contains
                    </div>
                    {data.structure.children.map((c) => (
                      <StructureRow key={c.linkId} row={c} showQty />
                    ))}
                  </>
                )}
                {data.structure.usedIn.length > 0 && (
                  <>
                    <div style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "10px 0 4px" }}>
                      Used in
                    </div>
                    {data.structure.usedIn.map((c) => (
                      <StructureRow key={c.linkId} row={c} showQty />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* ----------------------------- Mass properties -------------------- */}
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>Mass properties</h2>
              <div style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={loadMass} disabled={busy === "mass"}>
                {busy === "mass" ? <Spinner /> : mass ? "Refresh" : "Measure"}
              </button>
            </div>
            {mass ? (
              <div style={{ marginTop: 8 }}>
                <KV k="Mass" v={mass.massKg != null ? `${mass.massKg.toFixed(3)} kg` : "—"} />
                <KV k="Volume" v={mass.volumeM3 != null ? `${(mass.volumeM3 * 1e6).toFixed(1)} cm³` : "—"} />
                <KV k="Surface area" v={mass.areaM2 != null ? `${(mass.areaM2 * 1e4).toFixed(1)} cm²` : "—"} />
              </div>
            ) : (
              <p style={{ margin: "8px 0 0", color: "var(--text-faint)", fontSize: 12.5 }}>
                Read from Onshape on request rather than mirrored — it is only interesting when
                somebody looks.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------- Iterations --------------------------- */}
      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ margin: 0, fontSize: 15, padding: "13px 16px 10px" }}>
          Iteration history
          <span style={{ fontWeight: 400, color: "var(--text-faint)", fontSize: 12, marginLeft: 8 }}>
            PLM&rsquo;s own pre-release history. Onshape keeps microversions, but nothing a
            reviewer can read.
          </span>
        </h2>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 70 }}>Version</th>
              <th style={{ width: 130 }}>State</th>
              <th style={{ width: 90 }}>Cause</th>
              <th>What changed</th>
              <th style={{ width: 190 }}>By</th>
              <th style={{ width: 110 }}>When</th>
            </tr>
          </thead>
          <tbody>
            {data.iterations.map((it) => (
              <tr key={it.iteration}>
                <td><RevChip revision={it.revision} iteration={it.iteration} /></td>
                <td><StatusBadge status={it.lifecycleState} /></td>
                <td style={{ fontSize: 12 }}>{it.cause}</td>
                <td style={{ fontSize: 12 }}>
                  {it.changedKeys.length ? it.changedKeys.join(", ") : <span style={{ color: "var(--text-faint)" }}>—</span>}
                </td>
                <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {it.createdByEmail || "automatic"}
                </td>
                <td style={{ fontSize: 12, color: "var(--text-faint)" }} title={it.createdAt}>
                  {relTime(it.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* -------------------------- Onshape properties ------------------------ */}
      <details className="card">
        <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
          Everything Onshape reported ({p.onshapeProperties?.length ?? 0} properties)
        </summary>
        <p style={{ fontSize: 12, color: "var(--text-faint)", margin: "8px 0" }}>
          Kept verbatim, with the value Onshape sent beside the one PLM read from it. A property
          that failed to map shows here rather than vanishing — and a mapping that resolved to the
          wrong label only looks wrong next to the raw value.
        </p>
        <table className="table">
          <thead>
            <tr><th>Property</th><th>Value read</th><th>Raw</th></tr>
          </thead>
          <tbody>
            {(p.onshapeProperties ?? []).map((op: any, i: number) => (
              <tr key={`${op.propertyId}-${i}`}>
                <td style={{ fontSize: 12 }}>
                  {op.name || <span className="mono">{op.propertyId}</span>}
                </td>
                <td style={{ fontSize: 12 }}>{String(op.value ?? "")}</td>
                <td className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  {typeof op.raw === "object" ? JSON.stringify(op.raw) : String(op.raw ?? "")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {/* ------------------------------- Activity ---------------------------- */}
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
              <tr key={l.id} style={{ opacity: l.ok ? 1 : undefined }}>
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

function StructureRow({ row, showQty }: { row: any; showQty?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", fontSize: 12.5 }}>
      {showQty && (
        <span className="mono" style={{ color: "var(--text-faint)", minWidth: 26 }}>
          ×{row.quantity}
        </span>
      )}
      <Link href={`/parts/${row.partId}`} className="mono">{row.number ?? "—"}</Link>
      <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {row.name}
      </span>
      {row.revision && <span className="badge">{row.revision}</span>}
      <StatusBadge status={row.lifecycleState} />
    </div>
  );
}
