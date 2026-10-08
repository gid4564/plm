/**
 * Every call to Onshape is counted, and counted against what caused it.
 *
 * The API-usage page is only as good as the attribution, so this pins the
 * parts that are easy to get quietly wrong:
 *
 *   a retry is a call of its own — Onshape counts what was sent;
 *   a request handler's route names the run, and library steps inside it are
 *   steps of that run rather than runs of their own;
 *   work started outside any request (a timer) is its own run;
 *   ids in a path collapse, so equal endpoints group.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";

import { createServer, type Server } from "node:http";
import { connectDb } from "../src/lib/db";
import { ApiCall } from "../src/lib/models";
import { LiveOnshapeClient } from "../src/lib/onshape/live-client";
import {
  flushApiLog, normalizeEndpoint, routeProcessName, setApiSubject, withApiProcess, withApiRequest,
} from "../src/lib/api-log";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () =>
    resolve((s.address() as { port: number }).port)));

async function main() {
  await connectDb();
  await ApiCall.deleteMany({});

  console.log("\nPaths group by endpoint, not by document");
  const DID = "a1b2c3d4e5f60718293a4b5c";
  check("document, workspace and element ids collapse",
    normalizeEndpoint(`/v10/documents/d/${DID}/w/${DID}/elements/e/${DID}/parts?x=1`) ===
      "/v10/documents/d/:id/w/:id/elements/e/:id/parts",
    normalizeEndpoint(`/v10/documents/d/${DID}/w/${DID}/elements/e/${DID}/parts?x=1`));
  check("a part id after /partid/ collapses",
    normalizeEndpoint(`/v10/parts/d/${DID}/w/${DID}/e/${DID}/partid/JHD/gltf`) ===
      "/v10/parts/d/:id/w/:id/e/:id/partid/:id/gltf",
    normalizeEndpoint(`/v10/parts/d/${DID}/w/${DID}/e/${DID}/partid/JHD/gltf`));
  check("a route is named for what it does",
    routeProcessName("POST", "/api/parts/resync") === "Bulk re-sync" &&
    routeProcessName("GET", `/api/parts/${DID}/thumbnail`) === "Thumbnail");
  check("an unknown route falls back to method and path, ids collapsed",
    routeProcessName("GET", `/api/widgets/${DID}`) === "GET /api/widgets/:id",
    routeProcessName("GET", `/api/widgets/${DID}`));

  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    // The very first request is a gateway failure, to prove a retry is counted.
    if (calls === 1) { res.writeHead(502, { "Content-Type": "text/html" }); res.end("<html>bad gateway</html>"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "T1", name: "ok", workflowInfo: {} }));
  });
  const port = await listen(server);
  const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`, undefined, "co", undefined);

  console.log("\nA request is a run; steps inside it are steps, not runs");
  await withApiRequest("POST", "/api/parts/resync", async () => {
    await withApiProcess("Part sync", async () => {
      setApiSubject("PN-00042");
      await client.getTask("T1"); // 502 then 200: two requests
    });
    await withApiProcess("Part sync", async () => {
      setApiSubject("PN-00043");
      await client.getTask("T1");
    });
  });
  await flushApiLog();
  let rows: any[] = await ApiCall.find({}).sort({ at: 1, _id: 1 }).lean();
  check("the gateway retry counted as a call of its own", rows.length === 3, String(rows.length));
  check("the failed attempt is recorded as failed", rows[0]?.status === 502 && rows[0]?.ok === false);
  check("and the retry is marked attempt 1", rows[1]?.attempt === 1);
  check("all three belong to one run", new Set(rows.map((r) => r.runId)).size === 1);
  check("named for the route", rows.every((r) => r.process === "Bulk re-sync"), rows[0]?.process);
  check("with the step that made the call", rows.every((r) => r.step === "Part sync"));
  check("and what each step was about",
    rows[1]?.subject === "PN-00042" && rows[2]?.subject === "PN-00043",
    rows.map((r) => r.subject).join(","));

  console.log("\nWork started outside a request is its own run");
  await ApiCall.deleteMany({});
  await withApiRequest("POST", "/api/releases/x/decide", async () => {
    await withApiProcess("Drawing refresh", () => client.getTask("T1"), { newRun: true });
    await client.getTask("T1");
  });
  await flushApiLog();
  rows = await ApiCall.find({}).sort({ at: 1, _id: 1 }).lean();
  check("two calls, two runs", rows.length === 2 && rows[0].runId !== rows[1].runId, rows.map((r) => r.runId).join(","));
  check("the detached one is named for itself", rows[0]?.process === "Drawing refresh");
  check("the other keeps the route", rows[1]?.process === "Release decision", rows[1]?.process);

  console.log("\nA call with no process around it is still counted");
  await ApiCall.deleteMany({});
  await client.getTask("T1");
  await flushApiLog();
  rows = await ApiCall.find({}).lean();
  check("recorded as unattributed rather than lost", rows.length === 1 && rows[0].process === "Unattributed");

  console.log("\nA request that gets no reply is counted too");
  await ApiCall.deleteMany({});
  server.close();
  const dead = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);
  try { await withApiRequest("GET", "/api/bom", () => dead.getTask("T1")); } catch { /* expected */ }
  await flushApiLog();
  rows = await ApiCall.find({}).lean();
  check("status 0, with the reason", rows.length === 1 && rows[0].status === 0 && !!rows[0].error, JSON.stringify(rows[0]));

  await ApiCall.deleteMany({});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
