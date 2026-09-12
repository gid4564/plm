"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, PartThumb, RevChip, Spinner, StatusBadge, relTime } from "@/components/ui";
import { AttributeInput, type Definition } from "@/components/AttributeInput";
import { ProductField } from "@/components/ProductField";
import { PartTasks, TaskCountBadge, type PartTask } from "@/components/PartTasks";
import { PanelHeader, SignedOut, panelWrap } from "./shared";

type Ctx = {
  documentId: string; elementId: string; partId: string; configuration: string;
  workspaceId: string; versionId: string; companyId: string; userId: string;
};

export function PanelClient({
  ctx, signedIn, search,
}: {
  ctx: Ctx; signedIn: boolean; search: string;
}) {
  const [part, setPart] = useState<any>(null);
  const [defs, setDefs] = useState<Definition[]>([]);
  const [drawings, setDrawings] = useState<any[]>([]);
  const [tasks, setTasks] = useState<PartTask[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [loading, setLoading] = useState(signedIn && Boolean(ctx.elementId));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /*
   * Read from the server rather than defaulted, so the panel opens on the
   * product this person was last working in — including on a different machine.
   */
  const [currentProductId, setCurrentProductId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Set when Onshape has us pointed somewhere PLM will not sync from. */
  const [refusal, setRefusal] = useState<string | null>(null);

  const params = useCallback(
    (sync: boolean) => {
      const p = new URLSearchParams({
        documentId: ctx.documentId,
        elementId: ctx.elementId,
        configuration: ctx.configuration,
      });
      if (ctx.partId) p.set("partId", ctx.partId);
      if (ctx.workspaceId) p.set("workspaceId", ctx.workspaceId);
      if (ctx.versionId) p.set("versionId", ctx.versionId);
      if (sync) p.set("sync", "1");
      return p;
    },
    [ctx]
  );

  const apply = useCallback((data: any) => {
    setPart(data.part);
    setDefs(data.definitions ?? []);
    setDrawings(data.drawings ?? []);
    setTasks(data.tasks ?? []);
    setMissing(data.missingForRelease ?? []);
    setDraft({});
    setFieldErrors({});
  }, []);

  const load = useCallback(async () => {
    if (!signedIn || !ctx.elementId) return;
    setLoading(true);
    setError(null);
    try {
      // Deliberately no sync=1: selecting a part must not bring it into PLM.
      // Creation happens when someone presses Sync to PLM, or on a release.
      const res = await fetch(`/api/parts/lookup?${params(false)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lookup failed");
      apply(data);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [params, signedIn, ctx.elementId, apply]);

  useEffect(() => { load(); }, [load]);

  /*
   * The product the panel is working in.
   *
   * Two different meanings, and the difference matters. Before a part is in
   * PLM there is nothing to move, so choosing here sets the *current* product —
   * which is what `syncPartFromOnshape` files a newly created part into. Once
   * the part exists, the same control moves that part, because that is what
   * somebody looking at a tracked part means by changing its product.
   */
  /* The remembered product, so the picker opens on the right one. */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch("/api/products");
        const j = await r.json();
        if (alive && r.ok) setCurrentProductId(j.currentProductId ?? null);
      } catch {
        // The picker falls back to Unassigned, which is where a part with no
        // chosen product goes anyway — so this is not worth an error.
      }
    })();
    return () => { alive = false; };
  }, []);

  async function selectCurrentProduct(productId: string) {
    const r = await fetch(`/api/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select" }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not select that product");
    setCurrentProductId(productId);
  }

  async function moveThisPart(productId: string) {
    if (!part) return;
    const r = await fetch(`/api/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "assign", partIds: [part.id] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not change the product");
    setNotice(j.message ?? "Product changed.");
    await load();
  }

  async function sync() {
    setSyncing(true);
    setError(null);
    setRefusal(null);
    try {
      const res = await fetch(`/api/parts/lookup?${params(true)}`);
      const data = await res.json();
      if (res.status === 409) {
        // A refusal is not an error — the panel is pointed at something PLM
        // deliberately will not file, and saying why is the useful response.
        setRefusal(data.error);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Sync failed");
      apply(data);
      setNotice(`In PLM as ${data.part?.number}. Its part number has been written to Onshape.`);
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setSyncing(false);
    }
  }

  async function save() {
    if (!part) return;
    setSaving(true);
    setFieldErrors({});
    setNotice(null);
    try {
      const res = await fetch(`/api/parts/${part.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attributes: draft }),
      });
      const data = await res.json();
      if (res.status === 422 && data.errors) {
        setFieldErrors(data.errors);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Could not save");
      setNotice(data.changed ? `Saved as iteration ${data.part.iteration}.` : "Nothing had changed.");
      await load();
    } catch (err: any) {
      setError(String(err.message ?? err));
    } finally {
      setSaving(false);
    }
  }

  if (!signedIn) {
    return (
      <div style={panelWrap}>
        <PanelHeader />
        <SignedOut />
      </div>
    );
  }

  if (!ctx.elementId) {
    return (
      <div style={panelWrap}>
        <PanelHeader />
        <Alert kind="info">
          Select a part in the Part Studio, or open this panel on an assembly tab, and its PLM
          record appears here.
        </Alert>
      </div>
    );
  }

  const dirty = Object.keys(draft).length > 0;

  return (
    <div style={panelWrap}>
      <PanelHeader />

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {refusal && <Alert kind="warn" onDismiss={() => setRefusal(null)}>{refusal}</Alert>}

      {loading ? (
        <div style={{ padding: 20, textAlign: "center" }}><Spinner size={18} /></div>
      ) : !part ? (
        <div style={{ display: "grid", gap: 10 }}>
          <Alert kind="info">
            This {ctx.partId ? "part" : "tab"} is not in PLM yet.
          </Alert>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-faint)" }}>
            Adding it allocates a PLM number and writes it back onto the Onshape part. PLM is the
            number master.
          </p>
          {/*
            Chosen before syncing, not after: this is where the part will be
            filed, and asking afterwards means every part passes through the
            wrong product first.
          */}
          <ProductField
            label="File into product"
            compact
            value={currentProductId}
            emptyLabel="Unassigned"
            onChange={(id) => selectCurrentProduct(id)}
          />
          <button className="btn btn-primary" onClick={sync} disabled={syncing}>
            {syncing ? <Spinner /> : "Sync to PLM"}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
            <PartThumb partId={part.id} size={42} alt="" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{part.number}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", wordBreak: "break-word" }}>
                {part.name}
              </div>
              <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap" }}>
                <RevChip revision={part.revision} iteration={part.iteration} />
                <StatusBadge status={part.lifecycleState} />
                {part.kind === "assembly" && <span className="badge">asm</span>}
              </div>
            </div>
          </div>

          {missing.length > 0 && part.lifecycleState !== "Released" && (
            <Alert kind="warn">
              Not ready to release — still needs {missing.join(", ")}.
            </Alert>
          )}

          {/*
            Now it moves the part, rather than setting where the next one goes.
            Same control, different verb — which is why ProductField takes the
            action from its host instead of deciding.
          */}
          <ProductField
            label="Product"
            compact
            value={part.productId ?? null}
            onChange={(id) => moveThisPart(id)}
          />

          {part.writeBackBlocked && (
            <Alert kind="info">Nothing is written to Onshape for this part. {part.writeBackBlocked}</Alert>
          )}
          {part.pushPending && part.lastPushError && (
            <Alert kind="warn">A write to Onshape is outstanding. {part.lastPushError}</Alert>
          )}

          <div style={{ display: "grid", gap: 9 }}>
            {defs.map((d) => (
              <AttributeInput
                key={d.key}
                def={d}
                value={d.key in draft ? draft[d.key] : part.attributes?.[d.key] ?? null}
                error={fieldErrors[d.key]}
                onChange={(v) =>
                  setDraft((prev) => {
                    const next = { ...prev };
                    const stored = part.attributes?.[d.key] ?? null;
                    if (String(v ?? "") === String(stored ?? "")) delete next[d.key];
                    else next[d.key] = v;
                    return next;
                  })
                }
              />
            ))}
          </div>

          {dirty && (
            <div style={{ display: "flex", gap: 7 }}>
              <button className="btn btn-primary" onClick={save} disabled={saving} style={{ flex: 1 }}>
                {saving ? <Spinner /> : "Save"}
              </button>
              <button className="btn" onClick={() => { setDraft({}); setFieldErrors({}); }}>
                Discard
              </button>
            </div>
          )}

          {/*
            * Open tasks, inside Onshape's own panel.
            *
            * This is the most valuable place for it in the whole application:
            * the person seeing it is in the CAD, about to edit, and this is
            * where "somebody has already asked for a change here" stops being
            * something they find out afterwards.
            */}
          {tasks.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div
                style={{
                  fontSize: 11, color: "var(--text-faint)", marginBottom: 4,
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                Tasks
                <TaskCountBadge open={tasks.filter((t) => t.open).length} total={tasks.length} />
              </div>
              {/*
                * Inline, because this is Onshape's own right panel.
                *
                * A link to the task board navigates this iframe away from the
                * part the user is looking at, into a page built for a full
                * window with no way back. Expanding in place keeps the CAD on
                * screen; acting on the task opens PLM in a new tab.
                */}
              <PartTasks tasks={tasks} mode="inline" />
            </div>
          )}

          {drawings.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 4 }}>Drawings</div>
              {drawings.map((d) => (
                <div key={d.id} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
                  <span className="mono">{d.number}</span>
                  {d.revision && <span className="badge">{d.revision}</span>}
                  <div style={{ flex: 1 }} />
                  {d.currentFileId && (
                    <a
                      className="btn btn-sm"
                      href={`/api/drawings/${d.id}/files/${d.currentFileId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      PDF
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11, color: "var(--text-faint)", borderTop: "1px solid var(--border)", paddingTop: 7 }}>
            Last read from Onshape {relTime(part.lastSyncedFromOnshapeAt)}
            {part.lastPushedToOnshapeAt ? ` · last written ${relTime(part.lastPushedToOnshapeAt)}` : ""}
          </div>

          <a
            className="btn btn-sm"
            href={`/parts/${part.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Open in PLM
          </a>
        </>
      )}

      {/* Kept so the sign-in round trip returns to this exact part context. */}
      <input type="hidden" value={search} readOnly />
    </div>
  );
}
