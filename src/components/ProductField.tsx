"use client";

import { useCallback, useEffect, useState } from "react";

export type ProductOption = {
  id: string;
  name: string;
  total: number;
};

/**
 * The product picker, wherever a product is chosen.
 *
 * Shared because the same control belongs on the part page, in the Onshape
 * right panel and on the assembly import — and because what it means differs
 * between them while what it *looks* like should not. The host supplies
 * `onChange` and therefore the meaning:
 *
 *   part page      move this part into that product
 *   panel          this is the product I am working in, so file what I sync
 *                  from here into it
 *
 * It loads its own list. Three hosts otherwise each need the same fetch, the
 * same error handling and the same "created a product, now re-read" dance, and
 * they would drift.
 */
export function ProductField({
  value,
  label = "Product",
  hint,
  disabled,
  compact,
  emptyLabel = "Not filed to a product",
  onChange,
}: {
  /** Currently selected product id, or null. */
  value: string | null;
  label?: string;
  hint?: string;
  disabled?: boolean;
  /** Tighter layout for the Onshape panel, which is a narrow column. */
  compact?: boolean;
  emptyLabel?: string;
  /** Called with the chosen product's id. Awaited, so the control can show it saving. */
  onChange: (productId: string, productName: string) => Promise<void> | void;
}) {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/products");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load products");
      setProducts(j.products ?? []);
      setError(null);
    } catch (e: any) {
      /*
       * A product list that will not load leaves the picker empty and says so,
       * rather than taking its host page down. On the part page everything else
       * is still worth reading; in the panel, syncing still works — the part
       * just lands in Unassigned.
       */
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function choose(productId: string, productName: string) {
    setBusy(true);
    setError(null);
    try {
      await onChange(productId, productName);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function createThenChoose(name: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not create the product");
      await load();
      await onChange(j.product.id, j.product.name);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const locked = disabled || busy;

  return (
    <div>
      {label && (
        <label className="label" style={compact ? { fontSize: 11 } : undefined}>
          {label}
        </label>
      )}
      {hint && !compact && (
        <p style={{ margin: "0 0 6px", color: "var(--text-faint)", fontSize: 12 }}>{hint}</p>
      )}

      <select
        className="select"
        style={{ width: "100%" }}
        value={value ?? ""}
        disabled={locked}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new__") {
            const name = prompt("Name the new product:")?.trim();
            /*
             * Put the select back before anything async: otherwise a cancelled
             * prompt leaves "New product…" showing as though it were selected.
             */
            e.currentTarget.value = value ?? "";
            if (name) void createThenChoose(name);
            return;
          }
          if (!v || v === value) return;
          const picked = products.find((x) => x.id === v);
          void choose(v, picked?.name ?? "");
        }}
      >
        {/*
          The empty option exists only while it is true. Left in the list it
          invites someone to pick it and wonder why nothing happens — there is
          no "no product" to move to.
        */}
        {!value && <option value="">{emptyLabel}</option>}
        {products.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}{x.total ? ` — ${x.total} item${x.total === 1 ? "" : "s"}` : ""}
          </option>
        ))}
        <option value="__new__">New product…</option>
      </select>

      {busy && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--text-faint)" }}>saving…</div>
      )}
      {error && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--danger)" }}>{error}</div>
      )}
    </div>
  );
}
