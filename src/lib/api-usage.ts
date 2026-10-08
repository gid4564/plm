import { Types } from "mongoose";
import { connectDb } from "@/lib/db";
import { ApiCall } from "@/lib/models";

/**
 * The data behind the API-usage page: how many calls PLM has made to Onshape,
 * and what caused them.
 *
 * One endpoint with a `view`, because every view shares the same filters and
 * the page asks for the overview and one list at a time.
 *
 *   overview  totals, per-process / per-step / per-endpoint breakdowns, and a
 *             timeline — everything that is a sum over the filtered calls
 *   runs      one row per run (a process, start to finish) with its call count
 *   calls     the individual requests, newest first, optionally for one run
 *
 * Admin only: it reveals what the integration is doing and which documents are
 * being touched.
 */

type Filter = Record<string, unknown>;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatch(enterpriseId: string, sp: URLSearchParams): { match: Filter; from: Date; to: Date } {
  const to = sp.get("to") ? new Date(sp.get("to")!) : new Date();
  const range = Math.max(1, Math.min(Number(sp.get("range")) || 60, 60 * 24 * 90));
  const from = sp.get("from") ? new Date(sp.get("from")!) : new Date(to.getTime() - range * 60_000);

  const and: Filter[] = [
    { at: { $gte: from, $lte: to } },
    // Calls made before an enterprise was known (or by no particular one) are
    // still this install's budget.
    { $or: [{ enterpriseId: new Types.ObjectId(enterpriseId) }, { enterpriseId: null }] },
  ];

  const process = sp.get("process");
  if (process) and.push({ process });
  const step = sp.get("step");
  if (step) and.push({ step });
  const method = sp.get("method");
  if (method) and.push({ method: method.toUpperCase() });
  const endpoint = sp.get("endpoint");
  if (endpoint) and.push({ endpoint });
  const runId = sp.get("runId");
  if (runId) and.push({ runId });

  switch (sp.get("status")) {
    case "ok": and.push({ ok: true }); break;
    case "error": and.push({ ok: false }); break;
    case "429": and.push({ status: 429 }); break;
    case "4xx": and.push({ status: { $gte: 400, $lt: 500 } }); break;
    case "5xx": and.push({ status: { $gte: 500 } }); break;
    case "retry": and.push({ attempt: { $gt: 0 } }); break;
    case "slow": and.push({ ms: { $gte: 2000 } }); break;
  }

  const q = (sp.get("q") ?? "").trim();
  if (q) {
    const re = new RegExp(escapeRe(q), "i");
    and.push({ $or: [{ endpoint: re }, { path: re }, { subject: re }, { process: re }, { step: re }] });
  }

  return { match: { $and: and }, from, to };
}

/** Roughly 60 bars, on a bucket size that is a round number of minutes. */
function bucketMs(from: Date, to: Date): number {
  const span = to.getTime() - from.getTime();
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 360, 720, 1440].map((m) => m * 60_000);
  return steps.find((s) => span / s <= 70) ?? steps[steps.length - 1];
}

