"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Spinner, StatusBadge } from "@/components/ui";

type Tracked = { partId: string; number: string | null; revision: string; lifecycleState: string };

type Line = {
  key: string;
  quantity: number;
  partNumber: string;
  name: string;
  description: string;
  material: string;
  revision: string;
  state: string;
  indentLevel: number;
  importable: boolean;
  unresolvable: string | null;
  tracked: Tracked | null;
};

type Bom = {
  assembly: {
    documentId: string; elementId: string; documentName: string; elementName: string;
    elementType: string | null; workspaceId: string | null; versionId: string | null;
  };
  multiLevel: boolean;
  maxImport: number;
  shape: string;
  headers: string[];
  importable: number;
  partNumberColumnMissing: boolean;
  lines: Line[];
};

type ImportLine = {
  key: string; name: string; partNumber: string; quantity: number;
  outcome: "created" | "existing" | "failed" | "skipped";
  number: string | null; partId: string | null; message: string;
  warning: string | null;
};

type ImportResult = {
  created: number; existing: number; failed: number; warned: number; skipped: number;
  lines: ImportLine[];
};

type Initial = { documentId: string; elementId: string; workspaceId: string; versionId: string };

type SimulatorDoc = { documentId: string; documentName: string; elementId: string };

export function BomClient({
  initial, mock = false, simulator = [],
}: {
  initial: Initial;
  /** True when this PLM is running against the built-in simulator. */
  mock?: boolean;
  /** Documents the simulator holds, offered because real links cannot resolve. */
  simulator?: SimulatorDoc[];
}) {
  const [url, setUrl] = useState("");
  const [multiLevel, setMultiLevel] = useState(true);
  const [updateQuantities, setUpdateQuantities] = useState(false);

  const [bom, setBom] = useState<Bom | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const load = useCallback(
    async (params: URLSearchParams) => {
      setLoading(true);
      setError(null);
      try {
        params.set("multiLevel", multiLevel ? "1" : "0");
        const res = await fetch(`/api/bom?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not read the BOM");

        setBom(data);
        // Preselect what there is actually work to do on: everything importable
        // that PLM does not already track.
        setSelected(
          new Set(
            (data.lines as Line[])
              .filter((l) => l.importable && !l.tracked)
              .slice(0, data.maxImport)
              .map((l) => l.key)
          )
        );
      } catch (err: any) {
        setBom(null);
        setError(String(err.message ?? err));
      } finally {
        setLoading(false);
      }
    },
    [multiLevel]
  );

  /* Context handed over by the Onshape panel loads without being asked for. */
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current) return;
    if (!initial.documentId || !initial.elementId) return;
    autoLoaded.current = true;

    const p = new URLSearchParams({ documentId: initial.documentId, elementId: initial.elementId });
    if (initial.workspaceId) p.set("workspaceId", initial.workspaceId);
    if (initial.versionId) p.set("versionId", initial.versionId);
    load(p);
  }, [initial, load]);

  /** Re-read the same assembly — used after an import to refresh tracked state. */
  const reload = useCallback(() => {
    if (!bom) return;
    const p = new URLSearchParams({
      documentId: bom.assembly.documentId,
      elementId: bom.assembly.elementId,
    });
    if (bom.assembly.workspaceId) p.set("workspaceId", bom.assembly.workspaceId);
    if (bom.assembly.versionId) p.set("versionId", bom.assembly.versionId);
    load(p);
  }, [bom, load]);

  function loadSimulator(doc: SimulatorDoc) {
    setResult(null);
    setUrl("");
    load(new URLSearchParams({
      documentId: doc.documentId,
      elementId: doc.elementId,
      workspaceId: "w1",
    }));
  }

  function loadFromUrl(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    // A different assembly means the previous import summary no longer applies.
    setResult(null);
    load(new URLSearchParams({ url: url.trim() }));
  }

  const importable = useMemo(() => (bom?.lines ?? []).filter((l) => l.importable), [bom]);
  const atCap = bom ? selected.size >= bom.maxImport : false;

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll(which: "all" | "none" | "untracked") {
    if (!bom) return;
    if (which === "none") return setSelected(new Set());
    const pool = which === "all" ? importable : importable.filter((l) => !l.tracked);
    setSelected(new Set(pool.slice(0, bom.maxImport).map((l) => l.key)));
  }

  async function runImport() {
    if (!bom || selected.size === 0) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/bom/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: bom.assembly.documentId,
          elementId: bom.assembly.elementId,
          workspaceId: bom.assembly.workspaceId,
          versionId: bom.assembly.versionId,
          multiLevel: bom.multiLevel,
          keys: [...selected],
          updateQuantities,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");

      setResult(data);
      reload();
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 3px", letterSpacing: "-.02em" }}>Import from assembly</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.55 }}>
          Read an assembly&apos;s bill of materials from Onshape and raise a manufacturing order for
          each part, with quantities taken from the model.
        </p>
      </div>

      <form className="card" onSubmit={loadFromUrl} style={{ padding: 14, display: "grid", gap: 11 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <label className="label">Onshape assembly link</label>
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://cad.onshape.com/documents/…/w/…/e/…"
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading || !url.trim()}>
            {loading && <Spinner />} Read BOM
          </button>
        </div>

        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={multiLevel}
            onChange={(e) => setMultiLevel(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>
            Include subassemblies
            <span style={{ color: "var(--text-faint)" }}>
              {" "}— every part in the whole structure, with quantities added up. Turn this off to
              list only what sits directly in this assembly.
            </span>
          </span>
        </label>

        <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: 0, lineHeight: 1.5 }}>
          Open the assembly in Onshape and copy the address from the browser bar.
        </p>
      </form>

      {mock && (
        <Alert kind="warn">
          <strong>This PLM is running against the built-in simulator.</strong> Nothing is
          connected to Onshape, so a link to a real Onshape document cannot be read here —
          it will come back empty. Use one of the simulator documents below, or run PLM
          against a live Onshape enterprise.
          {simulator.length > 0 && (
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 9 }}>
              {simulator.map((d) => (
                <button
                  key={d.documentId}
                  className="btn btn-sm"
                  type="button"
                  onClick={() => loadSimulator(d)}
                  disabled={loading}
                >
                  {d.documentName}
                </button>
              ))}
            </div>
          )}
        </Alert>
      )}

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {result && <ImportSummary result={result} />}

      {loading && !bom && (
        <div className="card" style={{ padding: 44, textAlign: "center", color: "var(--text-muted)" }}>
          <Spinner size={18} />
          <div style={{ fontSize: 13, marginTop: 8 }}>Reading the BOM from Onshape…</div>
        </div>
      )}

      {bom && (
        <>
          <div className="card" style={{ padding: 14, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 15, fontWeight: 650, letterSpacing: "-.01em" }}>
                {bom.assembly.elementName || "Assembly"}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 12.5, marginTop: 2 }}>
                {bom.assembly.documentName} · {bom.lines.length} row{bom.lines.length === 1 ? "" : "s"}
                {importable.length !== bom.lines.length && ` · ${importable.length} can be ordered`}
                {bom.multiLevel ? " · all levels" : " · top level only"}
              </div>
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-sm" onClick={() => selectAll("untracked")} type="button">Select new</button>
              <button className="btn btn-sm" onClick={() => selectAll("all")} type="button">Select all</button>
              <button className="btn btn-sm" onClick={() => selectAll("none")} type="button">Clear</button>
              <button className="btn btn-sm" onClick={reload} type="button" disabled={loading}>
                {loading && <Spinner />} Refresh
              </button>
            </div>
          </div>

          {bom.partNumberColumnMissing && bom.lines.length > 0 && (
            <Alert kind="warn">
              No row in this bill of materials has a part number. That usually means PLM did
              not recognise the part-number column rather than that every part is unnumbered, so
              nothing has been held back here — each part is checked against Onshape as it is
              imported instead, and any without a number are reported then.
            </Alert>
          )}

          {bom.lines.length === 0 && (
            <Alert kind="warn">
              {bom.shape === "unrecognised" ? (
                <>
                  Onshape answered, but not in a shape PLM recognises, so no rows could be
                  read. This is worth reporting — the server log records the field names Onshape
                  actually sent.
                </>
              ) : (
                <>Onshape returned no BOM rows. Check that the assembly contains instances.</>
              )}
            </Alert>
          )}

          {bom.lines.length > 0 && (
            <div
              className="card"
              style={{
                // Stated rather than assumed: the table fills the card and
                // overflow clips its corners to the border radius, so the
                // default card padding would inset it and undo that.
                padding: 0,
                overflow: "hidden",
              }}
            >
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th style={{ width: 60 }}>Qty</th>
                      <th>Part No.</th>
                      <th>Name</th>
                      <th>Material</th>
                      <th style={{ width: 58 }}>Rev</th>
                      <th>In PLM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bom.lines.map((l, i) => {
                      const checked = selected.has(l.key);
                      const blocked = !l.importable;
                      return (
                        <tr key={`${l.key}-${i}`} style={blocked ? { opacity: 0.55 } : undefined}>
                          <td style={{ paddingRight: 0 }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={blocked || (!checked && atCap)}
                              onChange={() => toggle(l.key)}
                              aria-label={`Select ${l.name || l.partNumber}`}
                            />
                          </td>
                          <td className="mono" style={{ fontWeight: 600 }}>{l.quantity}</td>
                          <td className="mono">{l.partNumber || <Dash />}</td>
                          <td>
                            <div style={{ paddingLeft: l.indentLevel * 14 }}>
                              {l.name || <Dash />}
                              {blocked && l.unresolvable && (
                                <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.45, marginTop: 2 }}>
                                  {l.unresolvable}
                                </div>
                              )}
                            </div>
                          </td>
                          <td style={{ color: "var(--text-muted)" }}>{l.material || <Dash />}</td>
                          <td className="mono">{l.revision || <Dash />}</td>
                          <td>
                            {l.tracked ? (
                              <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                                <Link className="link mono" href={`/parts/${l.tracked.partId}`}>
                                  {l.tracked.number ?? "in PLM"}
                                </Link>
                                {l.tracked.revision && (
                                  <span className="badge">{l.tracked.revision}</span>
                                )}
                                <StatusBadge status={l.tracked.lifecycleState} />
                              </div>
                            ) : (
                              <span style={{ color: "var(--text-faint)", fontSize: 12 }}>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {importable.length > 0 && (
            <div className="card" style={{ padding: 14, display: "grid", gap: 11 }}>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
                The assembly itself comes into PLM too, as an assembly object, and each row below
                becomes a component of it with the quantity the model reports. That structure is
                what makes &ldquo;where is this used&rdquo; answerable from the other end.
              </p>

              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={updateQuantities}
                  onChange={(e) => setUpdateQuantities(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <span>
                  Update quantities on parts already tracked
                  <span style={{ color: "var(--text-faint)" }}>
                    {" "}— off by default, because a quantity in PLM may have been set
                    deliberately and would be overwritten.
                  </span>
                </span>
              </label>

              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  className="btn btn-primary"
                  onClick={runImport}
                  disabled={importing || selected.size === 0}
                >
                  {importing && <Spinner />}
                  {importing
                    ? `Importing ${selected.size} part${selected.size === 1 ? "" : "s"}…`
                    : `Create manufacturing orders (${selected.size})`}
                </button>

                <span style={{ fontSize: 12, color: "var(--text-faint)", lineHeight: 1.5 }}>
                  {atCap
                    ? `${bom.maxImport} parts is the most one import will take — run it again for the rest.`
                    : "Each part costs a couple of Onshape calls, so a long list takes a moment."}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Dash() {
  return <span style={{ color: "var(--text-faint)" }}>—</span>;
}

function ImportSummary({ result }: { result: ImportResult }) {
  const failures = result.lines.filter((l) => l.outcome === "failed");
  const warned = result.lines.filter((l) => l.outcome !== "failed" && l.warning);
  const skipped = result.lines.filter((l) => l.outcome === "skipped");

  return (
    <div className="card" style={{ padding: 14, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "baseline" }}>
        <strong style={{ fontSize: 14 }}>Import finished</strong>
        <span style={{ fontSize: 13, color: "var(--ok)" }}>{result.created} created</span>
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{result.existing} already tracked</span>
        {result.warned > 0 && (
          <span style={{ fontSize: 13, color: "var(--warn)" }}>
            {result.warned} without a write-back
          </span>
        )}
        {result.skipped > 0 && (
          <span style={{ fontSize: 13, color: "var(--warn)" }}>{result.skipped} skipped</span>
        )}
        {result.failed > 0 && (
          <span style={{ fontSize: 13, color: "var(--danger)" }}>{result.failed} failed</span>
        )}
        <Link className="link" href="/dashboard" style={{ fontSize: 13, marginLeft: "auto" }}>
          Open the manufacturing list →
        </Link>
      </div>

      {warned.length > 0 && (
        <div style={{ display: "grid", gap: 5, borderTop: "1px solid var(--border)", paddingTop: 9 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
            These parts are tracked and can be worked on as normal — the only thing missing is
            the PLM number on the part in Onshape. That happens when a part comes from a library,
            from standard content, or from another document this account cannot write to. Where
            the part itself could not be read at all, its details were taken from the assembly&apos;s
            bill of materials instead.
          </div>
          {warned.map((w) => (
            <div key={w.key} style={{ fontSize: 12, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600 }}>{w.name || w.partNumber || w.key}</span>
              {w.number && <span className="mono" style={{ color: "var(--text-faint)" }}> {w.number}</span>}
              <span style={{ color: "var(--warn)" }}> — {w.warning}</span>
            </div>
          ))}
        </div>
      )}

      {skipped.length > 0 && (
        <div style={{ display: "grid", gap: 5, borderTop: "1px solid var(--border)", paddingTop: 9 }}>
          {skipped.map((k) => (
            <div key={k.key} style={{ fontSize: 12, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600 }}>{k.name || k.partNumber || k.key}</span>
              <span style={{ color: "var(--warn)" }}> — {k.message}</span>
            </div>
          ))}
        </div>
      )}

      {failures.length > 0 && (
        <div style={{ display: "grid", gap: 5, borderTop: "1px solid var(--border)", paddingTop: 9 }}>
          {failures.map((f) => (
            <div key={f.key} style={{ fontSize: 12, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600 }}>{f.name || f.partNumber || f.key}</span>
              <span style={{ color: "var(--danger)" }}> — {f.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
