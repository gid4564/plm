"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, KV, Spinner, StatusBadge, relTime } from "@/components/ui";

type Def = {
  propertyId: string;
  name: string;
  valueType: string;
  /** Options whose stored value is the label itself. */
  enumValues: string[];
  /** Options with a separate code, as Onshape reports State. */
  enumOptions?: { value: unknown; label: string }[];
  builtIn: boolean;
};
type Plm = { id: string; number: string; revision: string; iteration?: number; lifecycleState: string } | null;
type Part = {
  id: string; documentId: string; documentName: string; workspaceId: string;
  elementId: string; elementName: string; partId: string; configuration: string;
  properties: Record<string, unknown>;
  revisions: { revision: string; versionId: string }[];
  plm: Plm;
};
type Drawing = {
  id: string; documentId: string; documentName: string; elementId: string; elementName: string;
  partIds: string[]; revisions: { revision: string; versionId: string }[]; plm: Plm;
};
type Pkg = {
  rpid: string; state: string; changeOrderId: string; itemCount: number;
  items: { elementType: string; name: string; revision: string }[]; createdAt: string;
};

/**
 * The simulated Onshape tenant.
 *
 * This stands in for a real enterprise so the whole integration — including the
 * release takeover and the two-pass drawing capture — can be demonstrated with
 * no Onshape account at all. Everything here talks to PLM the way Onshape
 * would: a property save fires a real metadata webhook over HTTP, and raising a
 * release candidate fires a real workflow-transition webhook at the registered
 * callback URL. Calling PLM's own functions directly would prove much less.
 */
