"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, PartThumb, Spinner, StatusBadge, relTime } from "@/components/ui";
import { PanelHeader, SignedOut, panelWrap } from "./shared";
import { ProductPicker } from "@/components/ProductPicker";

type Ctx = {
  documentId: string; elementId: string; partId: string; configuration: string;
  workspaceId: string; versionId: string; companyId: string; userId: string;
};

const wrap = panelWrap;

export function PanelClient({
  ctx, statuses, signedIn, search,
}: {
  ctx: Ctx; statuses: string[]; signedIn: boolean; search: string;
}) {
  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(signedIn && Boolean(ctx.partId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [remarks, setRemarks] = useState("");
  const [product, setProduct] = useState("");

  const load = useCallback(async () => {
    if (!signedIn || !ctx.partId) return;
    setLoading(true); setError(null);
    try {
      // Deliberately no sync=1: selecting a part must not enrol it in the MOS.
      // Creation happens when someone presses Sync to MOS, or on release.
      const p = new URLSearchParams({
        documentId: ctx.documentId, elementId: ctx.elementId, partId: ctx.partId,
        configuration: ctx.configuration,
      });
      if (ctx.workspaceId) p.set("workspaceId", ctx.workspaceId);
      if (ctx.versionId) p.set("versionId", ctx.versionId);

      const res = await fetch(`/api/items/lookup?${p}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lookup failed");

      setItem(data.item);
      setStatus(data.item?.status ?? "");
      setRemarks(data.item?.remarks ?? "");
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [ctx, signedIn]);

  useEffect(() => { load(); }, [load]);

  const [syncing, setSyncing] = useState(false);
  /**
   * Set when Onshape has us pointed at an assembly rather than a Part Studio.
   *
   * That used to be a dead end. It no longer is: an assembly is exactly what the
   * BOM importer wants, so the refusal offers the way through instead of just
   * explaining itself.
   */
  const [assemblyContext, setAssemblyContext] = useState(false);

  /** Bring this part into the MOS — the one path that allocates an MO number. */
  async function syncNow() {
    setSyncing(true); setError(null); setNotice(null);
    try {
      const p = new URLSearchParams({
        documentId: ctx.documentId, elementId: ctx.elementId, partId: ctx.partId,
        configuration: ctx.configuration, sync: "1",
      });
      if (ctx.workspaceId) p.set("workspaceId", ctx.workspaceId);
      if (ctx.versionId) p.set("versionId", ctx.versionId);
      if (product) p.set("product", product);

      const res = await fetch(`/api/items/lookup?${p}`);
      const data = await res.json();
      if (res.status === 409) {
        setAssemblyContext(true);
        throw new Error(data.error || "This is not a Part Studio part");
      }
      if (!res.ok) throw new Error(data.error || "Sync failed");

      setItem(data.item);
      setStatus(data.item?.status ?? "");
      setRemarks(data.item?.remarks ?? "");
      setNotice(`Created ${data.item?.moNumber}.`);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setSyncing(false);
    }
  }

  async function save() {
    if (!item) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const res = await fetch(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, remarks, push: !item?.writeBackBlocked }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");

      if (item?.writeBackBlocked) setNotice("Saved in the MOS.");
      else if (data.push && !data.push.ok) setError(`Saved, but the push failed: ${data.push.error}`);
      else setNotice("Saved and pushed to Onshape.");
      await load();
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setSaving(false);
    }
  }

  /* ------------------------------- gate states ------------------------------ */

  if (!signedIn) {
    return <SignedOut />;
  }

  if (!ctx.partId) {
    return (
      <div style={wrap}>
        <PanelHeader />
        <p style={{ color: "var(--text-muted)", margin: 0, lineHeight: 1.55 }}>
          Select a part to see its manufacturing order.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ ...wrap, alignContent: "center", justifyContent: "center", justifyItems: "center", color: "var(--text-muted)" }}>
        <Spinner size={18} />
        <span style={{ fontSize: 12 }}>Syncing with Onshape…</span>
      </div>
    );
  }

  /* --------------------------------- content -------------------------------- */

  const dirty = item && (status !== (item.status ?? "") || remarks !== (item.remarks ?? ""));

  const bomParams = new URLSearchParams({ documentId: ctx.documentId, elementId: ctx.elementId });
  if (ctx.workspaceId) bomParams.set("workspaceId", ctx.workspaceId);
  if (ctx.versionId) bomParams.set("versionId", ctx.versionId);
  const bomHref = `/bom?${bomParams}`;

  return (
    <div style={wrap}>
      <PanelHeader />

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {!item ? (
        <>
          <div
            style={{
              background: "var(--surface)", border: "1px dashed var(--border-strong)",
              borderRadius: 8, padding: 13, textAlign: "center",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>
              {assemblyContext ? "This is an assembly" : "Not tracked in the MOS"}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {assemblyContext
                ? "Manufacturing orders belong to parts. Read its bill of materials to order everything it is built from."
                : "This part has no manufacturing order. Syncing allocates an MO number and writes it back onto the part."}
            </div>
          </div>
          {!assemblyContext && (
            <div>
              <label className="label">Product</label>
              <ProductPicker value={product} onChange={setProduct} useProjectOption />
            </div>
          )}
          {assemblyContext ? (
            <a className="btn btn-primary" href={bomHref} target="_blank" rel="noopener noreferrer">
              Explode this assembly&apos;s BOM ↗
            </a>
          ) : (
            <button className="btn btn-primary" onClick={syncNow} disabled={syncing}>
              {syncing && <Spinner />} Sync to MOS
            </button>
          )}
          <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0, lineHeight: 1.5 }}>
            {assemblyContext
              ? "Importing the BOM raises one manufacturing order per part, with quantities from the model."
              : "Parts are also brought in automatically when they are released in Onshape."}
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
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <PartThumb itemId={item.id} size={46} alt={item.partName || "Part"} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="mono" style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-.01em" }}>
                  {item.moNumber || "No MO number"}
                </div>
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 2 }}>
              {item.partName}
              {item.partNumber && <span className="mono"> · {item.partNumber}</span>}
              {item.revision && <span className="mono"> · Rev {item.revision}</span>}
            </div>
              </div>
            </div>
            <div style={{ marginTop: 8 }}><StatusBadge status={item.status} /></div>
          </div>

          {item.writeBackBlocked ? (
            <Alert kind="info">
              Tracked in the MOS only — the MO number cannot be written onto this part.
            </Alert>
          ) : item.pushPending && item.lastPushError ? (
            <Alert kind="warn">{item.lastPushError}</Alert>
          ) : null}

          <div>
            <label className="label">Status</label>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className="label">Remarks</label>
            <textarea
              className="textarea" rows={4} value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Manufacturing notes…"
            />
          </div>

          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving && <Spinner />} {item?.writeBackBlocked ? "Save" : "Save & push to Onshape"}
          </button>

          <div
            style={{
              borderTop: "1px solid var(--border)", paddingTop: 9,
              fontSize: 11, color: "var(--text-faint)", lineHeight: 1.6,
            }}
          >
            <div>Product: {item.productName || "—"}</div>
            <div>Material: {item.material || "—"}</div>
            <div>Project: {item.project || "—"}</div>
            <div>Onshape state: {item.onshapeState || "—"}</div>
            <div style={{ marginTop: 4 }}>
              Pulled {relTime(item.lastSyncedFromOnshapeAt)} · pushed {relTime(item.lastPushedToOnshapeAt)}
            </div>
          </div>

          <a
            className="btn btn-sm"
            href={`/items/${item.id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open full record ↗
          </a>
        </>
      )}
    </div>
  );
}
