"use client";

import { useEffect, useState } from "react";
import { Alert, Spinner } from "@/components/ui";

type PartHit = { id: string; number: string | null; name: string };

/**
 * "Register a star release" — an off-cycle change to an already-released
 * part or assembly, in one modal usable from either place it can start:
 * a specific BOM line ("swap this component") or the object's own detail
 * page (a plain note, or "swap a component" picked from its own structure).
 *
 * The three shapes this can take are driven entirely by what the caller
 * passes, not by state inside here:
 *
 *   `swapTarget` set        — swapping one specific, already-known line.
 *     Only the replacement needs picking.
 *   `swapChoices` non-empty — the object is an assembly with children; a
 *     "swap a component" toggle lets the reason be about a substitution,
 *     picking which current child from the list.
 *   Neither                — a plain note against the object itself, no
 *     structure change at all (a standalone part, or an assembly with
 *     nothing in it yet).
 */
export function StarReleaseDialog({
  open, onClose, onDone,
  partId, partLabel, revisionLabel,
  swapTarget, swapChoices = [],
}: {
  open: boolean;
  onClose: () => void;
  onDone: (result: { revisionLabel: string }) => void;
  /** The part or assembly being starred — whichever object "owns" the change. */
  partId: string;
  partLabel?: string;
  /** Its current display revision, e.g. "A*" — shown so the next one is legible, when known here. */
  revisionLabel?: string;
  /** Swap a specific, already-known BOM line — skips the "which component" step. */
  swapTarget?: { bomLinkId: string; number: string | null; name: string } | null;
  /** Available when the caller wants a "swap a component" option offered generally. */
  swapChoices?: { bomLinkId: string; number: string | null; name: string }[];
}) {
  const [reason, setReason] = useState("");
  const [swapping, setSwapping] = useState(Boolean(swapTarget));
  const [chosenLinkId, setChosenLinkId] = useState(swapTarget?.bomLinkId ?? "");
  const [replacementQ, setReplacementQ] = useState("");
  const [replacementHits, setReplacementHits] = useState<PartHit[]>([]);
  const [replacement, setReplacement] = useState<PartHit | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setSwapping(Boolean(swapTarget));
    setChosenLinkId(swapTarget?.bomLinkId ?? "");
    setReplacementQ("");
    setReplacementHits([]);
    setReplacement(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, swapTarget?.bomLinkId]);

  useEffect(() => {
    if (!open || !swapping || !replacementQ.trim()) { setReplacementHits([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/parts?q=${encodeURIComponent(replacementQ.trim())}&limit=8`);
        const j = await r.json();
        setReplacementHits(r.ok ? (j.parts ?? []).map((p: any) => ({ id: p.id, number: p.number, name: p.name })) : []);
      } catch {
        setReplacementHits([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [open, swapping, replacementQ]);

  if (!open) return null;

  const linkId = swapTarget?.bomLinkId ?? chosenLinkId;
  const canSubmit =
    reason.trim().length > 0 && (!swapping || (linkId && replacement)) && !saving;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/parts/${partId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "star-release",
          reason: reason.trim(),
          ...(swapping && linkId && replacement
            ? { swap: { bomLinkId: linkId, newPartId: replacement.id } }
            : {}),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not register the star release");
      onDone({ revisionLabel: j.star?.revisionLabel ?? revisionLabel ?? "" });
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div
        onClick={saving ? undefined : onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.32)", zIndex: 60 }}
      />
      <div
        role="dialog"
        aria-label="Register a star release"
        style={{
          position: "fixed", top: "10%", left: "50%", transform: "translateX(-50%)",
          width: "min(460px, 92vw)", maxHeight: "80vh", overflowY: "auto",
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 16px 48px rgba(0,0,0,.24)", zIndex: 61, padding: 18,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Register a star release</h3>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-faint)" }}>
          {partLabel || "This"}
          {revisionLabel ? <> stays at <strong className="mono">{revisionLabel}</strong> today</> : " stays at its current revision"}
          {" "}— this does not create a new revision and is never sent to Onshape. Use it for a
          form-fit-function equivalent substitution, or a metadata or cosmetic note that does not
          need a real revision.
        </p>

        {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

        {swapChoices.length > 0 && !swapTarget && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={swapping}
              onChange={(e) => { setSwapping(e.target.checked); setChosenLinkId(""); setReplacement(null); }}
            />
            This is a component swap
          </label>
        )}

        {swapping && (
          <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
            {swapTarget ? (
              <div style={{ fontSize: 12.5 }}>
                <span style={{ color: "var(--text-faint)" }}>Swapping out: </span>
                <span className="mono">{swapTarget.number ?? "—"}</span> {swapTarget.name}
              </div>
            ) : (
              <div>
                <label className="label">Which component</label>
                <select
                  className="select" style={{ width: "100%" }}
                  value={chosenLinkId}
                  onChange={(e) => setChosenLinkId(e.target.value)}
                >
                  <option value="">Choose a component…</option>
                  {swapChoices.map((c) => (
                    <option key={c.bomLinkId} value={c.bomLinkId}>
                      {c.number ?? "—"} — {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="label">Replace with</label>
              {replacement ? (
                <div
                  style={{
                    display: "flex", alignItems: "center", gap: 8, fontSize: 12.5,
                    border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px",
                  }}
                >
                  <span className="mono" style={{ fontWeight: 600 }}>{replacement.number ?? "—"}</span>
                  <span style={{ flex: 1, color: "var(--text-muted)" }}>{replacement.name}</span>
                  <button className="btn btn-sm" onClick={() => { setReplacement(null); setReplacementQ(""); }}>
                    Change
                  </button>
                </div>
              ) : (
                <div style={{ position: "relative" }}>
                  <input
                    className="input"
                    style={{ width: "100%" }}
                    placeholder="Search by number or name…"
                    value={replacementQ}
                    onChange={(e) => setReplacementQ(e.target.value)}
                  />
                  {replacementQ.trim() && (
                    <div
                      style={{
                        position: "absolute", top: "100%", left: 0, right: 0, marginTop: 2,
                        background: "var(--surface)", border: "1px solid var(--border)",
                        borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,.16)", zIndex: 1,
                        maxHeight: 180, overflowY: "auto",
                      }}
                    >
                      {searching ? (
                        <div style={{ padding: 10, textAlign: "center" }}><Spinner size={13} /></div>
                      ) : replacementHits.length === 0 ? (
                        <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-faint)" }}>
                          No match.
                        </div>
                      ) : (
                        replacementHits.map((h) => (
                          <button
                            key={h.id}
                            onClick={() => { setReplacement(h); setReplacementQ(""); setReplacementHits([]); }}
                            style={{
                              display: "block", width: "100%", textAlign: "left", background: "none",
                              border: "none", padding: "6px 10px", cursor: "pointer", font: "inherit",
                            }}
                          >
                            <span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>
                              {h.number ?? "—"}
                            </span>{" "}
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{h.name}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <label className="label">Reason</label>
        <textarea
          className="input"
          rows={3}
          style={{ width: "100%", resize: "vertical", marginBottom: 14 }}
          placeholder={
            swapping
              ? "Why this is form-fit-function equivalent, and needs no new revision…"
              : "What changed, and why it does not need a new revision…"
          }
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={!canSubmit}>
            {saving ? <Spinner size={12} /> : "Register star release"}
          </button>
        </div>
      </div>
    </>
  );
}
