"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, PartThumb, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";

type Part = {
  id: string;
  number: string | null;
  name: string;
  kind: "part" | "assembly";
  revision: string;
  iteration: number;
  lifecycleState: string;
  onshapeState: string;
  material: string;
  classification: string;
  documentName: string;
  elementName: string;
  createdByEmail: string | null;
  releaseId: string | null;
  childCount: number;
  usedInCount: number;
  pushPending: boolean;
  writeBackBlocked: string | null;
  lastPushError: string | null;
  lastSyncedFromOnshapeAt: string | null;
  updatedAt: string;
};

export function PartsTable({
  states, myEmail, canDecide, underReview, initialState, initialKind, initialRelease,
}: {
  states: string[];
  myEmail: string;
  canDecide: boolean;
  underReview: number;
  initialState: string;
  initialKind: string;
  initialRelease: string;
}) {
  const [parts, setParts] = useState<Part[]>([]);
  const [stateFacets, setStateFacets] = useState<{ state: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [state, setState] = useState(initialState);
  const [kind, setKind] = useState(initialKind);
  const [owner, setOwner] = useState("all");
  const [releaseFilter, setReleaseFilter] = useState(initialRelease);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // Selection drives "Submit for release", which is the point of a list view
  // here rather than only a per-part action: a release is normally several
  // parts decided together.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<
    { ok: boolean; message: string; number?: string | null; releaseId?: string | null;
      failures?: { itemLabel: string; missing: string[] }[] } | null
  >(null);

  const query = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (state !== "all") p.set("state", state);
      if (kind !== "all") p.set("kind", kind);
      if (owner !== "all") p.set("owner", owner);
      if (releaseFilter !== "all") p.set("release", releaseFilter);
      if (cursor) p.set("cursor", cursor);
      return `/api/parts?${p.toString()}`;
    },
    [q, state, kind, owner, releaseFilter]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(query());
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load parts");
      setParts(j.parts);
      setStateFacets(j.states ?? []);
      setTotal(j.total);
      setNextCursor(j.nextCursor);
      // Anything no longer on screen cannot meaningfully stay selected.
      setSelected((prev) => new Set(j.parts.filter((p: Part) => prev.has(p.id)).map((p: Part) => p.id)));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  // Debounced so typing in the search box does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const r = await fetch(query(nextCursor));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load more");
      setParts((prev) => [...prev, ...j.parts]);
      setNextCursor(j.nextCursor);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Only pre-release parts can be put into a release. */
  const selectable = parts.filter((p) => p.lifecycleState === "In Work");
  const chosen = [...selected];

  async function submitForRelease() {
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const r = await fetch("/api/releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partIds: chosen }),
      });
      const j = await r.json();
      setSubmitResult({
        ok: Boolean(j.ok),
        message: j.message || j.error || "Unknown outcome",
        number: j.number ?? null,
        releaseId: j.releaseId ?? null,
        failures: j.validationFailures ?? [],
      });
      if (j.ok) {
        setSelected(new Set());
        load();
      }
    } catch (e: any) {
      setSubmitResult({ ok: false, message: String(e?.message ?? e) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 19 }}>Parts and assemblies</h1>
        <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
          {loading ? "loading…" : `${parts.length} of ${total}`}
        </span>
        <div style={{ flex: 1 }} />
        {stateFacets.map((f) => (
          <button
            key={f.state}
            className="btn btn-sm"
            onClick={() => setState(state === f.state ? "all" : f.state)}
            style={{
              borderColor: state === f.state ? "var(--accent)" : undefined,
              color: state === f.state ? "var(--accent)" : undefined,
            }}
          >
            {f.state} {f.count}
          </button>
        ))}
      </div>

      {underReview > 0 && (
        <Alert kind="warn">
          {underReview} release{underReview === 1 ? " is" : "s are"} waiting for a decision.{" "}
          <Link href="/releases?state=Under Review" style={{ color: "inherit", fontWeight: 600 }}>
            {canDecide ? "Review them" : "See them"}
          </Link>
          {!canDecide && " — an approver or admin has to decide."}
        </Alert>
      )}

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {submitResult && (
        <Alert kind={submitResult.ok ? "ok" : "warn"} onDismiss={() => setSubmitResult(null)}>
          <div>{submitResult.message}</div>
          {submitResult.releaseId && (
            <div style={{ marginTop: 6 }}>
              <Link href={`/releases/${submitResult.releaseId}`} style={{ color: "inherit", fontWeight: 600 }}>
                Open {submitResult.number}
              </Link>
            </div>
          )}
          {!!submitResult.failures?.length && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {submitResult.failures.map((f) => (
                <li key={f.itemLabel}>
                  <strong>{f.itemLabel}</strong> needs {f.missing.join(", ")}
                </li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          style={{ width: 240 }}
          placeholder="Search number, name, document…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="select" style={{ width: 130 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">Parts and assemblies</option>
          <option value="part">Parts only</option>
          <option value="assembly">Assemblies only</option>
        </select>
        <select className="select" style={{ width: 165 }} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="all">Any lifecycle state</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select" style={{ width: 160 }} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">Anyone</option>
          <option value="mine">Brought in by me</option>
          <option value="auto">Arrived automatically</option>
        </select>
        {releaseFilter !== "all" && (
          <button className="btn btn-sm" onClick={() => setReleaseFilter("all")}>
            Clear release filter ×
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : "Refresh"}
        </button>
      </div>

      {chosen.length > 0 && (
        <div
          className="card"
          style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 14px" }}
        >
          <strong style={{ fontSize: 13 }}>{chosen.length} selected</strong>
          <span style={{ color: "var(--text-faint)", fontSize: 12.5 }}>
            Raising a release here creates the Onshape release package too, then holds it for
            review in PLM.
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
          <button className="btn btn-primary btn-sm" onClick={submitForRelease} disabled={submitting}>
            {submitting ? <Spinner /> : "Submit for release"}
          </button>
        </div>
      )}

      {loading && parts.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--text-faint)" }}>
          <Spinner size={20} />
        </div>
      ) : parts.length === 0 ? (
        <div className="card" style={{ padding: 36, textAlign: "center" }}>
          <p style={{ margin: "0 0 14px", color: "var(--text-muted)" }}>
            Nothing here yet. Parts reach PLM from the Onshape panel, a &ldquo;Send to PLM&rdquo;
            context-menu action, an assembly import, or a release raised in Onshape.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <Link href="/bom" className="btn btn-primary">Import from an assembly</Link>
            <Link href="/simulator" className="btn">Open Onshape Simulator</Link>
          </div>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      aria-label="Select every part that can be released"
                      checked={selectable.length > 0 && selectable.every((p) => selected.has(p.id))}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(selectable.map((p) => p.id)) : new Set())
                      }
                      disabled={selectable.length === 0}
                    />
                  </th>
                  <th style={{ width: 46 }} />
                  <th>Number</th>
                  <th>Name</th>
                  <th>Rev</th>
                  <th>Lifecycle</th>
                  <th>Material</th>
                  <th>Make/buy</th>
                  <th>Structure</th>
                  <th>Onshape</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.number ?? p.name}`}
                        checked={selected.has(p.id)}
                        onChange={() => toggle(p.id)}
                        disabled={p.lifecycleState !== "In Work"}
                        title={
                          p.lifecycleState !== "In Work"
                            ? `${p.lifecycleState} — only a part In Work can be put into a release`
                            : undefined
                        }
                      />
                    </td>
                    <td><PartThumb partId={p.id} size={34} alt="" /></td>
                    <td>
                      <Link href={`/parts/${p.id}`} className="mono" style={{ fontWeight: 600 }}>
                        {p.number ?? "—"}
                      </Link>
                      {p.kind === "assembly" && (
                        <span className="badge" style={{ marginLeft: 6 }}>asm</span>
                      )}
                    </td>
                    <td>
                      <div>{p.name || <span style={{ color: "var(--text-faint)" }}>—</span>}</div>
                      <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                        {p.documentName}{p.elementName ? ` · ${p.elementName}` : ""}
                      </div>
                    </td>
                    <td><RevChip revision={p.revision} iteration={p.iteration} /></td>
                    <td>
                      <StatusBadge status={p.lifecycleState} />
                      {p.releaseId && (
                        <div style={{ fontSize: 11 }}>
                          <Link href={`/releases/${p.releaseId}`} style={{ color: "var(--text-faint)" }}>
                            in release
                          </Link>
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5 }}>{p.material || "—"}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {p.classification || <span style={{ color: "var(--warn)" }}>not set</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {p.childCount ? `${p.childCount} child${p.childCount === 1 ? "" : "ren"}` : ""}
                      {p.childCount && p.usedInCount ? " · " : ""}
                      {p.usedInCount ? `used in ${p.usedInCount}` : ""}
                      {!p.childCount && !p.usedInCount ? "—" : ""}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {p.writeBackBlocked ? (
                        <span title={p.writeBackBlocked} style={{ color: "var(--text-faint)" }}>
                          read-only
                        </span>
                      ) : p.pushPending ? (
                        <span title={p.lastPushError ?? ""} style={{ color: "var(--warn)" }}>
                          write pending
                        </span>
                      ) : (
                        <span style={{ color: "var(--ok)" }}>in step</span>
                      )}
                      {p.onshapeState && (
                        <div style={{ color: "var(--text-faint)", fontSize: 11 }}>{p.onshapeState}</div>
                      )}
                    </td>
                    <td style={{ fontSize: 12, color: "var(--text-faint)" }} title={p.updatedAt}>
                      {relTime(p.updatedAt)}
                      {p.createdByEmail === myEmail && (
                        <div style={{ fontSize: 11 }}>by you</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {nextCursor && (
            <div style={{ textAlign: "center" }}>
              <button className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? <Spinner /> : `Load more (${total - parts.length} left)`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
