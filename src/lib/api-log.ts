import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Accounting for the Onshape API calls PLM makes.
 *
 * Every request to Onshape goes through two places in live-client.ts, and each
 * reports here. What makes the numbers useful is attribution: a bare list of
 * requests says how many calls were made, never *why*. So the process that
 * caused a call travels with it, through async hops, in an AsyncLocalStorage —
 * no function in between has to be told about it.
 *
 *   - A request handler starts a run named for its route ("Bulk re-sync").
 *   - Library code names the step it is doing inside that run
 *     (`withApiProcess("Part sync", …)`), which becomes the call's `step`.
 *   - Work with no request around it (a timer, a startup resume) names its own
 *     run, and says so with `newRun`.
 *
 * `process` is therefore the outermost thing somebody asked for, and `step` is
 * the innermost thing that actually made the call. Summing by process answers
 * "what costs the most to run"; summing by step answers "which piece of it".
 *
 * Nothing here may ever break a real call: recording is fire-and-forget, and a
 * failure to record is swallowed.
 */

type Frame = {
  runId: string;
  process: string;
  step: string;
  subject: string;
  origin: string;
};

const als = new AsyncLocalStorage<Frame>();

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Plain names for the routes that reach Onshape, so the page reads as what a
 * person did rather than which URL they hit. First match wins; a route not in
 * the table is shown as its method and path, which is still unambiguous.
 */
const ROUTE_NAMES: [method: RegExp, path: RegExp, name: string][] = [
  [/^POST$/, /^\/api\/parts\/resync$/, "Bulk re-sync"],
  [/./, /^\/api\/parts\/[^/]+\/thumbnail$/, "Thumbnail"],
  [/./, /^\/api\/parts\/[^/]+\/export$/, "Export"],
  [/./, /^\/api\/parts\/[^/]+\/mass-properties$/, "Mass properties"],
  [/./, /^\/api\/parts\/[^/]+\/geometry$/, "3D model"],
  [/^DELETE$/, /^\/api\/parts\/[^/]+$/, "Part delete"],
  [/^POST$/, /^\/api\/parts\/[^/]+$/, "Part action"],
  [/^PATCH$|^PUT$/, /^\/api\/parts\/[^/]+$/, "Part edit"],
  [/^GET$/, /^\/api\/parts\/[^/]+$/, "Part view"],
  [/./, /^\/api\/parts\/lookup$/, "Part lookup"],
  [/./, /^\/api\/parts$/, "Part list / create"],
  [/./, /^\/api\/bom\/import$/, "BOM import"],
  [/./, /^\/api\/bom\/configuration$/, "BOM configurations"],
  [/./, /^\/api\/bom$/, "BOM read"],
  [/./, /^\/api\/(webhooks\/onshape|onshape\/webhook)$/, "Webhook"],
  [/./, /^\/api\/extensions\/send-to-plm$/, "Send to PLM"],
  [/./, /^\/api\/releases\/[^/]+\/decide$/, "Release decision"],
  [/./, /^\/api\/releases/, "Release"],
  [/./, /^\/api\/tasks/, "Tasks"],
  [/./, /^\/api\/onshape\/properties$/, "Property discovery"],
  [/./, /^\/api\/onshape\/oauth/, "Connect Onshape"],
  [/./, /^\/api\/enterprise$/, "Enterprise settings"],
  [/./, /^\/api\/drawings/, "Drawing"],
  [/./, /^\/api\/products/, "Product"],
];

export function routeProcessName(method: string, pathname: string): string {
  const m = method.toUpperCase();
  for (const [mr, pr, name] of ROUTE_NAMES) if (mr.test(m) && pr.test(pathname)) return name;
  // Collapse ids so the fallback still groups.
  return `${m} ${pathname.replace(/\/[0-9a-f]{24}(?=\/|$)/g, "/:id")}`;
}

/**
 * The Onshape path with ids collapsed, so two calls to the same endpoint group
 * together whichever document they were about. Query string dropped: it is
 * part of what was asked for, not which endpoint it was.
 */
