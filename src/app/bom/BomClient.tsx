"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, PartThumb, RevChip, Spinner, StatusBadge } from "@/components/ui";
import { TaskCountBadge } from "@/components/PartTasks";
import { AttributeInput, type Definition } from "@/components/AttributeInput";
import { PartPanel } from "./PartPanel";
import { StarReleaseDialog } from "@/components/StarReleaseDialog";

type Node = {
  key: string;
  partId: string;
  number: string | null;
  name: string;
  description: string;
  material: string;
  kind: "part" | "assembly";
  lifecycleState: string;
  revision: string;
  starCount: number;
  plmOnly: boolean;
  iteration: number;
  productName: string;
  findNumber: string;
  quantity: number;
  totalQuantity: number;
  level: number;
  massKg: number | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  linkId: string | null;
  linkEffectiveFrom: string | null;
  linkEffectiveTo: string | null;
  children: Node[];
  missingForRelease: string[];
  alsoUsedElsewhere: boolean;
  cycle: boolean;
  unreachable: boolean;
  openTaskCount: number;
  taskCount: number;
  starReasons: string[];
};

type Row = Omit<Node, "children" | "key" | "quantity"> & { usedIn: number };

type Bom = {
  product: { id: string; name: string } | null;
  asOf: string | null;
  roots: Node[];
  flat: Row[];
  totals: {
    distinctParts: number; totalPieces: number; assemblies: number;
    released: number; inWork: number; underReview: number;
    massKg: number | null; missingMass: number; needingAttributes: number;
    withOpenTasks: number; maxDepth: number;
  };
  excludedByDate: { partId: string; number: string | null; name: string; reason: string }[];
  cycles: { partId: string; number: string | null; path: string[] }[];
  excludedLinks: {
    linkId: string; parentId: string; parentNumber: string | null;
    childId: string; childNumber: string | null; childName: string; reason: string;
  }[];
  unreachable: { partId: string; number: string | null; name: string }[];
};

type Product = { id: string; name: string; total: number };

const today = () => new Date().toISOString().slice(0, 10);

