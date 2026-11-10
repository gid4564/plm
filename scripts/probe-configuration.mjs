/**
 * What can a configurator built on PLM actually get from a configured assembly?
 *
 * The questions this answers, against a real assembly rather than the docs:
 *
 *   1. Which configuration inputs Onshape reports — lists, yes/no, numbers
 *      with ranges, text — and whether the visibility rules that hide one
 *      input depending on another come back at all, and where.
 *   2. Whether a chosen set of values can be turned into Onshape's own
 *      configuration string (the cache key), and how long that takes.
 *   3. Whether a picture of that configuration can be rendered.
 *   4. What its BOM looks like: which parts, in which configuration of their
 *      own, and with which part numbers — and how that differs between two
 *      configurations, which is what a growing PLM BOM would be built from.
 *
 * Read-only towards Onshape. The one write is to PLM's own database: if the
 * stored access token is about to expire it is refreshed and saved back, as
 * the app itself does, so the app is not left holding a refresh token Onshape
 * has rotated.
 *
 * Runs with plain `node` from the deployment directory, so .env.local is found:
 *
 *   node probe-configuration.mjs "<assembly URL>"
 *   node probe-configuration.mjs "<assembly URL>" --set "Size=Large" --set "Handles=true"
 *
 * The URL is the one in the browser with the assembly tab open. Without
 * --set, the second configuration tried differs from the first in its first
 * input; --set names inputs by name or id and values by option name or value.
 *
 * Prints a summary, and writes everything Onshape returned (raw JSON, and the
 * two pictures) to ./probe-config-<time>/ for a closer look.
 */
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const argv = process.argv.slice(2);
const url = argv.find((a) => /\/documents\//.test(a));
const sets = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "--set" && argv[i + 1]) sets.push(argv[++i]);

if (!url) {
  console.error('Usage: node probe-configuration.mjs "<Onshape assembly URL>" [--set "Input=Value" ...]');
  process.exit(1);
}
const m = /\/documents\/([0-9a-f]{24})\/(w|v|m)\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i.exec(url);
if (!m) {
  console.error("That URL does not name a document, workspace or version, and tab (…/documents/<id>/w/<id>/e/<id>).");
  process.exit(1);
}
const [, did, wvType, wvId, eid] = m;
const wv = `${wvType}/${wvId}`;

