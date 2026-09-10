/**
 * Diagnose "Could not authenticate client" on the Onshape token exchange.
 *
 * Runs with plain node, from the deployment directory or the project root:
 *
 *   node scripts/check-onshape-oauth.mjs      # from the repo
 *   node check-onshape-oauth.mjs              # from the release bundle
 *
 * The trick is to send a deliberately invalid authorization code. Onshape
 * authenticates the *client* before it looks at the code, so the error it
 * returns says which half is wrong:
 *
 *   unauthorized_client  the client id/secret are not being accepted
 *   invalid_grant        the credentials are fine; only the code was bad
 *
 * So a run that reports invalid_grant is a pass. It needs no real code, no
 * browser, and no user — which is the point: the failure it diagnoses happens
 * mid-redirect, where there is nothing to inspect.
 *
 * It also tries each way of presenting the credentials, because RFC 6749 lets a
 * server require HTTP Basic and refuse form parameters. Sending them in the body
 * is what the app does today, so if only Basic is accepted, that is the bug.
 */
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const out = { ...process.env };
  for (const name of [".env.local", ".env"]) {
    const file = path.resolve(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      if (!(k in process.env)) out[k] = t.slice(i + 1).trim();
    }
  }
  return out;
}

const env = loadEnv();
const id = env.ONSHAPE_CLIENT_ID ?? "";
const secret = env.ONSHAPE_CLIENT_SECRET ?? "";
const oauthBase = (env.ONSHAPE_OAUTH_URL || "https://oauth.onshape.com").replace(/\/$/, "");
const appBase = (env.APP_BASE_URL || "").replace(/\/$/, "");
const redirectUri = `${appBase}/api/onshape/oauth/callback`;

/** Describe a credential without printing it. */
function describe(label, value) {
  if (!value) return `${label}: MISSING`;
  const notes = [];
  if (/^["'].*["']$/.test(value)) notes.push("wrapped in quotes — remove them");
  if (value !== value.trim()) notes.push("has leading/trailing whitespace");
  if (/\s/.test(value.trim())) notes.push("contains an internal space");
  return (
    `${label}: ${value.length} chars, ` +
    `starts "${value.slice(0, 4)}…", ends "…${value.slice(-4)}"` +
    (notes.length ? `  ⚠ ${notes.join("; ")}` : "")
  );
}

console.log("Configuration");
console.log(" ", describe("ONSHAPE_CLIENT_ID    ", id));
console.log(" ", describe("ONSHAPE_CLIENT_SECRET", secret));
console.log("  ONSHAPE_OAUTH_URL:", oauthBase);
console.log("  APP_BASE_URL     :", appBase || "MISSING");
console.log("  redirect_uri sent:", redirectUri);
console.log("  ONSHAPE_MODE     :", env.ONSHAPE_MODE || "(unset — defaults to mock)");

if (!id || !secret) {
  console.error("\nThe client id and secret must both be set. Nothing else can be tested.");
  process.exit(1);
}
if (!appBase) {
  console.error("\nAPP_BASE_URL is unset, so redirect_uri would be sent as a bare path.");
  console.error("Onshape rejects that, and it presents as a client-authentication failure.");
  process.exit(1);
}
if (env.ONSHAPE_MODE !== "live") {
  console.log("\nNote: ONSHAPE_MODE is not \"live\", so the app itself would not reach");
  console.log("Onshape at all. Testing the credentials anyway.");
}

/**
 * Attempt an exchange with a code that is certainly invalid.
 *
 * `style` decides how the credentials are presented — the whole question this
 * script exists to answer.
 */
async function attempt(style) {
  const params = {
    grant_type: "authorization_code",
    code: "deliberately-invalid-code-for-diagnostics",
    redirect_uri: redirectUri,
  };
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };

  if (style === "body" || style === "both") {
    params.client_id = id;
    params.client_secret = secret;
  }
  if (style === "basic" || style === "both") {
    headers.Authorization =
      "Basic " + Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64");
  }

  try {
    const res = await fetch(`${oauthBase}/oauth/token`, {
      method: "POST",
      headers,
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    let error = "";
    try { error = JSON.parse(text).error ?? ""; } catch { error = text.slice(0, 80); }
    return { status: res.status, error, text: text.slice(0, 200) };
  } catch (err) {
    return { status: 0, error: "network", text: String(err?.message ?? err) };
  }
}

const STYLES = [
  ["body",  "credentials in the form body  (what the app does today)"],
  ["basic", "credentials as HTTP Basic     (what RFC 6749 prefers)"],
  ["both",  "credentials both ways"],
];

console.log("\nSending an invalid code, to see which half Onshape objects to");
const results = {};
for (const [style, label] of STYLES) {
  const r = await attempt(style);
  results[style] = r;
  const verdict =
    r.error === "invalid_grant"
      ? "CLIENT AUTHENTICATED — only the code was rejected, which is the pass"
      : r.error === "unauthorized_client" || r.error === "invalid_client"
        ? "client rejected"
        : r.error === "network"
          ? `could not reach ${oauthBase}`
          : `unexpected: ${r.error || r.text}`;
  console.log(`  ${label}`);
  console.log(`    HTTP ${r.status}  ${r.error || "(no error field)"}  → ${verdict}`);
}

const passed = STYLES.filter(([s]) => results[s].error === "invalid_grant").map(([s]) => s);

console.log("\nConclusion");
if (passed.length === 0) {
  console.log("  Onshape accepted the credentials in none of the three forms, so the");
  console.log("  client id or secret itself is wrong, revoked, or from a different");
  console.log("  application. Re-copy both from the Developer Portal — the secret is");
  console.log("  shown once, so if it was not saved it has to be regenerated.");
  process.exitCode = 1;
} else if (passed.includes("body")) {
  console.log("  The credentials authenticate the way the app already sends them, so");
  console.log("  the failure is elsewhere. The next thing to check is redirect_uri:");
  console.log("  Onshape requires the value sent here to match a registered Redirect");
  console.log("  URL character for character. This script sent:");
  console.log(`      ${redirectUri}`);
  console.log("  Compare that against the Developer Portal exactly — scheme, host,");
  console.log("  path, and no trailing slash.");
} else {
  console.log(`  Onshape accepts the credentials only as: ${passed.join(", ")}.`);
  console.log("  The app sends them in the form body, which is why the exchange fails.");
  console.log("  lib/onshape/oauth.ts tokenRequest() needs to send HTTP Basic.");
  process.exitCode = 1;
}
