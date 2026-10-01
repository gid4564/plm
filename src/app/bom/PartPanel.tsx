"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, FavoriteButton, KV, PartThumb, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";
import { PartTasks, TaskCountBadge } from "@/components/PartTasks";
import { AttributeInput, type Definition } from "@/components/AttributeInput";

/**
 * A part's details, in a panel over the BOM.
 *
 * A panel rather than a navigation, because reading a BOM is a scanning task:
 * checking one part should not cost the reader their place in a tree they may
 * have spent several clicks expanding. The full part page is one click away for
 * anything this does not show.
 */
export function PartPanel({
  partId, onClose, onSaved, onStep, position,
}: {
  partId: string | null;
  onClose: () => void;
  /** Called after a successful save, so the BOM behind can re-read. */
  onSaved?: () => void;
  /**
   * Move to the previous or next part in the view behind.
   *
   * The point of the whole panel: filling release-required attributes across a
   * BOM is a walk through many parts, and closing and reopening for each is
   * most of the work.
   */
  onStep?: (delta: number) => void;
  position?: { index: number; total: number };
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /* Only the fields still needed for release, which is the usual task. */
  const [onlyMissing, setOnlyMissing] = useState(true);

  useEffect(() => {
    if (!partId) { setData(null); setError(null); return; }
    // A draft belongs to the part it was typed against.
    setDraft({});
    setFieldErrors({});
    setNotice(null);
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const r = await fetch(`/api/parts/${partId}`);
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) throw new Error(j.error || "Could not load that part");
        setData(j);
      } catch (e: any) {
        if (alive) setError(String(e?.message ?? e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [partId]);

  /* Escape closes it, which is what anyone tries first. */
  const dirty = Object.keys(draft).length > 0;

  /*
   * Escape closes, and the arrows step through the BOM — but neither throws
   * away typing. Someone halfway through a field who taps Escape has not asked
   * to lose it.
   */
  useEffect(() => {
    if (!partId) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(
        (e.target as HTMLElement)?.tagName ?? ""
      );
      if (e.key === "Escape") {
        if (dirty) { setNotice("Save or discard first — there are unsaved changes."); return; }
        onClose();
      }
      if (!typing && onStep && !dirty) {
        if (e.key === "ArrowDown" || e.key === "j") onStep(1);
        if (e.key === "ArrowUp" || e.key === "k") onStep(-1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [partId, onClose, onStep, dirty]);

  async function save(thenStep = 0) {
    if (!partId) return;
    setSaving(true);
    setFieldErrors({});
    setError(null);
    try {
      const r = await fetch(`/api/parts/${partId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: draft }),
      });
      const j = await r.json();
      if (j.errors) {
        setFieldErrors(j.errors);
        /*
         * A refusal can be about a field this panel is not showing — the
         * server validates the whole part, and this list is narrowed to what
         * is still missing. Its error would land on an input that does not
         * exist, and the save would look like it simply did nothing.
         */
        const labels = new Map<string, string>(
          (data?.definitions ?? []).map((d: Definition) => [d.key, d.label] as [string, string])
        );
        const shown = new Set(shownDefs.map((d) => d.key));
        const hidden = Object.entries(j.errors as Record<string, string>).filter(([k]) => !shown.has(k));
        if (hidden.length) {
          setError(
            "Not saved. " + hidden.map(([k, m]) => `${labels.get(k) ?? k}: ${m}`).join(" ")
          );
        }
        return;
      }
      if (!r.ok) throw new Error(j.error || "Could not save");
      setDraft({});
      setNotice(j.message ?? "Saved.");
      onSaved?.();
      if (thenStep && onStep) onStep(thenStep);
      else {
        // Re-read, so the release-readiness note reflects what was just saved.
        const again = await fetch(`/api/parts/${partId}`).then((x) => x.json()).catch(() => null);
        if (again?.part) setData(again);
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  if (!partId) return null;

  const p = data?.part;
  const defs: Definition[] = data?.definitions ?? [];

  /*
   * Governance comes from the server, not from here.
   *
   * `editable` and `lockReason` are computed against the part's state by
   * lib/attributes, and AttributeInput renders a locked field as a value with
   * its reason rather than a disabled box. Re-deciding either here would be a
   * second implementation of the rules.
   */
  const editableDefs = defs.filter((d) => d.editable);
  const missingKeys: string[] = data?.missingForReleaseKeys ?? [];
  const missingDefs = editableDefs.filter((d) => missingKeys.includes(d.key));
  const shownDefs = onlyMissing && missingDefs.length > 0 ? missingDefs : editableDefs;

  return (
    <>
      {/*
        The scrim closes it on click and dims the BOM behind, so it is obvious
        which of the two is being read.
      */}
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,.28)", zIndex: 40,
        }}
      />
      <aside
        role="dialog"
        aria-label="Part details"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: "min(440px, 92vw)",
          background: "var(--surface)", borderLeft: "1px solid var(--border)",
          boxShadow: "-8px 0 32px rgba(0,0,0,.18)", zIndex: 41,
          overflowY: "auto", padding: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <strong style={{ fontSize: 13 }}>Part</strong>
          {position && (
            <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
              {position.index + 1} of {position.total}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {onStep && (
            <>
              {/*
                Stepping is disabled while there are unsaved changes rather than
                hidden: the button explains itself, where a missing one would
                leave somebody wondering where it went.
              */}
              <button
                className="btn btn-sm"
                onClick={() => onStep(-1)}
                disabled={dirty || saving}
                title={dirty ? "Save or discard first" : "Previous part (↑)"}
              >
                ↑
              </button>
              <button
                className="btn btn-sm"
                onClick={() => onStep(1)}
                disabled={dirty || saving}
                title={dirty ? "Save or discard first" : "Next part (↓)"}
              >
                ↓
              </button>
            </>
          )}
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>

        {loading && <div style={{ padding: 24, textAlign: "center" }}><Spinner size={18} /></div>}
        {error && <div style={{ color: "var(--danger)", fontSize: 12.5 }}>{error}</div>}

        {p && (
          <div style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <PartThumb partId={p.id} size={64} radius={8} alt="" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{p.number ?? "—"}</div>
                  <FavoriteButton kind="part" targetId={p.id} active={Boolean(p.isFavorite)} size={16} />
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{p.name}</div>
                <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                  <RevChip
                    revision={p.revision} iteration={p.iteration} starCount={p.starCount}
                    starReasons={(data.starReleases ?? []).map(
                      (s: any) => `${s.baseRevision}${"*".repeat(s.starIndex)}: ${s.reason}`
                    )}
                  />
                  <StatusBadge status={p.lifecycleState} />
                  {p.kind === "assembly" && <span className="badge">assembly</span>}
                  {p.plmOnly && (
                    <span
                      className="badge"
                      title="Created by copying another part — no Onshape original backs this one"
                    >
                      PLM only
                    </span>
                  )}
                </div>
              </div>
            </div>

            {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

            {missingDefs.length > 0 && (
              <div
                style={{
                  fontSize: 12, color: "var(--warn)", border: "1px solid var(--warn)",
                  background: "var(--warn-soft)", borderRadius: 8, padding: "8px 10px",
                }}
              >
                Not ready to release — still needs{" "}
                {missingDefs.map((d) => d.label).join(", ")}.
              </div>
            )}

            {/* ---------------------------- Attributes ---------------------------- */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <strong style={{ fontSize: 12.5 }}>Attributes</strong>
                <div style={{ flex: 1 }} />
                {/*
                  Defaults to only what is missing, because that is the task
                  that brought anyone here: a BOM full of parts each needing
                  three fields. The full list is one click away for the rest.
                */}
                {missingDefs.length > 0 && (
                  <button className="btn btn-sm" onClick={() => setOnlyMissing((v) => !v)}>
                    {onlyMissing ? `Show all ${editableDefs.length}` : "Only what's missing"}
                  </button>
                )}
              </div>

              <div style={{ display: "grid", gap: 9 }}>
                {shownDefs.map((d: Definition) => (
                  <AttributeInput
                    key={d.key}
                    def={d}
                    value={d.key in draft ? draft[d.key] : p.attributes?.[d.key]}
                    error={fieldErrors[d.key]}
                    onChange={(v) => setDraft((prev) => ({ ...prev, [d.key]: v }))}
                  />
                ))}
                {shownDefs.length === 0 && (
                  <p style={{ margin: 0, fontSize: 12, color: "var(--text-faint)" }}>
                    Nothing editable in this state
                    {p.lifecycleState === "Released" ? " — the part is Released." : "."}
                  </p>
                )}
              </div>

              {dirty && (
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  <button className="btn btn-primary btn-sm" onClick={() => save()} disabled={saving}>
                    {saving ? <Spinner size={12} /> : "Save"}
                  </button>
                  {onStep && (
                    <button className="btn btn-sm" onClick={() => save(1)} disabled={saving}>
                      Save and next
                    </button>
                  )}
                  <button
                    className="btn btn-sm"
                    onClick={() => { setDraft({}); setFieldErrors({}); }}
                    disabled={saving}
                  >
                    Discard
                  </button>
                </div>
              )}
            </div>

            <div>
              <KV k="Product" v={p.productName || "—"} />
              <KV
                k="Mass"
                v={typeof p.attributes?.mass === "number" ? `${p.attributes.mass} kg` : "—"}
              />
              <KV k="Onshape" v={`${p.documentName}${p.elementName ? ` · ${p.elementName}` : ""}`} />
              <KV k="Last synced" v={relTime(p.lastSyncedFromOnshapeAt)} />
            </div>

            {/* Where it sits in the structure, which is the question a BOM prompts. */}
            {(data.children?.length > 0 || data.parents?.length > 0) && (
              <div style={{ fontSize: 12 }}>
                {data.parents?.length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <span style={{ color: "var(--text-faint)" }}>Used in: </span>
                    {data.parents.map((x: any, i: number) => (
                      <span key={x.partId}>
                        {i > 0 && ", "}
                        <Link href={`/parts/${x.partId}`} className="mono">{x.number ?? x.name}</Link>
                      </span>
                    ))}
                  </div>
                )}
                {data.children?.length > 0 && (
                  <div>
                    <span style={{ color: "var(--text-faint)" }}>Contains: </span>
                    {data.children.length} item{data.children.length === 1 ? "" : "s"}
                  </div>
                )}
              </div>
            )}

            {/*
              * Open tasks, shown here as well as on the part page.
              *
              * Reviewing a BOM is exactly when this matters: a component with
              * a change request against it is not settled, and finding that out
              * after signing off the BOM is finding out too late.
              */}
            {(data.tasks ?? []).length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: 12, fontWeight: 600, marginBottom: 6,
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  Tasks
                  <TaskCountBadge open={data.openTaskCount ?? 0} total={(data.tasks ?? []).length} />
                </div>
                <PartTasks tasks={data.tasks ?? []} />
              </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link href={`/parts/${p.id}`} className="btn btn-primary btn-sm">
                Open the full part page
              </Link>
              {data.onshapeUrl && (
                <a className="btn btn-sm" href={data.onshapeUrl} target="_blank" rel="noreferrer">
                  Open in Onshape
                </a>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

function dateOnly(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