export async function queryApiUsage(enterpriseId: string, sp: URLSearchParams): Promise<Record<string, unknown>> {
  await connectDb();

  const view = sp.get("view") || "overview";
  const { match, from, to } = buildMatch(enterpriseId, sp);

  /* ------------------------------- calls ---------------------------------- */
  if (view === "calls") {
    const limit = Math.max(1, Math.min(Number(sp.get("limit")) || 100, 500));
    const before = sp.get("before");
    const rows: any[] = await ApiCall.find(
      before ? { $and: [match, { at: { $lt: new Date(before) } }] } : match
    )
      .sort({ at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    return ({
      calls: page.map((c) => ({
        id: String(c._id), at: c.at, runId: c.runId, process: c.process, step: c.step,
        subject: c.subject, method: c.method, endpoint: c.endpoint, path: c.path,
        status: c.status, ok: c.ok, ms: c.ms, bytes: c.bytes, attempt: c.attempt, error: c.error,
      })),
      next: more ? page[page.length - 1].at : null,
    });
  }

  /* -------------------------------- runs ---------------------------------- */
  if (view === "runs") {
    const limit = Math.max(1, Math.min(Number(sp.get("limit")) || 50, 200));
    const sort = sp.get("sort") === "calls" ? { calls: -1, startedAt: -1 } : { startedAt: -1 };
    const runs: any[] = await ApiCall.aggregate([
      { $match: match },
      { $sort: { at: 1 } },
      {
        $group: {
          _id: "$runId",
          process: { $first: "$process" },
          origin: { $first: "$origin" },
          startedAt: { $min: "$at" },
          endedAt: { $max: "$at" },
          lastMs: { $last: "$ms" },
          calls: { $sum: 1 },
          errors: { $sum: { $cond: ["$ok", 0, 1] } },
          retries: { $sum: { $cond: [{ $gt: ["$attempt", 0] }, 1, 0] } },
          totalMs: { $sum: "$ms" },
          subjects: { $addToSet: "$subject" },
          steps: { $addToSet: "$step" },
        },
      },
      { $sort: sort as any },
      { $limit: limit },
    ]);
    return ({
      runs: runs.map((r) => {
        const subjects = (r.subjects as string[]).filter(Boolean);
        return {
          runId: r._id, process: r.process, origin: r.origin,
          startedAt: r.startedAt, durationMs: Math.max(0, +new Date(r.endedAt) - +new Date(r.startedAt)) + (r.lastMs ?? 0),
          calls: r.calls, errors: r.errors, retries: r.retries, totalMs: r.totalMs,
          subject: subjects.length === 1 ? subjects[0] : subjects.length ? `${subjects.length} items` : "",
          subjectCount: subjects.length,
          steps: (r.steps as string[]).filter(Boolean).sort(),
        };
      }),
    });
  }

  /* ------------------------------ overview -------------------------------- */
  const bucket = bucketMs(from, to);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const scope = { $or: [{ enterpriseId: new Types.ObjectId(enterpriseId) }, { enterpriseId: null }] };

  const [totals, byProcess, bySteps, byEndpoint, timeline, byStatus, facets, todayCount, monthCount, oldest] =
    await Promise.all([
      ApiCall.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            calls: { $sum: 1 },
            errors: { $sum: { $cond: ["$ok", 0, 1] } },
            retries: { $sum: { $cond: [{ $gt: ["$attempt", 0] }, 1, 0] } },
            throttled: { $sum: { $cond: [{ $eq: ["$status", 429] }, 1, 0] } },
            ms: { $avg: "$ms" },
            bytes: { $sum: "$bytes" },
            runs: { $addToSet: "$runId" },
          },
        },
        { $project: { calls: 1, errors: 1, retries: 1, throttled: 1, ms: 1, bytes: 1, runs: { $size: "$runs" } } },
      ]),
      // Per process: calls, then per-run stats so "average per run" is real.
      ApiCall.aggregate([
        { $match: match },
        {
          $group: {
            _id: { process: "$process", runId: "$runId" },
            calls: { $sum: 1 },
            errors: { $sum: { $cond: ["$ok", 0, 1] } },
            ms: { $sum: "$ms" },
          },
        },
        {
          $group: {
            _id: "$_id.process",
            calls: { $sum: "$calls" },
            runs: { $sum: 1 },
            errors: { $sum: "$errors" },
            maxPerRun: { $max: "$calls" },
            ms: { $sum: "$ms" },
          },
        },
        { $sort: { calls: -1 } },
        { $limit: 60 },
      ]),
      ApiCall.aggregate([
        { $match: match },
        { $group: { _id: { step: "$step", process: "$process" }, calls: { $sum: 1 }, errors: { $sum: { $cond: ["$ok", 0, 1] } } } },
        { $sort: { calls: -1 } },
        { $limit: 80 },
      ]),
      ApiCall.aggregate([
        { $match: match },
        {
          $group: {
            _id: { method: "$method", endpoint: "$endpoint" },
            calls: { $sum: 1 },
            errors: { $sum: { $cond: ["$ok", 0, 1] } },
            ms: { $avg: "$ms" },
            maxMs: { $max: "$ms" },
            bytes: { $sum: "$bytes" },
          },
        },
        { $sort: { calls: -1 } },
        { $limit: 60 },
      ]),
      ApiCall.aggregate([
        { $match: match },
        {
          $group: {
            _id: { $toDate: { $subtract: [{ $toLong: "$at" }, { $mod: [{ $toLong: "$at" }, bucket] }] } },
            calls: { $sum: 1 },
            errors: { $sum: { $cond: ["$ok", 0, 1] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      ApiCall.aggregate([
        { $match: match },
        { $group: { _id: "$status", calls: { $sum: 1 } } },
        { $sort: { calls: -1 } },
      ]),
      // The values the filter dropdowns offer — from the whole window, not the
      // filtered one, or choosing a process would empty every other choice.
      ApiCall.aggregate([
        { $match: { $and: [{ at: { $gte: from, $lte: to } }, scope] } },
        { $group: { _id: { process: "$process", step: "$step" } } },
      ]),
      ApiCall.countDocuments({ $and: [{ at: { $gte: today } }, scope] }),
      ApiCall.countDocuments({ $and: [{ at: { $gte: monthStart } }, scope] }),
      ApiCall.findOne(scope).sort({ at: 1 }).select("at").lean(),
    ]);

  const t: any = totals[0] ?? { calls: 0, errors: 0, retries: 0, throttled: 0, ms: 0, bytes: 0, runs: 0 };

  return ({
    window: { from, to, bucketMs: bucket },
    totals: {
      calls: t.calls, runs: t.runs, errors: t.errors, retries: t.retries, throttled: t.throttled,
      avgMs: Math.round(t.ms || 0), bytes: t.bytes,
      avgPerRun: t.runs ? +(t.calls / t.runs).toFixed(1) : 0,
    },
    today: todayCount,
    monthToDate: monthCount,
    // Data older than this does not exist, so a range reaching past it is not
    // "no calls" but "not recorded".
    recordedSince: (oldest as any)?.at ?? null,
    byProcess: byProcess.map((r: any) => ({
      process: r._id, calls: r.calls, runs: r.runs, errors: r.errors,
      avgPerRun: +(r.calls / r.runs).toFixed(1), maxPerRun: r.maxPerRun,
      avgMs: Math.round(r.ms / r.calls),
    })),
    bySteps: bySteps.map((r: any) => ({ step: r._id.step, process: r._id.process, calls: r.calls, errors: r.errors })),
    byEndpoint: byEndpoint.map((r: any) => ({
      method: r._id.method, endpoint: r._id.endpoint, calls: r.calls, errors: r.errors,
      avgMs: Math.round(r.ms), maxMs: r.maxMs, bytes: r.bytes,
    })),
    timeline: timeline.map((r: any) => ({ at: r._id, calls: r.calls, errors: r.errors })),
    byStatus: byStatus.map((r: any) => ({ status: r._id, calls: r.calls })),
    facets: {
      processes: [...new Set(facets.map((f: any) => f._id.process))].sort(),
      steps: [...new Set(facets.map((f: any) => f._id.step).filter(Boolean))].sort(),
    },
  });
}
