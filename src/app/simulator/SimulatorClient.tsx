"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Spinner, relTime } from "@/components/ui";

type Def = { propertyId: string; name: string; valueType: string; enumValues: string[]; builtIn: boolean };
type Part = {
  id: string; documentId: string; documentName: string; workspaceId: string;
  elementId: string; elementName: string; partId: string; configuration: string;
  properties: Record<string, string>;
  mos: { id: string; moNumber: string; status: string } | null;
};

/** Property ids the MOS owns — shown read-only, since Onshape is not their source. */
const MOS_OWNED = new Set(["MO Number", "MO Status", "MO Remarks"]);

export function SimulatorClient() {
  const [defs, setDefs] = useState<Def[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<any>(null);
  const [panelKey, setPanelKey] = useState(0);

  const load = useCallback(async (keepSelection = true) => {
    try {
      const res = await fetch("/api/simulator/parts");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load simulator data");
      setDefs(data.definitions);
      setParts(data.parts);
      setSelectedId((cur) => (keepSelection && cur ? cur : (data.parts[0]?.id ?? null)));
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const selected = useMemo(() => parts.find((p) => p.id === selectedId) ?? null, [parts, selectedId]);

  // Reset the draft whenever the selected part changes or is refetched.
  useEffect(() => {
    setDraft(selected ? { ...selected.properties } : {});
  }, [selected?.id, selected?.properties]);

  const defsByName = useMemo(() => new Map(defs.map((d) => [d.name, d])), [defs]);
  const nameFor = useCallback((pid: string) => defs.find((d) => d.propertyId === pid)?.name ?? pid, [defs]);

  const dirty = useMemo(() => {
    if (!selected) return false;
    return Object.entries(draft).some(([k, v]) => String(selected.properties[k] ?? "") !== String(v ?? ""));
  }, [draft, selected]);

  async function seed() {
    setSeeding(true); setError(null);
    try {
      const res = await fetch("/api/simulator/seed", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Seed failed");
      await load(false);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setSeeding(false);
    }
  }

  /** The designer's Save — writes properties, then fires the webhook. */
  async function save() {
    if (!selected) return;
    setSaving(true); setError(null); setLastEvent(null);
    try {
      // Only send what the designer may edit.
      const editable: Record<string, string> = {};
      for (const [pid, val] of Object.entries(draft)) {
        if (!MOS_OWNED.has(nameFor(pid))) editable[pid] = val ?? "";
      }

      const res = await fetch(`/api/simulator/parts/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: editable, fireWebhook: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");

      setLastEvent(data);
      await load(true);
      setPanelKey((k) => k + 1); // force the embedded panel to re-read
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div style={{ padding: 44, textAlign: "center", color: "var(--text-muted)" }}><Spinner size={18} /></div>;
  }

  const panelUrl = selected
    ? `/panel?documentId=${selected.documentId}&workspaceOrVersion=w&workspaceOrVersionId=${selected.workspaceId}` +
      `&elementId=${selected.elementId}&partId=${selected.partId}&configuration=${selected.configuration}`
    : null;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ fontSize: 20, margin: "0 0 3px", letterSpacing: "-.02em" }}>Onshape Simulator</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.5 }}>
            Stands in for a real Onshape tenant. Editing a property and saving fires a genuine{" "}
            <code className="mono">onshape.model.lifecycle.metadata</code> webhook at the MOS.
          </p>
        </div>
        <button className="btn" onClick={seed} disabled={seeding}>
          {seeding && <Spinner />} Seed sample data
        </button>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {parts.length === 0 ? (
        <div className="card" style={{ padding: 44, textAlign: "center" }}>
          <p style={{ fontSize: 14, margin: "0 0 6px" }}>No mock parts yet.</p>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 16px" }}>
            Seed the sample enterprise to get five parts across two documents.
          </p>
          <button className="btn btn-primary" onClick={seed} disabled={seeding}>
            {seeding && <Spinner />} Seed sample data
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "215px minmax(0,1fr) 300px", gap: 14, alignItems: "start" }}>
          {/* ------------------------- part tree ------------------------- */}
          <div className="card" style={{ overflow: "hidden" }}>
            <div
              style={{
                padding: "9px 12px", borderBottom: "1px solid var(--border)",
                fontSize: 11, fontWeight: 600, textTransform: "uppercase",
                letterSpacing: ".05em", color: "var(--text-faint)", background: "var(--surface-2)",
              }}
            >
              Parts
            </div>
            {groupByDoc(parts).map(([docName, group]) => (
              <div key={docName}>
                <div
                  style={{
                    padding: "7px 12px", fontSize: 11.5, fontWeight: 600,
                    color: "var(--text-muted)", background: "var(--surface-2)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  {docName}
                </div>
                {group.map((p) => {
                  const active = p.id === selectedId;
                  const label = p.properties[defsByName.get("Name")?.propertyId ?? ""] || p.partId;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedId(p.id)}
                      style={{
                        display: "block", width: "100%", textAlign: "left",
                        padding: "8px 12px", border: "none", cursor: "pointer",
                        borderBottom: "1px solid var(--border)", fontSize: 12.5,
                        background: active ? "var(--accent-soft)" : "transparent",
                        color: active ? "var(--accent)" : "var(--text)",
                        fontWeight: active ? 600 : 450,
                      }}
                    >
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 1 }}>
                        {p.mos?.moNumber ?? "not in MOS"}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* ------------------------ property editor ------------------------ */}
          <div className="card" style={{ padding: 18 }}>
            {!selected ? (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>Select a part.</p>
            ) : (
              <>
                <div style={{ marginBottom: 14 }}>
                  <h2 style={{ fontSize: 14, margin: "0 0 3px", fontWeight: 650 }}>Part properties</h2>
                  <p className="mono" style={{ fontSize: 11, color: "var(--text-faint)", margin: 0 }}>
                    {selected.documentName} › {selected.elementName} › {selected.partId}
                  </p>
                </div>

                <div style={{ display: "grid", gap: 11 }}>
                  {defs.map((d) => {
                    const owned = MOS_OWNED.has(d.name);
                    const value = draft[d.propertyId] ?? "";
                    return (
                      <div key={d.propertyId} style={{ display: "grid", gridTemplateColumns: "128px 1fr", gap: 11, alignItems: "center" }}>
                        <label
                          style={{ fontSize: 12, color: owned ? "var(--accent)" : "var(--text-muted)", fontWeight: owned ? 600 : 450 }}
                          title={owned ? "Owned by the MOS — written back by the sync" : undefined}
                        >
                          {d.name}
                          {owned && <span style={{ fontSize: 9.5, marginLeft: 4 }}>MOS</span>}
                        </label>
                        {d.valueType === "ENUM" ? (
                          <select className="select" value={value} disabled={owned}
                            onChange={(e) => setDraft({ ...draft, [d.propertyId]: e.target.value })}>
                            <option value="">—</option>
                            {d.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : (
                          <input
                            className="input" value={value} disabled={owned}
                            style={owned ? { color: "var(--text-faint)", background: "var(--surface-2)" } : undefined}
                            onChange={(e) => setDraft({ ...draft, [d.propertyId]: e.target.value })}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: "flex", gap: 9, alignItems: "center", marginTop: 16 }}>
                  <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
                    {saving && <Spinner />} Save (fires webhook)
                  </button>
                  {dirty && <span style={{ fontSize: 12, color: "var(--warn)" }}>Unsaved changes</span>}
                  {!dirty && selected.mos && (
                    <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
                      Synced as {selected.mos.moNumber}
                    </span>
                  )}
                </div>

                {lastEvent && (
                  <div style={{ marginTop: 16 }}>
                    <div className="label">Webhook delivered</div>
                    <pre
                      className="mono"
                      style={{
                        background: "var(--surface-2)", border: "1px solid var(--border)",
                        borderRadius: 7, padding: 11, fontSize: 10.5, overflowX: "auto",
                        margin: 0, maxHeight: 210, lineHeight: 1.55,
                      }}
                    >
{JSON.stringify({ payload: lastEvent.payload, response: lastEvent.webhook }, null, 2)}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>

          {/* --------------------- embedded right panel --------------------- */}
          <div className="card" style={{ overflow: "hidden", position: "sticky", top: 70 }}>
            <div
              style={{
                padding: "9px 12px", borderBottom: "1px solid var(--border)",
                fontSize: 11, fontWeight: 600, textTransform: "uppercase",
                letterSpacing: ".05em", color: "var(--text-faint)", background: "var(--surface-2)",
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
              }}
            >
              <span>Right panel extension</span>
              <button className="btn btn-sm" onClick={() => setPanelKey((k) => k + 1)}>Reload</button>
            </div>
            {panelUrl ? (
              <iframe
                key={panelKey}
                src={panelUrl}
                title="MOS app extension"
                style={{ width: "100%", height: 560, border: "none", display: "block" }}
              />
            ) : (
              <div style={{ padding: 22, fontSize: 12.5, color: "var(--text-muted)" }}>Select a part.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function groupByDoc(parts: Part[]): [string, Part[]][] {
  const m = new Map<string, Part[]>();
  for (const p of parts) {
    const list = m.get(p.documentName) ?? [];
    list.push(p);
    m.set(p.documentName, list);
  }
  return [...m.entries()];
}
