"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, Spinner, StatusBadge, relTime } from "@/components/ui";

type Release = {
  id: string;
  number: string;
  title: string;
  origin: "onshape" | "plm";
  state: string;
  onshapeState: string;
  onshapeReleasePackageId: string | null;
  partCount: number;
  drawingCount: number;
  validationFailureCount: number;
  submittedByEmail: string | null;
  submittedAt: string | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
  transitionError: string | null;
  drawingRefreshPending: boolean;
  updatedAt: string;
};

const STATES = ["Under Review", "Approved", "Released", "Rejected", "Cancelled"];

export function ReleasesClient({ initialState }: { initialState: string }) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState(initialState);
  const [total, setTotal] = useState(0);
  const [underReview, setUnderReview] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (state !== "all") p.set("state", state);
      const r = await fetch(`/api/releases?${p.toString()}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load releases");
      setReleases(j.releases);
      setTotal(j.total);
      setUnderReview(j.underReview);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [state]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 19 }}>Releases</h1>
        <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
          {loading ? "loading…" : `${releases.length} of ${total}`}
          {underReview ? ` · ${underReview} awaiting a decision` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <select className="select" style={{ width: 175 }} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="all">Any state</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : "Refresh"}
        </button>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

      {releases.length === 0 && !loading ? (
        <div className="card" style={{ padding: 36, textAlign: "center" }}>
          <p style={{ margin: "0 0 6px", color: "var(--text-muted)" }}>
            No releases yet.
          </p>
          <p style={{ margin: 0, color: "var(--text-faint)", fontSize: 12.5 }}>
            A release normally starts in Onshape: a designer raises a release candidate, and PLM
            takes over the approval from there. You can also select parts on the Parts page and
            submit them from here.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Release</th>
                <th>Title</th>
                <th style={{ width: 130 }}>PLM state</th>
                <th style={{ width: 120 }}>Onshape</th>
                <th style={{ width: 90 }}>Items</th>
                <th style={{ width: 100 }}>Started</th>
                <th>Decision</th>
                <th style={{ width: 110 }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/releases/${r.id}`} className="mono" style={{ fontWeight: 600 }}>
                      {r.number}
                    </Link>
                  </td>
                  <td style={{ fontSize: 12.5 }}>{r.title}</td>
                  <td>
                    <StatusBadge status={r.state} />
                    {r.transitionError && (
                      <div style={{ fontSize: 11, color: "var(--danger)" }} title={r.transitionError}>
                        Onshape refused
                      </div>
                    )}
                    {r.drawingRefreshPending && (
                      <div style={{ fontSize: 11, color: "var(--warn)" }}>
                        drawings outstanding
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }} className="mono">
                    {r.onshapeState || "—"}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.partCount} part{r.partCount === 1 ? "" : "s"}
                    {r.drawingCount ? <div>{r.drawingCount} drawing{r.drawingCount === 1 ? "" : "s"}</div> : null}
                    {r.validationFailureCount ? (
                      <div style={{ color: "var(--warn)" }}>{r.validationFailureCount} incomplete</div>
                    ) : null}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {/* Where a release began matters: it is the difference between
                        PLM taking over Onshape's process and PLM starting one. */}
                    <span className="badge" title={
                      r.origin === "onshape"
                        ? "A designer raised a release candidate in Onshape; PLM took it over"
                        : "Raised in PLM, which created the Onshape release package"
                    }>
                      {r.origin === "onshape" ? "Onshape" : "PLM"}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {r.decidedByEmail ? (
                      <>
                        {r.decidedByEmail}
                        <div style={{ fontSize: 11, color: "var(--text-faint)" }} title={r.decidedAt ?? ""}>
                          {relTime(r.decidedAt)}
                        </div>
                      </>
                    ) : (
                      <span style={{ color: "var(--warn)" }}>awaiting a decision</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-faint)" }} title={r.updatedAt}>
                    {relTime(r.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
