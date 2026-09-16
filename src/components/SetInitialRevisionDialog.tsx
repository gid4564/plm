"use client";

import { useEffect, useState } from "react";
import { Alert, Spinner } from "@/components/ui";

/**
 * Catching PLM's own record up to reality — an object released before PLM
 * tracked it, or directly in Onshape with no PLM release ever taken over.
 *
 * Neither a release nor a star release applies here: both assume PLM already
 * holds a revision to move from. Admin-only, and refused outright once a
 * real revision is on record — see lib/star-release.ts.
 */
export function SetInitialRevisionDialog({
  open, onClose, onDone, partId, partLabel,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (result: { revision: string }) => void;
  partId: string;
  partLabel?: string;
}) {
  const [revision, setRevision] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRevision("");
    setReason("");
    setError(null);
  }, [open]);

  if (!open) return null;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/parts/${partId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set-initial-revision",
          revision: revision.trim(),
          reason: reason.trim(),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not record the revision");
      onDone({ revision: j.initialRevision?.revision ?? revision.trim() });
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
        aria-label="Record an already-released revision"
        style={{
          position: "fixed", top: "10%", left: "50%", transform: "translateX(-50%)",
          width: "min(420px, 92vw)", maxHeight: "80vh", overflowY: "auto",
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 16px 48px rgba(0,0,0,.24)", zIndex: 61, padding: 18,
        }}
      >
        <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>Record an already-released revision</h3>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-faint)" }}>
          {partLabel || "This object"} has no revision in PLM — this is for something released
          before PLM tracked it, or released directly in Onshape with no PLM release taken over.
          Nothing is sent to Onshape, and this only works once: it refuses if a revision is
          already on record.
        </p>

        {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

        <label className="label">Revision</label>
        <input
          className="input"
          style={{ width: "100%", marginBottom: 12 }}
          placeholder="e.g. A"
          value={revision}
          onChange={(e) => setRevision(e.target.value)}
        />

        <label className="label">Reason</label>
        <textarea
          className="input"
          rows={3}
          style={{ width: "100%", resize: "vertical", marginBottom: 14 }}
          placeholder="Why this is already released outside PLM's own workflow…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={saving || !revision.trim() || !reason.trim()}
          >
            {saving ? <Spinner size={12} /> : "Record revision"}
          </button>
        </div>
      </div>
    </>
  );
}
