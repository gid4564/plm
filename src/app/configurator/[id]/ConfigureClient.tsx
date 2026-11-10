"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Spinner, relTime } from "@/components/ui";
import { resolve, summarize, validate, type ConfigInput, type Values } from "@/lib/configurator-rules";

type Model = {
  id: string; name: string; enabled: boolean; documentName: string; elementName: string;
  versionName: string; onVersion: boolean; inputs: ConfigInput[];
};

type BomRow = {
  level: number; quantity: number; partNumber: string; name: string; description: string;
  kind: "part" | "assembly" | "other"; configuration: string | null;
};

type Item = {
  id: string; number: string | null; summary: string; values: Values;
  state: "queued" | "generating" | "ready" | "failed"; step: string; error: string | null;
  hasPicture: boolean; bom: BomRow[] | null; bomError: string | null; requestCount: number; generatedAt: string | null; elapsedMs: number | null;
  lastRequestedAt: string;
};

const POLL_MS = 2000;
/** Outline numbers for an indented BOM: 1, 2, 2.1, 2.2, 3 — as Onshape's Item column. */
function outline(rows: BomRow[]): string[] {
  const counters: number[] = [];
  return rows.map((r) => {
    counters.length = r.level + 1;
    counters[r.level] = (counters[r.level] ?? 0) + 1;
    for (let i = 0; i < r.level; i++) counters[i] ??= 1;
    return counters.join(".");
  });
}

