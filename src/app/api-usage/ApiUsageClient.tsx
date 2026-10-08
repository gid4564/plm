"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Spinner } from "@/components/ui";

/* -------------------------------------------------------------------------- */
/* Types — what /api/admin/api-usage returns                                    */
/* -------------------------------------------------------------------------- */

type Overview = {
  window: { from: string; to: string; bucketMs: number };
  totals: {
    calls: number; runs: number; errors: number; retries: number; throttled: number;
    avgMs: number; bytes: number; avgPerRun: number;
  };
  today: number;
  monthToDate: number;
  recordedSince: string | null;
  byProcess: {
    process: string; calls: number; runs: number; errors: number;
    avgPerRun: number; maxPerRun: number; avgMs: number;
  }[];
  bySteps: { step: string; process: string; calls: number; errors: number }[];
  byEndpoint: {
    method: string; endpoint: string; calls: number; errors: number;
    avgMs: number; maxMs: number; bytes: number;
  }[];
  timeline: { at: string; calls: number; errors: number }[];
  byStatus: { status: number; calls: number }[];
  facets: { processes: string[]; steps: string[] };
};

type Run = {
  runId: string; process: string; origin: string; startedAt: string; durationMs: number;
  calls: number; errors: number; retries: number; subject: string; subjectCount: number; steps: string[];
};

type Call = {
  id: string; at: string; runId: string; process: string; step: string; subject: string;
  method: string; endpoint: string; path: string; status: number; ok: boolean;
  ms: number; bytes: number; attempt: number; error: string;
};

type Filters = {
  range: number; process: string; step: string; status: string; method: string; q: string;
};

type Tab = "process" | "runs" | "calls" | "endpoints";

const RANGES: { label: string; minutes: number }[] = [
  { label: "15 min", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "6 hours", minutes: 360 },
  { label: "24 hours", minutes: 1440 },
  { label: "7 days", minutes: 10080 },
  { label: "30 days", minutes: 43200 },
];

const STATUS_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "Any result" },
  { value: "ok", label: "Succeeded" },
  { value: "error", label: "Failed (any)" },
  { value: "429", label: "Throttled (429)" },
  { value: "4xx", label: "Client errors (4xx)" },
  { value: "5xx", label: "Server errors (5xx)" },
  { value: "retry", label: "Retries only" },
  { value: "slow", label: "Slow (2s +)" },
];

const DEFAULTS: Filters = { range: 60, process: "", step: "", status: "", method: "", q: "" };

const POLL_MS = 4000;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const n = (v: number) => v.toLocaleString();

function dur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function bytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function clock(d: string | number | Date, withSeconds = true): string {
  return new Date(d).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

function dayTime(d: string | number | Date): string {
  const t = new Date(d);
  const same = t.toDateString() === new Date().toDateString();
  return same ? clock(t) : `${t.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(t, false)}`;
}

function statusStyle(status: number): React.CSSProperties {
  if (status >= 200 && status < 300) return { background: "var(--ok-soft)", color: "var(--ok)" };
  if (status === 429) return { background: "var(--warn-soft)", color: "var(--warn)" };
  if (status >= 300 && status < 400) return { background: "var(--surface-2)", color: "var(--text-muted)" };
  return { background: "var(--danger-soft)", color: "var(--danger)" };
}

function StatusBadge({ status }: { status: number }) {
  return (
    <span className="badge mono" style={statusStyle(status)}>
      {status === 0 ? "no reply" : status}
    </span>
  );
}

function MethodTag({ method }: { method: string }) {
  const write = method !== "GET";
  return (
    <span
      className="mono"
      style={{ fontWeight: 600, color: write ? "var(--warn)" : "var(--text-muted)", minWidth: 44, display: "inline-block" }}
    >
      {method}
    </span>
  );
}

/** A horizontal bar showing `value` as a share of `max`. */
function Share({ value, max, danger }: { value: number; max: number; danger?: boolean }) {
  const pct = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    <div style={{ height: 8, background: "var(--surface-2)", borderRadius: 4, minWidth: 90 }}>
      <div
        style={{
          width: `${pct}%`, height: "100%", borderRadius: 4,
          background: danger ? "var(--danger)" : "var(--accent)",
        }}
      />
    </div>
  );
}