function loadEnv() {
  const out = { ...process.env };
  const file = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(file)) {
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
if (!env.MONGODB_URI) {
  console.error("MONGODB_URI not set. Run this from the deployment directory, or export it.");
  process.exit(1);
}
const API = env.ONSHAPE_API_URL || "https://cad.onshape.com/api";
const OAUTH = (env.ONSHAPE_OAUTH_URL || "https://oauth.onshape.com").replace(/\/$/, "");
const outDir = path.resolve(process.cwd(), `probe-config-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(outDir, { recursive: true });
const save = (name, data) =>
  fs.writeFileSync(path.join(outDir, name), typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));

const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
let token = "";

/** The service account's token, refreshed and saved back if it is about to lapse. */
async function getToken(db) {
  const enterprise = await db.collection("enterprises").findOne({});
  if (!enterprise) throw new Error("No enterprise found.");
  let user = enterprise.integrationUserId
    ? await db.collection("users").findOne({ _id: enterprise.integrationUserId })
    : null;
  if (!user?.onshapeAccessToken) {
    user = await db.collection("users").findOne(
      { enterpriseId: enterprise._id, onshapeAccessToken: { $nin: [null, ""] } },
      { sort: { role: 1, onshapeConnectedAt: -1 } }
    );
  }
  if (!user?.onshapeAccessToken) throw new Error("No connected Onshape account to read as. Connect one in Settings.");
  console.log(`reading as ${user.onshapeEmail || user.email}\n`);

  const expiring = !user.onshapeTokenExpiresAt || new Date(user.onshapeTokenExpiresAt).getTime() - Date.now() < 120_000;
  if (!expiring) return user.onshapeAccessToken;
  if (!user.onshapeRefreshToken || !env.ONSHAPE_CLIENT_ID || !env.ONSHAPE_CLIENT_SECRET) {
    console.log("(stored token may be stale and cannot be refreshed here — trying it anyway)\n");
    return user.onshapeAccessToken;
  }
  const res = await fetch(`${OAUTH}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ONSHAPE_CLIENT_ID, client_secret: env.ONSHAPE_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: user.onshapeRefreshToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  await db.collection("users").updateOne({ _id: user._id }, { $set: {
    onshapeAccessToken: j.access_token,
    ...(j.refresh_token ? { onshapeRefreshToken: j.refresh_token } : {}),
    onshapeTokenExpiresAt: new Date(Date.now() + Number(j.expires_in ?? 3600) * 1000),
    onshapeTokenFailedAt: null, onshapeTokenError: null,
  } });
  console.log("(refreshed the stored token and saved it back)\n");
  return j.access_token;
}

/** One call, timed. Returns { status, ms, json, text }. */
async function call(method, p, body) {
  const t0 = Date.now();
  const res = await fetch(`${API}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json;charset=UTF-8; qs=0.09",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, ms: Date.now() - t0, json, text };
}

/** Every path in a payload whose key mentions visibility or a condition. */
function findPaths(v, re, at = "$", out = []) {
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const here = Array.isArray(v) ? `${at}[${k}]` : `${at}.${k}`;
      if (re.test(k)) out.push(`${here} = ${JSON.stringify(x).slice(0, 160)}`);
      findPaths(x, re, here, out);
    }
  }
  return out;
}

/**
 * Onshape's typed envelope, unwrapped.
 *
 * Depending on the payload's serialization version, an object arrives either
 * flat (`{btType, parameterId, …}`) or wrapped (`{type, typeName, message: {…}}`).
 * The real tenant sent the wrapped form, where every field this reads lives
 * under `message`.
 */
const un = (x) => (x && typeof x === "object" && x.message && typeof x.message === "object" ? x.message : x);

/** A parameter, read the way a form would need it. */
function describe(wrapped) {
  const p = un(wrapped);
  const t = String(wrapped.typeName ?? wrapped.btType ?? p.btType ?? "");
  const kind = /Enum/i.test(t) ? "list" : /Boolean/i.test(t) ? "yes/no" : /Quantity/i.test(t) ? "number"
    : /String/i.test(t) ? "text" : t || "unknown";
  const rawOptions = (p.options ?? []).map(un);
  const options = rawOptions.map((o) => o.optionName ?? o.option);
  const r = un(p.rangeAndDefault);
  const range = r ? `${r.minValue}–${r.maxValue} ${r.units ?? ""}, default ${r.defaultValue}` : "";
  return {
    id: String(p.parameterId ?? ""), name: String(p.parameterName ?? p.parameterId ?? ""), kind, btType: t,
    options, range, default: p.defaultValue ?? r?.defaultValue ?? null,
    rawOptions, rawUnits: r?.units ?? "",
    visibility: p.visibilityCondition ?? null,
  };
}

/** The value to send for a parameter, from a --set or the current value. */
function valueFor(param, current, override) {
  if (override == null) return current;
  if (param.kind === "list") {
    const o = param.rawOptions.find((x) => x.option === override || x.optionName === override);
    if (!o) throw new Error(`"${override}" is not an option of ${param.name}: ${param.options.join(", ")}`);
    return o.option;
  }
  return override;
}

/**
 * Onshape's own configuration string for a set of values.
 *
 * A number goes with its unit ("900 millimeter"): a bare number is ambiguous
 * for a length, and the unit is the one the input itself declares.
 */
async function encode(params, defs) {
  return call("POST", `/elements/d/${did}/e/${eid}/configurationencodings`, {
    parameters: params.map(([parameterId, value]) => {
      const def = defs.find((p) => p.id === parameterId);
      const units = def?.kind === "number" ? def.rawUnits : "";
      const v = String(value);
      return { parameterId, parameterValue: units && /^-?[\d.]+$/.test(v) ? `${v} ${units}` : v };
    }),
  });
}

/** Rows of a BOM, reduced to what a configurator would store. */
function bomRows(payload) {
  // The newer shape: {bomTable: {headers, items}}, values named on each item.
  const items = payload?.bomTable?.items ?? payload?.items;
  if (Array.isArray(items)) {
    return items.map((it) => {
      const src = it.itemSource ?? {};
      return {
        name: String(it.name ?? ""), partNumber: String(it.partNumber ?? ""), quantity: it.quantity,
        indent: Number(it.indentLevel ?? (String(it.item ?? "").split(".").length - 1)) || 0,
        key: `${src.documentId}/${src.elementId ?? ""}/${src.partId ?? ""}`,
        configuration: String(src.fullConfiguration ?? src.configuration ?? ""),
      };
    });
  }
  const headers = new Map((payload?.headers ?? []).map((h) => [h.id, String(h.name ?? "").toLowerCase()]));
  const byName = (row, name) => {
    const bag = row.headerIdToValue ?? {};
    for (const [id, v] of Object.entries(bag)) if (headers.get(id) === name) return v;
    return undefined;
  };
  return (payload?.rows ?? []).map((row) => {
    const src = row.itemSource ?? {};
    const num = byName(row, "part number");
    const name = byName(row, "name");
    const qty = byName(row, "quantity");
    return {
      name: typeof name === "object" ? JSON.stringify(name) : String(name ?? ""),
      partNumber: typeof num === "object" ? JSON.stringify(num) : String(num ?? ""),
      quantity: qty,
      indent: row.indentLevel ?? 0,
      key: `${src.documentId}/${src.elementId}/${src.partId ?? ""}`,
      configuration: String(src.fullConfiguration ?? src.configuration ?? ""),
    };
  });
}

try {
  await mongo.connect();
  token = await getToken(mongo.db(env.MONGODB_DB || "plm"));

  const doc = await call("GET", `/documents/${did}`);
  console.log(`document: ${doc.json?.name ?? `(${doc.status})`}`);
  const els = await call("GET", `/documents/d/${did}/${wv}/elements?elementId=${eid}`);
  const el = (els.json ?? []).find((e) => e.id === eid);
  console.log(`tab     : ${el?.name ?? "?"} (${el?.elementType ?? els.status})\n`);
  if (el && el.elementType !== "ASSEMBLY") console.log("NOTE: that tab is not an assembly — the BOM step will fail.\n");

  /* 1 ─ the inputs */
  const cfg = await call("GET", `/elements/d/${did}/${wv}/e/${eid}/configuration`);
  save("configuration.json", cfg.json ?? cfg.text);
  if (cfg.status !== 200) throw new Error(`GET configuration -> ${cfg.status}: ${cfg.text.slice(0, 300)}`);
  const params = (cfg.json?.configurationParameters ?? []).map(describe);
  console.log(`1. CONFIGURATION INPUTS — ${params.length} (${cfg.ms} ms)`);
  for (const p of params) {
    console.log(`   - ${p.name} [${p.kind}]  id=${p.id}`);
    if (p.options.length) console.log(`       options: ${p.options.join(" | ")}`);
    if (p.range) console.log(`       range  : ${p.range}`);
  }
  /** A visibility rule in words: "Add cutouts=true AND Cutout type=Slots". */
  const rule = (v) => {
    const t = v?.typeName ?? v?.btType ?? "", m = un(v) ?? {};
    if (/Logical/.test(t)) {
      const parts = (m.children ?? []).map(rule).filter(Boolean);
      return parts.length > 1 ? `(${parts.join(` ${m.operation} `)})` : parts[0] ?? "";
    }
    if (/OnEqual/.test(t)) {
      const target = params.find((x) => x.id === m.parameterId);
      const opt = target?.rawOptions.find((o) => o.option === m.value);
      return `${target?.name ?? m.parameterId}=${opt?.optionName ?? m.value}`;
    }
    if (!t || t === "BTParameterVisibilityCondition") return "";
    return `<${t} ${JSON.stringify(m).slice(0, 80)}>`;
  };
  for (const p of params) {
    const r = rule(p.visibility);
    if (r) console.log(`   ${p.name} is shown only when ${r}`);
  }
  console.log(`   top-level keys: ${Object.keys(cfg.json ?? {}).join(", ")}`);
  const vis = findPaths(cfg.json, /visib|condition|hidden|show/i);
  console.log(vis.length
    ? `   visibility-related fields found (${vis.length}):\n${vis.slice(0, 25).map((x) => `     ${x}`).join("\n")}`
    : "   visibility-related fields: NONE in this payload");
  const current = new Map((cfg.json?.currentConfiguration ?? []).map(un).map((c) => [c.parameterId, c.value ?? c.parameterValue ?? c.option]));
  console.log("");

  /* 2 ─ two configurations to compare */
  const overrides = new Map();
  for (const s of sets) {
    const i = s.indexOf("=");
    const key = s.slice(0, i).trim(), val = s.slice(i + 1).trim();
    const p = params.find((x) => x.id === key || x.name.toLowerCase() === key.toLowerCase());
    if (!p) throw new Error(`No input named "${key}". Inputs: ${params.map((x) => x.name).join(", ")}`);
    overrides.set(p.id, val);
  }
  const baseValue = (p) => current.get(p.id) ?? p.default ?? p.rawOptions[0]?.option ?? "";
  const configA = params.map((p) => [p.id, baseValue(p)]);
  let configB;
  if (overrides.size) {
    configB = params.map((p) => [p.id, valueFor(p, baseValue(p), overrides.get(p.id))]);
  } else {
    const first = params.find((p) => p.kind === "list" && p.rawOptions.length > 1) ?? params.find((p) => p.kind === "yes/no");
    configB = params.map((p) => {
      if (p !== first) return [p.id, baseValue(p)];
      if (p.kind === "yes/no") return [p.id, String(String(baseValue(p)) !== "true")];
      const other = p.rawOptions.find((o) => o.option !== baseValue(p));
      return [p.id, other?.option ?? baseValue(p)];
    });
  }

  const results = [];
  for (const [label, config] of [["A", configA], ["B", configB]]) {
    console.log(`2${label}. CONFIGURATION ${label}: ${config.map(([id, v]) => `${params.find((p) => p.id === id)?.name}=${v}`).join(", ") || "(no inputs)"}`);
    const enc = await encode(config, params);
    save(`encoding-${label}.json`, enc.json ?? enc.text);
    const query = enc.json?.queryParam ?? "";
    const cfgParam = query.replace(/^configuration=/, "");
    console.log(`    encode -> ${enc.status} in ${enc.ms} ms; encodedId=${enc.json?.encodedId ?? "-"}`);
    console.log(`    configuration string (the cache key): ${decodeURIComponent(cfgParam).slice(0, 200) || "(empty)"}`);
    const q = cfgParam ? `&configuration=${cfgParam}` : "";

    /* 3 ─ a picture */
    const view = "outputWidth=800&outputHeight=600&pixelSize=0&viewMatrix=0.612,0.612,0,0,-0.354,0.354,0.866,0,0.707,-0.707,0.5,0";
    const img = await call("GET", `/assemblies/d/${did}/${wv}/e/${eid}/shadedviews?${view}${q}`);
    const b64 = Array.isArray(img.json?.images) ? img.json.images[0] : null;
    if (b64) save(`picture-${label}.png`, Buffer.from(b64, "base64"));
    console.log(`    picture -> ${img.status} in ${img.ms} ms${b64 ? `, saved picture-${label}.png` : `: ${img.text.slice(0, 200)}`}`);

    /* 4 ─ its BOM */
    const bq = new URLSearchParams({ indented: "true", multiLevel: "true", generateIfAbsent: "true", thumbnail: "false" });
    const bom = await call("GET", `/assemblies/d/${did}/${wv}/e/${eid}/bom?${bq}${q}`);
    save(`bom-${label}.json`, bom.json ?? bom.text);
    const rows = bom.status === 200 ? bomRows(bom.json) : [];
    console.log(`    BOM -> ${bom.status} in ${bom.ms} ms, ${rows.length} rows${bom.status !== 200 ? `: ${bom.text.slice(0, 200)}` : ""}`);
    for (const r of rows.slice(0, 40)) {
      console.log(`      ${"  ".repeat(r.indent)}${r.partNumber || "(no number)"}  ${r.name}  ×${r.quantity ?? "?"}${r.configuration && r.configuration !== "default" ? `  [cfg ${r.configuration.slice(0, 60)}]` : ""}`);
    }
    if (rows.length > 40) console.log(`      … ${rows.length - 40} more in bom-${label}.json`);
    results.push({ label, rows });
    console.log("");
  }

  /* the difference — what a growing PLM BOM would add */
  const [a, b] = results;
  const id = (r) => `${r.key}|${r.configuration}`;
  const inA = new Map(a.rows.map((r) => [id(r), r]));
  const inB = new Map(b.rows.map((r) => [id(r), r]));
  const onlyA = a.rows.filter((r) => !inB.has(id(r)));
  const onlyB = b.rows.filter((r) => !inA.has(id(r)));
  console.log("5. WHAT CHANGES BETWEEN A AND B");
  console.log(`   rows only in A: ${onlyA.length}${onlyA.length ? "\n" + onlyA.map((r) => `     ${r.partNumber || "(no number)"} ${r.name} [${r.configuration || "default"}]`).join("\n") : ""}`);
  console.log(`   rows only in B: ${onlyB.length}${onlyB.length ? "\n" + onlyB.map((r) => `     ${r.partNumber || "(no number)"} ${r.name} [${r.configuration || "default"}]`).join("\n") : ""}`);
  const sameNumberDiffCfg = onlyB.filter((r) => onlyA.some((x) => x.key === r.key && x.partNumber === r.partNumber));
  if (sameNumberDiffCfg.length) {
    console.log(`   ${sameNumberDiffCfg.length} part(s) change configuration but keep the SAME part number — ` +
      `Onshape's Part number is not configured for them, so PLM would have to number those variants itself.`);
  }
  console.log(`\nEverything Onshape returned is in ${outDir}`);
} catch (err) {
  console.error(`\nFAILED: ${err?.message ?? err}`);
  console.error(`Whatever was gathered before the failure is in ${outDir}`);
  process.exitCode = 1;
} finally {
  await mongo.close();
}
