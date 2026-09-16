"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Alert, CollapsibleSection, FavoriteButton, PartThumb, Spinner, StatusBadge } from "@/components/ui";
import { PartPanel } from "@/app/bom/PartPanel";
import { TaskPanel } from "@/app/tasks/TaskPanel";

type FavoriteRow =
  | {
      kind: "part";
      id: string;
      number: string | null;
      name: string;
      partKind: "part" | "assembly";
      lifecycleState: string;
    }
  | { kind: "task"; id: string; name: string; state: string; column: string };

const rowButton: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0,
  background: "none", border: "none", padding: "3px 0", cursor: "pointer",
  textAlign: "left", font: "inherit", color: "inherit",
};

const ellipsis: CSSProperties = {
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
};

/**
 * A person's own shortlist of parts, assemblies and tasks, at the top of
 * the dashboard.
 *
 * Opens the same flyouts the BOM and the task board use, rather than
 * navigating away — the point of a favorites list is checking on a handful
 * of things quickly, and each one is one click from here either way.
 */
export function FavoritesSection() {
  const [rows, setRows] = useState<FavoriteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPartId, setOpenPartId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/favorites");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load favorites");
      setRows(j.favorites ?? []);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Dropped locally the moment a star comes off, rather than waiting on a
  // full reload — the row disappearing IS the confirmation that it worked.
  function drop(kind: FavoriteRow["kind"], id: string) {
    setRows((prev) => (prev ?? []).filter((r) => !(r.kind === kind && r.id === id)));
  }

  const parts = (rows ?? []).filter((r): r is FavoriteRow & { kind: "part" } => r.kind === "part");
  const tasks = (rows ?? []).filter((r): r is FavoriteRow & { kind: "task" } => r.kind === "task");

  return (
    <>
      <CollapsibleSection
        storageKey="plm:dashboard:favorites-open"
        title={<h2 style={{ margin: 0, fontSize: 16 }}>Favorites</h2>}
        right={
          <span style={{ color: "var(--text-faint)", fontSize: 13 }}>
            {rows == null ? "" : rows.length}
          </span>
        }
      >
        <div className="card" style={{ padding: 14 }}>
          {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
          {rows == null ? (
            <div style={{ textAlign: "center", padding: 16 }}><Spinner size={16} /></div>
          ) : rows.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
              Nothing starred yet. Star a part, assembly, or task from its details page — or the
              BOM&rsquo;s part panel — to keep it here.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {parts.length > 0 && (
                <div>
                  <div
                    style={{
                      fontSize: 11, fontWeight: 600, color: "var(--text-faint)", marginBottom: 6,
                      textTransform: "uppercase", letterSpacing: 0.3,
                    }}
                  >
                    Parts &amp; assemblies
                  </div>
                  <div style={{ display: "grid", gap: 2 }}>
                    {parts.map((f) => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button style={rowButton} onClick={() => setOpenPartId(f.id)}>
                          <PartThumb partId={f.id} size={26} alt="" />
                          <span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>
                            {f.number ?? "—"}
                          </span>
                          <span style={{ ...ellipsis, fontSize: 12, color: "var(--text-muted)", flex: 1 }}>
                            {f.name}
                          </span>
                          {f.partKind === "assembly" && <span className="badge">asm</span>}
                          <StatusBadge status={f.lifecycleState} />
                        </button>
                        <FavoriteButton
                          kind="part" targetId={f.id} active size={16}
                          onChange={(on) => { if (!on) drop("part", f.id); }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {tasks.length > 0 && (
                <div>
                  <div
                    style={{
                      fontSize: 11, fontWeight: 600, color: "var(--text-faint)", marginBottom: 6,
                      textTransform: "uppercase", letterSpacing: 0.3,
                    }}
                  >
                    Tasks
                  </div>
                  <div style={{ display: "grid", gap: 2 }}>
                    {tasks.map((f) => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button style={rowButton} onClick={() => setOpenTaskId(f.id)}>
                          <span style={{ ...ellipsis, fontSize: 12.5, flex: 1 }}>
                            {f.name}
                          </span>
                          <span className="badge">{f.column || f.state || "—"}</span>
                        </button>
                        <FavoriteButton
                          kind="task" targetId={f.id} active size={16}
                          onChange={(on) => { if (!on) drop("task", f.id); }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </CollapsibleSection>

      <PartPanel partId={openPartId} onClose={() => setOpenPartId(null)} onSaved={load} />
      <TaskPanel taskId={openTaskId} onClose={() => setOpenTaskId(null)} onChanged={load} />
    </>
  );
}
