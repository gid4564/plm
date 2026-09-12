/**
 * Capturing a part's 3D when it is released.
 *
 * Onshape owns the geometry. What PLM keeps is a copy of what one revision
 * looked like, taken from the version the release produced — because a model
 * in Onshape moves on, and "what did revision A look like" stops being
 * answerable the moment it does.
 *
 * The rules worth testing are the ones that are easy to get wrong:
 *
 *   It is OFF unless the enterprise turns it on.
 *   It NEVER breaks a release. The release is the governed act; the geometry
 *   is a record kept beside it, so a failed export is written down, not thrown.
 *   A failure is stored as a REASON, because "Onshape refused this" and
 *   "nobody captured it yet" look identical on a part page otherwise.
 *   It is captured at the released VERSION, never the live workspace.
 *   It is kept per revision, so B does not overwrite A.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import { ActivityLog, Enterprise, Part, PartGeometry } from "../src/lib/models";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import {
  captureReleasedGeometry, geometryBytes, geometryCaptureEnabled, geometryForPart,
  MAX_GEOMETRY_BYTES,
} from "../src/lib/geometry";
import type { OnshapeClient } from "../src/lib/onshape/types";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-geometry";

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [Part, PartGeometry, ActivityLog]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Geo Co" });
  const eid = String(ent._id);
  const client = new MockOnshapeClient(COMPANY, { id: "u", email: "svc@test", name: "Svc" });

  const part: any = await Part.create({
    enterpriseId: ent._id, documentId: "dG", elementId: "eG", partId: "PG1",
    number: "PN-3D-001", name: "Bracket", kind: "part", lifecycleState: "Released",
    revision: "A",
  });
  const coords = {
    documentId: "dG", elementId: "eG", partId: "PG1", configuration: "default",
    workspaceId: null, versionId: "v-rel-A",
  };

  console.log("\nIt is off unless the enterprise asks for it");
  {
    check("off by default", (await geometryCaptureEnabled(eid)) === false);
    await Enterprise.updateOne({ _id: ent._id }, { $set: { releaseGltfEnabled: true } });
    check("on once set", (await geometryCaptureEnabled(eid)) === true);
  }

  console.log("\nA released part's geometry is captured and stored");
  {
    const r = await captureReleasedGeometry(client, eid, String(part._id), coords, {
      revision: "A", releaseId: null,
    });
    check("the capture succeeds", r.ok, r.reason ?? "");
    check("and has bytes", r.bytes > 0, String(r.bytes));

    const row: any = await PartGeometry.findOne({ enterpriseId: ent._id, partId: part._id }).lean();
    check("a row exists", !!row);
    check("holding the revision", row.revision === "A", row.revision);
    /*
     * The version matters more than anything else here: geometry taken from
     * the live workspace would be whatever the model looks like now, which is
     * precisely what this feature exists NOT to keep.
     */
    check("pinned to the released version", row.onshapeVersionId === "v-rel-A", String(row.onshapeVersionId));
    check("with no failure recorded", row.failureReason === null);
    /*
     * Decoded through geometryBytes, because a lean() read returns a BSON
     * Binary rather than a Buffer — and the naive reads are silently wrong:
     * `Buffer.from(binary)` is EMPTY, and `binary.length` is a function.
     */
    const stored = geometryBytes(row.data);
    check("and the size matches the bytes", row.size === stored.length, `${row.size} vs ${stored.length}`);
    check("the raw field is not a Buffer, so it must be decoded",
      !Buffer.isBuffer(row.data) && typeof (row.data as any).length === "function");
    check("decoding it the naive way would have given nothing",
      Buffer.from(row.data as any).length === 0);

    /* A real GLB, not arbitrary bytes — it starts with the glTF magic. */
    check("the stored file is a GLB", stored.subarray(0, 4).toString("ascii") === "glTF",
      stored.subarray(0, 4).toString("ascii"));
    check("declared as one", row.contentType === "model/gltf-binary", row.contentType);
  }

  console.log("\nEach revision is kept, not overwritten");
  {
    await captureReleasedGeometry(client, eid, String(part._id), { ...coords, versionId: "v-rel-B" }, {
      revision: "B", releaseId: null,
    });
    const rows = await geometryForPart(eid, String(part._id));
    check("both revisions are held", rows.length === 2, String(rows.length));
    check("newest first", rows[0].revision === "B", rows[0].revision);
    check("revision A survived", rows.some((r) => r.revision === "A"));
    check("each pinned to its own version",
      rows.find((r) => r.revision === "A")?.onshapeVersionId === "v-rel-A" &&
      rows.find((r) => r.revision === "B")?.onshapeVersionId === "v-rel-B");
    /* The listing must not drag megabytes of mesh around to show a size. */
    check("the listing carries no mesh bytes", !("data" in (rows[0] as any)));

    /* Capturing the same revision twice updates rather than duplicating. */
    await captureReleasedGeometry(client, eid, String(part._id), { ...coords, versionId: "v-rel-B" }, {
      revision: "B", releaseId: null,
    });
    const again = await geometryForPart(eid, String(part._id));
    check("re-capturing a revision does not duplicate it", again.length === 2, String(again.length));
  }

  console.log("\nA failure is recorded, never thrown");
  {
    /* A client that refuses, the way a tenant without permission would. */
    const refusing = {
      ...client,
      exportGltf: async () => { throw new Error("Onshape GET /parts/.../gltf -> 403: Forbidden"); },
    } as unknown as OnshapeClient;

    let threw = false;
    let r: any = null;
    try {
      r = await captureReleasedGeometry(refusing, eid, String(part._id), coords, { revision: "C" });
    } catch { threw = true; }

    /*
     * The whole point. A release must not fail because a mesh export did.
     */
    check("it does not throw", !threw);
    check("and reports the failure", r && r.ok === false);
    const row: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "C",
    }).lean();
    check("the reason is stored, not dropped", /403/.test(row?.failureReason ?? ""), String(row?.failureReason));
    check("with no bytes pretending to be a model", geometryBytes(row?.data).length === 0);
    check("and it is on the activity log",
      !!(await ActivityLog.findOne({ enterpriseId: ent._id, partId: part._id, ok: false }).lean()));
  }

  console.log("\nA model too big for the database is refused with a reason");
  {
    const huge = {
      ...client,
      exportGltf: async () => ({
        data: Buffer.alloc(MAX_GEOMETRY_BYTES + 1),
        contentType: "model/gltf-binary",
        via: "direct" as const,
        elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;

    const r = await captureReleasedGeometry(huge, eid, String(part._id), coords, { revision: "D" });
    /*
     * Mongo refuses a document over 16MB with an error about BSON size that
     * says nothing about geometry. Caught here so the part page can say
     * something a person can act on.
     */
    check("it is refused", !r.ok);
    check("the reason names the size", /MB/.test(r.reason ?? ""), r.reason ?? "");
    check("and says the model is still in Onshape", /Onshape/.test(r.reason ?? ""), r.reason ?? "");
    const row: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "D",
    }).lean();
    check("nothing oversized was stored", geometryBytes(row?.data).length === 0);
  }

  console.log("\nAn empty answer is not mistaken for a model");
  {
    const empty = {
      ...client,
      exportGltf: async () => ({
        data: Buffer.alloc(0), contentType: "model/gltf-binary", via: "direct" as const, elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;
    const r = await captureReleasedGeometry(empty, eid, String(part._id), coords, { revision: "E" });
    check("zero bytes is a failure", !r.ok);
    check("and says so", /empty/i.test(r.reason ?? ""), r.reason ?? "");
  }

  console.log("\nAn assembly exports too, through the translation path");
  {
    const asm: any = await Part.create({
      enterpriseId: ent._id, documentId: "dG", elementId: "eAsm", partId: "",
      number: "AS-3D-001", name: "Frame", kind: "assembly", lifecycleState: "Released", revision: "A",
    });
    const r = await captureReleasedGeometry(
      client, eid, String(asm._id),
      { documentId: "dG", elementId: "eAsm", partId: "", configuration: "default",
        workspaceId: null, versionId: "v-asm-A" },
      { revision: "A", isAssembly: true }
    );
    check("the assembly capture succeeds", r.ok, r.reason ?? "");
    const row: any = await PartGeometry.findOne({ enterpriseId: ent._id, partId: asm._id }).lean();
    check("its bytes are stored", (row?.size ?? 0) > 0);

    /*
     * A part with no part id is not an assembly by accident — asking for one
     * as a part must fail loudly rather than export the wrong thing.
     */
    let msg = "";
    try {
      await client.exportGltf(
        { documentId: "dG", elementId: "eAsm", partId: "", configuration: "default",
          workspaceId: null, versionId: "v-asm-A" },
        { isAssembly: false }
      );
    } catch (e: any) { msg = String(e?.message ?? e); }
    check("a part export with no part id is refused", /part id/i.test(msg), msg);
  }

  for (const M of [Part, PartGeometry, ActivityLog]) {
    await (M as any).deleteMany({ enterpriseId: ent._id });
  }
  await Enterprise.deleteOne({ _id: ent._id });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