function downloadCsv(item: Item) {
  const rows = item.bom ?? [];
  const nums = outline(rows);
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [["Item", "Quantity", "Part number", "Name", "Description", "Configuration"].map(q).join(",")]
    .concat(rows.map((r, i) => [nums[i], r.quantity, r.partNumber, r.name, r.description, r.configuration ?? ""].map(q).join(",")))
    .join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `${item.number ?? "configuration"}-bom.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const unitLabel = (u?: string) => (u === "millimeter" ? "mm" : u === "inch" ? "in" : u === "meter" ? "m" : u ?? "");

/**
 * Configure one model.
 *
 * The form shows exactly the inputs Onshape's own configuration panel would,
 * using the same rules module the server keys with (lib/configurator-rules.ts)
 * — so what is on screen is what gets generated.
 */
export function ConfigureClient({ id }: { id: string; isAdmin: boolean }) {
  const [model, setModel] = useState<Model | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [given, setGiven] = useState<Values>({});
  const [current, setCurrent] = useState<Item | null>(null);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/configurator/models/${id}`);
    const j = await r.json();
    if (!r.ok) { setError(j.error || "Could not load this model"); return; }
    setModel(j.model);
    setItems(j.items);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const inputs = model?.inputs ?? [];
  const { values, visible } = useMemo(() => resolve(inputs, given), [inputs, given]);
  const errors = useMemo(() => validate(inputs, values, visible), [inputs, values, visible]);
  const summary = useMemo(() => summarize(inputs, values, visible), [inputs, values, visible]);

  // Follow a generation until it settles, then refresh the gallery.
  useEffect(() => {
    if (!current || (current.state !== "queued" && current.state !== "generating")) return;
    const t = setInterval(async () => {
      const r = await fetch(`/api/configurator/items/${current.id}`);
      if (!r.ok) return;
      const { item } = await r.json();
      setCurrent(item);
      if (item.state === "ready" || item.state === "failed") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [current, load]);

  async function generate(retry = false) {
    setBusy(true); setError(null); setServerFields({});
    try {
      const r = await fetch(`/api/configurator/models/${id}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, retry }),
      });
      const j = await r.json();
      if (r.status === 422) { setError(j.error); setServerFields(j.fields ?? {}); return; }
      if (!r.ok) throw new Error(j.error || "Could not generate");
      setCurrent(j.item);
      setCached(Boolean(j.cached));
      void load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function show(item: Item) {
    setGiven(item.values ?? {});
    setCurrent(item);
    setCached(true);
  }

  if (!model) {
    return error ? <Alert kind="error">{error}</Alert>
      : <div className="card" style={{ padding: 40, textAlign: "center" }}><Spinner size={20} /></div>;
  }

  const set = (inputId: string, v: string) => setGiven((g) => ({ ...g, ...values, [inputId]: v }));
  const fieldError = (inputId: string) => serverFields[inputId] ?? errors[inputId];
  const showing = current;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <Link href="/configurator" style={{ fontSize: 12.5, color: "var(--accent)" }}>← Configurator</Link>
        <h1 style={{ margin: "4px 0 3px", fontSize: 20 }}>{model.name}</h1>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
          {model.documentName} · {model.elementName} ·{" "}
          {model.onVersion ? `version ${model.versionName}` : "workspace"}
        </p>
      </div>

      {!model.enabled && <Alert kind="warn">This model is switched off for configuring.</Alert>}
      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)" }}>
        {/* ----------------------------- Options ----------------------------- */}
        <div className="card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Options</h2>
          {inputs.filter((i) => visible.has(i.id)).map((i) => (
            <div key={i.id} style={{ display: "grid", gap: 4 }}>
              {i.kind === "boolean" ? (
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
                  <input type="checkbox" checked={values[i.id] === "true"}
                    onChange={(e) => set(i.id, String(e.target.checked))} />
                  {i.name}
                </label>
              ) : (
                <>
                  <label className="label" htmlFor={`in-${i.id}`}>{i.name}</label>
                  {i.kind === "list" ? (
                    <select id={`in-${i.id}`} value={values[i.id]} onChange={(e) => set(i.id, e.target.value)}>
                      {i.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : i.kind === "quantity" ? (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        id={`in-${i.id}`} className="input" type="number" style={{ flex: 1 }}
                        value={values[i.id]} min={i.min} max={i.max} step={i.integer ? 1 : "any"}
                        onChange={(e) => set(i.id, e.target.value)}
                      />
                      <span style={{ fontSize: 12, color: "var(--text-faint)", minWidth: 24 }}>{unitLabel(i.units)}</span>
                    </div>
                  ) : (
                    <input id={`in-${i.id}`} className="input" value={values[i.id]} onChange={(e) => set(i.id, e.target.value)} />
                  )}
                  {i.kind === "quantity" && (
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      {i.min}–{i.max} {unitLabel(i.units)}
                    </span>
                  )}
                </>
              )}
              {fieldError(i.id) && <span style={{ fontSize: 12, color: "var(--danger)" }}>{fieldError(i.id)}</span>}
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, fontSize: 12.5, color: "var(--text-muted)" }}>
            {summary || "Defaults"}
          </div>
          <button
            className="btn btn-primary" onClick={() => generate()}
            disabled={busy || !model.enabled || Object.keys(errors).length > 0}
          >
            {busy ? <Spinner /> : "Generate"}
          </button>
        </div>

        {/* ------------------------------ Result ----------------------------- */}
        <div className="card" style={{ display: "grid", gap: 10, alignContent: "start", minHeight: 360 }}>
          {!showing ? (
            <div style={{ color: "var(--text-faint)", fontSize: 13, padding: 20 }}>
              Choose options and press Generate. A configuration seen before appears straight away; a new
              one is generated in Onshape, usually in seconds — the first of the day can take a minute.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <span className="mono" style={{ fontWeight: 700, fontSize: 16 }}>{showing.number ?? "—"}</span>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{showing.summary}</span>
              </div>
              {showing.hasPicture && showing.state !== "failed" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/configurator/items/${showing.id}/picture`} alt={showing.summary}
                  style={{ width: "100%", maxWidth: 800, aspectRatio: "4 / 3", objectFit: "contain", background: "#fff", borderRadius: 8, border: "1px solid var(--border)" }}
                />
              ) : showing.state === "failed" ? (
                <Alert kind="error">
                  <strong>Onshape could not generate this configuration.</strong> {showing.error}
                  <div style={{ marginTop: 6 }}>
                    <button className="btn btn-sm" onClick={() => generate(true)} disabled={busy}>Try again</button>
                  </div>
                </Alert>
              ) : (
                <div style={{ display: "grid", placeItems: "center", aspectRatio: "4 / 3", maxWidth: 800, border: "1px dashed var(--border)", borderRadius: 8, color: "var(--text-muted)", fontSize: 13, gap: 8 }}>
                  <div style={{ display: "grid", gap: 8, justifyItems: "center" }}>
                    <Spinner size={20} />
                    {showing.state === "queued" ? "Waiting for a free slot…" : showing.step || "Generating in Onshape…"}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                {showing.state === "ready" && showing.hasPicture && (cached
                  ? `From PLM — generated ${relTime(showing.generatedAt)}, asked for ${showing.requestCount} time${showing.requestCount === 1 ? "" : "s"}.`
                  : `Generated in ${((showing.elapsedMs ?? 0) / 1000).toFixed(1)} s.`)}
              </div>
              {showing.state !== "failed" && (showing.hasPicture || showing.bom) && (
                <BomPanel item={showing} busy={busy} onRetry={() => generate(true)} onRead={() => generate()} />
              )}
            </>
          )}
        </div>
      </div>

      {/* --------------------------- Configurations -------------------------- */}
      {items.length > 0 && (
        <div className="card" style={{ display: "grid", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Configurations generated</h2>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" }}>
            {items.map((it) => (
              <button
                key={it.id} onClick={() => show(it)}
                style={{
                  display: "grid", gap: 4, textAlign: "left", padding: 8, cursor: "pointer",
                  background: current?.id === it.id ? "var(--accent-soft)" : "var(--surface)",
                  border: `1px solid ${current?.id === it.id ? "var(--accent)" : "var(--border)"}`, borderRadius: 8,
                  color: "inherit", font: "inherit",
                }}
              >
                {it.hasPicture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/configurator/items/${it.id}/picture`} alt="" loading="lazy"
                    style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "contain", background: "#fff", borderRadius: 6 }} />
                ) : (
                  <div style={{ aspectRatio: "4 / 3", display: "grid", placeItems: "center", background: "var(--surface-2)", borderRadius: 6, fontSize: 12, color: "var(--text-faint)" }}>
                    {it.state === "failed" ? "failed" : <Spinner />}
                  </div>
                )}
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 650 }}>{it.number ?? "—"}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.35 }}>{it.summary}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The configuration's bill of materials, as Onshape reported it for exactly these choices. */
function BomPanel({ item, busy, onRetry, onRead }: { item: Item; busy: boolean; onRetry: () => void; onRead: () => void }) {
  const reading = item.state === "queued" || item.state === "generating";
  const rows = item.bom ?? [];
  const nums = outline(rows);
  const parts = rows.filter((r) => r.kind === "part").length;
  const unnumbered = rows.filter((r) => r.kind !== "other" && !r.partNumber).length;
  return (
    <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>Bill of materials</h3>
        {item.bom && (
          <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
            {rows.length} lines · {parts} parts{unnumbered ? ` · ${unnumbered} without a number in Onshape` : ""}
          </span>
        )}
        {item.bom && (
          <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => downloadCsv(item)}>Download CSV</button>
        )}
      </div>
      {item.bom ? (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ width: "100%", fontSize: 12.5 }}>
            <thead>
              <tr><th style={{ width: 50 }}>Item</th><th style={{ width: 50, textAlign: "right" }}>Qty</th><th>Part number</th><th>Name</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} title={r.configuration && r.configuration !== "default" ? r.configuration : undefined}
                  style={{ color: r.kind === "other" ? "var(--text-faint)" : undefined }}>
                  <td className="mono">{nums[i]}</td>
                  <td style={{ textAlign: "right" }}>{r.quantity}</td>
                  <td className="mono">{r.partNumber || <span style={{ color: "var(--text-faint)" }}>—</span>}</td>
                  <td style={{ paddingLeft: 8 + r.level * 18, fontWeight: r.kind === "assembly" ? 650 : undefined,
                    fontStyle: r.kind === "other" ? "italic" : undefined }}>
                    {r.name || "(unnamed)"}
                    {r.kind === "other" && " · not a part"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : reading ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, color: "var(--text-muted)" }}>
          <Spinner /> {item.step || "Reading the BOM…"}
        </div>
      ) : item.bomError ? (
        <Alert kind="warn">
          Onshape did not return this configuration's BOM: {item.bomError}
          <div style={{ marginTop: 6 }}>
            <button className="btn btn-sm" onClick={onRetry} disabled={busy}>Try again</button>
          </div>
        </Alert>
      ) : (
        <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Generated before BOMs were kept.{" "}
          <button className="btn btn-sm" onClick={onRead} disabled={busy}>Read the BOM</button>
        </div>
      )}
    </div>
  );
}