export function SimulatorClient() {
  const [defs, setDefs] = useState<Def[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/simulator/parts");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not read the mock tenant");
      setDefs(j.definitions);
      setParts(j.parts);
      setDrawings(j.drawings);
      setPackages(j.releasePackages);
      setSelectedId((prev) => prev ?? j.parts[0]?.id ?? null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selected = parts.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    // Reset the edit form whenever the selection moves, so a half-typed value
    // cannot be saved onto a different part.
    setDraft({});
  }, [selectedId]);

  async function seed() {
    setBusy("seed");
    try {
      const res = await fetch("/api/simulator/seed", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Seeding failed");
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!selected) return;
    setBusy("save");
    setError(null);
    try {
      const res = await fetch(`/api/simulator/parts/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: draft, fireWebhook: true }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Save failed");
      setLastEvent({ kind: "metadata", ...j });
      setDraft({});
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function raiseRelease() {
    setBusy("release");
    setError(null);
    try {
      const res = await fetch("/api/simulator/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partIds: [...chosen], fireWebhook: true }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not raise a release candidate");
      setLastEvent({ kind: "release", ...j });
      setChosen(new Set());
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const dirty = Object.keys(draft).length > 0;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 3px", letterSpacing: "-.02em" }}>Onshape Simulator</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", maxWidth: 800, lineHeight: 1.55 }}>
          A stand-in Onshape tenant. Saving a property here fires a real metadata webhook at PLM,
          and raising a release candidate fires a real workflow-transition webhook — so the whole
          takeover runs exactly as it would against a live enterprise.
        </p>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {parts.length === 0 && !loading && (
        <div className="card" style={{ padding: 30, textAlign: "center" }}>
          <p style={{ margin: "0 0 12px", color: "var(--text-muted)" }}>
            The mock tenant is empty.
          </p>
          <button className="btn btn-primary" onClick={seed} disabled={busy != null}>
            {busy === "seed" ? <Spinner /> : "Seed it with parts and drawings"}
          </button>
        </div>
      )}

      {lastEvent && (
        <Alert kind="ok" onDismiss={() => setLastEvent(null)}>
          <div style={{ display: "grid", gap: 4 }}>
            <strong>
              {lastEvent.kind === "release"
                ? `Release package ${lastEvent.package?.rpid} raised in state ${lastEvent.package?.state} ` +
                  `with ${lastEvent.package?.items} item(s), including ${lastEvent.package?.drawings} drawing(s) ` +
                  `Onshape added itself.`
                : "Property saved and a metadata webhook delivered."}
            </strong>
            <div style={{ fontSize: 11.5 }}>
              PLM answered {lastEvent.webhook?.status ?? "—"}
              {lastEvent.webhook?.body?.reason ? ` (${lastEvent.webhook.body.reason})` : ""}
              {lastEvent.webhook?.body?.number ? ` · release ${lastEvent.webhook.body.number}` : ""}
              {lastEvent.webhook?.body?.releaseId ? (
                <>
                  {" "}·{" "}
                  <a href={`/releases/${lastEvent.webhook.body.releaseId}`} style={{ color: "inherit", fontWeight: 600 }}>
                    open the release
                  </a>
                </>
              ) : null}
            </div>
            {lastEvent.webhook?.body?.message && (
              <div style={{ fontSize: 11.5 }}>{lastEvent.webhook.body.message}</div>
            )}
          </div>
        </Alert>
      )}

      {parts.length > 0 && (
        <>
          {/* --------------------------- Release candidate ------------------- */}
          <section className="card" style={{ display: "grid", gap: 10 }}>
            <div>
              <h2 style={{ fontSize: 14, margin: "0 0 3px", fontWeight: 650 }}>
                Raise a release candidate
              </h2>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                What a designer does in Onshape. The package is created, the active drawings are
                added to it automatically, and PLM is notified — from there PLM owns the approval.
              </p>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {parts.map((p) => (
                <label
                  key={p.id}
                  style={{
                    display: "flex", gap: 6, alignItems: "center", fontSize: 12.5,
                    border: `1px solid ${chosen.has(p.id) ? "var(--accent)" : "var(--border)"}`,
                    background: chosen.has(p.id) ? "var(--accent-soft)" : "var(--surface-2)",
                    borderRadius: 7, padding: "5px 9px", cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(p.id)}
                    onChange={() =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      })
                    }
                  />
                  <span className="mono">{p.partId}</span>
                  <span>{String(p.properties[nameProp(defs)] ?? p.elementName)}</span>
                  {p.revisions.length > 0 && (
                    <span className="badge">{p.revisions[p.revisions.length - 1].revision}</span>
                  )}
                </label>
              ))}
            </div>

            <div>
              <button
                className="btn btn-primary"
                onClick={raiseRelease}
                disabled={busy != null || chosen.size === 0}
              >
                {busy === "release" ? <Spinner /> : `Raise a release candidate (${chosen.size})`}
              </button>
            </div>
          </section>

          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0,1fr) minmax(0,1.2fr)" }}>
            {/* ----------------------------- The tenant ---------------------- */}
            <section className="card" style={{ padding: 0 }}>
              <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650, padding: "13px 14px 8px" }}>
                Parts in the tenant
              </h2>
              <table className="table">
                <thead>
                  <tr><th>Part</th><th style={{ width: 70 }}>Rev</th><th>In PLM</th></tr>
                </thead>
                <tbody>
                  {parts.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => setSelectedId(p.id)}
                      style={{
                        cursor: "pointer",
                        background: p.id === selectedId ? "var(--accent-soft)" : undefined,
                      }}
                    >
                      <td>
                        <div style={{ fontSize: 12.5 }}>
                          {String(p.properties[nameProp(defs)] ?? p.elementName)}
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                          {p.documentName} · {p.partId}
                        </div>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {p.revisions.length ? p.revisions[p.revisions.length - 1].revision : "—"}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {p.plm ? (
                          <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                            <a href={`/parts/${p.plm.id}`} className="mono">{p.plm.number}</a>
                            <StatusBadge status={p.plm.lifecycleState} />
                          </div>
                        ) : (
                          <span style={{ color: "var(--text-faint)" }}>not synced</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {drawings.length > 0 && (
                <>
                  <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650, padding: "13px 14px 8px" }}>
                    Drawings in the tenant
                  </h2>
                  <table className="table">
                    <thead>
                      <tr><th>Drawing</th><th style={{ width: 70 }}>Rev</th><th>In PLM</th></tr>
                    </thead>
                    <tbody>
                      {drawings.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <div style={{ fontSize: 12.5 }}>{d.elementName}</div>
                            <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                              draws {d.partIds.join(", ")}
                            </div>
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {d.revisions.length ? d.revisions[d.revisions.length - 1].revision : "—"}
                          </td>
                          <td style={{ fontSize: 12 }}>
                            {d.plm ? (
                              <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                                <span className="mono">{d.plm.number}</span>
                                <StatusBadge status={d.plm.lifecycleState} />
                              </div>
                            ) : (
                              <span style={{ color: "var(--text-faint)" }}>not in PLM</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </section>

            {/* --------------------------- Edit properties ------------------- */}
            <section style={{ display: "grid", gap: 16, alignContent: "start" }}>
              {selected && (
                <div className="card" style={{ display: "grid", gap: 10 }}>
                  <div>
                    <h2 style={{ fontSize: 14, margin: "0 0 3px", fontWeight: 650 }}>
                      Part properties
                    </h2>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--text-faint)" }}>
                      What a designer edits in Onshape. Saving fires the metadata webhook, so PLM
                      picks the change up the way it would in production.
                    </p>
                  </div>

                  {defs.map((d) => {
                    const current = selected.properties[d.propertyId];
                    const value = d.propertyId in draft ? draft[d.propertyId] : asText(current);
                    return (
                      <div key={d.propertyId}>
                        <label className="label">
                          {d.name}
                          {d.builtIn && <span className="badge" style={{ marginLeft: 6 }}>built-in</span>}
                        </label>
                        {d.valueType === "ENUM" && (d.enumOptions?.length || d.enumValues.length) ? (
                          <select
                            className="select"
                            value={value}
                            onChange={(e) => setDraft((p) => ({ ...p, [d.propertyId]: e.target.value }))}
                          >
                            <option value="">—</option>
                            {/*
                              The option's own code is what gets stored.

                              This used to store the option's *index* — the
                              position in the list — which is the same
                              positional assumption the label resolver refuses
                              to make, and it made the simulator disagree with
                              itself: pick "Released" and the part stored 2 only
                              by coincidence of the list order, so a reordered
                              or extended list silently changed every part's
                              state.
                            */}
                            {d.enumOptions?.length
                              ? d.enumOptions.map((o) => (
                                  <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
                                ))
                              : d.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : (
                          <input
                            className="input"
                            value={value}
                            onChange={(e) => setDraft((p) => ({ ...p, [d.propertyId]: e.target.value }))}
                          />
                        )}
                      </div>
                    );
                  })}

                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-primary" onClick={save} disabled={!dirty || busy != null}>
                      {busy === "save" ? <Spinner /> : "Save in Onshape"}
                    </button>
                    {dirty && <button className="btn" onClick={() => setDraft({})}>Discard</button>}
                  </div>
                </div>
              )}

              {/* --------------------------- Release packages ---------------- */}
              {packages.length > 0 && (
                <div className="card" style={{ padding: 0 }}>
                  <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650, padding: "13px 14px 8px" }}>
                    Release packages in the tenant
                  </h2>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Package</th>
                        <th style={{ width: 90 }}>State</th>
                        <th>Items</th>
                        <th style={{ width: 90 }}>Raised</th>
                      </tr>
                    </thead>
                    <tbody>
                      {packages.map((r) => (
                        <tr key={r.rpid}>
                          <td className="mono" style={{ fontSize: 11 }}>{r.rpid}</td>
                          <td><StatusBadge status={r.state} /></td>
                          <td style={{ fontSize: 11.5 }}>
                            {r.items.map((i, n) => (
                              <div key={n}>
                                {i.elementType === "DRAWING" ? "drawing" : "part"}: {i.name}
                                {i.revision ? ` → ${i.revision}` : ""}
                              </div>
                            ))}
                          </td>
                          <td style={{ fontSize: 11.5, color: "var(--text-faint)" }} title={r.createdAt}>
                            {relTime(r.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {selected && (
                <div className="card">
                  <h2 style={{ fontSize: 14, margin: "0 0 8px", fontWeight: 650 }}>
                    Onshape coordinates
                  </h2>
                  <KV k="Document" v={selected.documentId} mono />
                  <KV k="Workspace" v={selected.workspaceId} mono />
                  <KV k="Element" v={selected.elementId} mono />
                  <KV k="Part" v={selected.partId} mono />
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** The property id that holds a part's name, so the list can label rows. */
function nameProp(defs: Def[]): string {
  return defs.find((d) => d.name.toLowerCase() === "name")?.propertyId ?? "";
}

/**
 * Render a stored property for an input.
 *
 * Onshape returns some values as objects — Material in particular arrives as
 * { id, displayName, … } — so String()-ing one yields "[object Object]".
 */
function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["displayName", "name", "value"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
    return JSON.stringify(v);
  }
  return String(v);
}