function Tile({
  label, value, sub, tone, onClick, active,
}: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  tone?: "danger" | "warn"; onClick?: () => void; active?: boolean;
}) {
  const color = tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--text)";
  return (
    <div
      className="card"
      onClick={onClick}
      style={{
        padding: "12px 14px", cursor: onClick ? "pointer" : "default",
        borderColor: active ? "var(--accent)" : undefined,
        outline: active ? "1px solid var(--accent)" : undefined,
      }}
    >
      <div className="label" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 650, color, lineHeight: 1.15 }}>{value}</div>
      {sub != null && <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Timeline                                                                    */
/* -------------------------------------------------------------------------- */

function Timeline({ data, from, to, bucketMs }: {
  data: Overview["timeline"]; from: string; to: string; bucketMs: number;
}) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const first = Math.floor(start / bucketMs) * bucketMs;
  const count = Math.max(1, Math.ceil((end - first) / bucketMs));
  const byTime = new Map(data.map((d) => [new Date(d.at).getTime(), d]));
  const bars = Array.from({ length: count }, (_, i) => {
    const t = first + i * bucketMs;
    return { t, calls: byTime.get(t)?.calls ?? 0, errors: byTime.get(t)?.errors ?? 0 };
  });
  const max = Math.max(1, ...bars.map((b) => b.calls));
  const W = 1000, H = 110, gap = 2;
  const bw = W / bars.length;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 110, display: "block" }}>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - H * f * 0.92} y2={H - H * f * 0.92}
            stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="3 4" />
        ))}
        {bars.map((b, i) => {
          const h = (b.calls / max) * H * 0.92;
          const eh = (b.errors / max) * H * 0.92;
          const x = i * bw + gap / 2;
          const w = Math.max(1, bw - gap);
          return (
            <g key={b.t}>
              <title>
                {`${dayTime(b.t)} — ${n(b.calls)} call${b.calls === 1 ? "" : "s"}` +
                  (b.errors ? `, ${n(b.errors)} failed` : "")}
              </title>
              <rect x={x} y={0} width={w} height={H} fill="transparent" />
              {b.calls > 0 && <rect x={x} y={H - h} width={w} height={h} rx={1.5} fill="var(--accent)" opacity={0.85} />}
              {b.errors > 0 && <rect x={x} y={H - eh} width={w} height={eh} rx={1.5} fill="var(--danger)" />}
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
        <span>{dayTime(start)}</span>
        <span>peak {n(max)} calls per {dur(bucketMs).replace(/^1m 0s$/, "1 min")}</span>
        <span>{dayTime(end)}</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export function ApiUsageClient() {
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [tab, setTab] = useState<Tab>("process");
  const [live, setLive] = useState(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runSort, setRunSort] = useState<"recent" | "calls">("recent");
  const [calls, setCalls] = useState<Call[]>([]);
  const [callsNext, setCallsNext] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedCalls, setExpandedCalls] = useState<Record<string, Call[]>>({});
  const [detail, setDetail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [qDraft, setQDraft] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  // The latest filters, read by the poller without re-arming it on every keystroke.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const sortRef = useRef(runSort);
  sortRef.current = runSort;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const query = useCallback((f: Filters, extra: Record<string, string> = {}) => {
    const sp = new URLSearchParams();
    sp.set("range", String(f.range));
    for (const k of ["process", "step", "status", "method", "q"] as const) if (f[k]) sp.set(k, f[k]);
    for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    return sp.toString();
  }, []);

  const get = useCallback(async (qs: string) => {
    const r = await fetch(`/api/admin/api-usage?${qs}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not load API usage");
    return j;
  }, []);

  const refresh = useCallback(async () => {
    const f = filtersRef.current;
    try {
      const jobs: Promise<any>[] = [get(query(f, { view: "overview" }))];
      if (tabRef.current === "runs") jobs.push(get(query(f, { view: "runs", sort: sortRef.current === "calls" ? "calls" : "recent" })));
      if (tabRef.current === "calls") jobs.push(get(query(f, { view: "calls", limit: "100" })));
      const [ov, extra] = await Promise.all(jobs);
      setOverview(ov);
      if (tabRef.current === "runs" && extra) setRuns(extra.runs);
      if (tabRef.current === "calls" && extra) { setCalls(extra.calls); setCallsNext(extra.next); }
      if (expandedRef.current) {
        const id = expandedRef.current;
        const c = await get(query(f, { view: "calls", runId: id, limit: "500" }));
        setExpandedCalls((m) => ({ ...m, [id]: [...c.calls].reverse() }));
      }
      setUpdatedAt(new Date());
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [get, query]);

  // Reload when the question changes.
  useEffect(() => {
    setLoading(true);
    refresh();
  }, [filters, tab, runSort, refresh]);

  // And keep asking while live.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [live, refresh]);

  // Debounce the search box into the filters.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === qDraft ? f : { ...f, q: qDraft })), 350);
    return () => clearTimeout(t);
  }, [qDraft]);

  const setF = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const clear = () => { setFilters({ ...DEFAULTS, range: filters.range }); setQDraft(""); };

  const active = (["process", "step", "status", "method", "q"] as const).filter((k) => filters[k]);
  const hasFilters = active.length > 0;

  async function loadMoreCalls() {
    if (!callsNext) return;
    try {
      const j = await get(query(filters, { view: "calls", limit: "100", before: callsNext }));
      setCalls((c) => [...c, ...j.calls]);
      setCallsNext(j.next);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  async function toggleRun(id: string) {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    try {
      const c = await get(query(filters, { view: "calls", runId: id, limit: "500" }));
      setExpandedCalls((m) => ({ ...m, [id]: [...c.calls].reverse() }));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  /** Jump to the calls behind a number someone clicked. */
  function drill(patch: Partial<Filters>, to: Tab = "calls") {
    // A search typed by drilling in must reach the box too, or its debounce
    // would put the old text straight back.
    if (patch.q !== undefined) setQDraft(patch.q);
    setFilters((f) => ({ ...f, ...patch }));
    setTab(to);
  }

  const t = overview?.totals;
  const topProcess = overview?.byProcess[0];
  const maxProcessCalls = Math.max(1, ...(overview?.byProcess ?? []).map((p) => p.calls));
  const maxEndpointCalls = Math.max(1, ...(overview?.byEndpoint ?? []).map((p) => p.calls));
  const stepsForProcess = useMemo(
    () => (overview?.bySteps ?? []).filter((s) => s.step),
    [overview]
  );
  const maxStepCalls = Math.max(1, ...stepsForProcess.map((s) => s.calls));

  const rangeLabel = RANGES.find((r) => r.minutes === filters.range)?.label ?? `${filters.range} min`;
  const reachesPastData =
    overview?.recordedSince && new Date(overview.window.from) < new Date(overview.recordedSince);

  return (
    <div style={{ maxWidth: 1240, margin: "0 auto", padding: "24px 20px 60px" }}>
      {/* ------------------------------ header ------------------------------ */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 14 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <h1 style={{ fontSize: 22, fontWeight: 650, margin: 0 }}>API usage</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            Every request PLM sends to Onshape, counted against the process that caused it.{" "}
            <button
              className="link" onClick={() => setShowHelp((v) => !v)}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
            >
              {showHelp ? "Hide" : "How to read this"}
            </button>
          </p>
        </div>

        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 7, overflow: "hidden" }}>
            {RANGES.map((r) => (
              <button
                key={r.minutes}
                onClick={() => setF({ range: r.minutes })}
                style={{
                  padding: "6px 10px", fontSize: 12.5, border: "none", cursor: "pointer",
                  borderRight: "1px solid var(--border)",
                  background: filters.range === r.minutes ? "var(--accent)" : "var(--surface)",
                  color: filters.range === r.minutes ? "#fff" : "var(--text)",
                  fontWeight: filters.range === r.minutes ? 600 : 450,
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-sm"
            onClick={() => setLive((v) => !v)}
            title={live ? "Updating every few seconds — click to pause" : "Paused — click to go live"}
            style={live ? { borderColor: "var(--ok)", color: "var(--ok)" } : undefined}
          >
            <span
              style={{
                width: 8, height: 8, borderRadius: "50%",
                background: live ? "var(--ok)" : "var(--text-faint)",
                boxShadow: live ? "0 0 0 3px var(--ok-soft)" : "none",
              }}
            />
            {live ? "Live" : "Paused"}
          </button>
          <button className="btn btn-sm" onClick={() => { setLoading(true); refresh(); }}>Refresh</button>
        </div>
      </div>

      {showHelp && (
        <div className="card" style={{ marginBottom: 14, fontSize: 13, lineHeight: 1.6 }}>
          <strong>Call</strong> — one HTTP request sent to Onshape. A retry after a gateway error or an expired
          token is a call of its own, because Onshape counts what was sent.
          <br />
          <strong>Run</strong> — everything one process did, start to finish: one BOM import, one webhook, one click
          on Re-sync. Several parts synced in a single bulk re-sync are one run.
          <br />
          <strong>Process</strong> is what started the run (a page, a webhook). <strong>Step</strong> is the piece of
          work inside it that made the call — for a bulk re-sync, every call is a "Part sync" step.
          <br />
          Click any process, step, endpoint or tile to filter to it. Only live Onshape traffic is counted; the
          simulator makes no calls.
        </div>
      )}

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {reachesPastData && (
        <Alert kind="warn">
          Calls have only been recorded since {dayTime(overview!.recordedSince!)}, so {rangeLabel.toLowerCase()} is
          not fully covered.
        </Alert>
      )}

      {/* ------------------------------- tiles ------------------------------ */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
        <Tile
          label={`Calls · ${rangeLabel}`}
          value={t ? n(t.calls) : "—"}
          sub={t ? `${n(t.runs)} run${t.runs === 1 ? "" : "s"}` : undefined}
        />
        <Tile
          label="Average per run"
          value={t ? t.avgPerRun : "—"}
          sub={topProcess ? `Heaviest: ${topProcess.process}` : undefined}
        />
        <Tile
          label="Failed"
          value={t ? n(t.errors) : "—"}
          tone={t && t.errors ? "danger" : undefined}
          sub={t && t.calls ? `${((t.errors / t.calls) * 100).toFixed(1)}% of calls` : undefined}
          onClick={t && t.errors ? () => drill({ status: "error" }) : undefined}
          active={filters.status === "error"}
        />
        <Tile
          label="Throttled (429)"
          value={t ? n(t.throttled) : "—"}
          tone={t && t.throttled ? "warn" : undefined}
          sub="Onshape asking PLM to slow down"
          onClick={t && t.throttled ? () => drill({ status: "429" }) : undefined}
          active={filters.status === "429"}
        />
        <Tile
          label="Retries"
          value={t ? n(t.retries) : "—"}
          sub={t ? `avg ${t.avgMs} ms per call` : undefined}
          onClick={t && t.retries ? () => drill({ status: "retry" }) : undefined}
          active={filters.status === "retry"}
        />
        <Tile
          label="Today · this month"
          value={overview ? `${n(overview.today)}` : "—"}
          sub={overview ? `${n(overview.monthToDate)} so far this month` : undefined}
        />
      </div>

      {/* ----------------------------- timeline ----------------------------- */}
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span className="label" style={{ margin: 0 }}>Calls over time</span>
          <span style={{ fontSize: 11.5, color: "var(--text-faint)", display: "flex", gap: 12, alignItems: "center" }}>
            <span><span style={{ color: "var(--accent)" }}>■</span> calls</span>
            <span><span style={{ color: "var(--danger)" }}>■</span> failed</span>
            {updatedAt && <span>updated {clock(updatedAt)}</span>}
          </span>
        </div>
        {overview ? (
          <Timeline
            data={overview.timeline} from={overview.window.from}
            to={overview.window.to} bucketMs={overview.window.bucketMs}
          />
        ) : (
          <div style={{ height: 110, display: "flex", alignItems: "center", justifyContent: "center" }}><Spinner /></div>
        )}
      </div>

      {/* ------------------------------ filters ----------------------------- */}
      <div className="card" style={{ marginBottom: 12, padding: "10px 12px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <select className="select" value={filters.process} onChange={(e) => setF({ process: e.target.value })} aria-label="Process">
            <option value="">All processes</option>
            {(overview?.facets.processes ?? []).map((p) => <option key={p}>{p}</option>)}
            {filters.process && !overview?.facets.processes.includes(filters.process) && <option>{filters.process}</option>}
          </select>
          <select className="select" value={filters.step} onChange={(e) => setF({ step: e.target.value })} aria-label="Step">
            <option value="">All steps</option>
            {(overview?.facets.steps ?? []).map((p) => <option key={p}>{p}</option>)}
            {filters.step && !overview?.facets.steps.includes(filters.step) && <option>{filters.step}</option>}
          </select>
          <select className="select" value={filters.status} onChange={(e) => setF({ status: e.target.value })} aria-label="Result">
            {STATUS_CHOICES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select className="select" value={filters.method} onChange={(e) => setF({ method: e.target.value })} aria-label="Method">
            <option value="">GET and writes</option>
            <option value="GET">Reads (GET)</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
          </select>
          <input
            className="input" placeholder="Search endpoint, part or process…"
            value={qDraft} onChange={(e) => setQDraft(e.target.value)} aria-label="Search"
            style={{ gridColumn: "span 2" }}
          />
        </div>
        {hasFilters && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>Showing only:</span>
            {active.map((k) => (
              <span key={k} className="badge" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                {k === "q" ? `“${filters.q}”` : filters[k]}
                <button
                  aria-label={`Remove ${k} filter`}
                  onClick={() => { setF({ [k]: "" } as Partial<Filters>); if (k === "q") setQDraft(""); }}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", padding: 0, fontSize: 13, lineHeight: 1 }}
                >
                  ×
                </button>
              </span>
            ))}
            <button className="link" onClick={clear} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12 }}>
              Clear all
            </button>
          </div>
        )}
      </div>

      {/* ------------------------------- tabs ------------------------------- */}
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border)", marginBottom: 10 }}>
        {([
          ["process", "By process"],
          ["runs", "Runs"],
          ["calls", "Live calls"],
          ["endpoints", "Endpoints"],
        ] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k} onClick={() => setTab(k)}
            style={{
              padding: "8px 14px", fontSize: 13, background: "none", border: "none", cursor: "pointer",
              borderBottom: `2px solid ${tab === k ? "var(--accent)" : "transparent"}`,
              color: tab === k ? "var(--accent)" : "var(--text-muted)",
              fontWeight: tab === k ? 600 : 450, marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
        {loading && <span style={{ marginLeft: "auto", alignSelf: "center" }}><Spinner /></span>}
      </div>

      {overview && overview.totals.calls === 0 && tab !== "calls" ? (
        <EmptyState hasFilters={hasFilters} onClear={clear} />
      ) : (
        <>
          {/* ----------------------------- by process ---------------------------- */}
          {tab === "process" && overview && (
            <>
              <div className="card" style={{ padding: 0, overflowX: "auto", marginBottom: 14 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Process</th><th style={{ width: "22%" }}>Share of calls</th>
                      <th style={{ textAlign: "right" }}>Calls</th>
                      <th style={{ textAlign: "right" }}>Runs</th>
                      <th style={{ textAlign: "right" }} title="Calls per run, on average">Avg / run</th>
                      <th style={{ textAlign: "right" }} title="The most calls any single run made">Max / run</th>
                      <th style={{ textAlign: "right" }}>Failed</th>
                      <th style={{ textAlign: "right" }}>Avg time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.byProcess.map((p) => (
                      <tr key={p.process}>
                        <td>
                          <button
                            className="link" onClick={() => drill({ process: p.process, step: "" }, "runs")}
                            style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 550, padding: 0, font: "inherit" }}
                            title="Show this process's runs"
                          >
                            {p.process}
                          </button>
                        </td>
                        <td><Share value={p.calls} max={maxProcessCalls} /></td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{n(p.calls)}</td>
                        <td style={{ textAlign: "right" }}>{n(p.runs)}</td>
                        <td style={{ textAlign: "right" }}>{p.avgPerRun}</td>
                        <td style={{ textAlign: "right" }}>{n(p.maxPerRun)}</td>
                        <td style={{ textAlign: "right", color: p.errors ? "var(--danger)" : "var(--text-faint)" }}>
                          {p.errors ? (
                            <button
                              onClick={() => drill({ process: p.process, status: "error" })}
                              style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", font: "inherit", textDecoration: "underline", padding: 0 }}
                            >
                              {n(p.errors)}
                            </button>
                          ) : "0"}
                        </td>
                        <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{dur(p.avgMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {stepsForProcess.length > 0 && (
                <>
                  <div className="label" style={{ margin: "4px 2px 6px" }}>
                    Which step inside each process makes the calls
                  </div>
                  <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Process</th><th>Step</th><th style={{ width: "22%" }}>Share</th>
                          <th style={{ textAlign: "right" }}>Calls</th>
                          <th style={{ textAlign: "right" }}>Failed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stepsForProcess.map((s) => (
                          <tr key={`${s.process}|${s.step}`}>
                            <td style={{ color: "var(--text-muted)" }}>{s.process}</td>
                            <td>
                              <button
                                className="link" onClick={() => drill({ process: s.process, step: s.step }, "calls")}
                                style={{ background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit" }}
                              >
                                {s.step}
                              </button>
                            </td>
                            <td><Share value={s.calls} max={maxStepCalls} /></td>
                            <td style={{ textAlign: "right", fontWeight: 600 }}>{n(s.calls)}</td>
                            <td style={{ textAlign: "right", color: s.errors ? "var(--danger)" : "var(--text-faint)" }}>{n(s.errors)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {/* -------------------------------- runs ------------------------------- */}
          {tab === "runs" && (
            <>
              <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center", fontSize: 12.5, color: "var(--text-muted)" }}>
                Sort
                <button className="btn btn-sm" style={runSort === "recent" ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined} onClick={() => setRunSort("recent")}>Newest</button>
                <button className="btn btn-sm" style={runSort === "calls" ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined} onClick={() => setRunSort("calls")}>Most calls</button>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-faint)" }}>
                  Click a run to see each call it made
                </span>
              </div>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 26 }} />
                      <th>Started</th><th>Process</th><th>About</th><th>Steps</th>
                      <th style={{ textAlign: "right" }}>Calls</th>
                      <th style={{ textAlign: "right" }}>Failed</th>
                      <th style={{ textAlign: "right" }}>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <React.Fragment key={r.runId}>
                        <tr onClick={() => toggleRun(r.runId)} style={{ cursor: "pointer" }}>
                          <td style={{ color: "var(--text-faint)" }}>{expanded === r.runId ? "▾" : "▸"}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{dayTime(r.startedAt)}</td>
                          <td style={{ fontWeight: 550 }}>{r.process}</td>
                          <td style={{ color: "var(--text-muted)" }}>{r.subject || "—"}</td>
                          <td>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {r.steps.slice(0, 3).map((s) => (
                                <span key={s} className="badge" style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>{s}</span>
                              ))}
                              {r.steps.length > 3 && <span style={{ fontSize: 11, color: "var(--text-faint)" }}>+{r.steps.length - 3}</span>}
                            </div>
                          </td>
                          <td style={{ textAlign: "right", fontWeight: 650 }}>{n(r.calls)}</td>
                          <td style={{ textAlign: "right", color: r.errors ? "var(--danger)" : "var(--text-faint)" }}>{n(r.errors)}</td>
                          <td style={{ textAlign: "right", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{dur(r.durationMs)}</td>
                        </tr>
                        {expanded === r.runId && (
                          <tr>
                            <td colSpan={8} style={{ background: "var(--surface-2)", padding: "8px 12px 12px 38px" }}>
                              {expandedCalls[r.runId] ? (
                                <CallTable calls={expandedCalls[r.runId]} detail={detail} setDetail={setDetail} compact />
                              ) : (
                                <Spinner />
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                    {!runs.length && !loading && (
                      <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--text-faint)", padding: 24 }}>No runs match.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* ------------------------------- live calls ------------------------------ */}
          {tab === "calls" && (
            <>
              <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <CallTable calls={calls} detail={detail} setDetail={setDetail} showRun onRun={(id) => { setTab("runs"); toggleRun(id); }} />
                {!calls.length && !loading && (
                  <div style={{ textAlign: "center", color: "var(--text-faint)", padding: 24, fontSize: 13 }}>
                    {hasFilters ? "No calls match these filters." : "No calls in this window yet."}
                  </div>
                )}
              </div>
              {callsNext && (
                <div style={{ textAlign: "center", marginTop: 10 }}>
                  <button className="btn btn-sm" onClick={loadMoreCalls}>Load older calls</button>
                </div>
              )}
            </>
          )}

          {/* ------------------------------- endpoints ------------------------------- */}
          {tab === "endpoints" && overview && (
            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Onshape endpoint</th><th style={{ width: "18%" }}>Share</th>
                    <th style={{ textAlign: "right" }}>Calls</th>
                    <th style={{ textAlign: "right" }}>Failed</th>
                    <th style={{ textAlign: "right" }}>Avg time</th>
                    <th style={{ textAlign: "right" }}>Slowest</th>
                    <th style={{ textAlign: "right" }}>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.byEndpoint.map((e) => (
                    <tr key={`${e.method} ${e.endpoint}`}>
                      <td>
                        <button
                          className="mono link" title="Show these calls"
                          onClick={() => drill({ q: e.endpoint, method: e.method })}
                          style={{ background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}
                        >
                          <MethodTag method={e.method} /> {e.endpoint}
                        </button>
                      </td>
                      <td><Share value={e.calls} max={maxEndpointCalls} /></td>
                      <td style={{ textAlign: "right", fontWeight: 600 }}>{n(e.calls)}</td>
                      <td style={{ textAlign: "right", color: e.errors ? "var(--danger)" : "var(--text-faint)" }}>{n(e.errors)}</td>
                      <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{dur(e.avgMs)}</td>
                      <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{dur(e.maxMs)}</td>
                      <td style={{ textAlign: "right", color: "var(--text-muted)" }}>{e.bytes ? bytes(e.bytes) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );

}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

function CallTable({
  calls, detail, setDetail, compact, showRun, onRun,
}: {
  calls: Call[]; detail: string | null; setDetail: (id: string | null) => void;
  compact?: boolean; showRun?: boolean; onRun?: (runId: string) => void;
}) {
  return (
    <table className="table" style={compact ? { fontSize: 12.5 } : undefined}>
      {!compact && (
        <thead>
          <tr>
            <th>Time</th><th>Process › step</th><th>Request</th>
            <th>Result</th><th style={{ textAlign: "right" }}>Time taken</th>
          </tr>
        </thead>
      )}
      <tbody>
        {calls.map((c) => (
          <React.Fragment key={c.id}>
            <tr onClick={() => setDetail(detail === c.id ? null : c.id)} style={{ cursor: "pointer" }}>
              <td className="mono" style={{ whiteSpace: "nowrap", color: "var(--text-muted)" }}>{clock(c.at)}</td>
              {!compact && (
                <td>
                  <span style={{ fontWeight: 550 }}>{c.process}</span>
                  {c.step && c.step !== c.process && <span style={{ color: "var(--text-faint)" }}> › {c.step}</span>}
                  {c.subject && <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{c.subject}</div>}
                </td>
              )}
              {compact && c.step && <td style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{c.step}{c.subject ? ` · ${c.subject}` : ""}</td>}
              <td className="mono" style={{ wordBreak: "break-all" }}>
                <MethodTag method={c.method} /> {c.endpoint}
                {c.attempt > 0 && (
                  <span className="badge" style={{ marginLeft: 6, background: "var(--warn-soft)", color: "var(--warn)" }}>retry {c.attempt}</span>
                )}
              </td>
              <td><StatusBadge status={c.status} /></td>
              <td style={{ textAlign: "right", color: c.ms >= 2000 ? "var(--warn)" : "var(--text-muted)", whiteSpace: "nowrap" }}>{dur(c.ms)}</td>
            </tr>
            {detail === c.id && (
              <tr>
                <td colSpan={compact ? 5 : 5} style={{ background: "var(--surface-2)" }}>
                  <div className="mono" style={{ wordBreak: "break-all", lineHeight: 1.7 }}>
                    <div><span style={{ color: "var(--text-faint)" }}>Request </span>{c.method} {c.path}</div>
                    <div>
                      <span style={{ color: "var(--text-faint)" }}>Started by </span>{c.process}
                      {c.step && c.step !== c.process ? ` › ${c.step}` : ""}
                      {c.subject ? ` · ${c.subject}` : ""}
                    </div>
                    <div>
                      <span style={{ color: "var(--text-faint)" }}>Took </span>{dur(c.ms)}
                      {c.bytes ? <> · {bytes(c.bytes)}</> : null}
                      {" · "}{new Date(c.at).toLocaleString()}
                    </div>
                    {c.error && <div style={{ color: "var(--danger)" }}>{c.error}</div>}
                    {showRun && onRun && (
                      <button
                        className="btn btn-sm" style={{ marginTop: 6 }}
                        onClick={(e) => { e.stopPropagation(); onRun(c.runId); }}
                      >
                        See the whole run
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

function EmptyState({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  return (
    <div className="card" style={{ textAlign: "center", padding: 36, color: "var(--text-muted)" }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
        {hasFilters ? "No calls match these filters" : "No Onshape calls in this window"}
      </div>
      <div style={{ fontSize: 13, maxWidth: 460, margin: "0 auto" }}>
        {hasFilters
          ? "Widen the time range or clear a filter."
          : "Either nothing has talked to Onshape in this period, or this install only has the simulator, which makes no real API calls. Sync a part and it will appear here within a few seconds."}
      </div>
      {hasFilters && <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={onClear}>Clear filters</button>}
    </div>
  );
}
