"use client";

import { useState } from "react";

export type ProductSummary = {
  id: string;
  name: string;
  code: string;
  description: string;
  parts: number;
  assemblies: number;
  total: number;
  released: number;
  inWork: number;
  underReview: number;
  isUnassigned: boolean;
};

/**
 * The product list beside the parts table.
 *
 * A product is the grouping people actually work in, so it gets a persistent
 * place on the page rather than a dropdown among the other filters: it is the
 * context everything else is read inside, not one more thing to narrow by.
 *
 * Counts are shown on every row because a product's size is the first thing
 * anyone wants to know about it, and because a product with nothing in it is
 * worth seeing — it usually means parts went somewhere else by mistake.
 */
export function ProductSidebar({
  products,
  unfiled,
  selected,
  canManage,
  canDelete,
  busy,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onFileUnfiled,
}: {
  products: ProductSummary[];
  unfiled: number;
  selected: string;
  canManage: boolean;
  /**
   * Whether the viewer may delete a product.
   *
   * Separate from canManage because the API separates them: creating and
   * renaming are open to any signed-in user, deleting is admin-only. Showing a
   * Delete button that answers 403 is worse than not showing one.
   */
  canDelete: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onFileUnfiled: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");

  const allTotal = products.reduce((t, p) => t + p.total, 0);

  async function submitNew() {
    const name = newName.trim();
    if (!name) return;
    await onCreate(name);
    setNewName("");
    setAdding(false);
  }

  async function submitRename(id: string) {
    const name = renameTo.trim();
    if (!name) return;
    await onRename(id, name);
    setRenaming(null);
  }

  return (
    <aside
      className="card"
      style={{ width: 250, flexShrink: 0, alignSelf: "flex-start", position: "sticky", top: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>Products</h2>
        <div style={{ flex: 1 }} />
        {canManage && (
          <button
            className="btn btn-sm"
            onClick={() => setAdding((v) => !v)}
            disabled={busy}
            title="Create a product"
          >
            {adding ? "Cancel" : "New"}
          </button>
        )}
      </div>

      {adding && (
        <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
          <input
            className="input"
            autoFocus
            placeholder="Product name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNew();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <button className="btn btn-primary btn-sm" onClick={submitNew} disabled={busy || !newName.trim()}>
            Create
          </button>
        </div>
      )}

      <div style={{ display: "grid", gap: 2 }}>
        <Row
          label="All products"
          count={allTotal}
          active={selected === "all"}
          onClick={() => onSelect("all")}
        />

        {products.map((p) => (
          <div key={p.id}>
            {renaming === p.id ? (
              <div style={{ display: "grid", gap: 6, padding: "6px 0" }}>
                <input
                  className="input"
                  autoFocus
                  value={renameTo}
                  onChange={(e) => setRenameTo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitRename(p.id);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-sm btn-primary" onClick={() => submitRename(p.id)} disabled={busy}>
                    Save
                  </button>
                  <button className="btn btn-sm" onClick={() => setRenaming(null)} disabled={busy}>
                    Cancel
                  </button>
                  {/*
                    Deleting is offered here rather than as a permanent icon on
                    every row: it is rare, and a delete control sitting next to
                    a filter control is a control people hit by accident.
                  */}
                  {!p.isUnassigned && canDelete && (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => onDelete(p.id)}
                      disabled={busy}
                      title={
                        p.total
                          ? `Its ${p.total} item(s) move to Unassigned — nothing is deleted`
                          : "Delete this product"
                      }
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <Row
                label={p.name}
                sub={statLine(p)}
                count={p.total}
                active={selected === p.id}
                muted={p.isUnassigned}
                onClick={() => onSelect(p.id)}
                onEdit={
                  canManage
                    ? () => { setRenaming(p.id); setRenameTo(p.name); }
                    : undefined
                }
              />
            )}
          </div>
        ))}

        {/*
          Parts that predate the product field, kept distinct from the
          "Unassigned" product. An unassigned part was filed there; an unfiled
          one was never asked, and folding the two together would hide the fact
          that something needs doing.
        */}
        {unfiled > 0 && (
          <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <Row
              label="Not yet filed"
              sub="added before products existed"
              count={unfiled}
              active={selected === "unfiled"}
              muted
              onClick={() => onSelect("unfiled")}
            />
            {canManage && (
              <button
                className="btn btn-sm"
                style={{ marginTop: 6, width: "100%" }}
                onClick={onFileUnfiled}
                disabled={busy}
              >
                File all into Unassigned
              </button>
            )}
          </div>
        )}
      </div>

      {products.length === 0 && (
        <p style={{ margin: "10px 0 0", color: "var(--text-faint)", fontSize: 12 }}>
          No products yet. Create one to start grouping parts by what they are part of.
        </p>
      )}
    </aside>
  );
}

/** The one-line breakdown under a product's name. */
function statLine(p: ProductSummary): string {
  if (p.total === 0) return "empty";
  const bits: string[] = [];
  if (p.assemblies) bits.push(`${p.assemblies} assembly${p.assemblies === 1 ? "" : "s"}`);
  if (p.parts) bits.push(`${p.parts} part${p.parts === 1 ? "" : "s"}`);
  if (p.released) bits.push(`${p.released} released`);
  else if (p.underReview) bits.push(`${p.underReview} in review`);
  return bits.join(" · ");
}

function Row({
  label, sub, count, active, muted, onClick, onEdit,
}: {
  label: string;
  sub?: string;
  count: number;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
  onEdit?: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button
        onClick={onClick}
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          background: active ? "var(--accent-soft, rgba(60,120,220,0.12))" : "transparent",
          border: "1px solid",
          borderColor: active ? "var(--accent, #3c78dc)" : "transparent",
          borderRadius: 6,
          padding: "6px 8px",
          cursor: "pointer",
          color: muted && !active ? "var(--text-faint)" : "var(--text)",
          font: "inherit",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: active ? 600 : 400,
            }}
            title={label}
          >
            {label}
          </span>
          <span
            style={{
              fontSize: 11.5,
              fontVariantNumeric: "tabular-nums",
              color: "var(--text-faint)",
            }}
          >
            {count}
          </span>
        </div>
        {sub && (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-faint)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={sub}
          >
            {sub}
          </div>
        )}
      </button>
      {onEdit && (
        <button
          className="btn btn-sm"
          onClick={onEdit}
          title="Rename or delete"
          style={{ padding: "2px 6px", lineHeight: 1 }}
        >
          ⋯
        </button>
      )}
    </div>
  );
}
