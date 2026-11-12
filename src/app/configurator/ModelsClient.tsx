"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, Spinner, relTime } from "@/components/ui";
import { ProductField } from "@/components/ProductField";

type Model = {
  id: string; name: string; enabled: boolean; documentName: string; elementName: string;
  versionName: string; onVersion: boolean; configurations: number; createdAt: string;
  productId: string; productName: string; productChosen: boolean;
};

type Preview = {
  documentName: string; elementName: string; wvType: string;
  versions: { id: string; name: string; createdAt: string }[];
  /** Inputs the newest version has — 0 when it predates the configuration. */
  newestVersionInputs: number | null;
  inputs: { name: string; kind: string }[];
};

/**
 * The configurable models, and adding one.
 *
 * Adding is two steps — paste a link, then confirm — because the version
 * matters (docs/CONFIGURATOR-DESIGN.md §6): the admin sees which version the
 * model will be read at, and what inputs it has, before committing to it.
 */
export function ModelsClient({ isAdmin }: { isAdmin: boolean }) {
  const [models, setModels] = useState<Model[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [versionId, setVersionId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/configurator/models");
    const j = await r.json();
    if (!r.ok) setError(j.error || "Could not load the models");
    else setModels(j.models);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function look() {
    setBusy("preview"); setError(null); setPreview(null);
    try {
      const r = await fetch("/api/configurator/models/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not read that assembly");
      setPreview(j.preview);
      setVersionId(j.preview.wvType === "v" ? "" : j.preview.versions[0]?.id ?? "");
      setName(j.preview.elementName || j.preview.documentName);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    setBusy("add"); setError(null);
    try {
      const r = await fetch("/api/configurator/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, versionId, name }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not add the model");
      setUrl(""); setPreview(null);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function fileInto(m: Model, productId: string, productName: string) {
    setError(null); setNotice(null);
    const r = await fetch(`/api/configurator/models/${m.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ productId }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not change the product");
    setNotice(`"${m.name}" now files into ${productName}` + (j.moved ? `; ${j.moved} configurator part${j.moved === 1 ? "" : "s"} moved there.` : "."));
    await load();
  }

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  /** Remove one model and what the configurator made for it. */
  async function remove(m: Model) {
    setError(null); setNotice(null);
    const pr = await fetch(`/api/configurator/models/${m.id}/reset`);
    const pj = await pr.json();
    if (!pr.ok) { setError(pj.error || "Could not check what removing it would delete"); return; }
    const { configurations, parts } = pj.preview;
    if (!window.confirm(
      `Remove "${m.name}" from the configurator?\n\nThis deletes the model, its ${plural(configurations, "configuration")} ` +
      `and the ${plural(parts, "PLM part")} and assemblies the configurator made for them. Parts PLM had before, released ` +
      `parts and parts used elsewhere are kept. Nothing in Onshape is changed. This cannot be undone.`
    )) return;
    setBusy(`remove-${m.id}`);
    try {
      const r = await fetch(`/api/configurator/models/${m.id}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not remove the model");
      setNotice(`Removed "${m.name}" with ${plural(j.result.configurations, "configuration")} and ${plural(j.result.partsRemoved, "part")}.`);
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  /** Clear the whole configurator, for a demo from scratch. */
  async function clearAll() {
    setError(null); setNotice(null);
    const pr = await fetch("/api/configurator/clear");
    const pj = await pr.json();
    if (!pr.ok) { setError(pj.error || "Could not check what clearing would delete"); return; }
    const { models: n, configurations, parts } = pj.preview;
    if (!window.confirm(
      `Clear the configurator?\n\nThis deletes ${n === 1 ? "the" : "all"} ${plural(n, "model")}, ${n === 1 ? "its" : "their"} ${plural(configurations, "configuration")} and the ` +
      `${plural(parts, "PLM part")} and assemblies the configurator made, and starts CFG numbering again at CFG-00001. ` +
      `Parts PLM had before, released parts and parts used elsewhere are kept. Nothing in Onshape is changed. ` +
      `This cannot be undone.`
    )) return;
    setBusy("clear");
    try {
      const r = await fetch("/api/configurator/clear", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not clear the configurator");
      const x = j.result;
      setNotice(
        `Cleared: ${plural(x.models, "model")}, ${plural(x.configurations, "configuration")} and ${plural(x.partsRemoved, "part")} removed` +
        (x.partsKept.length ? `; kept ${x.partsKept.map((k: any) => `${k.number} (${k.reason})`).join(", ")}` : "") +
        ". Ready to add models from scratch."
      );
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(m: Model) {
    const r = await fetch(`/api/configurator/models/${m.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !m.enabled }),
    });
    if (!r.ok) setError((await r.json()).error || "Could not change it");
    await load();
  }

  /**
   * Start a model again, for demos. The confirmation says exactly what goes,
   * because the configurator's PLM parts go with the configurations.
   */
  async function reset(m: Model) {
    setError(null); setNotice(null);
    const pr = await fetch(`/api/configurator/models/${m.id}/reset`);
    const pj = await pr.json();
    if (!pr.ok) { setError(pj.error || "Could not check what a reset would remove"); return; }
    const { configurations, parts } = pj.preview;
    const ok = window.confirm(
      `Reset "${m.name}"?\n\n` +
      `This deletes its ${configurations} configuration${configurations === 1 ? "" : "s"} (pictures and BOMs) and the ` +
      `${parts} PLM part${parts === 1 ? "" : "s"} and assemblies the configurator made for them. Parts PLM had before, ` +
      `released parts and parts used elsewhere are kept. Nothing in Onshape is changed.\n\n` +
      `CFG numbering starts again at 1 if no other model has configurations. This cannot be undone.`
    );
    if (!ok) return;
    setBusy(`reset-${m.id}`);
    try {
      const r = await fetch(`/api/configurator/models/${m.id}/reset`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not reset the model");
      const x = j.result;
      setNotice(
        `"${m.name}" was reset: ${x.configurations} configuration${x.configurations === 1 ? "" : "s"} and ` +
        `${x.partsRemoved} part${x.partsRemoved === 1 ? "" : "s"} removed` +
        (x.partsKept.length ? `; kept ${x.partsKept.map((k: any) => `${k.number} (${k.reason})`).join(", ")}` : "") +
        (x.cfgCounterReset ? ". CFG numbering starts again at CFG-00001." : ".")
      );
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
      <div>
        <h1 style={{ margin: "0 0 3px", fontSize: 20 }}>Configurator</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
          Pick a model, choose its options, and see the result. Each configuration is generated in
          Onshape once and kept in PLM, with its own CFG number.
        </p>
      </div>
      {isAdmin && (models?.length ?? 0) > 0 && (
        <button className="btn btn-sm btn-danger" onClick={clearAll} disabled={busy !== null}
          title="Remove every model, its configurations and the parts the configurator made — to start a demo from scratch">
          {busy === "clear" ? <Spinner /> : "Clear everything…"}
        </button>
      )}
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {models === null ? (
        <div className="card" style={{ padding: 30, textAlign: "center" }}><Spinner size={18} /></div>
      ) : models.length === 0 ? (
        <div className="card" style={{ color: "var(--text-muted)", fontSize: 13 }}>
          No configurable models yet.{isAdmin ? " Add one below." : " An admin adds them."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {models.map((m) => (
            <div key={m.id} className="card" style={{ display: "grid", gap: 6, opacity: m.enabled ? 1 : 0.6 }}>
              <Link href={`/configurator/${m.id}`} style={{ fontWeight: 650, fontSize: 15, color: "var(--accent)" }}>
                {m.name}
              </Link>
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                {m.documentName} · {m.elementName}
                <br />
                {m.onVersion ? `Version ${m.versionName}` : "Workspace — configurations may go stale"}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                {m.configurations} configuration{m.configurations === 1 ? "" : "s"} generated
                {!m.enabled && " · switched off"}
              </div>
              {isAdmin ? (
                <ProductField
                  compact value={m.productChosen ? m.productId : null} label="Files into"
                  emptyLabel={`Following its parts — ${m.productName}`}
                  onChange={(id, name) => fileInto(m, id, name)}
                />
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Files into {m.productName}</div>
              )}
              {isAdmin && !m.productChosen && (
                <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: -2 }}>
                  Following where the model&apos;s own parts are filed. Choose one to fix it, and move what was already made.
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <Link href={`/configurator/${m.id}`} className="btn btn-sm btn-primary">Configure</Link>
                {isAdmin && (
                  <>
                    <button className="btn btn-sm" onClick={() => toggle(m)}>{m.enabled ? "Switch off" : "Switch on"}</button>
                    <button className="btn btn-sm btn-danger" onClick={() => reset(m)} disabled={busy !== null}
                      title="Delete every configuration of this model and the PLM parts made for them">
                      {busy === `reset-${m.id}` ? <Spinner /> : "Reset"}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(m)} disabled={busy !== null}
                      title="Remove this model, its configurations and the PLM parts made for them">
                      {busy === `remove-${m.id}` ? <Spinner /> : "Remove"}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {isAdmin && (
        <div className="card" style={{ display: "grid", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Add a configurable model</h2>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-faint)" }}>
            Paste the link of a configured assembly, with its tab open. It is read at a version, so
            configurations generated from it stay correct when someone edits the workspace.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="input mono" style={{ flex: 1, minWidth: 260 }} value={url}
              placeholder="https://….onshape.com/documents/…/w/…/e/…"
              onChange={(e) => { setUrl(e.target.value); setPreview(null); }}
              aria-label="Assembly link"
            />
            <button className="btn btn-sm" onClick={look} disabled={!url.trim() || busy !== null}>
              {busy === "preview" ? <Spinner /> : "Read it"}
            </button>
          </div>

          {preview && (
            <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <div style={{ fontSize: 13 }}>
                <strong>{preview.documentName}</strong> · {preview.elementName} — {preview.inputs.length} inputs:{" "}
                <span style={{ color: "var(--text-muted)" }}>{preview.inputs.map((i) => i.name).join(", ")}</span>
              </div>
              <label className="label">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Model name" />
              {preview.wvType !== "v" && (
                <>
                  <label className="label">Version</label>
                  {preview.versions.length ? (
                    <select value={versionId} onChange={(e) => setVersionId(e.target.value)} aria-label="Version">
                      {preview.versions.map((v) => (
                        <option key={v.id} value={v.id}>{v.name || v.id} · {relTime(v.createdAt)}</option>
                      ))}
                    </select>
                  ) : (
                    <Alert kind="error">
                      This document has no versions yet. Create a version in Onshape — after the configuration
                      is set up — then read the link again.
                    </Alert>
                  )}
                  {preview.versions.length > 0 && preview.newestVersionInputs === 0 && versionId === preview.versions[0]?.id && (
                    <Alert kind="error">
                      The newest version, {preview.versions[0].name || "unnamed"}, has no configuration — it was made
                      before the configuration was added. Create a new version in Onshape, then read the link again.
                    </Alert>
                  )}
                </>
              )}
              <button
                className="btn btn-primary btn-sm" style={{ justifySelf: "start" }} onClick={add}
                disabled={
                  busy !== null || !name.trim() ||
                  (preview.wvType !== "v" && preview.versions.length === 0) ||
                  (preview.newestVersionInputs === 0 && versionId === preview.versions[0]?.id)
                }
              >
                {busy === "add" ? <Spinner /> : "Add model"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
