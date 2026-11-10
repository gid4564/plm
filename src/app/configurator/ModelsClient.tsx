"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, Spinner, relTime } from "@/components/ui";

type Model = {
  id: string; name: string; enabled: boolean; documentName: string; elementName: string;
  versionName: string; onVersion: boolean; configurations: number; createdAt: string;
};

type Preview = {
  documentName: string; elementName: string; wvType: string;
  versions: { id: string; name: string; createdAt: string }[];
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

  async function toggle(m: Model) {
    const r = await fetch(`/api/configurator/models/${m.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !m.enabled }),
    });
    if (!r.ok) setError((await r.json()).error || "Could not change it");
    await load();
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ margin: "0 0 3px", fontSize: 20 }}>Configurator</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
          Pick a model, choose its options, and see the result. Each configuration is generated in
          Onshape once and kept in PLM, with its own CFG number.
        </p>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

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
              <div style={{ display: "flex", gap: 8 }}>
                <Link href={`/configurator/${m.id}`} className="btn btn-sm btn-primary">Configure</Link>
                {isAdmin && (
                  <button className="btn btn-sm" onClick={() => toggle(m)}>{m.enabled ? "Switch off" : "Switch on"}</button>
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
                    <Alert kind="warn">
                      This document has no versions, so the model will be read from the workspace and its
                      configurations can go stale. Create a version in Onshape first if you can.
                    </Alert>
                  )}
                </>
              )}
              <button className="btn btn-primary btn-sm" style={{ justifySelf: "start" }} onClick={add} disabled={busy !== null || !name.trim()}>
                {busy === "add" ? <Spinner /> : "Add model"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
