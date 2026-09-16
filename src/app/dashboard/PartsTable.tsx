"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ProductSidebar, type ProductSummary } from "./ProductSidebar";
import { Alert, CollapsibleSection, PartThumb, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";
import { TaskCountBadge } from "@/components/PartTasks";

type Part = {
  id: string;
  number: string | null;
  name: string;
  kind: "part" | "assembly";
  plmOnly: boolean;
  revision: string;
  starCount: number;
  starReasons: string[];
  iteration: number;
  lifecycleState: string;
  onshapeState: string;
  productId: string | null;
  productName: string;
  material: string;
  classification: string;
  documentName: string;
  elementName: string;
  createdByEmail: string | null;
  releaseId: string | null;
  childCount: number;
  usedInCount: number;
  openTaskCount: number;
  taskCount: number;
  pushPending: boolean;
  writeBackBlocked: string | null;
  lastPushError: string | null;
  lastSyncedFromOnshapeAt: string | null;
  updatedAt: string;
};

export function PartsTable({
  states, myEmail, canDecide, isAdmin, underReview, initialState, initialKind, initialRelease,
  initialProduct,
}: {
  states: string[];
  myEmail: string;
  canDecide: boolean;
  /** Admin rights, which gate a narrower set of things than canDecide. */
  isAdmin: boolean;
  underReview: number;
  initialState: string;
  initialKind: string;
  initialRelease: string;
  initialProduct: string;
}) {
  const [parts, setParts] = useState<Part[]>([]);
  const [stateFacets, setStateFacets] = useState<{ state: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [state, setState] = useState(initialState);
  const [kind, setKind] = useState(initialKind);
  const [owner, setOwner] = useState("all");
  const [releaseFilter, setReleaseFilter] = useState(initialRelease);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [unfiled, setUnfiled] = useState(0);
  /*
   * "all" until the server says which product this person was last working in.
   * Not defaulted from localStorage: the same answer has to hold on their other
   * machine, and the server needs it anyway — a part synced from the panel is
   * filed into it.
   */
  const [product, setProduct] = useState(initialProduct);
  const [productsBusy, setProductsBusy] = useState(false);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // Selection drives "Submit for release", which is the point of a list view
  // here rather than only a per-part action: a release is normally several
  // parts decided together.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<
    { ok: boolean; message: string; number?: string | null; releaseId?: string | null;
      failures?: { itemLabel: string; missing: string[] }[] } | null
  >(null);

  const query = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (state !== "all") p.set("state", state);
      if (kind !== "all") p.set("kind", kind);
      if (owner !== "all") p.set("owner", owner);
      if (releaseFilter !== "all") p.set("release", releaseFilter);
      if (product !== "all") p.set("product", product);
      if (cursor) p.set("cursor", cursor);
      return `/api/parts?${p.toString()}`;
    },
    [q, state, kind, owner, releaseFilter, product]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(query());
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load parts");
      setParts(j.parts);
      setStateFacets(j.states ?? []);
      setTotal(j.total);
      setNextCursor(j.nextCursor);
      // Anything no longer on screen cannot meaningfully stay selected.
      setSelected((prev) => new Set(j.parts.filter((p: Part) => prev.has(p.id)).map((p: Part) => p.id)));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadProducts = useCallback(async (adoptCurrent: boolean) => {
    try {
      const r = await fetch("/api/products");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load products");
      setProducts(j.products ?? []);
      setUnfiled(j.unfiled ?? 0);
      /*
       * Adopt the remembered product on first load only. Doing it on every
       * refresh would drag the view back to it every time a product is
       * renamed or a part moved, overriding a selection just made by hand.
       */
      if (adoptCurrent && initialProduct !== "all") {
        /*
         * A product named in the URL is an explicit request — someone followed
         * a link from a part — and outranks whatever was last remembered.
         */
      } else if (adoptCurrent && j.currentProductId) {
        const exists = (j.products ?? []).some((p: ProductSummary) => p.id === j.currentProductId);
        if (exists) setProduct(j.currentProductId);
      }
    } catch {
      // A product list that will not load must not take the parts table with
      // it: the table is the page, and the sidebar is navigation.
    }
  }, [initialProduct]);

  useEffect(() => { void loadProducts(true); }, [loadProducts]);

  /** Remember the selection server-side, so it survives a different machine. */
  async function selectProduct(id: string) {
    setProduct(id);
    // "all" and "unfiled" are views, not products, so there is nothing to
    // remember for them — and no id the server would accept.
    if (id === "all" || id === "unfiled") return;
    await fetch(`/api/products/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select" }),
    }).catch(() => {});
  }

  async function productAction(run: () => Promise<Response>) {
    setProductsBusy(true);
    setError(null);
    try {
      const r = await run();
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");
      await loadProducts(false);
      await load();
      if (j.message) setSubmitResult({ ok: true, message: j.message });
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setProductsBusy(false);
    }
  }

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const r = await fetch(query(nextCursor));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load more");
      setParts((prev) => [...prev, ...j.parts]);
      setNextCursor(j.nextCursor);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Only pre-release parts can be put into a release. */
  /*
   * Selection is not about releasing.
   *
   * The checkbox used to be disabled unless a part was In Work, because the
   * only thing a selection did was raise a release. Moving parts between
   * products then inherited that limit — and released parts are precisely the
   * ones that need re-filing when products are reorganised, so the feature was
   * unusable on most of a mature system's parts.
   *
   * So anything can be selected, and each action decides for itself what it can
   * act on: a release takes the In Work ones, a product move takes them all.
   */
  const chosen = [...selected];
  const releasable = parts.filter((p) => selected.has(p.id) && p.lifecycleState === "In Work");
  const notReleasable = chosen.length - releasable.length;

  async function submitForRelease() {
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const r = await fetch("/api/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /*
         * Only the In Work ones. Now that anything can be selected, sending the
         * whole selection would have the server refuse the lot over a released
         * part somebody happened to tick.
         */
        body: JSON.stringify({ partIds: releasable.map((p) => p.id) }),
      });
      const j = await r.json();
      setSubmitResult({
        ok: Boolean(j.ok),
        message: j.message || j.error || "Unknown outcome",
        number: j.number ?? null,
        releaseId: j.releaseId ?? null,
        failures: j.validationFailures ?? [],
      });
      if (j.ok) {
        setSelected(new Set());
        load();
      }
    } catch (e: any) {
      setSubmitResult({ ok: false, message: String(e?.message ?? e) });
    } finally {
      setSubmitting(false);
    }
  }

  const activeProduct = products.find((x) => x.id === product);
  const titleText = product === "all"
    ? "Parts and assemblies"
    : product === "unfiled"
      ? "Not yet filed"
      : activeProduct?.name ?? "Parts and assemblies";

  return (
    <CollapsibleSection
      storageKey="plm:dashboard:parts-open"
      title={<h1 style={{ margin: 0, fontSize: 19 }}>{titleText}</h1>}
      right={
        <div style={{ display: "flex", gap: 12, alignItems: "center", flex: 1, minWidth: 0 }}>
          <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
            {loading ? "loading…" : `${parts.length} of ${total}`}
          </span>
          <div style={{ flex: 1 }} />
          {stateFacets.map((f) => (
            <button
              key={f.state}
              className="btn btn-sm"
              onClick={() => setState(state === f.state ? "all" : f.state)}
              style={{
                borderColor: state === f.state ? "var(--accent)" : undefined,
                color: state === f.state ? "var(--accent)" : undefined,
              }}
            >
              {f.state} {f.count}
            </button>
          ))}
        </div>
      }
    >
    {/*
     * Sidebar beside the table, wrapping to a stacked layout on a narrow
     * viewport. `min-width: 0` on the main column is what stops the table's own
     * horizontal scroll container from pushing the sidebar off the page.
     */}
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
      <ProductSidebar
        products={products}
        unfiled={unfiled}
        selected={product}
        /*
         * Anyone may create and rename a product — it is how people organise
         * their own work, and the picker on the part page and in the panel lets
         * any user create one, so gating it here only made the two disagree.
         */
        canManage
        /* Deleting is admin-only, matching the API, which returns 403. */
        canDelete={isAdmin}
        busy={productsBusy}
        onSelect={selectProduct}
        onCreate={(name) =>
          productAction(() =>
            fetch("/api/products", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            })
          )
        }
        onRename={(id, name) =>
          productAction(() =>
            fetch(`/api/products/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name }),
            })
          )
        }
        onDelete={async (id) => {
          const p = products.find((x) => x.id === id);
          if (
            !confirm(
              p?.total
                ? `Delete "${p.name}"? Its ${p.total} item(s) move to Unassigned — ` +
                  `nothing is deleted.`
                : `Delete "${p?.name}"?`
            )
          ) return;
          // The view would otherwise keep filtering on a product that is gone.
          if (product === id) setProduct("all");
          await productAction(() => fetch(`/api/products/${id}`, { method: "DELETE" }));
        }}
        onFileUnfiled={() =>
          productAction(() =>
            fetch("/api/products", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "file-unfiled" }),
            })
          )
        }
      />

      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 16 }}>
      {underReview > 0 && (
        <Alert kind="warn">
          {underReview} release{underReview === 1 ? " is" : "s are"} waiting for a decision.{" "}
          <Link href="/releases?state=Under Review" style={{ color: "inherit", fontWeight: 600 }}>
            {canDecide ? "Review them" : "See them"}
          </Link>
          {!canDecide && " — an approver or admin has to decide."}
        </Alert>
      )}

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {submitResult && (
        <Alert kind={submitResult.ok ? "ok" : "warn"} onDismiss={() => setSubmitResult(null)}>
          <div>{submitResult.message}</div>
          {submitResult.releaseId && (
            <div style={{ marginTop: 6 }}>
              <Link href={`/releases/${submitResult.releaseId}`} style={{ color: "inherit", fontWeight: 600 }}>
                Open {submitResult.number}
              </Link>
            </div>
          )}
          {!!submitResult.failures?.length && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {submitResult.failures.map((f) => (
                <li key={f.itemLabel}>
                  <strong>{f.itemLabel}</strong> needs {f.missing.join(", ")}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          style={{ width: 240 }}
          placeholder="Search number, name, document…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="select" style={{ width: 130 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">Parts and assemblies</option>
          <option value="part">Parts only</option>
          <option value="assembly">Assemblies only</option>
        </select>
        <select className="select" style={{ width: 165 }} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="all">Any lifecycle state</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select" style={{ width: 160 }} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">Anyone</option>
          <option value="mine">Brought in by me</option>
          <option value="auto">Arrived automatically</option>
        </select>
        {releaseFilter !== "all" && (
          <button className="btn btn-sm" onClick={() => setReleaseFilter("all")}>
            Clear release filter ×
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : "Refresh"}
        </button>
      </div>

      {chosen.length > 0 && (
        <div
          className="card"
          style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 14px" }}
        >
          <strong style={{ fontSize: 13 }}>{chosen.length} selected</strong>
          <span style={{ color: "var(--text-faint)", fontSize: 12.5 }}>
            {notReleasable > 0
              ? `${releasable.length} can be released — ` +
                `${notReleasable} ${notReleasable === 1 ? "is" : "are"} not In Work. ` +
                `All ${chosen.length} can be moved between products.`
              : "Raising a release here creates the Onshape release package too, then holds it " +
                "for review in PLM."}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => setSelected(new Set())}>Clear</button>

          {/*
            Moving items between products, from the selection that already
            exists for release submission. A select rather than a button,
            because the useful question is "into which product" — and it needs
            no separate confirm: a part's product is a grouping, and moving it
            back costs the same click.
          */}
          {products.length > 0 && (
            <select
              className="select"
              style={{ maxWidth: 230 }}
              value=""
              aria-label={`Move ${chosen.length} selected item(s) to a product`}
              title="Applies to every selected item, whatever its state"
              disabled={productsBusy}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const ids = [...selected];
                e.currentTarget.value = "";
                void productAction(() =>
                  fetch(`/api/products/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "assign", partIds: ids }),
                  })
                );
              }}
            >
              <option value="">
                {`Move ${chosen.length} item${chosen.length === 1 ? "" : "s"} to…`}
              </option>
              {products.map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </select>
          )}

          <button
            className="btn btn-primary btn-sm"
            onClick={submitForRelease}
            disabled={submitting || releasable.length === 0}
            title={
              releasable.length === 0
                ? "Only a part In Work can be put into a release"
                : notReleasable > 0
                  ? `Releases the ${releasable.length} In Work item(s); the rest are left alone`
                  : undefined
            }
          >
            {submitting
              ? <Spinner />
              : notReleasable > 0
                ? `Release ${releasable.length} of ${chosen.length}`
                : "Submit for release"}
          </button>
        </div>
      )}

      {loading && parts.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>
          <Spinner size={20} />
        </div>
      ) : parts.length === 0 ? (
        <div className="card" style={{ padding: 36, textAlign: "center" }}>
          {/*
            The empty state leads with where parts actually come from. It used
            to offer the assembly import and the simulator as its two buttons,
            which pointed every new user at the two paths that are now hidden
            from them — and made the by-hand fallback look like the main way in.
          */}
          <p style={{ margin: "0 0 6px", color: "var(--text-muted)" }}>
            {product === "all"
              ? "Nothing here yet."
              : `Nothing in ${activeProduct?.name ?? "this product"} yet.`}
          </p>
          <p style={{ margin: "0 0 14px", color: "var(--text-faint)", fontSize: 12.5 }}>
            Parts reach PLM from the Onshape panel, a &ldquo;Send to PLM&rdquo; context-menu
            action, or a release raised in Onshape.
            {product !== "all" && " Parts already in PLM can be moved here from the Parts list."}
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            {/*
              Admin-only, matching the nav: neither is part of the normal flow,
              and offering them to everyone here would undo that.
            */}
            {isAdmin && (
              <Link href="/import" className="btn">Import from an assembly</Link>
            )}
            <Link href="/manual" className="btn btn-primary">How parts get in</Link>
          </div>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      aria-label="Select every part shown"
                      title="Select every part on this page"
                      checked={parts.length > 0 && parts.every((p) => selected.has(p.id))}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(parts.map((p) => p.id)) : new Set())
                      }
                      disabled={parts.length === 0}
                    />
                  </th>
                  <th style={{ width: 46 }} />
                  <th>Number</th>
                  <th>Name</th>
                  <th>Rev</th>
                  <th>Lifecycle</th>
                  {/* Only when looking across products: inside one, every row
                      would repeat the heading above the table. */}
                  {product === "all" && <th>Product</th>}
                  <th>Material</th>
                  <th>Make/buy</th>
                  <th>Structure</th>
                  <th>Onshape</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.number ?? p.name}`}
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                      />
                    </td>
                    <td><PartThumb partId={p.id} size={34} alt="" /></td>
                    <td>
                      <Link href={`/parts/${p.id}`} className="mono" style={{ fontWeight: 600 }}>
                        {p.number ?? "—"}
                      </Link>
                      {p.kind === "assembly" && (
                        <span className="badge" style={{ marginLeft: 6 }}>asm</span>
                      )}
                      {p.plmOnly && (
                        <span
                          className="badge" style={{ marginLeft: 6 }}
                          title="Created by copying another part — no Onshape original backs this one"
                        >
                          PLM only
                        </span>
                      )}
                      {/*
                        * Beside the number rather than in its own column: it
                        * appears on a minority of rows, and an almost-empty
                        * column costs every row width to say nothing.
                        */}
                      {p.openTaskCount > 0 && (
                        <Link
                          href={`/parts/${p.id}#tasks`}
                          style={{ marginLeft: 6, textDecoration: "none" }}
                        >
                          <TaskCountBadge open={p.openTaskCount} total={p.taskCount} />
                        </Link>
                      )}
                    </td>
                    <td>
                      <div>{p.name || <span style={{ color: "var(--text-faint)" }}>—</span>}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                        {p.documentName}{p.elementName ? ` · ${p.elementName}` : ""}
                      </div>
                    </td>
                    <td>
                      <RevChip
                        revision={p.revision} iteration={p.iteration} starCount={p.starCount}
                        starReasons={p.starReasons}
                      />
                    </td>
                    <td>
                      <StatusBadge status={p.lifecycleState} />
                      {p.releaseId && (
                        <div style={{ fontSize: 11 }}>
                          <Link href={`/releases/${p.releaseId}`} style={{ color: "var(--text-faint)" }}>
                            in release
                          </Link>
                        </div>
                      )}
                    </td>
                    {product === "all" && (
                      <td style={{ fontSize: 12.5 }}>
                        {p.productName ? (
                          <button
                            onClick={() => selectProduct(p.productId!)}
                            title={`Show only ${p.productName}`}
                            style={{
                              background: "none", border: "none", padding: 0,
                              font: "inherit", color: "var(--accent)", cursor: "pointer",
                            }}
                          >
                            {p.productName}
                          </button>
                        ) : (
                          <span style={{ color: "var(--text-faint)" }}>not filed</span>
                        )}
                      </td>
                    )}
                    <td style={{ fontSize: 12.5 }}>{p.material || "—"}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {p.classification || <span style={{ color: "var(--warn)" }}>not set</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {p.childCount ? `${p.childCount} child${p.childCount === 1 ? "" : "ren"}` : ""}
                      {p.childCount && p.usedInCount ? " · " : ""}
                      {p.usedInCount ? `used in ${p.usedInCount}` : ""}
                      {!p.childCount && !p.usedInCount ? "—" : ""}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {p.writeBackBlocked ? (
                        <span title={p.writeBackBlocked} style={{ color: "var(--text-faint)" }}>
                          read-only
                        </span>
                      ) : p.pushPending ? (
                        <span title={p.lastPushError ?? ""} style={{ color: "var(--warn)" }}>
                          write pending
                        </span>
                      ) : (
                        <span style={{ color: "var(--ok)" }}>in step</span>
                      )}
                      {p.onshapeState && (
                        <div style={{ color: "var(--text-faint)", fontSize: 11 }}>{p.onshapeState}</div>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-faint)" }} title={p.updatedAt}>
                      {relTime(p.updatedAt)}
                      {p.createdByEmail === myEmail && (
                        <div style={{ fontSize: 11 }}>by you</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {nextCursor && (
            <div style={{ textAlign: "center" }}>
              <button className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <Spinner /> : `Load more (${total - parts.length} left)`}
              </button>
            </div>
          )}
        </>
      )}
      </div>
    </div>
    </CollapsibleSection>
  );
}