export function BomClient({
  initialProduct, initialView,
}: {
  initialProduct: string | null;
  initialView: string;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [product, setProduct] = useState<string | null>(initialProduct);
  const [view, setView] = useState<"structured" | "flat">(
    initialView === "flat" ? "flat" : "structured"
  );

  /*
   * Effectivity is off by default.
   *
   * A BOM filtered to today looks the same as an unfiltered one until somebody
   * sets an end date, and then silently differs — so the unfiltered view is the
   * honest default, and turning the filter on is a visible act.
   */
  const [dateMode, setDateMode] = useState<"all" | "today" | "on">("all");
  const [onDate, setOnDate] = useState(today());

  const [bom, setBom] = useState<Bom | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openPart, setOpenPart] = useState<string | null>(null);
  const [swapTarget, setSwapTarget] = useState<
    { parentId: string; bomLinkId: string; number: string | null; name: string } | null
  >(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /* Narrow to the parts that are short of something, which is the work. */
  const [needsOnly, setNeedsOnly] = useState(false);
  const [tasksOnly, setTasksOnly] = useState(false);
  const [bulkKey, setBulkKey] = useState("");
  const [bulkValue, setBulkValue] = useState<unknown>("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [defs, setDefs] = useState<Definition[]>([]);

  const asOfParam = dateMode === "all" ? "all" : dateMode === "today" ? "today" : onDate;

  /* Products, and a sensible starting selection. */
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/products");
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Could not load products");
        const list: Product[] = j.products ?? [];
        setProducts(list);
        if (!initialProduct) {
          /*
           * The remembered product, else the largest one with anything in it.
           * Opening on an empty product would make the page look broken on a
           * first visit.
           */
          const remembered = list.find((p) => p.id === j.currentProductId && p.total > 0);
          const biggest = [...list].sort((a, b) => b.total - a.total)[0];
          setProduct(remembered?.id ?? (biggest?.total ? biggest.id : list[0]?.id ?? null));
        }
      } catch (e: any) {
        setError(String(e?.message ?? e));
      }
    })();
  }, [initialProduct]);

  const load = useCallback(async () => {
    if (!product) { setBom(null); return; }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/products/${product}/bom?asOf=${encodeURIComponent(asOfParam)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load the BOM");
      setBom(j);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [product, asOfParam]);

  useEffect(() => { void load(); }, [load]);

  const needle = q.trim().toLowerCase();
  const matches = useCallback(
    (n: {
      number: string | null; name: string; description: string; material: string;
      missingForRelease?: string[]; openTaskCount?: number;
    }) => {
      if (needsOnly && !(n.missingForRelease?.length)) return false;
      if (tasksOnly && !(n.openTaskCount ?? 0)) return false;
      if (!needle) return true;
      return [n.number ?? "", n.name, n.description, n.material]
        .some((v) => v.toLowerCase().includes(needle));
    },
    [needle, needsOnly, tasksOnly]
  );

  /*
   * In the structured view a search keeps a node whose descendant matches —
   * otherwise searching for a screw hides the assembly it is in, and the
   * result is a list of orphans with no context.
   */
  const visibleRoots = useMemo(() => {
    if (!bom) return [];
    /*
     * Short-circuit only when nothing is filtering.
     *
     * This tested the search box alone, so the "needs attributes" toggle did
     * nothing at all in the structured view unless something was also typed —
     * the count said 12 and the tree showed everything.
     */
    if (!needle && !needsOnly && !tasksOnly) return bom.roots;
    const keep = (n: Node): Node | null => {
      const kids = n.children.map(keep).filter(Boolean) as Node[];
      if (matches(n) || kids.length) return { ...n, children: kids };
      return null;
    };
    return bom.roots.map(keep).filter(Boolean) as Node[];
  }, [bom, needle, needsOnly, tasksOnly, matches]);

  const flatRows = useMemo(
    () => (bom ? bom.flat.filter(matches) : []),
    [bom, matches]
  );

  function toggleSelect(partId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(partId)) next.delete(partId); else next.add(partId);
      return next;
    });
  }

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const allKeys = useMemo(() => {
    const out: string[] = [];
    const walk = (ns: Node[]) => ns.forEach((n) => { if (n.children.length) { out.push(n.key); walk(n.children); } });
    walk(bom?.roots ?? []);
    return out;
  }, [bom]);

  /*
   * The parts the panel steps through, in the order they are on screen.
   *
   * Taken from the current view rather than the raw BOM so that ↓ follows what
   * the reader can see — filtered, searched, and in the same order. A step that
   * jumped to a row hidden by the filter would be disorienting.
   */
  const walkOrder = useMemo(() => {
    if (view === "flat") return flatRows.map((r) => r.partId);
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (ns: Node[]) => {
      for (const n of ns) {
        // One entry per part: stepping should visit a shared part once.
        if (!seen.has(n.partId)) { seen.add(n.partId); out.push(n.partId); }
        if (!collapsed.has(n.key)) walk(n.children);
      }
    };
    walk(visibleRoots);
    return out;
  }, [view, flatRows, visibleRoots, collapsed]);

  const stepTo = useCallback((delta: number) => {
    if (!openPart) return;
    const i = walkOrder.indexOf(openPart);
    if (i < 0) return;
    const next = walkOrder[i + delta];
    if (next) setOpenPart(next);
  }, [openPart, walkOrder]);

  /*
   * The metamodel, for the bulk editor's field list.
   *
   * /api/attributes returns both object types and no per-part `editable` flag —
   * it cannot have one, since editability depends on the part's state and this
   * form has no part. Filtered to PART here, and marked editable so the input
   * renders: whether a value may actually be written is decided per part on
   * the server, which is the only place that can answer it.
   */
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/attributes");
        const j = await r.json();
        if (!r.ok) return;
        const parts = (j.definitions ?? [])
          .filter((d: any) => d.objectType === "PART")
          // Onshape owns some fields outright; offering to type over them in
          // bulk would be offering to have the next sync undo the work.
          .filter((d: any) => d.syncDirection !== "from-onshape")
          .map((d: any): Definition => ({
            key: d.key, label: d.label, description: d.description ?? "",
            dataType: d.dataType, enumValues: d.enumValues ?? [], unit: d.unit ?? "",
            group: d.group ?? "", order: d.order ?? 100,
            required: Boolean(d.required),
            requiredForRelease: Boolean(d.requiredForRelease),
            owner: d.owner ?? "plm", syncDirection: d.syncDirection,
            authority: d.authority, onshapePropertyName: d.onshapePropertyName ?? "",
            mapped: Boolean(d.onshapePropertyId),
            editable: true, lockReason: null,
          }));
        setDefs(parts);
      } catch {
        // The bulk editor simply stays unavailable; the BOM is unaffected.
      }
    })();
  }, []);

  const selectedIds = [...selected];
  const bulkDef = defs.find((d) => d.key === bulkKey);

  async function applyBulk() {
    if (!bulkKey || selectedIds.length === 0) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const r = await fetch("/api/parts/bulk-attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partIds: selectedIds, attributes: { [bulkKey]: bulkValue } }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not apply");
      setBulkResult(j.message ?? "Applied.");
      await load();
    } catch (e: any) {
      setBulkResult(String(e?.message ?? e));
    } finally {
      setBulkBusy(false);
    }
  }

  const t = bom?.totals;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 19 }}>Bill of materials</h1>
        {bom?.product && (
          <span style={{ color: "var(--text-muted)", fontSize: 13 }}>{bom.product.name}</span>
        )}
        <div style={{ flex: 1 }} />
        {product && (
          <a
            className="btn btn-sm"
            href={`/api/products/${product}/bom?asOf=${encodeURIComponent(asOfParam)}&format=csv`}
          >
            Export CSV
          </a>
        )}
      </div>

      {/* ------------------------------- Controls ------------------------------ */}
      <div className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ minWidth: 210 }}>
          <label className="label">Product</label>
          <select
            className="select"
            style={{ width: "100%" }}
            value={product ?? ""}
            onChange={(e) => { setProduct(e.target.value || null); setCollapsed(new Set()); }}
          >
            {products.length === 0 && <option value="">No products yet</option>}
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.total ? ` — ${p.total} item${p.total === 1 ? "" : "s"}` : " — empty"}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">View</label>
          <div style={{ display: "flex", gap: 4 }}>
            {(["structured", "flat"] as const).map((v) => (
              <button
                key={v}
                className="btn btn-sm"
                onClick={() => setView(v)}
                style={{
                  borderColor: view === v ? "var(--accent)" : undefined,
                  color: view === v ? "var(--accent)" : undefined,
                  fontWeight: view === v ? 600 : undefined,
                }}
              >
                {v === "structured" ? "Structured" : "Flattened"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">Effective</label>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {([["all", "All dates"], ["today", "Today"], ["on", "On date"]] as const).map(([m, label]) => (
              <button
                key={m}
                className="btn btn-sm"
                onClick={() => setDateMode(m)}
                style={{
                  borderColor: dateMode === m ? "var(--accent)" : undefined,
                  color: dateMode === m ? "var(--accent)" : undefined,
                  fontWeight: dateMode === m ? 600 : undefined,
                }}
              >
                {label}
              </button>
            ))}
            {dateMode === "on" && (
              <input
                className="input"
                type="date"
                value={onDate}
                onChange={(e) => setOnDate(e.target.value)}
                style={{ width: 150 }}
              />
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 170 }}>
          <label className="label">Find</label>
          <input
            className="input"
            style={{ width: "100%" }}
            placeholder="Number, name, material…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {t && t.needingAttributes > 0 && (
          <div>
            <label className="label">Release readiness</label>
            <button
              className="btn btn-sm"
              onClick={() => setNeedsOnly((v) => !v)}
              style={{
                borderColor: needsOnly ? "var(--warn)" : undefined,
                color: needsOnly ? "var(--warn)" : undefined,
                fontWeight: needsOnly ? 600 : undefined,
              }}
              title="Show only parts still missing an attribute they need to be released"
            >
              {needsOnly ? "Showing " : "Needs attributes: "}{t.needingAttributes}
            </button>
          </div>
        )}

        {/*
          * A filter, not just a number: on a product-sized BOM the parts with
          * work outstanding against them are the ones worth reviewing first,
          * and finding them by scanning every row defeats the point.
          */}
        {t && t.withOpenTasks > 0 && (
          <div>
            <label className="label">Onshape tasks</label>
            <button
              className="btn btn-sm"
              onClick={() => setTasksOnly((v) => !v)}
              style={{
                borderColor: tasksOnly ? "var(--warn)" : undefined,
                color: tasksOnly ? "var(--warn)" : undefined,
                fontWeight: tasksOnly ? 600 : undefined,
              }}
              title="Show only parts with an open Onshape task against them"
            >
              {tasksOnly ? "Showing " : "Open tasks: "}{t.withOpenTasks}
            </button>
          </div>
        )}

        {view === "structured" && allKeys.length > 0 && (
          <div style={{ display: "flex", gap: 4 }}>
            <button className="btn btn-sm" onClick={() => setCollapsed(new Set())}>Expand all</button>
            <button className="btn btn-sm" onClick={() => setCollapsed(new Set(allKeys))}>Collapse all</button>
          </div>
        )}
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {/* ------------------------------ Bulk edit ------------------------------ */}
      {selectedIds.length > 0 && (
        <div className="card" style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 13 }}>{selectedIds.length} selected</strong>
            <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
              Set one attribute on all of them. Each part is still checked on its own terms — a
              field locked by a part&rsquo;s state is refused for that part, not for the set.
            </span>
            <div style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={{ minWidth: 200 }}>
              <label className="label">Attribute</label>
              <select
                className="select"
                style={{ width: "100%" }}
                value={bulkKey}
                onChange={(e) => { setBulkKey(e.target.value); setBulkValue(""); }}
              >
                <option value="">Choose one…</option>
                {/*
                  Release-required fields first and marked, since filling those
                  across many parts is what this is for.
                */}
                {[...defs]
                  .sort((a, b) =>
                    Number(b.requiredForRelease) - Number(a.requiredForRelease) ||
                    a.label.localeCompare(b.label))
                  .map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}{d.requiredForRelease ? " — needed to release" : ""}
                    </option>
                  ))}
              </select>
            </div>

            {bulkDef && (
              <div style={{ minWidth: 220, flex: 1 }}>
                <AttributeInput
                  /*
                   * Forced editable for the bulk form: this control is not a
                   * part, so there is no state to judge it against. Whether the
                   * value may be written is decided per part on the server,
                   * which is the only place that can answer it.
                   */
                  def={{ ...bulkDef, editable: true, lockReason: null }}
                  value={bulkValue}
                  onChange={setBulkValue}
                />
              </div>
            )}

            <button
              className="btn btn-primary btn-sm"
              onClick={applyBulk}
              disabled={!bulkKey || bulkBusy}
            >
              {bulkBusy ? <Spinner size={12} /> : `Apply to ${selectedIds.length}`}
            </button>
          </div>

          {bulkResult && <Alert kind="info" onDismiss={() => setBulkResult(null)}>{bulkResult}</Alert>}
        </div>
      )}

      {/* -------------------------------- Totals ------------------------------- */}
      {t && (
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5 }}>
          <Stat label="Distinct parts" value={t.distinctParts} />
          <Stat label="Total pieces" value={t.totalPieces} />
          <Stat label="Assemblies" value={t.assemblies} />
          <Stat label="Levels" value={t.maxDepth + 1} />
          <Stat label="Released" value={t.released} />
          <Stat label="In work" value={t.inWork} />
          {t.underReview > 0 && <Stat label="In review" value={t.underReview} />}
          <Stat
            label="Rolled-up mass"
            value={t.massKg != null ? `${t.massKg.toFixed(3)} kg` : "—"}
            hint={
              t.massKg == null
                ? `${t.missingMass} part(s) have no mass, so a total would understate it. ` +
                  `Measure them on their part pages.`
                : "Summed from the leaf parts and their quantities."
            }
          />
        </div>
      )}

      {bom && bom.excludedByDate.length > 0 && (
        <Alert kind="info">
          {bom.excludedByDate.length} part(s) are hidden by the date filter:{" "}
          {bom.excludedByDate.slice(0, 6).map((x, i) => (
            <span key={x.partId}>
              {i > 0 && ", "}
              <button
                onClick={() => setOpenPart(x.partId)}
                style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer" }}
              >
                {x.number ?? x.name}
              </button>
              {" "}({x.reason})
            </span>
          ))}
          {bom.excludedByDate.length > 6 && `, and ${bom.excludedByDate.length - 6} more`}.
          {" "}Anything beneath them is hidden too — an assembly that is not valid to build is not
          a route to its components on that date.
        </Alert>
      )}

      {bom && bom.excludedLinks.length > 0 && (
        <Alert kind="info">
          {bom.excludedLinks.length} component position(s) are not in use on this date:{" "}
          {bom.excludedLinks.slice(0, 5).map((x, i) => (
            <span key={x.linkId}>
              {i > 0 && ", "}
              <button
                onClick={() => setOpenPart(x.childId)}
                style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer" }}
              >
                {x.childNumber ?? x.childName}
              </button>
              {" in "}{x.parentNumber ?? "an assembly"} ({x.reason})
            </span>
          ))}
          {bom.excludedLinks.length > 5 && `, and ${bom.excludedLinks.length - 5} more`}.
          {" "}These parts are not retired — this assembly simply does not use them on that date.
          Each may still appear elsewhere in the BOM.
        </Alert>
      )}

      {bom && bom.unreachable.length > 0 && (
        <Alert kind="info">
          {bom.unreachable.length} part(s) are shown at the top because nothing in this product
          contains them:{" "}
          {bom.unreachable.slice(0, 6).map((x, i) => (
            <span key={x.partId}>
              {i > 0 && ", "}
              <button
                onClick={() => setOpenPart(x.partId)}
                style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--accent)", cursor: "pointer" }}
              >
                {x.number ?? x.name}
              </button>
            </span>
          ))}
          {bom.unreachable.length > 6 && `, and ${bom.unreachable.length - 6} more`}.
          {" "}Usually that means the assembly holding them is filed under a different product.
          {bom.cycles.length > 0 && " Here it is the structure fault below."}
        </Alert>
      )}

      {bom && bom.cycles.length > 0 && (
        <Alert kind="warn">
          {bom.cycles.length} part(s) contain themselves, directly or through a chain:{" "}
          {bom.cycles.map((c) => c.number ?? c.partId).join(", ")}. The walk stops there rather
          than looping. This is a structure fault — re-import the assembly, or check for a
          duplicate that was merged onto itself.
        </Alert>
      )}

      {/* --------------------------------- Views ------------------------------- */}
      {loading && !bom ? (
        <div className="card" style={{ padding: 40, textAlign: "center" }}><Spinner size={20} /></div>
      ) : !product ? (
        <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-muted)" }}>
          Create a product on the Parts page first, then its BOM appears here.
        </div>
      ) : !bom || (view === "structured" ? visibleRoots.length === 0 : flatRows.length === 0) ? (
        <div className="card" style={{ padding: 32, textAlign: "center" }}>
          <p style={{ margin: 0, color: "var(--text-muted)" }}>
            {needle
              ? `Nothing in this BOM matches “${q}”.`
              : bom?.excludedByDate.length
                ? "Everything in this product is filtered out by the date above."
                : "This product has no parts yet."}
          </p>
        </div>
      ) : view === "structured" ? (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <Head
              structured
              allShown={walkOrder}
              selected={selected}
              onSelectAll={(on) => setSelected(on ? new Set(walkOrder) : new Set())}
            />
            <tbody>
              {visibleRoots.map((n) => (
                <TreeRows
                  key={n.key}
                  node={n}
                  parentId={null}
                  collapsed={collapsed}
                  onToggle={toggle}
                  onOpen={setOpenPart}
                  onChanged={load}
                  selected={selected}
                  onSelect={toggleSelect}
                  onSwap={setSwapTarget}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <Head
              allShown={flatRows.map((r) => r.partId)}
              selected={selected}
              onSelectAll={(on) =>
                setSelected(on ? new Set(flatRows.map((r) => r.partId)) : new Set())}
            />
            <tbody>
              {flatRows.map((r) => (
                <tr key={r.partId}>
                  <td style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.number ?? r.name}`}
                      checked={selected.has(r.partId)}
                      onChange={() => toggleSelect(r.partId)}
                    />
                  </td>
                  <td style={{ width: 46 }}><PartThumb partId={r.partId} size={34} alt="" /></td>
                  <td><NumberCell row={r} onOpen={setOpenPart} /></td>
                  <td style={{ fontSize: 12.5 }}>{r.name}</td>
                  <td style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{r.description || "—"}</td>
                  <td style={{ fontSize: 12.5 }}>{r.material || "—"}</td>
                  <td><StatusBadge status={r.lifecycleState} /></td>
                  <td style={{ fontSize: 12.5, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.totalQuantity}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-faint)", textAlign: "right" }}>
                    {r.usedIn > 1 ? `${r.usedIn} places` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PartPanel
        partId={openPart}
        onClose={() => setOpenPart(null)}
        onSaved={load}
        onStep={stepTo}
        position={
          openPart && walkOrder.includes(openPart)
            ? { index: walkOrder.indexOf(openPart), total: walkOrder.length }
            : undefined
        }
      />

      <StarReleaseDialog
        open={swapTarget !== null}
        onClose={() => setSwapTarget(null)}
        onDone={load}
        partId={swapTarget?.parentId ?? ""}
        swapTarget={swapTarget}
      />
    </div>
  );
}

function Head({
  structured, allShown, selected, onSelectAll,
}: {
  structured?: boolean;
  allShown: string[];
  selected: Set<string>;
  onSelectAll: (on: boolean) => void;
}) {
  return (
    <thead>
      <tr>
        <th style={{ width: 28 }}>
          <input
            type="checkbox"
            aria-label="Select every part shown"
            checked={allShown.length > 0 && allShown.every((id) => selected.has(id))}
            onChange={(e) => onSelectAll(e.target.checked)}
            disabled={allShown.length === 0}
          />
        </th>
        <th style={{ width: 46 }} />
        <th>Part number</th>
        <th>Name</th>
        <th>Description</th>
        <th>Material</th>
        <th style={{ width: 120 }}>State</th>
        <th style={{ width: 70, textAlign: "right" }}>{structured ? "Qty" : "Total qty"}</th>
        <th style={{ width: 90, textAlign: "right" }}>{structured ? "Total" : "Used in"}</th>
        {/*
          Only in the structured view: effectivity here belongs to the edge —
          this component in this assembly — and the flattened view has collapsed
          the edges away, so there is nothing for the column to describe.
        */}
        {structured && <th style={{ width: 190 }}>In this assembly</th>}
      </tr>
    </thead>
  );
}

/** One node and its descendants, as table rows so the columns stay aligned. */
function TreeRows({
  node, parentId, collapsed, onToggle, onOpen, onChanged, selected, onSelect, onSwap,
}: {
  node: Node;
  /** This node's own parent — null at the root, where there is no edge to swap. */
  parentId: string | null;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onOpen: (partId: string) => void;
  onChanged: () => void;
  selected: Set<string>;
  onSelect: (partId: string) => void;
  onSwap: (target: { parentId: string; bomLinkId: string; number: string | null; name: string }) => void;
}) {
  const isCollapsed = collapsed.has(node.key);
  const hasKids = node.children.length > 0;

  return (
    <>
      <tr>
        <td style={{ width: 28 }}>
          <input
            type="checkbox"
            aria-label={`Select ${node.number ?? node.name}`}
            checked={selected.has(node.partId)}
            onChange={() => onSelect(node.partId)}
          />
        </td>
        <td style={{ width: 46 }}><PartThumb partId={node.partId} size={34} alt="" /></td>
        <td>
          <div style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: node.level * 18 }}>
            {hasKids ? (
              <button
                onClick={() => onToggle(node.key)}
                aria-label={isCollapsed ? "Expand" : "Collapse"}
                style={{
                  background: "none", border: "none", cursor: "pointer", padding: "0 3px",
                  color: "var(--text-faint)", fontSize: 10, width: 16,
                }}
              >
                {isCollapsed ? "▶" : "▼"}
              </button>
            ) : (
              <span style={{ width: 16, display: "inline-block" }} />
            )}
            <NumberCell row={node} onOpen={onOpen} />
          </div>
        </td>
        <td style={{ fontSize: 12.5 }}>{node.name}</td>
        <td style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{node.description || "—"}</td>
        <td style={{ fontSize: 12.5 }}>{node.material || "—"}</td>
        <td><StatusBadge status={node.lifecycleState} /></td>
        <td style={{ fontSize: 12.5, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {node.quantity}
        </td>
        <td style={{ fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--text-faint)" }}>
          {node.totalQuantity}
        </td>
        <td>
          {node.linkId && parentId ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <LinkWindow
                linkId={node.linkId}
                from={node.linkEffectiveFrom}
                to={node.linkEffectiveTo}
                onSaved={onChanged}
              />
              <button
                className="btn btn-sm"
                title="Swap this component for a form-fit-function equivalent, without a new revision"
                onClick={() =>
                  onSwap({ parentId, bomLinkId: node.linkId!, number: node.number, name: node.name })
                }
              >
                Swap…
              </button>
            </div>
          ) : (
            <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>top level</span>
          )}
        </td>
      </tr>
      {!isCollapsed && node.children.map((c) => (
        <TreeRows
          key={c.key} node={c} parentId={node.partId} collapsed={collapsed} onToggle={onToggle}
          onOpen={onOpen} onChanged={onChanged} selected={selected} onSelect={onSelect} onSwap={onSwap}
        />
      ))}
    </>
  );
}

/** The part number, as the control that opens the panel. */
function NumberCell({
  row, onOpen,
}: {
  row: {
    partId: string; number: string | null; name: string; kind: string;
    revision: string; starCount?: number; starReasons?: string[]; iteration: number;
    alsoUsedElsewhere?: boolean; cycle?: boolean; unreachable?: boolean; productName?: string;
    missingForRelease?: string[];
    openTaskCount?: number; taskCount?: number; plmOnly?: boolean;
  };
  onOpen: (partId: string) => void;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <button
        onClick={() => onOpen(row.partId)}
        className="mono"
        title="Show this part's details"
        style={{
          background: "none", border: "none", padding: 0, cursor: "pointer",
          color: "var(--accent)", font: "inherit", fontSize: 12.5,
        }}
      >
        {row.number ?? row.name ?? "—"}
      </button>
      <RevChip
        revision={row.revision} iteration={row.iteration} starCount={row.starCount ?? 0}
        starReasons={row.starReasons}
      />
      {row.kind === "assembly" && <span className="badge">asm</span>}
      {row.plmOnly && (
        <span className="badge" title="Created by copying another part — no Onshape original backs this one">
          PLM only
        </span>
      )}
      {row.alsoUsedElsewhere && (
        <span className="badge" title="This part appears in more than one place in this BOM">
          shared
        </span>
      )}
      {/*
        * Open tasks. Placed before "needs N" because an outstanding change
        * request is a reason not to release the part at all, where a missing
        * attribute is a reason it cannot be released yet.
        */}
      <TaskCountBadge
        open={row.openTaskCount ?? 0}
        total={row.taskCount}
        withLabel
        onClick={() => onOpen(row.partId)}
      />
      {!!row.missingForRelease?.length && (
        /*
         * "N fields missing", not "needs N".
         *
         * This badge counts ATTRIBUTES a part still lacks before it can be
         * released. Sitting in the number cell a few columns from Qty and
         * Total, "needs 2" read as a quantity — the one thing on a BOM row a
         * bare number is assumed to be. Naming the unit is what stops that.
         */
        <span
          className="badge"
          title={`Missing before release: ${row.missingForRelease.join(", ")}`}
          style={{ background: "var(--warn-soft)", color: "var(--warn)", borderColor: "var(--warn)" }}
        >
          {row.missingForRelease.length} field{row.missingForRelease.length === 1 ? "" : "s"} missing
        </span>
      )}
      {row.unreachable && (
        <span className="badge" title="Nothing in this product contains it — shown at the top so it is not lost">
          top level
        </span>
      )}
      {row.cycle && (
        <span className="badge" style={{ color: "var(--warn)" }} title="Contains itself — the walk stops here">
          cycle
        </span>
      )}
    </span>
  );
}

/**
 * The effectivity window of one component in one assembly.
 *
 * Editable in place, because this is a property of a position in a structure
 * and there is nowhere else it naturally belongs — not the part (it is not
 * about the part) and not a separate page (you set it while reading the BOM
 * that made you want to).
 */
function LinkWindow({
  linkId, from, to, onSaved,
}: {
  linkId: string;
  from: string | null;
  to: string | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(from?.slice(0, 10) ?? "");
  const [t, setT] = useState(to?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setF(from?.slice(0, 10) ?? "");
    setT(to?.slice(0, 10) ?? "");
  }, [from, to]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/bom-links/${linkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Empty string clears the end, which is how "and it still is" is said.
        body: JSON.stringify({ effectiveFrom: f || null, effectiveTo: t || null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save");
      setEditing(false);
      onSaved();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    const label =
      !from && !to
        ? "always"
        : `${from ? from.slice(0, 10) : "always"} → ${to ? to.slice(0, 10) : "current"}`;
    return (
      <button
        onClick={() => setEditing(true)}
        title="Set when this assembly uses this component"
        style={{
          background: "none", border: "1px solid transparent", borderRadius: 6,
          padding: "2px 5px", cursor: "pointer", font: "inherit", fontSize: 11.5,
          color: to ? "var(--warn)" : "var(--text-faint)",
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
        <input
          className="input" type="date" value={f} onChange={(e) => setF(e.target.value)}
          style={{ width: 124, fontSize: 11.5, padding: "2px 4px" }}
          aria-label="Effective from"
        />
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>→</span>
        <input
          className="input" type="date" value={t} onChange={(e) => setT(e.target.value)}
          style={{ width: 124, fontSize: 11.5, padding: "2px 4px" }}
          aria-label="Effective to"
        />
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}>
          {busy ? <Spinner size={11} /> : "Save"}
        </button>
        <button className="btn btn-sm" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </button>
        {(f || t) && (
          <button
            className="btn btn-sm"
            onClick={() => { setF(""); setT(""); }}
            disabled={busy}
            title="Always in use"
          >
            Clear
          </button>
        )}
      </div>
      {err && <div style={{ fontSize: 11, color: "var(--danger)" }}>{err}</div>}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div title={hint}>
      <div style={{ color: "var(--text-faint)", fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
