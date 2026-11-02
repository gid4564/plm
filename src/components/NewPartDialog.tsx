"use client";

import { useEffect, useState } from "react";
import { Alert, Spinner } from "@/components/ui";

/**
 * Create a part in PLM, optionally with its files attached in the same step.
 *
 * Two requests rather than one — create, then upload — so a file the server
 * refuses (too large, empty) leaves a part that exists and says what went
 * wrong, rather than nothing at all. Either way it ends on the new part's
 * page, which is where "Create in Onshape" lives.
 */
export function NewPartDialog({
  open, onClose, onCreated, productId,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (part: { id: string; number: string }, uploadError: string | null) => void;
  /** File into this product; omitted, the part goes where the person is working. */
  productId?: string | null;
}) {
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setFiles([]);
    setError(null);
  }, [open]);

  if (!open) return null;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/parts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), productId: productId ?? null }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not create the part");
      const part = j.part as { id: string; number: string };

      let uploadError: string | null = null;
      if (files.length > 0) {
        const form = new FormData();
        for (const f of files) form.append("file", f);
        const u = await fetch(`/api/parts/${part.id}/attachments`, { method: "POST", body: form });
        if (!u.ok) {
          const uj = await u.json().catch(() => ({}));
          uploadError = uj.error || `The files were not attached (${u.status}).`;
        }
      }
      onCreated(part, uploadError);
    } catch (e: any) {
      setError(String(e?.message ?? e));
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
        aria-label="New part"
        style={{
          position: "fixed", top: "10%", left: "50%", transform: "translateX(-50%)",
          width: "min(440px, 92vw)", maxHeight: "80vh", overflowY: "auto",
          background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 16px 48px rgba(0,0,0,.24)", zIndex: 61, padding: 18,
        }}
      >
        <h3 style={{ margin: "0 0 4px", fontSize: 15 }}>New part</h3>
        <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-faint)" }}>
          Created in PLM with a new number. Attach a CAD file (STEP, Parasolid, SolidWorks…)
          and the part&rsquo;s page offers to create it in Onshape from that file. Other files
          — drawings, spec sheets — go with it.
        </p>

        {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

        <label className="label">Name</label>
        <input
          className="input"
          style={{ width: "100%", marginBottom: 12 }}
          placeholder="e.g. Mounting bracket"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !saving) void submit(); }}
        />

        <label className="label">Files</label>
        <input
          type="file"
          multiple
          style={{ width: "100%", marginBottom: 6, fontSize: 13 }}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <p style={{ margin: "0 0 14px", fontSize: 11.5, color: "var(--text-faint)" }}>
          Optional — files can be attached on the part&rsquo;s page later too.
        </p>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={saving || !name.trim()}>
            {saving ? <Spinner size={12} /> : "Create part"}
          </button>
        </div>
      </div>
    </>
  );
}
