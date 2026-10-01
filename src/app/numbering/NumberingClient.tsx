"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Spinner } from "@/components/ui";

type NumberingType = "PART" | "ASSEMBLY" | "DRAWING" | "RELEASE";
// A plain local copy, not imported from lib/numbering — that module pulls in
// the Mongoose models, which a "use client" file must never bundle.
const NUMBERING_TYPES: NumberingType[] = ["PART", "ASSEMBLY", "DRAWING", "RELEASE"];

const LABELS: Record<NumberingType, string> = {
  PART: "Part", ASSEMBLY: "Assembly", DRAWING: "Drawing", RELEASE: "Release",
};

/** What each scheme numbers, and where those numbers surface. */
const PURPOSE: Record<NumberingType, string> = {
  PART:
    "Parts, whether synced from a Part Studio or created here. Written onto the Onshape part, " +
    "and what Onshape's Release candidate dialog asks for.",
  ASSEMBLY:
    "Assemblies, which PLM holds as objects in their own right rather than only as containers " +
    "to explode.",
  DRAWING:
    "Drawing documents. Issued when a drawing arrives with a release package, since Onshape " +
    "attaches the active sheets itself.",
  RELEASE:
    "Releases. Travels to Onshape as the release package's changeOrderId, which is how a " +
    "package is traced back to PLM from the Onshape side.",
};

type Sequence = {
  type: NumberingType; prefix: string; suffix: string; padding: number; counter: number; next: string;
};

type LogEntry = {
  id: string; type: NumberingType; number: string; source: "manual" | "onshape";
  issuedByEmail: string; documentId: string; elementId: string; partId: string; createdAt: string;
};

type CategoryScheme = {
  id: string; type: NumberingType; onshapeCategoryId: string; onshapeCategoryName: string;
  prefix: string; suffix: string; padding: number; counter: number; next: string;
};

type SeenCategory = {
  type: NumberingType; onshapeCategoryId: string; onshapeCategoryName: string; lastSeenAt: string;
};

export function NumberingClient({ isAdmin }: { isAdmin: boolean }) {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [categorySchemes, setCategorySchemes] = useState<CategoryScheme[]>([]);
  const [seenCategories, setSeenCategories] = useState<SeenCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [main, cats] = await Promise.all([
        fetch("/api/numbering"),
        fetch("/api/numbering/categories"),
      ]);
      const data = await main.json();
      if (!main.ok) throw new Error(data.error || "Failed to load");
      setSequences(data.sequences ?? []);
      setLog(data.log ?? []);

      const catData = await cats.json();
      if (cats.ok) {
        setCategorySchemes(catData.schemes ?? []);
        setSeenCategories(catData.seen ?? []);
      }
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
        <h1 style={{ fontSize: 20, margin: "0 0 3px", letterSpacing: "-.02em" }}>Numbering</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.55, maxWidth: 760 }}>
          PLM is the number master. Every part, assembly, drawing and release takes its identifier
          from a scheme below, and Onshape&rsquo;s own <em>Part number generator</em> extension calls
          in for one — which is what puts a PLM number on a part at the moment someone opens the
          Release candidate dialog, rather than after the fact.
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
        <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0, lineHeight: 1.6 }}>
          Once set, Onshape&rsquo;s Release candidate dialog, properties dialog, BOM table and
          configuration table can each request a number and apply it directly — PLM never writes it,
          because that write is Onshape&rsquo;s own job once it has an answer. It is a batch endpoint:
          Onshape may ask for several numbers in one call, so raising a release candidate over a set
          of unnumbered parts numbers them all at once. This location takes no method and no Action
          Body — Onshape decides the payload.
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

      <CategoryOverrides
        isAdmin={isAdmin}
        schemes={categorySchemes}
        seen={seenCategories}
        onChanged={load}
      />

      <div className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Recently issued</h2>
        <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "0 0 12px", lineHeight: 1.55 }}>
          Most recent 25 numbers, across every type. A number is never reused, even one issued for a
          request that failed afterwards — it may already have been read, quoted or written onto a
          drawing, and two things wearing one number is worse than one number that looks unused.
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
      if (!res.ok) throw new Error(data.error || "Could not save this scheme");
      setEditing(false);
      onChanged();
    } catch (err: any) {
      // Reported rather than swallowed. A save that appears to do nothing is
      // indistinguishable from one that worked and displayed the old value,
      // and an admin has no way to tell which happened.
      setGenError(String(err.message ?? err));
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
      <div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>{LABELS[seq.type]}</h2>
          {isAdmin && (
            <button className="btn btn-sm" onClick={() => setEditing((e) => !e)}>
              {editing ? "Cancel" : "Edit"}
            </button>
          )}
        </div>
        {/* Four schemes look interchangeable without this; what each one
            numbers, and where those numbers surface, is the distinction. */}
        <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "4px 0 0", lineHeight: 1.5 }}>
          {PURPOSE[seq.type]}
        </p>
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

/**
 * Numbering schemes scoped to one Onshape category, on top of the plain
 * per-type schemes above.
 *
 * The category id is typed in, not picked from a live Onshape list — Onshape
 * does not publish whether categories nest or what an unfiltered read of them
 * returns, so there is nothing here yet to browse with confidence. What helps
 * instead: every category Onshape has actually sent on a real numbering
 * request is remembered, whether or not a scheme existed for it at the time —
 * "Recently seen" below turns into real candidates to assign a scheme to,
 * without hunting through Onshape's own admin screens for an id.
 */
