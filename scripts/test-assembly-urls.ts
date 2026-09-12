/**
 * Every Onshape URL this client builds, for a part and for an assembly.
 *
 * Written after an assembly write failed with
 *   POST /metadata/.../e/ca9d4a6d.../p/ -> 400
 *   "Category overrides endpoint does not support wildcard requests"
 *
 * An assembly has no partId, so a part-scoped URL degenerates to a trailing
 * empty segment and Onshape reads that as a wildcard. Every part-scoped URL in
 * the client had the same latent fault, because MOS never tracked assemblies —
 * so this asserts the whole class rather than the one endpoint that was
 * reported.
 */
import { LiveOnshapeClient } from "../src/lib/onshape/live-client";
import { findFormat } from "../src/lib/onshape/export-formats";
import { createServer, type Server } from "node:http";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const PART = {
  documentId: "D", elementId: "E", partId: "JcD",
  workspaceId: "W", configuration: "default",
};
const ASSEMBLY = { ...PART, partId: "" };

/** Records every path and body the client sends, answering plausibly. */
function recorder() {
  const calls: { method: string; path: string; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls.push({ method: req.method ?? "", path: req.url ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" });
      // One shape that satisfies metadata, mass properties and translations.
      res.end(JSON.stringify({
        properties: [], images: [Buffer.from("x").toString("base64")],
        bodies: { "-all-": { mass: [1, 1, 1], volume: [1, 1, 1], periphery: [1, 1, 1],
                             centroid: [0, 0, 0, 0, 0, 0, 0, 0, 0] } },
        id: "tx1", requestState: "DONE", resultExternalDataIds: ["ext1"],
        name: "Doc", defaultWorkspace: { id: "W" },
      }));
    });
  });
  return { calls, server };
}

const listen = (s: Server) =>
  new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

/** The fault this exists to prevent: an empty segment or an empty parameter. */
function malformed(path: string): string | null {
  if (/\/p\/(\?|$)/.test(path)) return "empty /p/ segment";
  if (/partid\/(\?|\/|$)/.test(path)) return "empty partid segment";
  if (/[?&]partId=(&|$)/.test(path)) return "empty partId parameter";
  if (/\/\/(?!$)/.test(path.replace(/^https?:\/\//, ""))) return "doubled slash";
  return null;
}

async function main() {
  for (const [label, coords] of [["part", PART], ["assembly", ASSEMBLY]] as const) {
    console.log(`\nEvery URL built for ${label === "part" ? "a part" : "an assembly"}`);
    const { calls, server } = recorder();
    const port = await listen(server);
    const client = new LiveOnshapeClient("t", `http://127.0.0.1:${port}`);

    await client.getPartMetadata(coords).catch(() => {});
    await client.updatePartProperties(coords, { p1: "v" }).catch(() => {});
    await client.getPartThumbnail(coords, 300).catch(() => {});
    await client.getMassProperties(coords).catch(() => {});
    await client.exportPart(coords, findFormat("STEP")!).catch(() => {});
    await client.exportPart(coords, findFormat("STL")!).catch(() => {});
    server.close();

    const bad = calls.map((c) => ({ ...c, why: malformed(c.path) })).filter((c) => c.why);
    check(`${calls.length} calls, none malformed`, bad.length === 0,
      bad.map((b) => `${b.path} (${b.why})`).join("; "));

    for (const c of calls) {
      const shown = c.path.split("?")[0];
      console.log(`       ${c.method.padEnd(4)} ${shown}`);
    }

    if (label === "assembly") {
      const metadata = calls.filter((c) => c.path.startsWith("/metadata"));
      check("metadata addresses the element, with no /p/ segment",
        metadata.length > 0 && metadata.every((c) => !c.path.includes("/p/")),
        metadata.map((c) => c.path).join("; "));
      check("the write is a POST to that element path",
        metadata.some((c) => c.method === "POST" && /\/metadata\/d\/D\/w\/W\/e\/E(\?|$)/.test(c.path)),
        metadata.filter((c) => c.method === "POST").map((c) => c.path).join("; "));
      check("thumbnails use the assembly endpoint",
        calls.some((c) => c.path.startsWith("/assemblies") && c.path.includes("shadedviews")));
      check("mass properties use the assembly endpoint",
        calls.some((c) => c.path.startsWith("/assemblies") && c.path.includes("massproperties")));
      check("and name no part to filter by",
        !calls.some((c) => c.path.includes("massproperties") && c.path.includes("partId=")));
      const tx = calls.filter((c) => c.path.includes("/translations"));
      check("translations go to the assembly endpoint",
        tx.length > 0 && tx.every((c) => c.path.startsWith("/assemblies")),
        tx.map((c) => c.path).join("; "));
      check("and send no partIds",
        tx.every((c) => !c.body.includes("partIds")), tx.map((c) => c.body).join("; "));
      check("a direct-download format is routed through a translation instead",
        !calls.some((c) => /\/(stl|parasolid)\b/.test(c.path)));
    } else {
      check("metadata addresses the part",
        calls.some((c) => c.path.includes("/metadata/") && c.path.includes("/p/JcD")));
      check("thumbnails use the parts endpoint with the part id",
        calls.some((c) => c.path.startsWith("/parts") && c.path.includes("partid/JcD")));
      check("mass properties filter by the part",
        calls.some((c) => c.path.includes("massproperties") && c.path.includes("partId=JcD")));
      check("translations still name the part",
        calls.some((c) => c.path.includes("/translations") && c.body.includes("JcD")));
      check("and a direct format stays a direct download",
        calls.some((c) => c.path.startsWith("/parts") && /\/(stl|parasolid)/.test(c.path)));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
