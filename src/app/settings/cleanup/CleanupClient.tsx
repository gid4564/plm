"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, Spinner, StatusBadge } from "@/components/ui";

type Row = {
  id: string; moNumber: string | null; partName: string; partNumber: string;
  status: string; remarks: string; documentName: string; createdAt: string;
  signals: Record<string, boolean>; unused: boolean;
};

export function CleanupClient() {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState({ total: 0, unused: 0, inUse: 0 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [before, setBefore] = useState("");
  const [showInUse, setShowInUse] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const q = before ? `?before=${encodeURIComponent(new Date(before).toISOString())}` : "";
      const res = await fetch(`/api/items/cleanup${q}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setRows(data.items);
      setSummary({ total: data.total, unused: data.unused, inUse: data.inUse });
      // Pre-select only the unused ones; anything a person has touched must be
      // an explicit choice.
      setSelected(new Set(data.items.filter((r: Row) => r.unused).map((r: Row) => r.id)));
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [before]);

  useEffect(() => { load(); }, [load]);

  const visible = showInUse ? rows : rows.filter((r) => r.unused);

  function toggle(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }

  async function remove() {
    setWorking(true); setError(null); setNotice(null);
    try {
      const ids = [...selected];
      let deleted = 0;
      const failures: string[] = [];

      // Batched so a large cleanup does not outlive a proxy timeout.
      for (let i = 0; i < ids.length; i += 50) {
        const res = await fetch("/api/items/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ids.slice(i, i + 50) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Delete failed");
        deleted += data.deleted;
        for (const f of data.failures) failures.push(`${f.moNumber ?? f.id}: ${f.error}`);
        setNotice(`Deleting… ${deleted} of ${ids.length}.`);
      }

      setNotice(
        `Deleted ${deleted} item${deleted === 1 ? "" : "s"}.` +
        (failures.length ? ` ${failures.length} could not be deleted.` : "")
      );
      if (failures.length) setError(failures.slice(0, 4).join(" · "));
      setConfirming(false);
      await load();
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setWorking(false);
    }
  }

  const SIGNAL_LABEL: Record<string, string> = {
    defaultStatus: "status untouched",
    noRemarks: "no remarks",
    defaultQuantity: "quantity 1",
    noDueDate: "no due date",
    neverTouchedByAPerson: "never edited by a person",
  };

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 940 }}>
      <div>
        <Link href="/settings" className="link" style={{ fontSize: 12.5 }}>← Settings</Link>
        <h1 style={{ fontSize: 20, margin: "8px 0 3px", letterSpacing: "-.02em" }}>
          Remove unused manufacturing items
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0, lineHeight: 1.55 }}>
          Before enrolment became deliberate, any property change in Onshape created a
          manufacturing item. This finds the ones nobody has used since. Deleting clears
          MO Number, MO Status and MO Remarks on the part in Onshape first, so no stale
          numbers are left in your CAD data.
        </p>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div className="card" style={{ padding: 16, display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <label className="label">Created before</label>
          <input className="input" type="date" value={before} style={{ width: 170 }}
                 onChange={(e) => setBefore(e.target.value)} />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, paddingBottom: 8 }}>
          <input type="checkbox" checked={showInUse} onChange={(e) => setShowInUse(e.target.checked)} />
          Also show items that appear to be in use
        </label>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", paddingBottom: 8 }}>
          {loading ? "Loading…" : (
            <>
              <strong>{summary.unused}</strong> unused · <strong>{summary.inUse}</strong> in use ·{" "}
              {summary.total} total
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 44, textAlign: "center" }}><Spinner size={18} /></div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 44, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            Nothing to clean up.
          </div>
        ) : (
          <div style={{ overflowX: "auto", maxHeight: 460, overflowY: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}></th>
                  <th>MO Number</th>
                  <th>Part</th>
                  <th>Status</th>
                  <th>Why it looks unused</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id} style={{ opacity: r.unused ? 1 : 0.65 }}>
                    <td>
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.moNumber}</td>
                    <td>
                      <div>{r.partName || "—"}</div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                        {r.partNumber} · {r.documentName}
                      </div>
                    </td>
                    <td><StatusBadge status={r.status} /></td>
                    <td style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      {r.unused
                        ? Object.keys(r.signals).filter((k) => r.signals[k]).map((k) => SIGNAL_LABEL[k]).join(" · ")
                        : (
                          <span style={{ color: "var(--warn)" }}>
                            in use — {Object.keys(r.signals).filter((k) => !r.signals[k]).map((k) => SIGNAL_LABEL[k]).join(", ")} differs
                          </span>
                        )}
                    </td>
                    <td style={{ fontSize: 11.5, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16, borderColor: selected.size ? "var(--danger)" : "var(--border)" }}>
        {!confirming ? (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-danger" disabled={selected.size === 0 || working}
                    onClick={() => setConfirming(true)}>
              Delete {selected.size} selected item{selected.size === 1 ? "" : "s"}
            </button>
            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
              Only the ticked rows are deleted.
            </span>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 11 }}>
            <Alert kind="warn">
              Permanently delete <strong>{selected.size}</strong> manufacturing order
              {selected.size === 1 ? "" : "s"}? Their MO numbers are not reused, and the
              properties are cleared from the parts in Onshape. This cannot be undone.
            </Alert>
            <div style={{ display: "flex", gap: 9 }}>
              <button className="btn btn-danger" onClick={remove} disabled={working}>
                {working && <Spinner />} Yes, delete {selected.size}
              </button>
              <button className="btn" onClick={() => setConfirming(false)} disabled={working}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
