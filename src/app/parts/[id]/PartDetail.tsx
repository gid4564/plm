"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { ProductField } from "@/components/ProductField";
import { useRouter } from "next/navigation";
import { Alert, FavoriteButton, KV, PartThumb, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";
import { AttributeInput, type Definition } from "@/components/AttributeInput";
import { PartTasks, TaskCountBadge, type PartTask } from "@/components/PartTasks";
import { StarReleaseDialog } from "@/components/StarReleaseDialog";
import { SetInitialRevisionDialog } from "@/components/SetInitialRevisionDialog";
/*
 * Lazily, and never on the server: the viewer registers a custom element and
 * pulls in a ~460KB library, so only a reader who opens a model pays for it.
 */
const ModelViewer = dynamic(
  () => import("@/components/ModelViewer").then((m) => m.ModelViewer),
  { ssr: false, loading: () => null }
);

type Data = {
  part: any;
  definitions: Definition[];
  missingForRelease: string[];
  structure: { children: any[]; usedIn: any[] };
  variants: { id: string; parentPartId: string; name: string; description: string; order: number }[];
  iterations: any[];
  drawings: any[];
  release: { id: string; number: string; state: string } | null;
  onshapeUrl: string | null;
  logs: any[];
  tasks: PartTask[];
  openTaskCount: number;
  geometry: {
    id: string; revision: string; size: number; contentType: string;
    onshapeVersionId: string | null; releaseId: string | null;
    capturedAt: string | null; failureReason: string | null;
  }[];
  starReleases: any[];
};

export function PartDetail({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Which captured revision the viewer is showing. Empty means the newest. */
  const [viewRevision, setViewRevision] = useState<string>("");

  /** Pending edits, keyed by attribute. Empty means nothing is dirty. */
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [mass, setMass] = useState<any>(null);
  const [starDialog, setStarDialog] = useState<
    null | { swapTarget: { bomLinkId: string; number: string | null; name: string } | null }
  >(null);
  const [initialRevisionOpen, setInitialRevisionOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/parts/${id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load this part");
      setData(j);
      setDraft({});
      setFieldErrors({});
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return <div className="card" style={{ padding: 40, textAlign: "center" }}><Spinner size={20} /></div>;
  }
  if (!data) {
    return <Alert kind="error">{error ?? "Not found"}</Alert>;
  }

  const p = data.part;
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    setSaving(true);
    setFieldErrors({});
    setNotice(null);
    try {
      const r = await fetch(`/api/parts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: draft }),
      });
      const j = await r.json();

      if (r.status === 422 && j.errors) {
        // Per-field, because a governance refusal is about one attribute and
        // has a reason worth reading next to it.
        setFieldErrors(j.errors);
        return;
      }
      if (!r.ok) throw new Error(j.error || "Could not save");

      const push = j.push;
      setNotice(
        j.changed
          ? `Saved as iteration ${j.part.iteration}.` +
            (push?.ok
              ? ` ${Object.keys(push.written ?? {}).length} value(s) written to Onshape.`
              : push?.error
                ? ` Onshape was not updated: ${push.error}`
                : "")
          : "Nothing had changed."
      );
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function act(action: string) {
    setBusy(action);
    setNotice(null);
    try {
      const r = await fetch(`/api/parts/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");

      if (action === "pull") {
        const n = Object.keys(j.pull?.changes ?? {}).length;
        setNotice(n ? `Re-read from Onshape: ${n} value(s) changed.` : "Re-read from Onshape: nothing had changed.");
      } else if (action === "push") {
        setNotice(j.push?.ok ? "Written to Onshape." : `Onshape refused the write: ${j.push?.error}`);
      } else if (action === "obsolete") {
        setNotice("Obsoleted.");
      }
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  /** Re-export one revision's 3D model, in place. */
  async function recaptureGeometry(revision: string) {
    const key = `recapture:${revision}`;
    setBusy(key);
    setNotice(null);
    try {
      const r = await fetch(`/api/parts/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recapture-geometry", revision }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work");
      const cap = j.recapture;
      setNotice(
        cap?.ok
          ? `Recaptured the 3D model (${(cap.bytes / 1024).toFixed(0)} KB).`
          : `Could not recreate it: ${cap?.reason ?? "unknown reason"}`
      );
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Move this part into a product.
   *
   * Creating one is handled by the picker; this only ever receives an id.
   */
  async function setProduct(productId: string) {
    if (!productId || productId === p.productId) return;
    const r = await fetch(`/api/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "assign", partIds: [id] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not change the product");
    setNotice(j.message ?? "Product changed.");
    await load();
  }

  async function loadMass() {
    setBusy("mass");
    try {
      const r = await fetch(`/api/parts/${id}/mass-properties`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Onshape could not measure this part");
      setMass(j);
      /*
       * The reading is now stored on the part's Mass attribute, so the
       * attributes panel above is stale until the part is re-read. Reloading is
       * cheaper than telling somebody to refresh, and a page showing two
       * different masses for one part is the kind of thing that costs trust.
       */
      if (j?.stored?.written) {
        setNotice(
          `Mass ${j.stored.was == null ? "recorded as" : `updated to`} ` +
          `${j.stored.now} ${j.stored.unit}.`
        );
        await load();
      } else if (j?.stored?.why) {
        setNotice(`Measured, but not stored: ${j.stored.why}`);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(force = false) {
    const msg = force
      ? `Permanently delete ${p.number} (${p.lifecycleState}${p.revision ? `, revision ${p.revision}` : ""}) from PLM? ` +
        `This bypasses obsoleting, removes its history and its structure links in every assembly, and cannot be undone.`
      : `Remove ${p.number} from PLM? Its PLM values will be cleared in Onshape.`;
    if (!confirm(msg)) return;
    setBusy("delete");
    try {
      const r = await fetch(`/api/parts/${id}${force ? "?force=1" : ""}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not remove this part");
      router.push("/dashboard");
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(null);
    }
  }

  /** Copy this part to a new, PLM-only one and go straight there. */
  async function copyThis() {
    setBusy("copy");
    setError(null);
    try {
      const r = await fetch(`/api/parts/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "copy" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not copy this part");
      router.push(`/parts/${j.copy.id}`);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(null);
    }
  }

  // Grouped in the order the schema declares, so an admin's grouping and
  // ordering is what a reader sees.
  const groups: { name: string; defs: Definition[] }[] = [];
  for (const d of data.definitions) {
    const name = d.group || "Other";
    const g = groups.find((x) => x.name === name);
    if (g) g.defs.push(d);
    else groups.push({ name, defs: [d] });
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        <PartThumb partId={id} size={64} radius={8} alt="" />
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <FavoriteButton kind="part" targetId={id} active={Boolean(p.isFavorite)} size={20} />
            <h1 className="mono" style={{ margin: 0, fontSize: 19 }}>{p.number ?? "—"}</h1>
            <RevChip
              revision={p.revision} iteration={p.iteration} starCount={p.starCount}
              starReasons={data.starReleases.map(
                (s: any) => `${s.baseRevision}${"*".repeat(s.starIndex)}: ${s.reason}`
              )}
            />
            <StatusBadge status={p.lifecycleState} />
            {p.kind === "assembly" && <span className="badge">assembly</span>}
            {p.plmOnly && (
              <span className="badge" title="Created by copying another part — no Onshape original backs this one">
                PLM only
              </span>
            )}
            {p.revision ? (
              <button
                className="btn btn-sm"
                onClick={() => setStarDialog({ swapTarget: null })}
                title="A form-fit-function equivalent swap, or a metadata/cosmetic note — no new revision, nothing sent to Onshape"
              >
                ★ Register star release
              </button>
            ) : isAdmin && (
              /*
               * The escape hatch for something released before PLM tracked
               * it, or released in Onshape with no PLM release ever taken
               * over — star release has no revision to attach to without
               * this. See lib/star-release.ts.
               */
              <button
                className="btn btn-sm"
                onClick={() => setInitialRevisionOpen(true)}
                title="Record that this is already released outside PLM's own workflow, so star releases work from here"
              >
                Set initial revision…
              </button>
            )}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 3 }}>{p.name}</div>
          <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 2 }}>
            {p.documentName}{p.elementName ? ` · ${p.elementName}` : ""}
            {" · "}
            {/*
              The product is shown beside the Onshape location because the two
              answer the same kind of question — where does this live — and
              people look for both in the same glance. It is a link, not a
              label: from a part, the most likely next thing is its siblings.
            */}
            {p.productId ? (
              <Link href={`/dashboard?product=${p.productId}`} style={{ color: "var(--accent)" }}>
                {p.productName || "product"}
              </Link>
            ) : (
              <span style={{ color: "var(--text-faint)" }}>not filed to a product</span>
            )}
            {p.partIdInOnshape ? ` · part ${p.partIdInOnshape}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {data.onshapeUrl && (
            <a className="btn" href={data.onshapeUrl} target="_blank" rel="noreferrer">Open in Onshape</a>
          )}
          {!p.plmOnly && (
            <button className="btn" onClick={() => act("pull")} disabled={busy === "pull"}>
              {busy === "pull" ? <Spinner /> : "Re-read from Onshape"}
            </button>
          )}
          <button
            className="btn" onClick={copyThis} disabled={busy === "copy"}
            title="Create a new, PLM-only part with the same attributes — a fresh number, no Onshape link"
          >
            {busy === "copy" ? <Spinner /> : "Copy"}
          </button>
          {p.pushPending && (
            <button className="btn" onClick={() => act("push")} disabled={busy === "push"}>
              {busy === "push" ? <Spinner /> : "Retry write"}
            </button>
          )}
          {isAdmin && p.lifecycleState === "Released" && (
            <button className="btn" onClick={() => act("obsolete")} disabled={busy === "obsolete"}>
              {busy === "obsolete" ? <Spinner /> : "Obsolete"}
            </button>
          )}
          {p.lifecycleState !== "Released" && p.lifecycleState !== "Obsolete" && (
            <button className="btn btn-danger" onClick={() => remove()} disabled={busy === "delete"}>
              {busy === "delete" ? <Spinner /> : "Remove"}
            </button>
          )}
          {isAdmin && (p.lifecycleState === "Released" || p.lifecycleState === "Obsolete") && (
            <button
              className="btn btn-danger" onClick={() => remove(true)} disabled={busy === "delete"}
              title="Admin only — delete this part outright, without obsoleting it"
            >
              {busy === "delete" ? <Spinner /> : "Delete permanently"}
            </button>
          )}
        </div>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {data.release && (
        <Alert kind={data.release.state === "Under Review" ? "warn" : "info"}>
          This part is in release{" "}
          <Link href={`/releases/${data.release.id}`} style={{ color: "inherit", fontWeight: 600 }}>
            {data.release.number}
          </Link>
          , which is {data.release.state.toLowerCase()}.
        </Alert>
      )}

      {p.writeBackBlocked && (
        <Alert kind="info">
          <strong>Nothing is written to Onshape for this part.</strong> {p.writeBackBlocked}
        </Alert>
      )}
      {p.pushPending && p.lastPushError && (
        <Alert kind="warn"><strong>A write to Onshape is outstanding.</strong> {p.lastPushError}</Alert>
      )}

      {data.missingForRelease.length > 0 && p.lifecycleState !== "Released" && (
        <Alert kind="warn">
          <strong>Not ready to release.</strong> These attributes must hold a value first:{" "}
          {data.missingForRelease.join(", ")}.
        </Alert>
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
        {/* ------------------------------- Attributes -------------------------- */}
        <div className="card" style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>Attributes</h2>
            <div style={{ flex: 1 }} />
            {dirty && (
              <>
                <button className="btn btn-sm" onClick={() => { setDraft({}); setFieldErrors({}); }}>
                  Discard
                </button>
                <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                  {saving ? <Spinner /> : "Save"}
                </button>
              </>
            )}
          </div>

          {groups.map((g) => (
            <div key={g.name} style={{ display: "grid", gap: 10 }}>
              <div
                style={{
                  fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em",
                  color: "var(--text-faint)", borderBottom: "1px solid var(--border)", paddingBottom: 4,
                }}
              >
                {g.name}
              </div>
              {g.defs.map((d) => (
                <AttributeInput
                  key={d.key}
                  def={d}
                  value={d.key in draft ? draft[d.key] : p.attributes?.[d.key] ?? null}
                  error={fieldErrors[d.key]}
                  onChange={(v) =>
                    setDraft((prev) => {
                      const next = { ...prev };
                      // Reverting a field to its stored value should leave the
                      // form clean, not merely equal — otherwise Save stays lit
                      // with nothing to do.
                      const stored = p.attributes?.[d.key] ?? null;
                      if (String(v ?? "") === String(stored ?? "")) delete next[d.key];
                      else next[d.key] = v;
                      return next;
                    })
                  }
                />
              ))}
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: 16 }}>
          {/* ------------------------------ Drawings --------------------------- */}
          {/* --------------------------------- Product --------------------------- */}
          <div className="card">
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Product</h2>
            <p style={{ margin: "0 0 8px", color: "var(--text-faint)", fontSize: 12 }}>
              What this {p.kind === "assembly" ? "assembly" : "part"} is part of. PLM&rsquo;s own
              grouping — Onshape organises by document, which is a container for CAD rather than a
              statement about what is being built.
            </p>

            <ProductField
              label=""
              value={p.productId ?? null}
              onChange={(productId) => setProduct(productId)}
            />

            {p.productId && (
              <Link
                href={`/dashboard?product=${p.productId}`}
                className="btn btn-sm"
                style={{ marginTop: 8, display: "inline-block" }}
              >
                Show everything in {p.productName}
              </Link>
            )}
          </div>

          {/* --------------------------------- 3D ------------------------------
            * Only when there is something to say. A permanently empty "3D
            * model" card on every part would suggest the feature is broken
            * rather than switched off.
            */}
          {(data.geometry ?? []).length > 0 && (
            <div className="card">
              <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>3D model</h2>
              <p style={{ margin: "0 0 8px", fontSize: 11.5, color: "var(--text-faint)" }}>
                Captured when the part is synced, and again from the version each release
                produced — a released revision is kept for good; the unreleased capture keeps
                moving until then.
              </p>

              {/*
                * The viewer, on whichever revision is selected.
                *
                * Only shown for a capture that actually has bytes: pointing it
                * at a failed row would render an empty scene, which reads as a
                * broken viewer rather than a model that was never stored.
                */}
              {(() => {
                const withBytes = (data.geometry ?? []).filter((g) => !g.failureReason);
                const shown = withBytes.find((g) => g.revision === viewRevision) ?? withBytes[0];
                if (!shown) return null;
                return (
                  <div style={{ marginBottom: 10 }}>
                    <ModelViewer
                      key={shown.id}
                      src={`/api/parts/${id}/geometry?revision=${encodeURIComponent(shown.revision)}`}
                      label={`${p.number ?? p.name} revision ${shown.revision || "—"}`}
                      // Whatever PLM already has cached — even the generic
                      // placeholder svg, which still beats a blank box.
                      poster={`/api/parts/${id}/thumbnail?size=400`}
                      // Only once Mass properties below has actually been
                      // measured — see loadMass. Onshape reports a centroid
                      // from geometry alone, so this can exist even for a
                      // part with no material and therefore no mass.
                      hotspot={
                        mass?.centroidM
                          ? {
                              positionM: mass.centroidM,
                              label:
                                mass.hasMass && mass.massKg != null
                                  ? `Center of mass · ${mass.massKg.toFixed(2)} kg`
                                  : "Center of mass",
                            }
                          : undefined
                      }
                    />
                    {withBytes.length > 1 && (
                      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11.5, color: "var(--text-faint)", alignSelf: "center" }}>
                          Revision:
                        </span>
                        {withBytes.map((g) => (
                          <button
                            key={g.id}
                            className="btn btn-sm"
                            onClick={() => setViewRevision(g.revision)}
                            style={{
                              borderColor: g.revision === shown.revision ? "var(--accent)" : undefined,
                              color: g.revision === shown.revision ? "var(--accent)" : undefined,
                              fontWeight: g.revision === shown.revision ? 600 : undefined,
                            }}
                          >
                            {g.revision || "—"}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              {(data.geometry ?? []).map((g) => (
                <div
                  key={g.id}
                  style={{
                    display: "flex", gap: 8, alignItems: "center", padding: "5px 0",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <span className="badge">{g.revision || "no revision"}</span>
                  {g.failureReason ? (
                    <span style={{ fontSize: 12, color: "var(--danger)", flex: 1 }}>
                      {g.failureReason}
                    </span>
                  ) : (
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)", flex: 1 }}>
                      glTF · {(g.size / 1024).toFixed(0)} KB
                      {g.capturedAt ? ` · ${relTime(g.capturedAt)}` : ""}
                    </span>
                  )}
                  {/*
                    * Re-exports this one revision from Onshape in place —
                    * the retry for a capture that failed (too large, a
                    * translation that timed out, Onshape briefly
                    * unreachable), and also just a way to refresh one that
                    * did not: nothing else in PLM re-triggers this short of
                    * waiting for the next sync or release.
                    */}
                  <button
                    className="btn btn-sm"
                    onClick={() => recaptureGeometry(g.revision)}
                    disabled={busy === `recapture:${g.revision}`}
                    title={
                      g.failureReason
                        ? "Try exporting this revision's 3D model again"
                        : "Re-export this revision's 3D model from Onshape"
                    }
                  >
                    {busy === `recapture:${g.revision}` ? <Spinner /> : "Recreate"}
                  </button>
                  {!g.failureReason && (
                    <a
                      className="btn btn-sm"
                      href={`/api/parts/${id}/geometry?revision=${encodeURIComponent(g.revision)}`}
                      download
                    >
                      Download
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* --------------------------------- Tasks ---------------------------
            * Above Drawings on purpose: a drawing is a record of what the part
            * is, and an open task is a request to change it. The second is the
            * one somebody needs to see before they touch anything.
            */}
          <div className="card" id="tasks">
            <h2 style={{ margin: "0 0 10px", fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
              Tasks
              <TaskCountBadge open={data.openTaskCount} total={(data.tasks ?? []).length} />
              <Link href="/tasks" className="btn btn-sm" style={{ marginLeft: "auto" }}>
                Task board
              </Link>
            </h2>
            <PartTasks tasks={data.tasks ?? []} />
          </div>

          <div className="card">
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>Drawings</h2>
            {data.drawings.length === 0 ? (
              <p style={{ margin: 0, color: "var(--text-faint)", fontSize: 12.5 }}>
                None yet. Drawings reach PLM with a release package — Onshape adds the active
                sheets to it itself.
              </p>
            ) : (
              data.drawings.map((d) => (
                <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0" }}>
                  <Link href={`/drawings/${d.id}`} className="mono" style={{ fontSize: 12.5 }}>
                    {d.number}
                  </Link>
                  <span style={{ fontSize: 12.5, color: "var(--text-muted)", flex: 1 }}>{d.name}</span>
                  {d.revision && <span className="badge">{d.revision}</span>}
                  {d.currentFileId && (
                    <a
                      className="btn btn-sm"
                      href={`/api/drawings/${d.id}/files/${d.currentFileId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      PDF
                    </a>
                  )}
                </div>
              ))
            )}
          </div>

          {/* ------------------------------ Structure -------------------------- */}
          <div className="card">
            <h2 style={{ margin: "0 0 10px", fontSize: 15 }}>
              {p.kind === "assembly" ? "Components" : "Structure"}
            </h2>
            {data.structure.children.length === 0 && data.structure.usedIn.length === 0 ? (
              <p style={{ margin: 0, color: "var(--text-faint)", fontSize: 12.5 }}>
                No structure recorded. Importing an assembly&rsquo;s BOM is what creates it.
              </p>
            ) : (
              <>
                {data.structure.children.length > 0 && (
                  <>
                    <div style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "0 0 4px" }}>
                      Contains
                    </div>
                    {data.structure.children.map((c) => (
                      <StructureRow
                        key={c.linkId}
                        row={c}
                        showQty
                        /*
                         * Only "Contains" rows can be tagged — this assembly's
                         * own variants are what they are tagged against.
                         * "Used in" rows belong to a different parent's
                         * variants, which this page has not loaded.
                         */
                        variants={data.variants}
                        onVariantsChanged={load}
                        /*
                         * Swapping only makes sense once this assembly itself
                         * has a revision to keep — see the disabled reason
                         * below, which is what registerStarRelease enforces
                         * server-side too.
                         */
                        onSwap={
                          p.revision
                            ? () => setStarDialog({
                                swapTarget: { bomLinkId: c.linkId, number: c.number, name: c.name },
                              })
                            : undefined
                        }
                      />
                    ))}
                  </>
                )}
                {data.structure.usedIn.length > 0 && (
                  <>
                    <div style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "10px 0 4px" }}>
                      Used in
                    </div>
                    {data.structure.usedIn.map((c) => (
                      <StructureRow key={c.linkId} row={c} showQty />
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* ------------------------------ Variants ---------------------------
            * Named variants of THIS assembly's BOM — "Model A", "Model B" —
            * that a "Contains" row above can be tagged against. PLM's own
            * concept; Onshape has nothing to sync it from. Only meaningful
            * for an assembly, which is the whole reason a BOM branches.
            */}
          {p.kind === "assembly" && (
            <VariantsCard parentPartId={p.id} variants={data.variants} onChanged={load} />
          )}

          {/* --------------------------- Star releases -------------------------
            * Only once there is a revision to star, and only once one has
            * actually happened — an empty card here on every released part
            * would suggest the feature is broken rather than simply unused.
            */}
          {p.revision && data.starReleases.length > 0 && (
            <div className="card">
              <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>Star releases</h2>
              <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--text-faint)" }}>
                Off-cycle changes at revision {p.revision} — never sent to Onshape, and none of
                them move the revision itself.
              </p>
              <div style={{ display: "grid", gap: 8 }}>
                {data.starReleases.map((star: any) => (
                  <div
                    key={star.id}
                    style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 12.5 }}
                  >
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <span className="badge mono">{star.baseRevision}{"*".repeat(star.starIndex)}</span>
                      <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
                        {star.createdByEmail} · {relTime(star.createdAt)}
                      </span>
                    </div>
                    {star.swap && (
                      <div style={{ marginTop: 3, color: "var(--text-muted)" }}>
                        Swapped <span className="mono">{star.swap.fromNumber || "—"}</span> for{" "}
                        <span className="mono">{star.swap.toNumber || "—"}</span>
                      </div>
                    )}
                    <div style={{ marginTop: 3 }}>{star.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ----------------------------- Mass properties -------------------- */}
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>Mass properties</h2>
              <div style={{ flex: 1 }} />
              <button className="btn btn-sm" onClick={loadMass} disabled={busy === "mass"}>
                {busy === "mass" ? <Spinner /> : mass ? "Refresh" : "Measure"}
              </button>
            </div>
            {mass ? (
              <div style={{ marginTop: 8 }}>
                <KV k="Mass" v={mass.massKg != null ? `${mass.massKg.toFixed(3)} kg` : "—"} />
                <KV k="Volume" v={mass.volumeM3 != null ? `${(mass.volumeM3 * 1e6).toFixed(1)} cm³` : "—"} />
                {/* surfaceAreaM2, not areaM2 — the latter never existed on the
                    response, so this row silently read "—" on every part. */}
                <KV
                  k="Surface area"
                  v={mass.surfaceAreaM2 != null
                    ? `${(mass.surfaceAreaM2 * 1e4).toFixed(1)} cm²`
                    : "—"}
                />
                <KV
                  k="Stored on this part"
                  v={mass.stored?.written
                    ? `Yes — Mass = ${mass.stored.now} ${mass.stored.unit}`
                    : mass.stored?.why ?? "—"}
                />
              </div>
            ) : (
              <p style={{ margin: "8px 0 0", color: "var(--text-faint)", fontSize: 12.5 }}>
                Read from Onshape on request rather than on every sync — it is only interesting
                when somebody looks. Measuring also records the mass on this part's Mass
                attribute, since Onshape is the authority on it.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------- Iterations --------------------------- */}
      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ margin: 0, fontSize: 15, padding: "13px 16px 10px" }}>
          Version history
          <span style={{ fontWeight: 400, color: "var(--text-faint)", fontSize: 12, marginLeft: 8 }}>
            {/*
              This used to say "pre-release history", which undersold it: the
              release snapshots are in here too, each holding the attributes and
              the Onshape version as they stood at that revision. Nothing is
              rewritten in place, so an earlier revision still reads as it was
              released.
            */}
            Every iteration this {p.kind === "assembly" ? "assembly" : "part"} has had, including
            the released revisions. Each row is the state as it stood — nothing is overwritten,
            so revision A still reads as revision A after B is released.
          </span>
        </h2>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 70 }}>Version</th>
              <th style={{ width: 130 }}>State</th>
              <th style={{ width: 90 }}>Cause</th>
              <th>What changed</th>
              <th style={{ width: 190 }}>By</th>
              <th style={{ width: 110 }}>When</th>
            </tr>
          </thead>
          <tbody>
            {data.iterations.map((it) => (
              <tr key={it.iteration}>
                <td><RevChip revision={it.revision} iteration={it.iteration} /></td>
                <td><StatusBadge status={it.lifecycleState} /></td>
                <td style={{ fontSize: 12 }}>
                  {it.releaseId ? (
                    <Link href={`/releases/${it.releaseId}`} style={{ color: "var(--accent)" }}>
                      {it.cause}
                    </Link>
                  ) : (
                    it.cause
                  )}
                </td>
                <td style={{ fontSize: 12 }}>
                  {it.changedKeys.length ? it.changedKeys.join(", ") : <span style={{ color: "var(--text-faint)" }}>—</span>}
                </td>
                <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {it.createdByEmail || "automatic"}
                </td>
                <td style={{ fontSize: 12, color: "var(--text-faint)" }} title={it.createdAt}>
                  {relTime(it.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* -------------------------- Onshape properties ------------------------ */}
      <details className="card">
        <summary style={{ cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
          Everything Onshape reported ({p.onshapeProperties?.length ?? 0} properties)
        </summary>
        <p style={{ fontSize: 12, color: "var(--text-faint)", margin: "8px 0" }}>
          Kept verbatim, with the value Onshape sent beside the one PLM read from it. A property
          that failed to map shows here rather than vanishing — and a mapping that resolved to the
          wrong label only looks wrong next to the raw value.
        </p>
        <table className="table">
          <thead>
            <tr><th>Property</th><th>Value read</th><th>Raw</th></tr>
          </thead>
          <tbody>
            {(p.onshapeProperties ?? []).map((op: any, i: number) => (
              <tr key={`${op.propertyId}-${i}`}>
                <td style={{ fontSize: 12 }}>
                  {op.name || <span className="mono">{op.propertyId}</span>}
                </td>
                <td style={{ fontSize: 12 }}>{String(op.value ?? "")}</td>
                <td className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  {typeof op.raw === "object" ? JSON.stringify(op.raw) : String(op.raw ?? "")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {/* ------------------------------- Activity ---------------------------- */}
      <div className="card" style={{ padding: 0 }}>
        <h2 style={{ margin: 0, fontSize: 15, padding: "13px 16px 10px" }}>Activity</h2>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Direction</th>
              <th style={{ width: 90 }}>Action</th>
              <th>Message</th>
              <th style={{ width: 110 }}>When</th>
            </tr>
          </thead>
          <tbody>
            {data.logs.map((l) => (
              <tr key={l.id} style={{ opacity: l.ok ? 1 : undefined }}>
                <td className="mono" style={{ fontSize: 11 }}>{l.direction}</td>
                <td style={{ fontSize: 12, color: l.ok ? undefined : "var(--danger)" }}>{l.action}</td>
                <td style={{ fontSize: 12 }}>{l.message}</td>
                <td style={{ fontSize: 12, color: "var(--text-faint)" }} title={l.createdAt}>
                  {relTime(l.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <StarReleaseDialog
        open={starDialog !== null}
        onClose={() => setStarDialog(null)}
        onDone={(result) => {
          setNotice(`Registered ${result.revisionLabel}.`);
          void load();
        }}
        partId={id}
        partLabel={p.number ?? p.name}
        revisionLabel={`${p.revision}${"*".repeat(p.starCount ?? 0)}`}
        swapTarget={starDialog?.swapTarget ?? null}
        swapChoices={
          p.kind === "assembly"
            ? data.structure.children.map((c: any) => ({ bomLinkId: c.linkId, number: c.number, name: c.name }))
            : []
        }
      />

      <SetInitialRevisionDialog
        open={initialRevisionOpen}
        onClose={() => setInitialRevisionOpen(false)}
        onDone={(result) => {
          setNotice(`Recorded revision ${result.revision}.`);
          void load();
        }}
        partId={id}
        partLabel={p.number ?? p.name}
      />
    </div>
  );
}

function StructureRow({
  row, showQty, onSwap, variants, onVariantsChanged,
}: {
  row: any; showQty?: boolean;
  /** Present only for a child row of an assembly that can be starred. */
  onSwap?: () => void;
  /** The parent assembly's own variants — present only for a "Contains" row. */
  variants?: { id: string; name: string }[];
  onVariantsChanged?: () => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", fontSize: 12.5, flexWrap: "wrap" }}>
      {showQty && (
        <span className="mono" style={{ color: "var(--text-faint)", minWidth: 26 }}>
          ×{row.quantity}
        </span>
      )}
      <Link href={`/parts/${row.partId}`} className="mono">{row.number ?? "—"}</Link>
      <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {row.name}
      </span>
      {row.revision && <span className="badge">{row.revision}</span>}
      <StatusBadge status={row.lifecycleState} />
      {!!variants?.length && (
        <LinkVariantTags
          linkId={row.linkId}
          variants={variants}
          selected={row.variantIds ?? []}
          onSaved={onVariantsChanged ?? (() => {})}
        />
      )}
      {onSwap && (
        <button
          className="btn btn-sm"
          onClick={onSwap}
          title="Swap this component for a form-fit-function equivalent, without a new revision"
        >
          Swap…
        </button>
      )}
    </div>
  );
}

/**
 * Which of the parent assembly's variants this one component belongs to.
 *
 * Empty (the default for every edge) means every variant — this is only
 * about narrowing a specific position down to the model(s) that actually use
 * it, most often one of several sibling positions for the same slot, each a
 * different configured size or option.
 */
function LinkVariantTags({
  linkId, variants, selected, onSaved,
}: {
  linkId: string; variants: { id: string; name: string }[]; selected: string[]; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(selected));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setPicked(new Set(selected)), [selected]);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/bom-links/${linkId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantIds: [...picked] }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not save");
      setEditing(false);
      onSaved();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    const names = variants.filter((v) => selected.includes(v.id)).map((v) => v.name);
    return (
      <button
        className="btn btn-sm"
        onClick={() => setEditing(true)}
        title="Which variants of this assembly use this component — empty means all of them"
      >
        {names.length ? names.join(", ") : "All variants"}
      </button>
    );
  }

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
        border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px",
      }}
    >
      {variants.map((v) => (
        <label key={v.id} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11.5 }}>
          <input
            type="checkbox"
            checked={picked.has(v.id)}
            onChange={(e) => {
              const next = new Set(picked);
              if (e.target.checked) next.add(v.id); else next.delete(v.id);
              setPicked(next);
            }}
          />
          {v.name}
        </label>
      ))}
      {err && <span style={{ color: "var(--danger)", fontSize: 11 }}>{err}</span>}
      <button className="btn btn-sm btn-primary" onClick={save} disabled={busy}>
        {busy && <Spinner />} Save
      </button>
      <button className="btn btn-sm" onClick={() => { setEditing(false); setPicked(new Set(selected)); }}>
        Cancel
      </button>
    </div>
  );
}

/** Manage the named variants of one assembly's BOM. See BomLink.variantIds. */
function VariantsCard({
  parentPartId, variants, onChanged,
}: {
  parentPartId: string;
  variants: { id: string; parentPartId: string; name: string; description: string; order: number }[];
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    if (!name.trim()) return;
    setBusy("add"); setErr(null);
    try {
      const res = await fetch("/api/variants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPartId, name: name.trim() }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not add this variant");
      setName(""); setAdding(false);
      onChanged();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(
      `Remove the variant "${label}"? Components tagged with it are not removed from the BOM — ` +
      `they simply stop being narrowed to it.`
    )) return;
    setBusy(id);
    try {
      await fetch(`/api/variants/${id}`, { method: "DELETE" });
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2 style={{ margin: "0 0 4px", fontSize: 15 }}>Variants</h2>
      <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
        Named versions of this assembly&rsquo;s BOM — different models built from the same
        structure, differing only in which of a few alternate components each one uses. Tag a
        component under &ldquo;Components&rdquo; above with one or more of these; anything left
        untagged is in every variant.
      </p>
      {variants.length === 0 && !adding && (
        <p style={{ margin: "0 0 8px", color: "var(--text-faint)", fontSize: 12.5 }}>
          No variants defined — every component applies to this assembly as a whole.
        </p>
      )}
      {variants.length > 0 && (
        <div style={{ display: "grid", gap: 1, marginBottom: 8 }}>
          {variants.map((v) => (
            <div
              key={v.id}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
                borderBottom: "1px solid var(--border)", fontSize: 12.5,
              }}
            >
              <span style={{ fontWeight: 600 }}>{v.name}</span>
              <span style={{ flex: 1 }} />
              <button
                className="btn btn-sm btn-danger" onClick={() => remove(v.id, v.name)}
                disabled={busy === v.id}
              >
                {busy === v.id ? <Spinner size={12} /> : "Remove"}
              </button>
            </div>
          ))}
        </div>
      )}
      {err && <Alert kind="error" onDismiss={() => setErr(null)}>{err}</Alert>}
      {adding ? (
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input" style={{ maxWidth: 220 }} value={name} placeholder="e.g. Model A"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            autoFocus
          />
          <button className="btn btn-primary btn-sm" onClick={add} disabled={busy === "add" || !name.trim()}>
            {busy === "add" && <Spinner />} Add
          </button>
          <button className="btn btn-sm" onClick={() => { setAdding(false); setName(""); }}>Cancel</button>
        </div>
      ) : (
        <button className="btn btn-sm" onClick={() => setAdding(true)}>Add a variant</button>
      )}
    </div>
  );
}
