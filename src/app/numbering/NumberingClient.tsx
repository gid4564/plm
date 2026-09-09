"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Spinner } from "@/components/ui";

type NumberingType = "PART" | "ASSEMBLY" | "DRAWING";

const LABELS: Record<NumberingType, string> = {
  PART: "Part", ASSEMBLY: "Assembly", DRAWING: "Drawing",
};

type Sequence = {
  type: NumberingType; prefix: string; suffix: string; padding: number; counter: number; next: string;
};

type LogEntry = {
  id: string; type: NumberingType; number: string; source: "manual" | "onshape";
  issuedByEmail: string; documentId: string; elementId: string; partId: string; createdAt: string;
};

export function NumberingClient({ isAdmin }: { isAdmin: boolean }) {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/numbering");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setSequences(data.sequences ?? []);
      setLog(data.log ?? []);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const extensionUrl = typeof window !== "undefined" ? `${window.location.origin}/api/numbering/onshape-extension` : "";

  function copyUrl() {
    navigator.clipboard?.writeText(extensionUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (loading) {
    return <div style={{ padding: 44, textAlign: "center", color: "var(--text-muted)" }}><Spinner size={18} /></div>;
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 3px", letterSpacing: "-.02em" }}>Part Numbering</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.55 }}>
          A standalone number generator — not part of the manufacturing order system. Onshape's own
          "Part number generator" app extension calls this tool directly to hand out and apply the
          next number, the way an external numbering app would.
        </p>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div className="card" style={{ padding: 16, display: "grid", gap: 8 }}>
        <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>Connect Onshape to this tool</h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.6 }}>
          In your Onshape app's Developer Settings, open <strong>Extensions</strong> →{" "}
          <strong>Add extension</strong>, set Location to <strong>Part number generator</strong>, and
          use this as the Action URL:
        </p>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="input mono" style={{ fontSize: 12 }} value={extensionUrl} readOnly />
          <button className="btn btn-sm" onClick={copyUrl} type="button">{copied ? "Copied" : "Copy"}</button>
        </div>
        <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0 }}>
          Once set, Onshape's own Release dialog, properties dialog, BOM table and configuration table
          can all request a number from this tool and apply it directly — no MOS UI involved.
        </p>
      </div>

      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {sequences.map((seq) => (
          <TypeCard
            key={seq.type}
            seq={seq}
            isAdmin={isAdmin}
            onChanged={load}
            onIssued={(n) => { setNotice(n); load(); }}
          />
        ))}
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Recently issued</h2>
        <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "0 0 12px" }}>
          Most recent 25 numbers, across every type. A number is never reused, even one issued for a
          request that failed afterward.
        </p>
        {log.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>Nothing issued yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 1 }}>
            {log.map((l) => (
              <div
                key={l.id}
                style={{
                  display: "flex", gap: 11, padding: "8px 0", borderBottom: "1px solid var(--border)",
                  fontSize: 12.5, alignItems: "baseline",
                }}
              >
                <span
                  className="badge"
                  style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderColor: "var(--border)", minWidth: 70, justifyContent: "center", flexShrink: 0 }}
                >
                  {LABELS[l.type]}
                </span>
                <span className="mono" style={{ fontWeight: 600, flexShrink: 0 }}>{l.number}</span>
                <span style={{ flex: 1, minWidth: 0, color: "var(--text-muted)" }} className="mono">
                  {l.documentId ? `${l.documentId.slice(0, 8)}… / ${l.elementId.slice(0, 8)}…${l.partId ? ` / ${l.partId}` : ""}` : (
                    <span style={{ color: "var(--text-faint)" }}>generated only</span>
                  )}
                </span>
                <span style={{ color: "var(--text-faint)", fontSize: 11, flexShrink: 0 }}>
                  {l.source === "onshape" ? "from Onshape" : l.issuedByEmail}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TypeCard({
  seq, isAdmin, onChanged, onIssued,
}: {
  seq: Sequence; isAdmin: boolean; onChanged: () => void; onIssued: (notice: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [prefix, setPrefix] = useState(seq.prefix);
  const [suffix, setSuffix] = useState(seq.suffix);
  const [padding, setPadding] = useState(seq.padding);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  async function saveConfig() {
    setSaving(true);
    try {
      const res = await fetch("/api/numbering", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: seq.type, prefix, suffix, padding: Number(padding) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEditing(false);
      onChanged();
    } catch {
      // Fields simply do not update; pressing Save again after fixing the
      // value works normally, so a card-local alert would add more state for
      // a rare admin-only mistake than it is worth.
    } finally {
      setSaving(false);
    }
  }

  function resetCounter() {
    if (!confirm(`Reset the ${LABELS[seq.type]} counter to 0? Numbers already issued are not affected.`)) return;
    fetch("/api/numbering", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: seq.type, resetCounter: true }),
    }).then(onChanged);
  }

  async function generate() {
    setGenerating(true); setGenError(null);
    try {
      const res = await fetch("/api/numbering/next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: seq.type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not generate a number");
      onIssued(`Generated ${data.number}.`);
    } catch (err: any) {
      setGenError(String(err.message ?? err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>{LABELS[seq.type]}</h2>
        {isAdmin && (
          <button className="btn btn-sm" onClick={() => setEditing((e) => !e)}>
            {editing ? "Cancel" : "Edit"}
          </button>
        )}
      </div>

      {editing ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 70px", gap: 8 }}>
            <div>
              <label className="label">Prefix</label>
              <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            </div>
            <div>
              <label className="label">Suffix</label>
              <input className="input mono" value={suffix} onChange={(e) => setSuffix(e.target.value)} />
            </div>
            <div>
              <label className="label">Digits</label>
              <input
                className="input" type="number" min={0} max={10} value={padding}
                onChange={(e) => setPadding(Number(e.target.value))}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={saveConfig} disabled={saving}>
              {saving && <Spinner />} Save
            </button>
            <button className="btn btn-sm btn-danger" onClick={resetCounter} type="button">
              Reset counter
            </button>
          </div>
        </div>
      ) : (
        <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {seq.prefix}#####{seq.suffix} · issued {seq.counter}
        </div>
      )}

      <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.01em" }} className="mono">
        {seq.next}
      </div>
      <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0 }}>Next number, if generated now.</p>

      {genError && <Alert kind="error" onDismiss={() => setGenError(null)}>{genError}</Alert>}

      <button className="btn btn-primary" onClick={generate} disabled={generating}>
        {generating && <Spinner />} Generate
      </button>
    </div>
  );
}
