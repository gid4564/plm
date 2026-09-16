"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, RevChip, Spinner, StatusBadge } from "@/components/ui";
import { ProductField } from "@/components/ProductField";
import { PanelHeader, SignedOut, panelWrap } from "../shared";

type Ctx = { documentId: string; elementId: string; workspaceId: string; versionId: string };

type Tracked = { partId: string; number: string | null; revision: string; lifecycleState: string };

type Line = {
  key: string; quantity: number; partNumber: string; name: string;
  material: string; revision: string;
  importable: boolean; unresolvable: string | null; tracked: Tracked | null;
};

type Bom = {
  assembly: { documentName: string; elementName: string };
  maxImport: number;
  shape: string;
  lines: Line[];
};

type ImportLine = {
  key: string; name: string; partNumber: string;
  outcome: "created" | "existing" | "failed" | "skipped";
  moNumber: string | null; message: string; warning: string | null;
};

type ImportResult = {
  created: number; existing: number; failed: number; warned: number; skipped: number;
  removedLinks: number;
  product: { id: string | null; name: string; source: "assembly" | "current" | "unassigned" };
  elsewhere: { partId: string; number: string | null; productName: string }[];
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
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [currentProductId, setCurrentProductId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  /*
   * The assembly ELEMENT itself, as its own PLM object — distinct from the
   * BOM below, which is its children. A BOM legitimately never lists the
   * assembly as one of its own lines, so without this there was no entry for
   * the assembly anywhere in its own panel, and no way back in for someone
   * once it was removed from PLM: the BOM view only ever offers to import
   * children, never to (re)track the assembly they belong to.
   */
  const [assemblyPart, setAssemblyPart] = useState<any>(null);
  const [assemblyLoading, setAssemblyLoading] = useState(signedIn && Boolean(ctx.elementId));
  const [assemblySyncing, setAssemblySyncing] = useState(false);
  const [assemblyNotice, setAssemblyNotice] = useState<string | null>(null);

  const params = useCallback(() => {
    const p = new URLSearchParams({ documentId: ctx.documentId, elementId: ctx.elementId });
    if (ctx.workspaceId) p.set("workspaceId", ctx.workspaceId);
    if (ctx.versionId) p.set("versionId", ctx.versionId);
    return p;
  }, [ctx]);

  /**
   * How much of this assembly PLM already holds.
   *
   * A local query, so opening the panel is instant and costs Onshape nothing.
   * Reading the BOM itself is a real API call against a shared rate limit and
   * stays behind a button — clicking through assembly tabs should not spend
   * anyone's quota.
   */
  const loadTracked = useCallback(async () => {
    if (!signedIn || !ctx.elementId) return;
    try {
      const res = await fetch(`/api/parts?q=${encodeURIComponent(ctx.elementId)}`);
      const data = await res.json();
      // The parts list answers under `parts`; reading `items` here counted
      // nothing and the panel always claimed the assembly was un-imported.
      if (res.ok) setAlreadyHere((data.parts ?? []).length);
    } catch {
      // Cosmetic; the panel works without it.
    }
  }, [ctx.elementId, signedIn]);

  useEffect(() => { loadTracked(); }, [loadTracked]);

  /**
   * Whether the assembly ELEMENT itself — not its children — is in PLM.
   *
   * Read-only: `sync` is only ever set by the button below, the same rule
   * `/api/parts/lookup` applies everywhere else it is used. Opening the panel
   * must never be what brings something into PLM.
   */
  const loadAssembly = useCallback(async () => {
    if (!signedIn || !ctx.elementId) return;
    setAssemblyLoading(true);
    try {
      const res = await fetch(`/api/parts/lookup?${params()}`);
      const data = await res.json();
      if (res.ok) setAssemblyPart(data.part ?? null);
    } catch {
      // Cosmetic; the sync button below still works from a stale read.
    } finally {
      setAssemblyLoading(false);
    }
  }, [ctx.elementId, params, signedIn]);

  useEffect(() => { loadAssembly(); }, [loadAssembly]);

  async function syncAssembly() {
    setAssemblySyncing(true);
    setError(null);
    try {
      const p = params();
      p.set("sync", "1");
      const res = await fetch(`/api/parts/lookup?${p}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");
      setAssemblyPart(data.part ?? null);
      setAssemblyNotice(
        `In PLM as ${data.part?.number}. Its part number has been written to Onshape.`
      );
      // The BOM view's own "already tracked" badges read stale otherwise —
      // this assembly may itself be a line in a BOM read a moment ago.
      await Promise.all([loadTracked(), bom ? readBom() : Promise.resolve()]);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setAssemblySyncing(false);
    }
  }

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

  /*
   * The product this import will be filed into.
   *
   * The picker sets the *current* product rather than moving anything: none of
   * these parts exists in PLM yet, so there is nothing to move — and the
   * import reads the same setting server-side when it creates them.
   */
  /* The remembered product, so the picker opens on the right one. */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch("/api/products");
        const j = await r.json();
        if (alive && r.ok) setCurrentProductId(j.currentProductId ?? null);
      } catch {
        // Falls back to Unassigned, which is where an unchosen part goes anyway.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function selectCurrentProduct(productId: string) {
    const r = await fetch(`/api/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select" }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not select that product");
    setCurrentProductId(productId);
  }

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
                  }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");

      setResult(data);
      // The import itself always syncs the assembly ELEMENT too, whatever
      // was selected below — see importBomLines' parentSync. Without this,
      // the card at the top kept saying "not in PLM" for an assembly the
      // import had just tracked.
      await Promise.all([readBom(), loadTracked(), loadAssembly()]);
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
      {assemblyNotice && (
        <Alert kind="ok" onDismiss={() => setAssemblyNotice(null)}>{assemblyNotice}</Alert>
      )}

      {/*
        * The assembly ELEMENT, as its own PLM record — separate from the BOM
        * below, which is its children. A BOM never lists the assembly as one
        * of its own lines, so without a card of its own here there was no
        * entry for the assembly anywhere in this panel, and once it was
        * removed from PLM nothing in the panel offered a way back in.
        */}
      {assemblyLoading ? (
        <div style={{ padding: 10, textAlign: "center" }}><Spinner size={16} /></div>
      ) : assemblyPart ? (
        <div
          style={{
            display: "flex", gap: 8, alignItems: "center",
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 10,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mono" style={{ fontWeight: 600, fontSize: 13 }}>
              {assemblyPart.number}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", wordBreak: "break-word" }}>
              {assemblyPart.name}
            </div>
            <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap" }}>
              <RevChip revision={assemblyPart.revision} iteration={assemblyPart.iteration} />
              <StatusBadge status={assemblyPart.lifecycleState} />
              <span className="badge">asm</span>
            </div>
          </div>
          <a className="btn btn-sm" href={`/parts/${assemblyPart.id}`} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      ) : (
        <div
          style={{
            display: "grid", gap: 8,
            background: "var(--surface)", border: "1px dashed var(--border-strong)",
            borderRadius: 8, padding: 10,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            This assembly itself is not in PLM.
          </span>
          {/*
            Chosen before syncing, same as the single-part panel: this is the
            only chance to pick a product before the assembly is filed into
            whichever one was last remembered.
            */}
          <ProductField
            label="File into product"
            compact
            value={currentProductId}
            emptyLabel="Unassigned"
            onChange={(pid) => selectCurrentProduct(pid)}
          />
          <button className="btn btn-sm btn-primary" onClick={syncAssembly} disabled={assemblySyncing}>
            {assemblySyncing ? <Spinner /> : "Sync to PLM"}
          </button>
        </div>
      )}

      {result && (
        <Alert kind={result.failed > 0 ? "warn" : "ok"} onDismiss={() => setResult(null)}>
          <strong>
            {result.created} created
            {result.existing > 0 && `, ${result.existing} already tracked`}
          </strong>
          {/*
            The product is stated even in the panel's compact summary: filing
            one assembly's parts across two products is tedious to unpick, and
            the import chooses on the user's behalf.
          */}
          {result.product && (
            <div>
              Filed into <strong>{result.product.name}</strong>
              {result.product.source === "assembly" && " (this assembly's product)"}
            </div>
          )}
          {result.warned > 0 && <div>{result.warned} without a write-back to Onshape.</div>}
          {result.skipped > 0 && <div>{result.skipped} skipped as duplicates.</div>}
          {result.removedLinks > 0 && (
            <div>{result.removedLinks} no longer in the assembly — the parts themselves are kept.</div>
          )}
          {result.elsewhere?.length > 0 && (
            <div>
              {result.elsewhere.length} part(s) here are filed under another product, and were
              left as they are.
            </div>
          )}
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
              {alreadyHere ? `${alreadyHere} part${alreadyHere === 1 ? "" : "s"} in PLM` : "Not imported yet"}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Reading the bill of materials lists every part in this assembly so you can add the
              ones you want to PLM, with the structure and quantities taken from the model.
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
              {untracked.length} not yet in PLM · {multiLevel ? "all levels" : "top level"}
            </div>
          </div>

          {bom.lines.length === 0 && (
            <Alert kind="warn">
              {bom.shape === "unrecognised"
                ? "Onshape answered in a shape PLM does not recognise. The server log records what it sent."
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
                          title={
                            `Already in PLM · ${l.tracked.lifecycleState}` +
                            (l.tracked.revision ? ` · revision ${l.tracked.revision}` : "")
                          }
                        >
                          {l.tracked.number ?? "in PLM"}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>

              {/*
                Chosen before importing: everything in one import is filed
                together, so asking afterwards would mean moving a whole
                assembly by hand.
              */}
              <ProductField
                label="File into product"
                compact
                value={currentProductId}
                emptyLabel="Unassigned"
                onChange={(pid) => selectCurrentProduct(pid)}
              />
              <button
                className="btn btn-primary"
                onClick={runImport}
                disabled={importing || selected.size === 0}
              >
                {importing && <Spinner />}
                {/*
                  "items", not "orders": PLM tracks parts and assemblies, and a
                  BOM import brings in both. "Order" is MOS's word — MOS raises
                  a manufacturing order per part — and it came along with the
                  code this panel was adapted from.
                */}
                {importing
                  ? `Adding ${selected.size}…`
                  : `Add ${selected.size} item${selected.size === 1 ? "" : "s"} to PLM`}
              </button>
            </>
          )}
        </>
      )}

      <a className="btn btn-sm" href={fullPageHref} target="_blank" rel="noopener noreferrer">
        Open in PLM ↗
      </a>
    </div>
  );
}
