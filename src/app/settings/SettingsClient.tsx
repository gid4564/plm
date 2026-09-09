"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Alert, KV, Spinner } from "@/components/ui";

type Props = {
  mode: "mock" | "live";
  role: string;
  appBaseUrl: string;
  enterprise: {
    name: string; onshapeCompanyId: string; statuses: string[];
    moPrefix: string; moCounter: number;
  };
  connected: boolean;
  integrationEmail: string | null;
};

type PropField = {
  key: string; label: string; valueType: string;
  description: string; propertyId: string | null;
};

export function SettingsClient(p: Props) {
  const [fields, setFields] = useState<PropField[]>([]);
  const [instructions, setInstructions] = useState<string[]>([]);
  const [webhook, setWebhook] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [seenNames, setSeenNames] = useState<string[]>([]);
  const [ent, setEnt] = useState<any>(null);
  const [sampledFrom, setSampledFrom] = useState<string | null>(null);
  const [partUrl, setPartUrl] = useState("");
  const [partId, setPartId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newFacility, setNewFacility] = useState("");

  const loadAll = useCallback(async () => {
    try {
      const [pr, wr, er] = await Promise.all([
        fetch("/api/onshape/properties").then((r) => r.json()),
        fetch("/api/onshape/webhook").then((r) => r.json()),
        fetch("/api/enterprise").then((r) => r.json()),
      ]);
      if (pr.fields) setFields(pr.fields);
      setWebhook(wr);
      setEnt(er);
    } catch (err: any) {
      setError(String(err.message ?? err));
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Surface the ?onshape=connected redirect from the OAuth callback.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("onshape") === "connected") {
      setNotice(q.get("mock") ? "Onshape connected (mock mode — no real handshake occurred)." : "Onshape account connected.");
      window.history.replaceState({}, "", "/settings");
    }
  }, []);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name); setError(null); setNotice(null);
    try { await fn(); } catch (err: any) { setError(String(err.message ?? err)); }
    finally { setBusy(null); }
  }

  const discover = () => run("discover", async () => {
    const res = await fetch("/api/onshape/properties", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partUrl: partUrl.trim() || undefined, partId: partId.trim() || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Discovery failed");

    setInstructions(data.instructions || []);
    setSeenNames(data.seenNames || []);
    setSampledFrom(data.sampledFrom || null);
    setNotice(
      data.missing.length === 0
        ? `All ${data.found.length} MOS properties matched against ${data.definitionCount} definitions from Onshape.`
        : `Matched ${data.found.length} of ${data.found.length + data.missing.length}. ${data.definitionCount} definitions were visible to the app.`
    );
    await loadAll();
  });

  const registerWebhook = () => run("webhook", async () => {
    const res = await fetch("/api/onshape/webhook", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Registration failed");
    setNotice(
      `Webhook registered (${data.webhookId}). Events: ${(data.confirmed || []).join(", ")}.` +
      (data.removedPrevious ? ` Removed previous subscription ${data.removedPrevious}.` : "")
    );
    if (data.missing?.length) {
      setError(
        `Onshape did not accept: ${data.missing.join(", ")}. Those events will never ` +
        `reach the MOS — releases will not sync until this is resolved.`
      );
    }
    await loadAll();
  });

  const removeWebhook = (id?: string) => run(id ? `stray:${id}` : "unwebhook", async () => {
    const res = await fetch(`/api/onshape/webhook${id ? `?id=${encodeURIComponent(id)}` : ""}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Removal failed");
    setNotice(id ? `Removed stale subscription ${id}.` : "Webhook removed.");
    await loadAll();
  });

  /**
   * Sweeps in batches: each item is an Onshape round trip, so one request for a
   * whole catalogue would outlive most proxy timeouts.
   */
  const resyncAll = () => run("resync", async () => {
    let processed = 0, updated = 0, rounds = 0;
    const problems: string[] = [];

    for (;;) {
      const res = await fetch("/api/items/resync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-sync failed");

      processed += data.processed;
      updated += data.updated;
      for (const f of data.failures ?? []) problems.push(`${f.moNumber ?? "?"}: ${f.error}`);
      rounds++;

      setNotice(`Re-syncing… ${processed} of ${data.total} processed.`);
      if (data.remaining === 0 || data.processed === 0 || rounds > 200) break;
    }

    setNotice(
      `Re-synced ${processed} item${processed === 1 ? "" : "s"} — ${updated} updated.` +
      (problems.length ? ` ${problems.length} failed.` : "")
    );
    if (problems.length) setError(problems.slice(0, 5).join(" · "));
  });

  /** Replace the whole list — the endpoint takes it that way; see the note on the route. */
  const saveFacilities = (next: string[]) => run("facilities", async () => {
    const res = await fetch("/api/enterprise", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facilities: next }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not change the list");
    await loadAll();
  });

  function addFacility() {
    const name = newFacility.trim();
    if (!name) return;
    if ((ent?.facilities ?? []).some((f: string) => f.toLowerCase() === name.toLowerCase())) {
      setNewFacility("");
      return;
    }
    saveFacilities([...(ent?.facilities ?? []), name]);
    setNewFacility("");
  }

  function removeFacility(name: string) {
    saveFacilities((ent?.facilities ?? []).filter((f: string) => f !== name));
  }

  const setReleaseSync = (enabled: boolean) => run("releaseSync", async () => {
    const res = await fetch("/api/enterprise", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseSyncEnabled: enabled }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not change the setting");
    setNotice(
      enabled
        ? "Releasing a part will now enrol it in the MOS."
        : "Releases will no longer enrol parts. Existing items are unaffected."
    );
    await loadAll();
  });

  const seed = () => run("seed", async () => {
    const res = await fetch("/api/simulator/seed", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Seed failed");
    setNotice(`Seeded ${data.parts} mock parts and ${data.properties} property definitions.`);
  });

  const isAdmin = p.role === "admin";

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 780 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 3px", letterSpacing: "-.02em" }}>Settings</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
          Onshape connection, property mapping and webhook registration for {p.enterprise.name}.
        </p>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {p.mode === "mock" && (
        <Alert kind="info">
          <strong>Mock mode.</strong> ONSHAPE_MODE is not set to <code>live</code>, so Onshape is simulated
          locally. OAuth, property discovery and webhooks all short-circuit to the built-in simulator.
          Set <code>ONSHAPE_MODE=live</code> plus your Dev Portal credentials to talk to a real enterprise.
        </Alert>
      )}

      {/* ------------------------------- enterprise ---------------------------- */}
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 12px", fontWeight: 650 }}>Enterprise</h2>
        <KV k="Name" v={p.enterprise.name} />
        <KV k="Onshape ID" v={p.enterprise.onshapeCompanyId} mono />
        <KV k="MO prefix" v={p.enterprise.moPrefix} mono />
        <KV k="MO issued" v={String(p.enterprise.moCounter)} mono />
        <KV k="Statuses" v={p.enterprise.statuses.join(" · ")} />
      </section>

      {/* -------------------------------- OAuth -------------------------------- */}
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Onshape connection</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
          Webhook-driven writes use the enterprise integration account — the first user to connect.
          Its refresh token keeps working after designers sign out.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span
            className="badge"
            style={
              p.connected
                ? { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "var(--ok)" }
                : { background: "var(--warn-soft)", color: "var(--warn)", borderColor: "var(--warn)" }
            }
          >
            {p.connected ? "Your account is connected" : "Not connected"}
          </span>
          <a className="btn btn-primary" href="/api/onshape/oauth/start?returnTo=/settings">
            {p.connected ? "Reconnect" : "Connect Onshape"}
          </a>
          {p.integrationEmail && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Integration account: <strong>{p.integrationEmail}</strong>
            </span>
          )}
        </div>
      </section>

      {/* ---------------------------- property mapping ------------------------- */}
      <section className="card" style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>Custom property mapping</h2>
          <button className="btn btn-sm" onClick={discover} disabled={busy !== null}>
            {busy === "discover" && <Spinner />} Run discovery
          </button>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
          The MOS matches your enterprise custom properties <em>by name</em> and caches the ids —
          nothing is hardcoded. Anything unmatched is listed with instructions below.
        </p>

        <div style={{ display: "grid", gap: 8 }}>
          {fields.map((f) => (
            <div
              key={f.key}
              style={{
                display: "flex", alignItems: "center", gap: 11, padding: "9px 11px",
                background: "var(--surface-2)", borderRadius: 7, fontSize: 13,
              }}
            >
              <span
                className="badge"
                style={
                  f.propertyId
                    ? { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "var(--ok)" }
                    : { background: "var(--warn-soft)", color: "var(--warn)", borderColor: "var(--warn)" }
                }
              >
                {f.propertyId ? "mapped" : "missing"}
              </span>
              <strong style={{ minWidth: 100 }}>{f.label}</strong>
              <span className="mono" style={{ color: "var(--text-faint)", fontSize: 11.5, flex: 1, wordBreak: "break-all" }}>
                {f.propertyId ?? `create a ${f.valueType} property named "${f.label}"`}
              </span>
            </div>
          ))}
          {fields.length === 0 && (
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              Run discovery to populate the mapping.
            </p>
          )}
        </div>

        {/* Discovery input: Onshape has no dependable company-level schema
            endpoint, so reading a real part is the reliable path. */}
        <div style={{ marginTop: 14, padding: 12, background: "var(--surface-2)", borderRadius: 8 }}>
          <div className="label" style={{ marginBottom: 8 }}>Read the ids from a real part (most reliable)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 8 }}>
            <input
              className="input" value={partUrl} onChange={(e) => setPartUrl(e.target.value)}
              placeholder="https://cad.onshape.com/documents/…/w/…/e/…"
            />
            <input
              className="input mono" value={partId} onChange={(e) => setPartId(e.target.value)}
              placeholder="Part ID"
            />
          </div>
          <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "7px 0 0", lineHeight: 1.5 }}>
            Paste a Part Studio URL and a part ID (e.g. <span className="mono">JHD</span>), then run discovery.
            Leave blank to reuse a part the MOS has already synced. Every metadata response names its
            properties, so one real part reveals the whole mapping.
          </p>
        </div>

        {sampledFrom && (
          <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "10px 0 0" }}>
            Read from <strong>{sampledFrom}</strong>.
          </p>
        )}

        {seenNames.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
              {seenNames.length} property name{seenNames.length === 1 ? "" : "s"} Onshape reported — check spelling here
            </summary>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 8, lineHeight: 1.7 }}>
              {seenNames.join("  ·  ")}
            </div>
          </details>
        )}

        {instructions.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <Alert kind="warn">
              <strong>Create these in Onshape, then run discovery again:</strong>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
                {instructions.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </Alert>
          </div>
        )}
      </section>

      {/* -------------------------------- webhook ------------------------------ */}
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Webhook</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
          Subscribes to <code className="mono">onshape.model.lifecycle.metadata</code> for the enterprise.
          Onshape requires an HTTPS callback it can reach, so put the app behind a tunnel or real domain in live mode.
        </p>

        <KV k="Callback" v={webhook?.callbackUrl ?? `${p.appBaseUrl}/api/webhooks/onshape`} mono />
        <KV k="Webhook ID" v={webhook?.webhookId ?? "not registered"} mono />
        <KV k="Registered" v={webhook?.registeredAt ? new Date(webhook.registeredAt).toLocaleString() : "—"} />

        <div style={{ display: "flex", gap: 9, marginTop: 14 }}>
          <button className="btn btn-primary" onClick={registerWebhook} disabled={busy !== null || !isAdmin}>
            {busy === "webhook" && <Spinner />} {webhook?.webhookId ? "Re-register" : "Register webhook"}
          </button>
          {webhook?.webhookId && (
            <button className="btn btn-danger" onClick={() => removeWebhook()} disabled={busy !== null || !isAdmin}>
              {busy === "unwebhook" && <Spinner />} Remove
            </button>
          )}
        </div>

        {/* What Onshape actually holds, which is not always what we recorded. */}
        {webhook?.live?.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div className="label" style={{ marginBottom: 8 }}>
              Subscriptions Onshape currently holds ({webhook.live.length})
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {webhook.live.map((w: any) => (
                <div
                  key={w.id}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 11px",
                    background: w.stray ? "var(--warn-soft)" : "var(--surface-2)",
                    border: `1px solid ${w.stray ? "var(--warn)" : "var(--border)"}`,
                    borderRadius: 7, fontSize: 12.5,
                  }}
                >
                  <span
                    className="badge"
                    style={w.stray
                      ? { background: "transparent", color: "var(--warn)", borderColor: "var(--warn)" }
                      : { background: "transparent", color: "var(--ok)", borderColor: "var(--ok)" }}
                  >
                    {w.stray ? "stale" : "current"}
                  </span>
                  <span className="mono" style={{ fontSize: 11, flex: 1, minWidth: 0, wordBreak: "break-all" }}>
                    {w.id}
                    <div style={{ color: "var(--text-faint)", marginTop: 2 }}>
                      {w.events.length ? w.events.join(" · ") : "no events"}
                    </div>
                  </span>
                  {w.stray && isAdmin && (
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => removeWebhook(w.id)}
                      disabled={busy !== null}
                    >
                      {busy === `stray:${w.id}` && <Spinner />} Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
            {webhook.strayCount > 0 && (
              <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "9px 0 0", lineHeight: 1.5 }}>
                {webhook.strayCount} subscription{webhook.strayCount === 1 ? " is" : "s are"} left over from an
                earlier registration. They still deliver events the MOS cannot attribute — remove them.
              </p>
            )}
          </div>
        )}
        {!isAdmin && (
          <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "9px 0 0" }}>
            Only enterprise admins can change the webhook.
          </p>
        )}
      </section>

      {/* --------------------------- release enrolment -------------------------- */}
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>
          Enrol parts when they are released
        </h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
          When on, releasing a part in Onshape creates a manufacturing item for it automatically.
          Off by default: on a shared tenant most releases have nothing to do with manufacturing,
          and enrolling them all fills the MOS with records nobody asked for. Parts can always be
          brought in individually with <strong>Sync to MOS</strong> in the Onshape panel.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span
            className="badge"
            style={ent?.releaseSyncEnabled
              ? { background: "var(--ok-soft)", color: "var(--ok)", borderColor: "var(--ok)" }
              : { background: "var(--surface-2)", color: "var(--text-muted)", borderColor: "var(--border)" }}
          >
            {ent?.releaseSyncEnabled ? "On" : "Off"}
          </span>
          <button
            className={ent?.releaseSyncEnabled ? "btn btn-danger" : "btn btn-primary"}
            onClick={() => setReleaseSync(!ent?.releaseSyncEnabled)}
            disabled={busy !== null || !isAdmin}
          >
            {busy === "releaseSync" && <Spinner />}
            {ent?.releaseSyncEnabled ? "Turn off" : "Turn on"}
          </button>
          {!isAdmin && (
            <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
              Only an admin can change this.
            </span>
          )}
        </div>

        {!ent?.releaseSyncEnabled && ent?.releasesIgnored > 0 && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "12px 0 0", lineHeight: 1.5 }}>
            <strong>{ent.releasesIgnored}</strong> release
            {ent.releasesIgnored === 1 ? " has" : "s have"} been ignored since this was turned off
            {ent.lastReleaseIgnoredAt
              ? `, most recently ${new Date(ent.lastReleaseIgnoredAt).toLocaleString()}`
              : ""}
            . That is roughly how many items would have been created.
          </p>
        )}
      </section>

      {/* ------------------------------ facilities ------------------------------ */}
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>
          Manufacturing locations &amp; vendors
        </h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
          Who can be assigned as responsible for making a part — a plant, a division, or an outside
          vendor. This is a plain list your enterprise defines; the MOS does not care which of these
          are internal and which are outsourced. Shown as <strong>Manufactured by</strong> on each
          item, and never written back to Onshape.
        </p>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: isAdmin ? 12 : 0 }}>
          {(ent?.facilities ?? []).length === 0 ? (
            <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>None defined yet.</span>
          ) : (
            (ent?.facilities ?? []).map((f: string) => (
              <span
                key={f} className="badge"
                style={{ background: "var(--surface-2)", color: "var(--text-muted)", borderColor: "var(--border)", gap: 6 }}
              >
                {f}
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => removeFacility(f)}
                    disabled={busy !== null}
                    aria-label={`Remove ${f}`}
                    style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 13, lineHeight: 1 }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))
          )}
        </div>

        {isAdmin ? (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input" style={{ maxWidth: 240 }} value={newFacility}
              onChange={(e) => setNewFacility(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addFacility(); }}
              placeholder="e.g. Plant 3 – Shenzhen"
            />
            <button className="btn" onClick={addFacility} disabled={busy !== null || !newFacility.trim()}>
              {busy === "facilities" && <Spinner />} Add
            </button>
          </div>
        ) : (
          <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
            Only an admin can change this list.
          </span>
        )}
      </section>

      {/* ------------------------------- cleanup ------------------------------- */}
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Remove unused items</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
          Finds manufacturing items that were created automatically and never used — from
          before enrolment became deliberate. Shows what it would delete before doing anything,
          and clears the MO properties in Onshape as it goes.
        </p>
        <Link href="/settings/cleanup" className="btn">Review unused items</Link>
      </section>

      {/* ------------------------------- maintenance --------------------------- */}
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Re-sync all items</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
          Re-reads every manufacturing item from Onshape and refreshes the mirrored fields.
          Useful after an upgrade changes how a field is interpreted — otherwise those rows keep
          their old values until a designer next touches the part. MOS-owned fields are untouched.
        </p>
        <button className="btn" onClick={resyncAll} disabled={busy !== null}>
          {busy === "resync" && <Spinner />} Re-sync all from Onshape
        </button>
      </section>

      {/* ------------------------------- simulator ----------------------------- */}
      {p.mode === "mock" && (
        <section className="card" style={{ padding: 18 }}>
          <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Simulator data</h2>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.55 }}>
            Loads five sample parts across two documents plus the enterprise custom-property definitions.
            Safe to re-run — existing property values are left alone.
          </p>
          <button className="btn" onClick={seed} disabled={busy !== null}>
            {busy === "seed" && <Spinner />} Seed mock Onshape data
          </button>
        </section>
      )}

      {/* ------------------------------ panel config --------------------------- */}
      <section className="card" style={{ padding: 18 }}>
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>App extensions (right panel)</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 12px", lineHeight: 1.55 }}>
          Two separate extensions, both with location <strong>Element right panel</strong>. Set each
          one&apos;s element type in the Dev Portal so the right panel appears on the right kind of tab.
        </p>
        <h3 style={{ fontSize: 12.5, margin: "0 0 6px", fontWeight: 650 }}>
          Part Studio — one part&apos;s manufacturing order
        </h3>
        <pre
          className="mono"
          style={{
            background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 7,
            padding: 11, fontSize: 11, overflowX: "auto", margin: 0, lineHeight: 1.6,
          }}
        >
{`${p.appBaseUrl}/panel`}
{`?documentId={$documentId}`}
{`&workspaceOrVersion={$workspaceOrVersion}`}
{`&workspaceOrVersionId={$workspaceOrVersionId}`}
{`&elementId={$elementId}`}
{`&partId={$partId}`}
{`&configuration={$configuration}`}
{`&companyId={$companyId}`}
{`&userId={$userId}`}
        </pre>

        <h3 style={{ fontSize: 12.5, margin: "16px 0 6px", fontWeight: 650 }}>
          Assembly — read the bill of materials
        </h3>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 10px", lineHeight: 1.55 }}>
          No <code className="mono">partId</code> or{" "}
          <code className="mono">configuration</code> here: this panel works on the assembly tab
          itself, not on whatever happens to be selected inside it.
        </p>
        <pre
          className="mono"
          style={{
            background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 7,
            padding: 11, fontSize: 11, overflowX: "auto", margin: 0, lineHeight: 1.6,
          }}
        >
{`${p.appBaseUrl}/panel/assembly`}
{`?documentId={$documentId}`}
{`&workspaceOrVersion={$workspaceOrVersion}`}
{`&workspaceOrVersionId={$workspaceOrVersionId}`}
{`&elementId={$elementId}`}
{`&companyId={$companyId}`}
{`&userId={$userId}`}
        </pre>
      </section>
    </div>
  );
}
