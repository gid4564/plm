"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, PartThumb, Spinner, StatusBadge, relTime } from "@/components/ui";

type Assembly = { elementId: string; name: string; documentName: string; count: number };
type ProductFacet = { id: string; name: string; count: number };

type Item = {
  id: string; moNumber: string | null; partName: string; partNumber: string;
  revision: string; status: string; remarks: string; quantity: number;
  material: string; project: string; documentName: string; elementName: string;
  createdByEmail: string | null;
  productId: string | null;
  productName: string;
  sourceAssembly: { elementId: string; name: string; documentName: string; quantityInAssembly: number | null } | null;
  usedInCount: number;
  manufacturedBy: string;
  pushPending: boolean; lastPushError: string | null; writeBackBlocked: string | null;
  lastSyncedFromOnshapeAt: string | null; lastPushedToOnshapeAt: string | null;
  updatedAt: string;
};

export function ItemsTable({
  statuses, facilities = [], myEmail, initialAssembly = "all", initialProduct = "all",
}: {
  statuses: string[]; facilities?: string[]; myEmail: string; initialAssembly?: string; initialProduct?: string;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");
  const [assembly, setAssembly] = useState(initialAssembly);
  const [assemblies, setAssemblies] = useState<Assembly[]>([]);
  const [product, setProduct] = useState(initialProduct);
  const [products, setProducts] = useState<ProductFacet[]>([]);
  const [manufacturedBy, setManufacturedBy] = useState("all");
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const buildParams = useCallback((cursor?: string | null) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status !== "all") p.set("status", status);
    if (owner !== "all") p.set("owner", owner);
    if (assembly !== "all") p.set("assembly", assembly);
    if (product !== "all") p.set("product", product);
    if (manufacturedBy !== "all") p.set("manufacturedBy", manufacturedBy);
    if (cursor) p.set("cursor", cursor);
    return p;
  }, [q, status, owner, assembly, product, manufacturedBy]);

  /** First page. Replaces the list — this is what a filter or search change does. */
  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/items?${buildParams()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load items");
      setItems(data.items);
      setAssemblies(data.assemblies ?? []);
      setProducts(data.products ?? []);
      setTotal(data.total ?? data.items.length);
      setNextCursor(data.nextCursor ?? null);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  // Debounced so typing in the search box does not hammer the API.
  useEffect(() => {
    const t = setTimeout(load, 220);
    return () => clearTimeout(t);
  }, [load]);

  /*
   * Confirm the sign-in that started in the Onshape panel.
   *
   * That flow opens a tab purely to set the cookie and lands it here, so say
   * plainly that it worked and what to do next — otherwise the tab looks like
   * an ordinary dashboard and it is not obvious the panel is now usable. The
   * query string is cleared afterwards, the same as Settings does.
   */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("onshape") === "connected") {
      setNotice(
        "Signed in and connected to Onshape. Go back to the Onshape tab and press " +
        "“I’ve signed in — continue” in the MOS panel." +
        (q.get("mock") ? " (Mock mode — no real handshake occurred.)" : "")
      );
      q.delete("onshape");
      q.delete("mock");
      const rest = q.toString();
      window.history.replaceState({}, "", rest ? `/dashboard?${rest}` : "/dashboard");
    }
  }, []);

  /**
   * Next page. Appends rather than replacing, and is keyed to the exact row the
   * previous page ended on — see lib/pagination.ts — so it stays correct even
   * while items above it are being edited.
   */
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await fetch(`/api/items?${buildParams(nextCursor)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load more items");
      setItems((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor ?? null);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Change the product filter, and remember it as this user's default the next
   * time they open the dashboard. Fire-and-forget — worth doing, not worth
   * blocking the filter change on, or surfacing an error for if it fails.
   */
  function selectProduct(id: string) {
    setProduct(id);
    fetch("/api/me/last-product", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: id === "all" ? null : id }),
    }).catch(() => {});
  }

  /** The active product's name, for the header — from the facet list, or the loaded rows if a deep link named one the facet has not caught up to. */
  function activeProductName(): string | null {
    if (product === "all") return null;
    return products.find((p) => p.id === product)?.name
      ?? items.find((i) => i.productId === product)?.productName
      ?? null;
  }

  const pending = items.filter((i) => i.pushPending).length;
  const blocked = items.filter((i) => i.writeBackBlocked).length;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h1 style={{ fontSize: 20, margin: 0, letterSpacing: "-.02em" }}>Manufacturing Items</h1>
            {product !== "all" && (
              <span
                className="badge"
                style={{ background: "var(--accent-soft)", color: "var(--accent)", borderColor: "var(--accent)", gap: 6 }}
                title="This list is narrowed to one product"
              >
                {activeProductName() || "one product"}
                <button
                  type="button"
                  onClick={() => selectProduct("all")}
                  aria-label="Clear product filter"
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 }}
                >
                  ×
                </button>
              </span>
            )}
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "3px 0 0" }}>
            {loading
              ? "Loading…"
              : total > items.length
                ? `${items.length} of ${total} item${total === 1 ? "" : "s"} loaded`
                : `${items.length} item${items.length === 1 ? "" : "s"}`}
            {pending > 0 && (
              <span style={{ color: "var(--warn)" }}> · {pending} with a pending push to Onshape</span>
            )}
            {blocked > 0 && (
              <span style={{ color: "var(--text-faint)" }}> · {blocked} with no write-back</span>
            )}
          </p>
        </div>

        <input
          className="input" style={{ width: 220 }} value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search MO, part, project…"
        />
        <select className="select" style={{ width: 150 }} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">Everyone</option>
          <option value="mine">My items</option>
          <option value="auto">Added on release</option>
        </select>
        {assemblies.length > 0 && (
          <select
            className="select" style={{ width: 190 }} value={assembly}
            onChange={(e) => setAssembly(e.target.value)}
            title="Show only the parts exploded out of one assembly"
          >
            <option value="all">All assemblies</option>
            {assemblies.map((a) => (
              <option key={a.elementId} value={a.elementId}>
                {a.name} ({a.count})
              </option>
            ))}
          </select>
        )}
        {products.length > 0 && (
          <select
            className="select" style={{ width: 170 }} value={product}
            onChange={(e) => selectProduct(e.target.value)}
            title="Show only the parts belonging to one product"
          >
            <option value="all">All products</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.count})
              </option>
            ))}
          </select>
        )}
        <select className="select" style={{ width: 165 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {facilities.length > 0 && (
          <select
            className="select" style={{ width: 165 }} value={manufacturedBy}
            onChange={(e) => setManufacturedBy(e.target.value)}
            title="Show only the items assigned to one plant or vendor"
          >
            <option value="all">Manufactured by: all</option>
            {facilities.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : null} Refresh
        </button>
      </div>

      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <div className="card" style={{ overflow: "hidden" }}>
        {loading && items.length === 0 ? (
          <div style={{ padding: 44, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            <Spinner size={18} />
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 44, textAlign: "center" }}>
            <p style={{ fontSize: 14, margin: "0 0 6px" }}>No manufacturing items yet.</p>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 16px", lineHeight: 1.55 }}>
              Sync a part from the MOS panel in Onshape, or import a whole assembly&apos;s bill of
              materials at once.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <Link href="/bom" className="btn btn-primary">Import from an assembly</Link>
              <Link href="/simulator" className="btn">Open Onshape Simulator</Link>
            </div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 56 }}></th>
                  <th>MO Number</th>
                  <th>Part</th>
                  <th>Part No.</th>
                  <th>Rev</th>
                  <th style={{ width: 52 }}>Qty</th>
                  <th>Status</th>
                  <th>Project</th>
                  <th>Product</th>
                  <th>Manufactured by</th>
                  <th>Added by</th>
                  <th>Source</th>
                  <th>Sync</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td style={{ paddingRight: 0 }}>
                      <Link href={`/items/${i.id}`} style={{ display: "block" }}>
                        <PartThumb itemId={i.id} size={38} alt={i.partName || "Part"} />
                      </Link>
                    </td>
                    <td>
                      <Link href={`/items/${i.id}`} className="link mono" style={{ fontWeight: 600 }}>
                        {i.moNumber || "—"}
                      </Link>
                    </td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{i.partName || "Unnamed part"}</div>
                      {i.material && (
                        <div style={{ color: "var(--text-faint)", fontSize: 11.5 }}>{i.material}</div>
                      )}
                    </td>
                    <td className="mono">{i.partNumber || "—"}</td>
                    <td className="mono">{i.revision || "—"}</td>
                    <td className="mono">{i.quantity ?? 1}</td>
                    <td><StatusBadge status={i.status} /></td>
                    <td style={{ color: "var(--text-muted)" }}>{i.project || "—"}</td>
                    <td style={{ color: "var(--text-muted)" }}>{i.productName || "—"}</td>
                    <td style={{ color: "var(--text-muted)" }}>{i.manufacturedBy || "—"}</td>
                    <td style={{ fontSize: 12 }}>
                      {i.createdByEmail ? (
                        <span
                          style={{ color: i.createdByEmail === myEmail ? "var(--accent)" : "var(--text-muted)" }}
                          title={i.createdByEmail}
                        >
                          {i.createdByEmail === myEmail ? "You" : i.createdByEmail.split("@")[0]}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-faint)" }} title="Enrolled automatically, or predates attribution">
                          on release
                        </span>
                      )}
                    </td>
                    <td style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      <div>{i.documentName}</div>
                      <div style={{ color: "var(--text-faint)", fontSize: 11 }}>{i.elementName}</div>
                      {i.sourceAssembly?.name && (
                        <div style={{ color: "var(--accent)", fontSize: 11 }} title="Imported from this assembly's BOM">
                          ⌬ {i.sourceAssembly.name}
                          {i.usedInCount > 1 && (
                            <span style={{ color: "var(--text-faint)" }} title="Also known to be used in other assemblies — see Used in on the item page">
                              {" "}+{i.usedInCount - 1} more
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 11.5 }}>
                      {i.writeBackBlocked ? (
                        // Deliberately neutral: this is a settled state, not a
                        // job for someone. Amber here would send people chasing
                        // a write that is never going to happen.
                        <span
                          className="badge"
                          style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderColor: "var(--border)" }}
                          title={i.writeBackBlocked}
                        >
                          No write-back
                        </span>
                      ) : i.pushPending ? (
                        <span
                          className="badge"
                          style={{ background: "var(--warn-soft)", color: "var(--warn)", borderColor: "var(--warn)" }}
                          title={i.lastPushError || "Push to Onshape is pending"}
                        >
                          Push pending
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-faint)" }}>
                          ↑ {relTime(i.lastPushedToOnshapeAt)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {nextCursor && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Spinner />} Load more ({total - items.length} remaining)
          </button>
        </div>
      )}
    </div>
  );
}
