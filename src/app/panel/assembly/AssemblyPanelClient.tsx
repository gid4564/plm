"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Spinner } from "@/components/ui";
import { ProductPicker } from "@/components/ProductPicker";
import { PanelHeader, SignedOut, panelWrap } from "../shared";

type Ctx = { documentId: string; elementId: string; workspaceId: string; versionId: string };

type Tracked = { itemId: string; moNumber: string | null; quantity: number; status: string };

type Line = {
  key: string; quantity: number; partNumber: string; name: string;
  material: string; revision: string;
  importable: boolean; unresolvable: string | null; tracked: Tracked | null;
};

type Bom = {
  assembly: { documentName: string; elementName: string };
  maxImport: number;
  shape: string;
  partNumberColumnMissing: boolean;
  lines: Line[];
};

type ImportLine = {
  key: string; name: string; partNumber: string;
  outcome: "created" | "existing" | "failed" | "skipped";
  moNumber: string | null; message: string; warning: string | null;
};

type ImportResult = {
  created: number; existing: number; failed: number; warned: number; skipped: number;
  lines: ImportLine[];
};

export function AssemblyPanelClient({
  ctx, signedIn, search,
}: {
  ctx: Ctx; signedIn: boolean; search: string;
}) {
  const [alreadyHere, setAlreadyHere] = useState<number | null>(null);
  const [bom, setBom] = useState<Bom | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [multiLevel, setMultiLevel] = useState(true);
  const [product, setProduct] = useState("");
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const params = useCallback(() => {
    const p = new URLSearchParams({ documentId: ctx.documentId, elementId: ctx.elementId });
    if (ctx.workspaceId) p.set("workspaceId", ctx.workspaceId);
    if (ctx.versionId) p.set("versionId", ctx.versionId);
    return p;
  }, [ctx]);

  /**
   * How much of this assembly the MOS already holds.
   *
   * A local query, so opening the panel is instant and costs Onshape nothing.
   * Reading the BOM itself is a real API call against a shared rate limit and
   * stays behind a button — clicking through assembly tabs should not spend
   * anyone's quota.
   */
  const loadTracked = useCallback(async () => {
    if (!signedIn || !ctx.elementId) return;
    try {
      const res = await fetch(`/api/items?assembly=${encodeURIComponent(ctx.elementId)}`);
      const data = await res.json();
      if (res.ok) setAlreadyHere((data.items ?? []).length);
    } catch {
      // Cosmetic; the panel works without it.
    }
  }, [ctx.elementId, signedIn]);

  useEffect(() => { loadTracked(); }, [loadTracked]);

  const readBom = useCallback(async () => {
    setReading(true); setError(null);
    try {
      const p = params();
      p.set("multiLevel", multiLevel ? "1" : "0");
      const res = await fetch(`/api/bom?${p}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not read the BOM");

      setBom(data);
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
      setReading(false);
    }
  }, [params, multiLevel]);

  async function runImport() {
    if (!bom || selected.size === 0) return;
    setImporting(true); setError(null); setResult(null);

    try {
      const res = await fetch("/api/bom/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: ctx.documentId,
          elementId: ctx.elementId,
          workspaceId: ctx.workspaceId || null,
          versionId: ctx.versionId || null,
          multiLevel,
          keys: [...selected],
          product: product || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");

      setResult(data);
      await Promise.all([readBom(), loadTracked()]);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setImporting(false);
    }
  }

  const importable = useMemo(() => (bom?.lines ?? []).filter((l) => l.importable), [bom]);
  const untracked = useMemo(() => importable.filter((l) => !l.tracked), [importable]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  /* ------------------------------- gate states ------------------------------ */

  if (!signedIn) {
    return <SignedOut title="Bill of Materials" />;
  }

  if (!ctx.elementId) {
    return (
      <div style={panelWrap}>
        <PanelHeader title="Bill of Materials" />
        <p style={{ color: "var(--text-muted)", margin: 0, lineHeight: 1.55 }}>
          Open an assembly to read its bill of materials.
        </p>
      </div>
    );
  }

  const fullPageHref = `/bom?${params()}`;

  return (
    <div style={panelWrap}>
      <PanelHeader title="Bill of Materials" />

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {result && (
        <Alert kind={result.failed > 0 ? "warn" : "ok"} onDismiss={() => setResult(null)}>
          <strong>
            {result.created} created
            {result.existing > 0 && `, ${result.existing} already tracked`}
          </strong>
          {result.warned > 0 && <div>{result.warned} without a write-back to Onshape.</div>}
          {result.skipped > 0 && <div>{result.skipped} skipped as duplicates.</div>}
          {result.failed > 0 && (
            <div style={{ marginTop: 4 }}>
              {result.lines
                .filter((l) => l.outcome === "failed")
                .map((f) => (
                  <div key={f.key} style={{ fontSize: 11, lineHeight: 1.45, marginTop: 3 }}>
                    <strong>{f.name || f.partNumber}</strong> — {f.message}
                  </div>
                ))}
            </div>
          )}
        </Alert>
      )}

      {!bom ? (
        <>
          <div
            style={{
              background: "var(--surface)", border: "1px dashed var(--border-strong)",
              borderRadius: 8, padding: 13, textAlign: "center",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>
              {alreadyHere ? `${alreadyHere} part${alreadyHere === 1 ? "" : "s"} in the MOS` : "Not imported yet"}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Reading the bill of materials lists every part in this assembly so you can raise a
              manufacturing order for each, with quantities from the model.
            </div>
          </div>

          <label style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 11.5, cursor: "pointer" }}>
            <input
              type="checkbox" checked={multiLevel}
              onChange={(e) => setMultiLevel(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ color: "var(--text-muted)", lineHeight: 1.45 }}>
              Include subassemblies, with quantities added up
            </span>
          </label>

          <button className="btn btn-primary" onClick={readBom} disabled={reading}>
            {reading && <Spinner />} Read bill of materials
          </button>

          <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0, lineHeight: 1.5 }}>
            Reading is a call to Onshape, so it happens when you ask rather than on every tab you open.
          </p>
        </>
      ) : (
        <>
          <div
            style={{
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 8, padding: 11,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 650, letterSpacing: "-.01em" }}>
              {bom.assembly.elementName || "Assembly"}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginTop: 2, lineHeight: 1.45 }}>
              {bom.lines.length} row{bom.lines.length === 1 ? "" : "s"} ·{" "}
              {untracked.length} not yet in the MOS · {multiLevel ? "all levels" : "top level"}
            </div>
          </div>

          {bom.partNumberColumnMissing && bom.lines.length > 0 && (
            <Alert kind="warn">
              No row here has a part number — most likely the column was not recognised. Parts are
              checked against Onshape as they import instead.
            </Alert>
          )}

          {bom.lines.length === 0 && (
            <Alert kind="warn">
              {bom.shape === "unrecognised"
                ? "Onshape answered in a shape the MOS does not recognise. The server log records what it sent."
                : "Onshape returned no BOM rows for this assembly."}
            </Alert>
          )}

          {bom.lines.length > 0 && (
            <>
              <div style={{ display: "flex", gap: 5 }}>
                <button
                  className="btn btn-sm" type="button"
                  onClick={() => setSelected(new Set(untracked.slice(0, bom.maxImport).map((l) => l.key)))}
                >
                  New
                </button>
                <button
                  className="btn btn-sm" type="button"
                  onClick={() => setSelected(new Set(importable.slice(0, bom.maxImport).map((l) => l.key)))}
                >
                  All
                </button>
                <button className="btn btn-sm" type="button" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
                <button className="btn btn-sm" type="button" onClick={readBom} disabled={reading} style={{ marginLeft: "auto" }}>
                  {reading && <Spinner />} Refresh
                </button>
              </div>

              <div
                style={{
                  border: "1px solid var(--border)", borderRadius: 8,
                  background: "var(--surface)", maxHeight: "46vh", overflowY: "auto",
                }}
              >
                {bom.lines.map((l, i) => {
                  const checked = selected.has(l.key);
                  const blocked = !l.importable;
                  return (
                    <label
                      key={`${l.key}-${i}`}
                      style={{
                        display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px",
                        borderBottom: i === bom.lines.length - 1 ? "none" : "1px solid var(--border)",
                        opacity: blocked ? 0.55 : 1,
                        cursor: blocked ? "default" : "pointer",
                      }}
                    >
                      <input
                        type="checkbox" checked={checked} disabled={blocked}
                        onChange={() => toggle(l.key)}
                        style={{ marginTop: 2 }}
                      />
                      <span className="mono" style={{ fontSize: 11.5, fontWeight: 700, minWidth: 20 }}>
                        {l.quantity}×
                      </span>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: "block", fontSize: 12, lineHeight: 1.35 }}>
                          {l.name || l.partNumber || "Unnamed"}
                        </span>
                        <span style={{ display: "block", fontSize: 10.5, color: "var(--text-faint)", lineHeight: 1.4 }}>
                          {l.partNumber && <span className="mono">{l.partNumber}</span>}
                          {l.partNumber && l.material && " · "}
                          {l.material}
                          {blocked && l.unresolvable && <span> — {l.unresolvable}</span>}
                        </span>
                      </span>
                      {l.tracked && (
                        <span
                          className="badge mono"
                          style={{
                            background: "var(--surface-2)", color: "var(--text-muted)",
                            borderColor: "var(--border)", fontSize: 10, flexShrink: 0,
                          }}
                          title={`Already tracked · ${l.tracked.status}`}
                        >
                          {l.tracked.moNumber ?? "tracked"}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>

              <div>
                <label className="label" style={{ fontSize: 11 }}>Product</label>
                <ProductPicker value={product} onChange={setProduct} useProjectOption />
              </div>

              <button
                className="btn btn-primary"
                onClick={runImport}
                disabled={importing || selected.size === 0}
              >
                {importing && <Spinner />}
                {importing ? `Importing ${selected.size}…` : `Create ${selected.size} order${selected.size === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </>
      )}

      <a className="btn btn-sm" href={fullPageHref} target="_blank" rel="noopener noreferrer">
        Open in the MOS ↗
      </a>
    </div>
  );
}