export function normalizeEndpoint(path: string): string {
  const [pathname] = path.split("?");
  const keyed = new Set(["d", "w", "v", "m", "e", "partid", "wvm", "wvmid", "companies", "users", "tasks", "comments"]);
  const segs = pathname.split("/");
  return segs
    .map((seg, i) => {
      if (!seg) return seg;
      const prev = (segs[i - 1] ?? "").toLowerCase();
      if (keyed.has(prev) && !/^(d|w|v|m|e)$/i.test(seg)) return ":id";
      if (/^[0-9a-f]{24}$/i.test(seg)) return ":id";
      if (seg.length >= 20 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

const newId = () => randomBytes(6).toString("hex");

/**
 * Run `fn` as part of a process.
 *
 * Inside a run it names a *step* and leaves the run alone. Outside one — or
 * with `newRun` — it starts the run. The outermost name is the one the page
 * groups by.
 */
export function withApiProcess<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { subject?: string; newRun?: boolean; origin?: string } = {}
): Promise<T> {
  const parent = als.getStore();
  const frame: Frame =
    parent && !opts.newRun
      ? { ...parent, step: name, subject: opts.subject ?? parent.subject }
      : {
          runId: newId(), process: name, step: name,
          subject: opts.subject ?? "", origin: opts.origin ?? "background",
        };
  return als.run(frame, fn);
}

/**
 * Start the run for an incoming request. Called by the route wrapper, which is
 * the one place every API route passes through.
 */
export function withApiRequest<T>(method: string, pathname: string, fn: () => Promise<T>): Promise<T> {
  const name = routeProcessName(method, pathname);
  const frame: Frame = {
    runId: newId(), process: name, step: name, subject: "",
    origin: `${method.toUpperCase()} ${pathname}`,
  };
  return als.run(frame, fn);
}

/**
 * Say what the current process is about, once it is known — a part number is
 * only learned partway through a sync. Mutates the current frame, which is
 * this step's own copy, so it never leaks into a sibling.
 */
export function setApiSubject(subject: string | null | undefined): void {
  const f = als.getStore();
  if (f && subject) f.subject = String(subject).slice(0, 120);
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                   */
/* -------------------------------------------------------------------------- */

export type CallRecord = {
  enterpriseId: string | null;
  method: string;
  path: string;
  status: number;
  ms: number;
  bytes: number;
  attempt: number;
  error?: string;
};

type Pending = Record<string, unknown>;

declare global {
  var __plmApiLogBuffer: { items: Pending[]; timer: NodeJS.Timeout | null; warned: boolean } | undefined;
}
const buf = (globalThis.__plmApiLogBuffer ??= { items: [], timer: null, warned: false });

const FLUSH_MS = 1000;
const FLUSH_AT = 100;

/** Write what is buffered now. Exported for tests and for a clean shutdown. */
export async function flushApiLog(): Promise<void> {
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  if (!buf.items.length) return;
  const batch = buf.items.splice(0, buf.items.length);
  try {
    // Imported here, not at the top: this module is loaded by the Onshape
    // client, and the models pull in mongoose.
    const { connectDb } = await import("@/lib/db");
    const { ApiCall } = await import("@/lib/models");
    await connectDb();
    await ApiCall.insertMany(batch, { ordered: false });
  } catch (err: any) {
    if (!buf.warned) {
      buf.warned = true;
      console.warn(`[PLM] could not record Onshape API calls: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
}

/** Record one request that was actually sent to Onshape. Never throws. */
export function recordApiCall(c: CallRecord): void {
  try {
    const f = als.getStore();
    buf.items.push({
      enterpriseId: c.enterpriseId || null,
      at: new Date(),
      runId: f?.runId ?? `bg-${newId()}`,
      process: f?.process ?? "Unattributed",
      step: f?.step ?? "",
      subject: f?.subject ?? "",
      origin: f?.origin ?? "",
      method: c.method.toUpperCase(),
      endpoint: normalizeEndpoint(c.path),
      path: c.path.slice(0, 400),
      status: c.status,
      ok: c.status >= 200 && c.status < 400,
      ms: Math.round(c.ms),
      bytes: c.bytes,
      attempt: c.attempt,
      error: (c.error ?? "").slice(0, 300),
    });
    if (buf.items.length >= FLUSH_AT) void flushApiLog();
    else if (!buf.timer) {
      buf.timer = setTimeout(() => void flushApiLog(), FLUSH_MS);
      buf.timer.unref?.();
    }
  } catch {
    /* accounting must never break the call it is counting */
  }
}
