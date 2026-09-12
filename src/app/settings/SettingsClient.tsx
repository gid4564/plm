"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, Field, KV, Spinner, relTime } from "@/components/ui";

type Props = {
  mode: "mock" | "live";
  role: "admin" | "approver" | "user";
  appBaseUrl: string;
  connected: boolean;
};

export function SettingsClient(p: Props) {
  const isAdmin = p.role === "admin";

  const [ent, setEnt] = useState<any>(null);
  const [mapping, setMapping] = useState<any>(null);
  const [webhook, setWebhook] = useState<any>(null);
  const [clients, setClients] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Shown once, then gone: the secret is stored only as a hash.
  const [newSecret, setNewSecret] = useState<{ clientId: string; clientSecret: string; warning: string } | null>(null);
  const [clientName, setClientName] = useState("Onshape");
  /*
   * Deliberately blank. This used to default to a guessed Onshape callback URL,
   * which is worse than empty: a wrong value that looks authoritative gets
   * registered unread, and the mismatch only surfaces later as a refusal during
   * Grant Access. The right value is whatever Onshape actually sends, and the
   * hint on the field says how to find it.
   */
  const [redirectUri, setRedirectUri] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editUri, setEditUri] = useState("");
  const [partUrl, setPartUrl] = useState("");
  const [partId, setPartId] = useState("");
  const [resync, setResync] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, m, w] = await Promise.all([
        fetch("/api/enterprise").then((r) => r.json()),
        fetch("/api/onshape/properties").then((r) => r.json()),
        fetch("/api/onshape/webhook").then((r) => r.json()),
      ]);
      setEnt(e);
      setMapping(m);
      setWebhook(w);
      if (isAdmin) {
        setClients(await fetch("/api/oauth/clients").then((r) => r.json()));
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { load(); }, [load]);

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const post = async (url: string, body?: unknown, method = "POST") => {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "That did not work");
    return json;
  };

  if (loading) {
    return <div className="card" style={{ padding: 40, textAlign: "center" }}><Spinner size={20} /></div>;
  }

  const unmatched = (mapping?.mappings ?? []).filter((m: any) => m.status === "unmatched");
  const bound = (mapping?.mappings ?? []).filter((m: any) => m.status === "bound");
  const plmOnly = (mapping?.mappings ?? []).filter((m: any) => m.status === "plm-only");

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 3px", letterSpacing: "-.02em" }}>Settings</h1>
        <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
          Onshape mode: <strong>{p.mode}</strong>
          {p.mode === "mock" && " — the built-in simulator stands in for a real tenant"}
        </p>
      </div>

      {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert kind="ok" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {!isAdmin && (
        <Alert kind="info">
          Most of this is admin-only. You can see how things are configured.
        </Alert>
      )}

      {/* ------------------------------- Enterprise -------------------------- */}
      <section className="card">
        <h2 style={{ fontSize: 14, margin: "0 0 12px", fontWeight: 650 }}>Enterprise</h2>
        <KV k="Name" v={ent?.name} />
        <KV k="Onshape company" v={ent?.onshapeCompanyId} mono />
        <KV k="Onshape domain" v={ent?.onshapeDomain || "—"} mono />
      </section>

      {/* --------------------------- Onshape connection ---------------------- */}
      <section className="card">
        <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Your Onshape account</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 10px", lineHeight: 1.5 }}>
          PLM reads and writes Onshape as you for anything you do by hand. This is the ordinary
          OAuth direction — PLM as the client — and it is separate from how Onshape authenticates
          to PLM further down.
        </p>
        {/*
          * The service account's broken connection is shown here as well as in
          * Release management, because this is where someone comes to fix it —
          * and because the webhook path that discovers the breakage has no UI
          * of its own to report from.
          */}
        {ent?.serviceAccount?.tokenFailedAt && (
          <Alert kind="error">
            <strong>The Onshape connection for {ent.serviceAccount.email} has stopped
            working.</strong> A token refresh failed {relTime(ent.serviceAccount.tokenFailedAt)},
            so background syncing and release transitions will be failing. That account has to
            press Connect Onshape again.
            {ent.serviceAccount.tokenError && (
              <span style={{ display: "block", marginTop: 5, fontSize: 11.5, opacity: 0.85 }}>
                Onshape said: {ent.serviceAccount.tokenError}
              </span>
            )}
          </Alert>
        )}

        {p.connected ? (
          <Alert kind="ok">Connected.</Alert>
        ) : (
          <a className="btn btn-primary" href="/api/onshape/oauth/start?returnTo=/settings">
            Connect Onshape
          </a>
        )}
      </section>

      {/* ------------------------------ Release setup ------------------------ */}
      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Release management</h2>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            When a designer raises a release candidate in Onshape, PLM takes over the approval and
            then performs the approve or reject transition on the Onshape release package itself.
          </p>
        </div>

        {/*
          * The Onshape identity leads, because that is the one Onshape checks
          * against the workflow's approver list. The PLM login is shown beneath
          * it as provenance — it is merely the account holding the tokens.
          */}
        <KV
          k="Releases execute as"
          v={
            !ent?.serviceAccount ? (
              <span style={{ color: "var(--warn)" }}>not set</span>
            ) : ent.serviceAccount.onshapeEmail ? (
              <>
                <strong>{ent.serviceAccount.onshapeEmail}</strong>
                {ent.serviceAccount.onshapeName ? ` (${ent.serviceAccount.onshapeName})` : ""}
                <span style={{ display: "block", color: "var(--text-faint)", fontSize: 11.5 }}>
                  in Onshape · via the PLM login {ent.serviceAccount.email} · connected{" "}
                  {relTime(ent.serviceAccount.connectedAt)}
                </span>
              </>
            ) : (
              <>
                <span style={{ color: "var(--warn)" }}>
                  Onshape identity not recorded
                </span>
                <span style={{ display: "block", color: "var(--text-faint)", fontSize: 11.5 }}>
                  Held by the PLM login {ent.serviceAccount.email}, connected before PLM
                  started recording which Onshape account a token acts as. Press Connect
                  Onshape again to capture it.
                </span>
              </>
            )
          }
        />
        <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "-4px 0 0", lineHeight: 1.5 }}>
          <strong>
            The Onshape account named above must be a designated approver on the release
            workflow.
          </strong>{" "}
          Onshape restricts an approve transition to designated approvers, and PLM performs
          that transition as this account. Whoever decides the release in PLM is recorded
          separately and needs no Onshape seat at all.
        </p>

        {isAdmin && (ent?.serviceAccountCandidates ?? []).length > 0 && (
          <Field
            label="Act as"
            hint="Labelled by the Onshape account each connection authenticates as, which is what matters here — not by the PLM login holding it."
          >
            <select
              className="select"
              value={""}
              onChange={(e) =>
                e.target.value &&
                run("service", async () => {
                  await post("/api/enterprise", { integrationUserId: e.target.value }, "PATCH");
                  setNotice("Service account set.");
                  await load();
                })
              }
            >
              <option value="">— choose a connected Onshape account —</option>
              {ent.serviceAccountCandidates.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.onshapeEmail
                    ? `${c.onshapeEmail}${c.onshapeName ? ` — ${c.onshapeName}` : ""}  (via PLM login ${c.email})`
                    : `Onshape identity unknown — held by PLM login ${c.email}`}
                </option>
              ))}
            </select>
          </Field>
        )}

        {isAdmin && (
          <details>
            <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
              Using a dedicated Onshape service account, not your own
            </summary>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginTop: 8 }}>
              <p style={{ margin: "0 0 8px" }}>
                The list above holds PLM logins, because an Onshape token has to belong to
                one. But the token can authenticate as <em>any</em> Onshape account — so a
                dedicated service user is a matter of which Onshape account you are signed in
                as at the moment you connect, not of which PLM user you are.
              </p>
              <ol style={{ margin: "0 0 8px", paddingLeft: 20 }}>
                <li>Create the service user in your Onshape enterprise and give it a seat.</li>
                <li>
                  Add it as a <strong>designated approver</strong> on the release workflow
                  (Onshape: Enterprise settings → Release management).
                </li>
                <li>
                  In a private window, sign in to <em>Onshape</em> as the service user.
                </li>
                <li>
                  In that same window, sign in to PLM — a dedicated PLM login such as{" "}
                  <span className="mono">service@…</span> keeps the audit trail legible, but
                  any will do — and press <strong>Connect Onshape</strong>.
                </li>
                <li>
                  Come back here. The entry will name the service user, and you can nominate
                  it.
                </li>
              </ol>
              <p style={{ margin: 0 }}>
                The private window matters: connecting from your normal session links your own
                Onshape account, and every release would then be executed and attributed to
                you in Onshape&rsquo;s own records.
              </p>
            </div>
          </details>
        )}

        <KV
          k="Release workflow"
          v={
            ent?.onshapeReleaseWorkflowId ? (
              <>
                {ent.onshapeReleaseWorkflowName || "Release"}{" "}
                <span className="mono" style={{ color: "var(--text-faint)", fontSize: 11 }}>
                  {ent.onshapeReleaseWorkflowId}
                </span>
              </>
            ) : (
              <span style={{ color: "var(--warn)" }}>not discovered</span>
            )
          }
        />

        {isAdmin && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-sm"
              disabled={busy != null}
              onClick={() =>
                run("workflow", async () => {
                  const j = await post("/api/enterprise", { action: "discover-workflow" });
                  setNotice(j.message);
                  await load();
                })
              }
            >
              {busy === "workflow" ? <Spinner /> : "Discover the release workflow"}
            </button>

            <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={Boolean(ent?.releaseTakeoverEnabled)}
                onChange={(e) =>
                  run("takeover", async () => {
                    await post("/api/enterprise", { releaseTakeoverEnabled: e.target.checked }, "PATCH");
                    setNotice(e.target.checked ? "PLM will now take over releases." : "Release takeover switched off.");
                    await load();
                  })
                }
              />
              Take over releases raised in Onshape
            </label>

            <label style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 13 }}>
              <input
                type="checkbox"
                style={{ marginTop: 3 }}
                checked={Boolean(ent?.releaseGltfEnabled)}
                onChange={(e) =>
                  run("gltf", async () => {
                    await post("/api/enterprise", { releaseGltfEnabled: e.target.checked }, "PATCH");
                    setNotice(
                      e.target.checked
                        ? "PLM will capture the 3D model of each part as it is released."
                        : "3D capture switched off. Models already captured are kept."
                    );
                    await load();
                  })
                }
              />
              <span>
                Capture the 3D model (glTF) when a part is released
                <span style={{ display: "block", color: "var(--text-faint)", fontSize: 11.5, marginTop: 2 }}>
                  Taken from the version the release produces, so it is the geometry
                  as released, and kept per revision. Costs one Onshape call per
                  released item; an assembly goes through a translation job and takes
                  longer than a part.
                </span>
              </span>
            </label>
          </div>
        )}

        {!ent?.releaseTakeoverEnabled && (
          <Alert kind="warn">
            <strong>Release takeover is off.</strong> Release packages raised in Onshape are
            acknowledged and ignored — PLM will not approve or reject anything.
            {ent?.releasesIgnored ? (
              <>
                {" "}{ent.releasesIgnored} have been ignored so far, most recently{" "}
                {relTime(ent.lastReleaseIgnoredAt)}.
              </>
            ) : null}
            {" "}It is off by default on purpose: switching it on means PLM starts acting on real
            release packages across the whole tenant.
          </Alert>
        )}
      </section>

      {/* --------------------------- Attribute mapping ----------------------- */}
      <section className="card" style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>Onshape property mapping</h2>
          <div style={{ flex: 1 }} />
          <Link href="/attributes" className="btn btn-sm">Edit the attribute schema</Link>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
          Each attribute names the Onshape property it maps to. Matching is by name, because
          Onshape&rsquo;s property ids are per-tenant — discovery resolves those names to the ids
          this tenant actually uses. Last run {relTime(mapping?.checkedAt)}.
        </p>

        <div style={{ display: "flex", gap: 14, fontSize: 12.5 }}>
          <span style={{ color: "var(--ok)" }}>{bound.length} bound</span>
          <span style={{ color: unmatched.length ? "var(--danger)" : "var(--text-faint)" }}>
            {unmatched.length} not found
          </span>
          <span style={{ color: "var(--text-faint)" }}>{plmOnly.length} PLM-only</span>
        </div>

        {unmatched.length > 0 && (
          <Alert kind="warn">
            These attributes name a property this tenant does not have, so nothing moves for them:{" "}
            {unmatched.map((m: any) => `${m.label} → "${m.onshapePropertyName}"`).join("; ")}.
          </Alert>
        )}

        {isAdmin && (
          <>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "2fr 1fr auto", alignItems: "end" }}>
              <Field
                label="Sample a specific part (optional)"
                hint="Onshape has no dependable company-level property endpoint, but a real part's metadata names every property on it."
              >
                <input
                  className="input"
                  placeholder="https://cad.onshape.com/documents/…/w/…/e/…"
                  value={partUrl}
                  onChange={(e) => setPartUrl(e.target.value)}
                />
              </Field>
              <Field label="Part ID">
                <input className="input mono" placeholder="JHD" value={partId} onChange={(e) => setPartId(e.target.value)} />
              </Field>
              <button
                className="btn btn-primary"
                disabled={busy != null}
                onClick={() =>
                  run("discover", async () => {
                    const j = await post("/api/onshape/properties", {
                      partUrl: partUrl.trim() || undefined,
                      partId: partId.trim() || undefined,
                    });
                    setNotice(
                      `Bound ${j.bound.length}, ${j.unmatched.length} not found, ${j.plmOnly} PLM-only. ` +
                      `Saw ${j.definitionCount} propert${j.definitionCount === 1 ? "y" : "ies"}` +
                      (j.sampledFrom ? ` (sampled ${j.sampledFrom})` : "") + "."
                    );
                    await load();
                  })
                }
              >
                {busy === "discover" ? <Spinner /> : "Run discovery"}
              </button>
            </div>
            {mapping?.schemaError && (
              <Alert kind="info">
                Onshape&rsquo;s company-level property endpoint returned an error, so only
                properties seen on a real part were used: {mapping.schemaError}
              </Alert>
            )}
          </>
        )}
      </section>

      {/* -------------------- Onshape authenticating to PLM ------------------ */}
      {isAdmin && (
        <section className="card" style={{ display: "grid", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>
              How Onshape authenticates to PLM
            </h2>
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
              Onshape&rsquo;s extension action URLs use <em>External OAuth</em>: Onshape is the
              client and PLM is the authorization server. Register Onshape as a client here, then
              paste the id, the secret and these two endpoints into the Developer Portal against
              this application&rsquo;s External OAuth settings.
            </p>
          </div>

          <KV k="Authorize URL" v={clients?.endpoints?.authorize} mono />
          <KV k="Token URL" v={clients?.endpoints?.token} mono />

          <Alert kind="info">
            <strong>Finding the redirect URI.</strong> It is whatever Onshape sends, and it
            is not documented — so read it rather than guess. Press Grant Access in Onshape:
            you land on this PLM&rsquo;s <span className="mono">/api/oauth/authorize</span>,
            and the browser&rsquo;s address bar carries{" "}
            <span className="mono">redirect_uri=…</span>. Register that value exactly,
            URL-decoded. If it does not match, the refusal names both what Onshape sent and
            what the client permits.
          </Alert>

          {newSecret && (
            <Alert kind="warn">
              <div style={{ display: "grid", gap: 5 }}>
                <div><strong>Client id</strong> <span className="mono">{newSecret.clientId}</span></div>
                <div><strong>Client secret</strong> <span className="mono">{newSecret.clientSecret}</span></div>
                <div style={{ fontSize: 12 }}>{newSecret.warning}</div>
              </div>
            </Alert>
          )}

          {(clients?.clients ?? []).map((c: any) => (
            <div
              key={c.id}
              style={{
                display: "flex", gap: 10, alignItems: "center",
                borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 12.5,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{c.name}</strong>
                {c.disabledAt && <span className="badge" style={{ marginLeft: 6 }}>disabled</span>}
                <div className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>{c.clientId}</div>
                <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  {c.liveTokens} live token{c.liveTokens === 1 ? "" : "s"} · last used {relTime(c.lastUsedAt)}
                </div>
                {/* Shown because a mismatch here is the commonest reason Grant
                    Access fails, and it is otherwise invisible. */}
                <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
                  sends codes to:{" "}
                  <span className="mono">{(c.redirectUris ?? []).join(", ") || "nothing registered"}</span>
                </div>

                {editing === c.clientId && (
                  <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "flex-start" }}>
                    <input
                      className="input"
                      style={{ flex: 1, minWidth: 0 }}
                      placeholder="https://… exactly as Onshape sent it"
                      value={editUri}
                      onChange={(e) => setEditUri(e.target.value)}
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={busy != null || !editUri.trim()}
                      onClick={() =>
                        run(`edit-${c.id}`, async () => {
                          const j = await post("/api/oauth/clients", {
                            clientId: c.clientId,
                            redirectUris: [editUri.trim()],
                          }, "PATCH");
                          setNotice(j.message);
                          setEditing(null);
                          await load();
                        })
                      }
                    >
                      {busy === `edit-${c.id}` ? <Spinner /> : "Save"}
                    </button>
                    <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                )}
              </div>
              {!c.disabledAt && editing !== c.clientId && (
                <>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      setEditing(c.clientId);
                      setEditUri((c.redirectUris ?? [])[0] ?? "");
                    }}
                  >
                    Redirect URI
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy != null}
                    onClick={() =>
                      run(`revoke-${c.id}`, async () => {
                        if (!confirm(`Disable "${c.name}" and revoke its ${c.liveTokens} live token(s)?`)) return;
                        const j = await post(`/api/oauth/clients?clientId=${encodeURIComponent(c.clientId)}`, undefined, "DELETE");
                        setNotice(`Disabled. ${j.tokensRevoked} token(s) revoked.`);
                        await load();
                      })
                    }
                  >
                    {busy === `revoke-${c.id}` ? <Spinner /> : "Disable"}
                  </button>
                </>
              )}
            </div>
          ))}

          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr 2fr auto", alignItems: "end" }}>
            <Field label="Name">
              <input className="input" value={clientName} onChange={(e) => setClientName(e.target.value)} />
            </Field>
            <Field
              label="Redirect URI"
              hint="Whatever Onshape sends — see below. Matched exactly, never by prefix."
            >
              <input
                className="input"
                placeholder="https://…"
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
              />
            </Field>
            <button
              className="btn btn-primary"
              disabled={busy != null}
              onClick={() =>
                run("register-client", async () => {
                  const j = await post("/api/oauth/clients", {
                    name: clientName.trim(),
                    redirectUris: [redirectUri.trim()],
                  });
                  setNewSecret(j);
                  await load();
                })
              }
            >
              {busy === "register-client" ? <Spinner /> : "Register"}
            </button>
          </div>
        </section>
      )}

      {/* --------------------------------- Webhook --------------------------- */}
      <section className="card" style={{ display: "grid", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>Webhook</h2>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            How Onshape tells PLM that something happened. Note the callback carries a shared
            secret in its URL rather than a bearer token: Onshape&rsquo;s webhook registration
            accepts no custom headers, so there is nowhere else to put one.
          </p>
        </div>
        <KV k="Registered" v={webhook?.webhookId ? `${webhook.webhookId} · ${relTime(webhook.registeredAt)}` : "no"} mono />
        <KV k="Callback" v={webhook?.callbackUrl} mono />
        <KV k="Events" v={(webhook?.events ?? []).join(", ")} mono />

        {webhook?.strayCount > 0 && (
          <Alert kind="warn">
            {webhook.strayCount} subscription(s) at this callback are not the one on record — left
            behind by an earlier registration. They keep delivering events that cannot be
            attributed. Re-registering removes them.
          </Alert>
        )}

        {isAdmin && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy != null}
              onClick={() =>
                run("webhook", async () => {
                  const j = await post("/api/onshape/webhook");
                  setNotice(`Registered for ${(j.events ?? []).length} event(s).`);
                  await load();
                })
              }
            >
              {busy === "webhook" ? <Spinner /> : webhook?.webhookId ? "Re-register" : "Register"}
            </button>
            {webhook?.webhookId && (
              <button
                className="btn btn-sm"
                disabled={busy != null}
                onClick={() =>
                  run("unwebhook", async () => {
                    await post("/api/onshape/webhook", undefined, "DELETE");
                    setNotice("Removed.");
                    await load();
                  })
                }
              >
                {busy === "unwebhook" ? <Spinner /> : "Remove"}
              </button>
            )}
          </div>
        )}
      </section>

      {/* ------------------------------- Behaviour --------------------------- */}
      {isAdmin && (
        <section className="card" style={{ display: "grid", gap: 10 }}>
          <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>Behaviour</h2>
          <label style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={Boolean(ent?.ignoreConfigurations)}
              onChange={(e) =>
                run("cfg", async () => {
                  await post("/api/enterprise", { ignoreConfigurations: e.target.checked }, "PATCH");
                  setNotice("Saved.");
                  await load();
                })
              }
            />
            <span>
              Treat every configuration of a part as one PLM part
              <span style={{ display: "block", color: "var(--text-faint)", fontSize: 11.5, marginTop: 2 }}>
                Onshape reports the configuration string inconsistently across entry points, and
                because it is part of the identity key those differences produce duplicate parts
                with separate numbers. Turn this off only if you genuinely need one PLM part per
                configuration.
              </span>
            </span>
          </label>
        </section>
      )}

      {/* --------------------------------- Re-sync --------------------------- */}
      <section className="card" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>Re-read everything from Onshape</h2>
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
          Worth running after a mapping change: a newly mapped attribute holds nothing until
          something re-reads the parts. Done 25 at a time, oldest first — press again until
          nothing is left.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            className="btn btn-sm"
            disabled={busy != null}
            onClick={() =>
              run("resync", async () => {
                const j = await post("/api/parts/resync");
                setResync(j);
                setNotice(
                  `${j.processed} read: ${j.updated} changed, ${j.unchanged} unchanged` +
                  `${j.failures.length ? `, ${j.failures.length} failed` : ""}. ${j.remaining} left.`
                );
              })
            }
          >
            {busy === "resync" ? <Spinner /> : "Re-read a batch"}
          </button>
          {resync?.failures?.length > 0 && (
            <span style={{ fontSize: 12, color: "var(--danger)" }}>
              {resync.failures.length} could not be read
            </span>
          )}
        </div>
      </section>

      {/* ------------------------------- Simulator --------------------------- */}
      {p.mode === "mock" && isAdmin && (
        <section className="card" style={{ display: "grid", gap: 8 }}>
          <h2 style={{ fontSize: 14, margin: 0, fontWeight: 650 }}>Simulator data</h2>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            Fills the mock Onshape tenant with parts, drawings and property definitions. Existing
            values are left alone, so this is safe to press again.
          </p>
          <div>
            <button
              className="btn btn-sm"
              disabled={busy != null}
              onClick={() =>
                run("seed", async () => {
                  const j = await post("/api/simulator/seed");
                  setNotice(
                    `Seeded ${j.parts} part(s), ${j.assemblies} assembly/assemblies, ` +
                    `${j.drawings} drawing(s), ${j.tasks} task(s) and ` +
                    `${j.properties} property definition(s).`
                  );
                })
              }
            >
              {busy === "seed" ? <Spinner /> : "Seed the mock tenant"}
            </button>
          </div>
        </section>
      )}

      {/* ------------------------------ Extensions --------------------------- */}
      <section className="card" style={{ display: "grid", gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 650 }}>App extensions</h2>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            Register these in Onshape&rsquo;s Developer Portal against this application. The iframe
            panels need <span className="mono">{p.appBaseUrl}</span> to be public HTTPS or they
            cannot hold a session. The action URLs authenticate with External OAuth, configured
            above.
          </p>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Location</th>
              <th style={{ width: 60 }}>Type</th>
              <th style={{ width: 70 }}>Method</th>
              <th style={{ width: 130 }}>Context</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {/*
              * Method and Context are both required by the Developer Portal and
              * neither is guessable, so they are listed beside the URL rather
              * than left to the docs. A context PLM refuses — Drawing, Blob, or
              * an assembly Instance — produces a menu item that always fails,
              * which is worse than no menu item at all.
              */}
            {[
              ["Element right panel", "iFrame", "—", "Part, Part Studio",
               "/panel?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}&partId={$partId}&configuration={$configuration}"],
              ["Element right panel", "iFrame", "—", "Assembly",
               "/panel/assembly?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}"],
              ["Part number generator", "Action", "POST", "—",
               "/api/numbering/onshape-extension"],
              ["Element context menu", "Action", "POST", "Part Studio, Assembly",
               "/api/extensions/send-to-plm?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}"],
              ["Tree context menu", "Action", "POST", "Part",
               "/api/extensions/send-to-plm?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceOrVersionId={$workspaceOrVersionId}&elementId={$elementId}&partId={$partId}&configuration={$configuration}"],
              ["Document list context menu", "Action", "POST", "Part Studio, Assembly",
               "/api/extensions/send-to-plm?documentId={$documentId}&elementId={$elementId}&partId={$partId}"],
            ].map(([loc, type, method, context, path], i) => (
              <tr key={`${loc}-${i}`}>
                <td style={{ fontSize: 12.5 }}>{loc}</td>
                <td style={{ fontSize: 12 }}>{type}</td>
                <td style={{ fontSize: 12 }} className="mono">{method}</td>
                <td style={{ fontSize: 12 }}>{context}</td>
                <td className="mono" style={{ fontSize: 10.5, wordBreak: "break-all" }}>
                  {p.appBaseUrl}{path}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: 0, lineHeight: 1.55 }}>
          Either method works on the Send to PLM action URLs — both GET and POST are
          exported, and each field is read from whichever of the Action Body or the query
          string carries a usable value. GET needs one field less; POST is semantically
          right, since the call creates a PLM object and writes a part number back to
          Onshape. GET is safe rather than merely tolerated: the operation is idempotent,
          so a second call reports the number that already exists instead of allocating
          another.
          {" "}Leave <strong>Drawing</strong>, <strong>Blob</strong> and an assembly{" "}
          <strong>Instance</strong> unticked — PLM refuses all three deliberately, and a
          menu item that always fails is worse than one that is not there.
        </p>

        {/*
          * The Developer Portal requires an Action Body in valid JSON whenever the
          * action type is POST, and it is not obvious what belongs in it — so it is
          * offered here rather than left to the docs.
          */}
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
            Action Body JSON, if you register the context menus as POST
          </summary>
          <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "8px 0 6px", lineHeight: 1.55 }}>
            With a body supplying the context, the Action URL needs no query string —
            just <span className="mono">{p.appBaseUrl}/api/extensions/send-to-plm</span>.
          </p>
          {[
            ["Element context menu, and document list context menu", [
              "documentId", "workspaceOrVersion", "workspaceOrVersionId", "elementId",
            ]],
            ["Tree context menu — also names the selected part", [
              "documentId", "workspaceOrVersion", "workspaceOrVersionId", "elementId",
              "partId", "configuration",
            ]],
          ].map(([label, keys]) => (
            <div key={label as string} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 3 }}>
                {label as string}
              </div>
              <pre
                className="mono"
                style={{
                  margin: 0, fontSize: 11, lineHeight: 1.5, overflowX: "auto",
                  background: "var(--surface-2)", border: "1px solid var(--border)",
                  borderRadius: 6, padding: "8px 10px",
                }}
              >
{`{\n${(keys as string[]).map((k) => `  "${k}": "{$${k}}"`).join(",\n")}\n}`}
              </pre>
            </div>
          ))}
        </details>
      </section>
    </div>
  );
}