function CategoryOverrides({
  isAdmin, schemes, seen, onChanged,
}: {
  isAdmin: boolean; schemes: CategoryScheme[]; seen: SeenCategory[]; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<NumberingType>("PART");
  const [categoryId, setCategoryId] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [padding, setPadding] = useState(5);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function useSeen(s: SeenCategory) {
    setAdding(true);
    setType(s.type);
    setCategoryId(s.onshapeCategoryId);
    setCategoryName(s.onshapeCategoryName);
  }

  async function addScheme() {
    if (!categoryId.trim()) {
      setFormError("A category id is required.");
      return;
    }
    setSaving(true); setFormError(null);
    try {
      const res = await fetch("/api/numbering/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type, onshapeCategoryId: categoryId.trim(), onshapeCategoryName: categoryName.trim(),
          prefix, suffix, padding: Number(padding),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add this scheme");
      setAdding(false);
      setCategoryId(""); setCategoryName(""); setPrefix(""); setSuffix(""); setPadding(5);
      onChanged();
    } catch (err: any) {
      setFormError(String(err.message ?? err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ padding: 18, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Category overrides</h2>
          <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: 0, lineHeight: 1.55, maxWidth: 640 }}>
            A part, assembly or drawing whose Onshape category matches one below is numbered from
            that scheme instead of the plain one above. A category with no scheme of its own falls
            back to the type&rsquo;s default — nothing here is inherited between categories.
          </p>
        </div>
        {isAdmin && !adding && (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>Add</button>
        )}
      </div>

      {adding && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 1fr", gap: 8 }}>
            <div>
              <label className="label">Type</label>
              <select className="input" value={type} onChange={(e) => setType(e.target.value as NumberingType)}>
                {NUMBERING_TYPES.map((t) => <option key={t} value={t}>{LABELS[t]}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Onshape category id</label>
              <input
                className="input mono" value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                placeholder="from Onshape's category admin screen"
              />
            </div>
            <div>
              <label className="label">Category name (display only)</label>
              <input className="input" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} />
            </div>
          </div>
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
          {formError && <Alert kind="error" onDismiss={() => setFormError(null)}>{formError}</Alert>}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={addScheme} disabled={saving}>
              {saving && <Spinner />} Add scheme
            </button>
            <button className="btn btn-sm" onClick={() => { setAdding(false); setFormError(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {schemes.length > 0 && (
        <div style={{ display: "grid", gap: 1 }}>
          {schemes.map((sc) => (
            <CategorySchemeRow key={sc.id} scheme={sc} isAdmin={isAdmin} onChanged={onChanged} />
          ))}
        </div>
      )}

      {schemes.length === 0 && !adding && (
        <p style={{ color: "var(--text-muted)", fontSize: 12.5, margin: 0 }}>
          No category-specific schemes yet — every part, assembly and drawing uses the plain scheme
          for its type above.
        </p>
      )}

      {seen.length > 0 && (
        <div>
          <div style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "6px 0 6px", fontWeight: 600 }}>
            Recently seen, not yet configured
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {seen.slice(0, 20).map((s) => (
              <button
                key={`${s.type}:${s.onshapeCategoryId}`}
                type="button"
                className="badge"
                disabled={!isAdmin}
                onClick={() => useSeen(s)}
                style={{
                  background: "var(--surface-2)", color: "var(--text-muted)", borderColor: "var(--border)",
                  cursor: isAdmin ? "pointer" : "default", fontSize: 11,
                }}
                title={`Onshape id: ${s.onshapeCategoryId}`}
              >
                {LABELS[s.type]} · {s.onshapeCategoryName || s.onshapeCategoryId}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CategorySchemeRow({
  scheme, isAdmin, onChanged,
}: {
  scheme: CategoryScheme; isAdmin: boolean; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [prefix, setPrefix] = useState(scheme.prefix);
  const [suffix, setSuffix] = useState(scheme.suffix);
  const [padding, setPadding] = useState(scheme.padding);
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function save() {
    setSaving(true); setRowError(null);
    try {
      const res = await fetch("/api/numbering/categories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: scheme.id, prefix, suffix, padding: Number(padding) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");
      setEditing(false);
      onChanged();
    } catch (err: any) {
      setRowError(String(err.message ?? err));
    } finally {
      setSaving(false);
    }
  }

  function remove() {
    if (!confirm(
      `Remove the ${LABELS[scheme.type]} scheme for "${scheme.onshapeCategoryName || scheme.onshapeCategoryId}"? ` +
      `Numbers already issued under it are unaffected — this category just falls back to the ` +
      `${LABELS[scheme.type]} default from now on.`
    )) return;
    fetch("/api/numbering/categories", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: scheme.id }),
    }).then(onChanged);
  }

  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid var(--border)", display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span
          className="badge"
          style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderColor: "var(--border)", minWidth: 70, justifyContent: "center" }}
        >
          {LABELS[scheme.type]}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {scheme.onshapeCategoryName || <span className="mono">{scheme.onshapeCategoryId}</span>}
        </span>
        {scheme.onshapeCategoryName && (
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-faint)" }}>{scheme.onshapeCategoryId}</span>
        )}
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{scheme.next}</span>
        {isAdmin && (
          <>
            <button className="btn btn-sm" onClick={() => setEditing((e) => !e)}>{editing ? "Cancel" : "Edit"}</button>
            <button className="btn btn-sm btn-danger" onClick={remove}>Remove</button>
          </>
        )}
      </div>

      {editing && (
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
          {rowError && <Alert kind="error" onDismiss={() => setRowError(null)}>{rowError}</Alert>}
          <div>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
              {saving && <Spinner />} Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
