"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Field, KV, PartThumb, Spinner, StatusBadge, relTime } from "@/components/ui";
import { ProductPicker } from "@/components/ProductPicker";
import { formatArea, formatCentroidMm, formatMass, formatVolume } from "@/lib/onshape/mass-properties";

type ExportFormat = {
  id: string; label: string; purpose: string; extension: string; async: boolean;
};

type MassProperties = {
  hasMass: boolean;
  massKg: number | null;
  volumeM3: number | null;
  centroidM: [number, number, number] | null;
  surfaceAreaM2: number | null;
};

type Log = {
  id: string; direction: string; action: string; trigger: string;
  message: string; changes: any; ok: boolean; createdAt: string;
};

export function ItemDetail({ itemId, statuses, facilities = [] }: { itemId: string; statuses: string[]; facilities?: string[] }) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [item, setItem] = useState<any>(null);
  const [onshapeUrl, setOnshapeUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [formats, setFormats] = useState<ExportFormat[]>([]);
  const [exporting, setExporting] = useState<string | null>(null);
  const [mass, setMass] = useState<MassProperties | null>(null);
  const [massLoading, setMassLoading] = useState(false);
  const [massError, setMassError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Local form state, kept separate so edits are not clobbered by refetches.
  const [status, setStatus] = useState("");
  const [remarks, setRemarks] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [dueDate, setDueDate] = useState("");
  const [product, setProduct] = useState("");
  const [manufacturedBy, setManufacturedBy] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/items/${itemId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load item");
      setItem(data.item);
      setOnshapeUrl(data.onshapeUrl ?? null);
      setLogs(data.logs);
      setStatus(data.item.status ?? "");
      setRemarks(data.item.remarks ?? "");
      setQuantity(data.item.quantity ?? 1);
      setDueDate(data.item.dueDate ? String(data.item.dueDate).slice(0, 10) : "");
      setProduct(data.item.productName || "Unassigned");
      setManufacturedBy(data.item.manufacturedBy ?? "");
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch(`/api/items/${itemId}/export`)
      .then((r) => r.json())
      .then((d) => setFormats(d.formats ?? []))
      .catch(() => {});
  }, [itemId]);

  /**
   * Download the part in one of Onshape's neutral formats.
   *
   * Fetched rather than linked, so a failure lands in the page as a readable
   * message instead of dumping JSON into a new tab — and so the wait can show a
   * spinner, which matters when Onshape has to run a translation job first.
   */
  /** Fetched on request — see the note on the API route for why it is not automatic. */
  async function loadMassProperties() {
    setMassLoading(true); setMassError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/mass-properties`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not read mass properties");
      setMass(data);
    } catch (err: any) {
      setMassError(String(err.message ?? err));
    } finally {
      setMassLoading(false);
    }
  }

  async function exportAs(f: ExportFormat) {
    setExporting(f.id); setError(null); setNotice(null);
    try {
      const res = await fetch(`/api/items/${itemId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: f.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Export to ${f.label} failed`);
      }

      const blob = await res.blob();
      const filename = res.headers.get("X-MOS-Filename") || `part.${f.extension}`;
      const secs = Number(res.headers.get("X-MOS-Elapsed-Ms") || 0) / 1000;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick: revoking immediately cancels the download in
      // some browsers before it has started.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      setNotice(
        `${filename} downloaded — ${Math.max(1, Math.round(blob.size / 1024))} KB` +
        (secs >= 1 ? `, ${secs.toFixed(1)}s` : "") + "."
      );
      await load();
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setExporting(null);
    }
  }

  async function save() {
    setSaving(true); setError(null); setNotice(null);
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status, remarks, quantity: Number(quantity),
          dueDate: dueDate || null, product, manufacturedBy,
          // No point attempting a write this part is known to refuse.
          push: !item?.writeBackBlocked,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");

      if (item?.writeBackBlocked) {
        setNotice("Saved in the MOS. This part takes no write-back to Onshape.");
      } else if (data.push && !data.push.ok) {
        setError(`Saved in the MOS, but the push to Onshape failed: ${data.push.error}`);
      } else {
        const n = Object.keys(data.push?.written ?? {}).length;
        setNotice(`Saved. ${n} propert${n === 1 ? "y" : "ies"} written back to Onshape.`);
      }
      await load();
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setSaving(false);
    }
  }

  async function action(kind: "push" | "pull") {
    setBusy(kind); setError(null); setNotice(null);
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${kind} failed`);

      if (kind === "push") {
        if (!data.push.ok) throw new Error(data.push.error);
        setNotice("Pushed MOS fields to Onshape.");
      } else {
        setNotice(
          data.pull.action === "unchanged"
            ? "Pulled from Onshape — nothing had changed."
            : `Pulled from Onshape — ${Object.keys(data.pull.changes).length} field(s) updated.`
        );
      }
      await load();
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(force = false) {
    setDeleting(true); setError(null);
    try {
      const res = await fetch(`/api/items/${itemId}${force ? "?force=1" : ""}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed");
      router.push("/dashboard");
      router.refresh();
    } catch (err: any) {
      setError(String(err.message ?? err));
      setDeleting(false);
    }
  }

  if (loading) {
    return <div style={{ padding: 44, textAlign: "center", color: "var(--text-muted)" }}><Spinner size={18} /></div>;
  }
  if (!item) return <Alert kind="error">Item not found.</Alert>;

  const dirty =
    status !== (item.status ?? "") ||
    remarks !== (item.remarks ?? "") ||
    Number(quantity) !== (item.quantity ?? 1) ||
    dueDate !== (item.dueDate ? String(item.dueDate).slice(0, 10) : "") ||
    product !== (item.productName || "Unassigned") ||
    manufacturedBy !== (item.manufacturedBy ?? "");

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <Link href="/dashboard" className="link" style={{ fontSize: 12.5 }}>← Manufacturing Items</Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" }}>
          <h1 className="mono" style={{ fontSize: 22, margin: 0, letterSpacing: "-.01em", fontWeight: 700 }}>
            {item.moNumber || "No MO number"}
          </h1>
          <StatusBadge status={item.status} />
          <span style={{ color: "var(--text-muted)", fontSize: 14 }}>{item.partName}</span>
          <div style={{ flex: 1 }} />
          {onshapeUrl && (
            <a
              className="btn btn-sm"
              href={onshapeUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Opens the Part Studio containing this part"
            >
              Open in Onshape ↗
            </a>
          )}
        </div>
      </div>

      {error && (
        <Alert kind="error" onDismiss={() => setError(null)}>
          <div>{error}</div>
          {/* The delete path refuses to strand a stale MO number in CAD, so it
              needs an explicit override for parts already gone from Onshape. */}
          {error.includes("Could not clear the MO properties") && (
            <button
              className="btn btn-sm btn-danger"
              style={{ marginTop: 9 }}
              onClick={() => remove(true)}
              disabled={deleting}
            >
              {deleting && <Spinner />} Delete anyway, without clearing Onshape
            </button>
          )}
        </Alert>
      )}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {item.writeBackBlocked && !error && (
        <Alert kind="info">
          <strong>This part is tracked in the MOS only.</strong> {item.writeBackBlocked}{" "}
          Everything here — status, quantity, remarks, due date — works as normal; the MO number
          simply does not appear on the part in Onshape.
        </Alert>
      )}
      {item.pushPending && item.lastPushError && !error && (
        <Alert kind="warn">
          <strong>Push to Onshape pending.</strong> {item.lastPushError}
        </Alert>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,340px)", gap: 16, alignItems: "start" }}>
        {/* ------------------------------- editable ------------------------------ */}
        <div style={{ display: "grid", gap: 16 }}>
          <section className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
              <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>Manufacturing Order</h2>
              <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                Owned by the MOS · {item.writeBackBlocked ? "not written to Onshape" : "pushed to Onshape"}
              </span>
            </div>

            <div style={{ display: "grid", gap: 14 }}>
              <Field
                label="Product"
                hint="Follows the Onshape Project property when one is set on the part. Changing it here holds until the next sync from Onshape sees a different Project value."
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <ProductPicker value={product} onChange={setProduct} />
                  </div>
                  {item.productId && (
                    <Link
                      className="link" style={{ fontSize: 12, whiteSpace: "nowrap" }}
                      href={`/dashboard?product=${item.productId}`}
                    >
                      View other parts in this product →
                    </Link>
                  )}
                </div>
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 150px", gap: 12 }}>
                <Field label="Status">
                  <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                    {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Field>
                <Field label="Quantity">
                  <input
                    className="input" type="number" min={0} value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                  />
                </Field>
                <Field label="Due date">
                  <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </Field>
              </div>

              {facilities.length > 0 && (
                <Field label="Manufactured by" hint="A plant, division or vendor from the enterprise's list in Settings. MOS-only — there is no Onshape property to write this back to.">
                  <select
                    className="select" value={manufacturedBy}
                    onChange={(e) => setManufacturedBy(e.target.value)}
                  >
                    <option value="">Not yet decided</option>
                    {facilities.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </Field>
              )}

              <Field
                label="Remarks"
                hint={
                  item.writeBackBlocked
                    ? "Free text for the manufacturing team. Kept in the MOS only for this part."
                    : "Free text for the manufacturing team. Written to the MO Remarks property in Onshape."
                }
              >
                <textarea
                  className="textarea" value={remarks} rows={4}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Tooling notes, supplier constraints, deviations…"
                />
              </Field>

              <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
                  {saving && <Spinner />} {item?.writeBackBlocked ? "Save" : "Save & push to Onshape"}
                </button>
                <button
                  className="btn"
                  onClick={() => action("push")}
                  disabled={busy !== null || Boolean(item.writeBackBlocked)}
                  title={item.writeBackBlocked ? "This part cannot be written to in Onshape." : undefined}
                >
                  {busy === "push" && <Spinner />} Re-push
                </button>
                <button className="btn" onClick={() => action("pull")} disabled={busy !== null}>
                  {busy === "pull" && <Spinner />} Pull from Onshape
                </button>
                {dirty && <span style={{ fontSize: 12, color: "var(--warn)" }}>Unsaved changes</span>}
              </div>
            </div>
          </section>

          <section className="card" style={{ padding: 18 }}>
            <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Sync history</h2>
            <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "0 0 12px" }}>
              Most recent 25 events for this item.
            </p>

            {logs.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>Nothing recorded yet.</p>
            ) : (
              <div style={{ display: "grid", gap: 1 }}>
                {logs.map((l) => (
                  <div
                    key={l.id}
                    style={{
                      display: "flex", gap: 11, padding: "9px 0",
                      borderBottom: "1px solid var(--border)", fontSize: 12.5, alignItems: "flex-start",
                    }}
                  >
                    <span
                      className="badge"
                      style={{
                        background: l.ok ? "var(--surface-2)" : "var(--danger-soft)",
                        color: l.ok ? "var(--text-muted)" : "var(--danger)",
                        borderColor: l.ok ? "var(--border)" : "var(--danger)",
                        minWidth: 108, justifyContent: "center", flexShrink: 0,
                      }}
                      title={l.direction}
                    >
                      {l.direction === "onshape->mos" ? "↓ Onshape" : "↑ MOS"} · {l.action}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>{l.message}</div>
                      {l.changes && (
                        <div className="mono" style={{ color: "var(--text-faint)", fontSize: 11, marginTop: 3, wordBreak: "break-word" }}>
                          {Object.entries(l.changes).map(([k, v]: [string, any]) =>
                            v && typeof v === "object" && "from" in v
                              ? `${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`
                              : `${k} = ${JSON.stringify(v)}`
                          ).join("   ")}
                        </div>
                      )}
                    </div>
                    <span style={{ color: "var(--text-faint)", fontSize: 11, flexShrink: 0 }}>
                      {relTime(l.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
              <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>Mass properties</h2>
              {mass && (
                <button className="btn btn-sm" onClick={loadMassProperties} disabled={massLoading}>
                  {massLoading && <Spinner />} Refresh
                </button>
              )}
            </div>
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
              Mass, volume and centroid, read from the part&apos;s geometry in Onshape. Mass needs a
              material assigned to the part — without one, Onshape has a shape but no density to
              weigh it with.
            </p>

            {massError && (
              <Alert kind="error" onDismiss={() => setMassError(null)}>{massError}</Alert>
            )}

            {!mass && !massError && (
              <button className="btn btn-primary" onClick={loadMassProperties} disabled={massLoading}>
                {massLoading && <Spinner />} Load mass properties
              </button>
            )}

            {mass && (
              <div style={{ display: "grid", gap: 1 }}>
                {!mass.hasMass && (
                  <Alert kind="info">
                    No material is assigned to this part in Onshape, so mass cannot be computed.
                    Volume and centroid come from geometry alone and do not need one.
                  </Alert>
                )}
                <KV k="Mass" v={mass.hasMass && mass.massKg != null ? formatMass(mass.massKg) : "— no material"} mono={mass.hasMass} />
                <KV k="Volume" v={mass.volumeM3 != null ? formatVolume(mass.volumeM3) : "—"} mono />
                <KV k="Surface area" v={mass.surfaceAreaM2 != null ? formatArea(mass.surfaceAreaM2) : "—"} mono />
                <KV k="Centroid" v={mass.centroidM ? formatCentroidMm(mass.centroidM) : "—"} mono />
              </div>
            )}
          </section>

          {formats.length > 0 && (
            <section className="card" style={{ padding: 18 }}>
              <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Export the part</h2>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
                Download this part&apos;s geometry from Onshape in a neutral format, to send to a
                supplier or open in CAM. The file is generated on request, so it always matches the
                part as it stands now.
              </p>

              <div style={{ display: "grid", gap: 7 }}>
                {formats.map((f) => (
                  <div
                    key={f.id}
                    style={{
                      display: "flex", gap: 12, alignItems: "center",
                      padding: "9px 11px", border: "1px solid var(--border)", borderRadius: 8,
                      background: "var(--surface-2)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {f.label}
                        <span className="mono" style={{ color: "var(--text-faint)", fontWeight: 400, fontSize: 11.5 }}>
                          {" "}.{f.extension}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
                        {f.purpose}
                        {f.async && (
                          <span style={{ color: "var(--text-faint)" }}>
                            {" "}· Onshape translates this one, so it takes a few seconds
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      className="btn btn-sm"
                      onClick={() => exportAs(f)}
                      disabled={exporting !== null}
                      style={{ flexShrink: 0 }}
                    >
                      {exporting === f.id && <Spinner />}
                      {exporting === f.id ? (f.async ? "Translating…" : "Downloading…") : "Download"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="card" style={{ padding: 18, borderColor: "var(--danger)" }}>
            <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650, color: "var(--danger)" }}>
              Delete this item
            </h2>
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 12px", lineHeight: 1.55 }}>
              Blanks MO Number, MO Status and MO Remarks on the part in Onshape, then removes the MOS
              record. <strong>{item.moNumber}</strong> is not reused — if Onshape reports this part
              again it is treated as new and gets a fresh number.
            </p>

            {!confirmDelete ? (
              <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                Delete {item.moNumber}
              </button>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                <Alert kind="warn">
                  Permanently delete <strong>{item.moNumber}</strong> ({item.partName})? This cannot be
                  undone.
                </Alert>
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  <button className="btn btn-danger" onClick={() => remove(false)} disabled={deleting}>
                    {deleting && <Spinner />} Yes, delete
                  </button>
                  <button className="btn" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                    Cancel
                  </button>
                </div>
                <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: 0, lineHeight: 1.5 }}>
                  If Onshape cannot be reached the item is kept, so a stale MO number is never left
                  behind in CAD. Use <em>Delete anyway</em> from the error if the part no longer exists.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* ------------------------------ from Onshape --------------------------- */}
        <div style={{ display: "grid", gap: 16 }}>
          <section className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
              <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>From Onshape</h2>
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>read-only</span>
            </div>

            <div style={{ marginBottom: 14 }}>
              <PartThumb itemId={itemId} size={276} radius={9} alt={item.partName || "Part"} />
            </div>
            <KV k="Part name" v={item.partName} />
            <KV k="Part number" v={item.partNumber} mono />
            <KV k="Revision" v={item.revision} mono />
            <KV k="Description" v={item.description} />
            <KV k="Material" v={item.material} />
            <KV k="Onshape state" v={item.onshapeState} />
            <KV k="Vendor" v={item.vendor} />
            <KV k="Project" v={item.project} />
            <KV
              k="Revision shown"
              v={
                item.revision ? (
                  <span>
                    {item.revision}
                    <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                      {" "}— the last release the MOS saw. It is kept even while the designer works
                      on the next one, and advances when a newer revision is released.
                    </span>
                  </span>
                ) : (
                  <span style={{ color: "var(--text-faint)" }}>
                    None yet — this part has not been released.
                  </span>
                )
              }
            />
            <KV k="Document" v={item.documentName} />
            <KV k="Element" v={item.elementName} />
            {item.sourceAssembly?.elementId && (
              <KV
                k="From assembly"
                v={
                  <span style={{ display: "inline-flex", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
                    <Link className="link" href={`/dashboard?assembly=${item.sourceAssembly.elementId}`}>
                      {item.sourceAssembly.elementName || "Assembly"}
                    </Link>
                    <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
                      uses {item.sourceAssembly.quantityInAssembly ?? 1}
                    </span>
                  </span>
                }
              />
            )}
            <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--text-faint)" }}>
              Last pulled {relTime(item.lastSyncedFromOnshapeAt)} · last pushed {relTime(item.lastPushedToOnshapeAt)}
            </div>
          </section>

          <section className="card" style={{ padding: 18 }}>
            <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Used in</h2>
            <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "0 0 12px", lineHeight: 1.5 }}>
              Assemblies this part is known to appear in, from BOM imports. Only imports know this —
              a part synced on its own from the panel has none here until an assembly containing it
              is imported.
            </p>
            {(item.usedIn ?? []).length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                Not known to be used in any assembly yet.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 1 }}>
                {(item.usedIn ?? []).map((u: any) => (
                  <div
                    key={u.elementId}
                    style={{
                      display: "flex", gap: 10, alignItems: "baseline", padding: "6px 0", fontSize: 12.5,
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <Link className="link" href={`/dashboard?assembly=${u.elementId}`} style={{ flex: 1, minWidth: 0 }}>
                      {u.elementName || "Assembly"}
                    </Link>
                    <span className="mono" style={{ color: "var(--text-muted)" }}>×{u.quantity}</span>
                    <span style={{ color: "var(--text-faint)", fontSize: 11, flexShrink: 0 }}>
                      {relTime(u.lastImportedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Every property Onshape returned. A field showing blank above but
              present here means the name did not match — send it over and the
              alias list in standard-properties.ts can be extended. */}
          <section className="card" style={{ padding: 18 }}>
            <details>
              <summary style={{ fontSize: 14, fontWeight: 650, cursor: "pointer" }}>
                All Onshape properties{" "}
                <span style={{ color: "var(--text-faint)", fontWeight: 400, fontSize: 12 }}>
                  ({(item.onshapeProperties ?? []).length})
                </span>
              </summary>
              <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "8px 0 10px", lineHeight: 1.5 }}>
                Exactly what Onshape returned for this part, names included. Where a value was a
                code the MOS translated, the original is shown beside it as <code>raw</code>.
              </p>
              {(item.onshapeProperties ?? []).length === 0 ? (
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                  Nothing recorded yet — re-sync with “Pull from Onshape”.
                </p>
              ) : (
                <div style={{ display: "grid", gap: 1 }}>
                  {(item.onshapeProperties ?? []).map((p: any) => (
                    <div
                      key={p.propertyId}
                      style={{
                        display: "flex", gap: 10, padding: "5px 0", fontSize: 12,
                        borderBottom: "1px solid var(--border)",
                      }}
                    >
                      <span style={{ color: "var(--text-muted)", minWidth: 110, flexShrink: 0 }}>
                        {p.name || <em style={{ color: "var(--danger)" }}>unnamed</em>}
                      </span>
                      <span style={{ wordBreak: "break-word", minWidth: 0 }}>
                        {p.value === null || p.value === "" || p.value === undefined
                          ? <span style={{ color: "var(--text-faint)" }}>—</span>
                          : String(p.value)}
                        {p.raw !== null && p.raw !== undefined && p.raw !== "" && (
                          <span
                            className="mono"
                            style={{ color: "var(--text-faint)", fontSize: 11, marginLeft: 6 }}
                            title="The code Onshape sent, before the MOS named it"
                          >
                            raw: {typeof p.raw === "object" ? JSON.stringify(p.raw) : String(p.raw)}
                          </span>
                        )}
                        {Array.isArray(p.options) && p.options.length > 0 && (
                          <div
                            className="mono"
                            style={{ color: "var(--text-faint)", fontSize: 10.5, marginTop: 2, lineHeight: 1.5 }}
                            title="Every choice Onshape offered for this property"
                          >
                            options: {p.options
                              .map((o: any) =>
                                o && typeof o === "object"
                                  ? `${JSON.stringify(o.value)}→${o.label ?? "?"}`
                                  : String(o)
                              )
                              .join("  ")}
                          </div>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </details>
          </section>

          <section className="card" style={{ padding: 18 }}>
            <h2 style={{ fontSize: 14, margin: "0 0 10px", fontWeight: 650 }}>Onshape identity</h2>
            <KV k="Document ID" v={item.documentId} mono />
            <KV k="Element ID" v={item.elementId} mono />
            <KV k="Part ID" v={item.partId} mono />
            <KV k="Configuration" v={item.configuration} mono />
            <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "10px 0 0", lineHeight: 1.5 }}>
              This quadruple is the sync key. Part numbers and names can change without breaking the link.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
