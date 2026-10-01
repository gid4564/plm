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

import JSZip from "jszip";
import { connectDb } from "../src/lib/db";
import { ActivityLog, Enterprise, MockOnshapePart, Part, PartGeometry } from "../src/lib/models";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import {
  captureReleasedGeometry, detectGltfFormat, geometryBytes, geometryCaptureEnabled,
  geometryForPart, MAX_GEOMETRY_BYTES, deleteGeometryForPart, readGeometryBytes,
} from "../src/lib/geometry";
import { syncPartFromOnshape } from "../src/lib/sync";
import type { OnshapeClient } from "../src/lib/onshape/types";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-geometry";

/** The GridFS tests write real files — cleared before and after, not just the documents. */
async function dropGeometryBucket() {
  const conn = await connectDb();
  const db = conn.connection.db;
  if (!db) return;
  await db.collection("part-geometry.files").drop().catch(() => {});
  await db.collection("part-geometry.chunks").drop().catch(() => {});
}

async function main() {
  await connectDb();
  await dropGeometryBucket();

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

  console.log("\nWhat is stored is a structurally valid GLB, not just bytes");
  {
    /*
     * Walked the way a loader walks it. A file that merely starts with the
     * right magic can still be unreadable — a wrong declared length or a
     * chunk that overruns the end fails inside the viewer, where the error is
     * someone else's to debug.
     */
    const out = await client.exportGltf(
      { documentId: "dG", elementId: "eG", partId: "PG1", configuration: "default",
        workspaceId: null, versionId: "v-rel-A" },
      {}
    );
    const b = out.data;

    check("the magic is glTF", b.subarray(0, 4).toString("ascii") === "glTF");
    check("it declares glTF 2.0", b.readUInt32LE(4) === 2, String(b.readUInt32LE(4)));
    check("the declared total is the real length", b.readUInt32LE(8) === b.length,
      `${b.readUInt32LE(8)} vs ${b.length}`);

    /* Every chunk, end to end, landing exactly on the final byte. */
    let off = 12;
    const chunks: { type: string; length: number }[] = [];
    while (off < b.length) {
      const len = b.readUInt32LE(off);
      const type = b.subarray(off + 4, off + 8).toString("ascii").replace(/\0/g, "");
      chunks.push({ type: type || "BIN", length: len });
      off += 8 + len;
    }
    check("the chunks account for every byte", off === b.length, `${off} vs ${b.length}`);
    check("there is a JSON chunk first", chunks[0]?.type === "JSON", JSON.stringify(chunks));
    check("and a binary chunk after it", chunks[1]?.type === "BIN", JSON.stringify(chunks));
    check("every chunk length is 4-byte aligned",
      chunks.every((c) => c.length % 4 === 0), JSON.stringify(chunks));

    const jsonLen = chunks[0].length;
    const doc = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8"));
    check("the JSON parses", !!doc.asset);
    check("declaring glTF 2.0 inside too", doc.asset.version === "2.0", doc.asset.version);

    /*
     * Geometry, not an empty scene. A valid GLB with no mesh renders as
     * nothing — which on a demo looks exactly like a broken viewer.
     */
    check("it contains a mesh", (doc.meshes ?? []).length > 0);
    check("with indexed triangles", doc.meshes[0].primitives[0].indices !== undefined);
    check("and positions", doc.meshes[0].primitives[0].attributes?.POSITION !== undefined);
    check("the scene references a node", (doc.scenes?.[0]?.nodes ?? []).length > 0);

    /*
     * POSITION accessors must carry min and max — the spec requires it, and a
     * viewer uses them to frame the camera. Without them the model can load
     * and still appear as an empty box.
     */
    const pos = doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION];
    check("the POSITION accessor declares min and max",
      Array.isArray(pos.min) && Array.isArray(pos.max), JSON.stringify(pos));

    /* The buffer the views point into has to be the size actually shipped. */
    check("the declared buffer length matches the binary chunk",
      doc.buffers[0].byteLength <= chunks[1].length,
      `${doc.buffers[0].byteLength} vs ${chunks[1].length}`);
    for (const [i, bv] of (doc.bufferViews ?? []).entries()) {
      check(`bufferView ${i} stays inside the buffer`,
        bv.byteOffset + bv.byteLength <= doc.buffers[0].byteLength,
        `${bv.byteOffset}+${bv.byteLength} > ${doc.buffers[0].byteLength}`);
      check(`bufferView ${i} starts 4-byte aligned`, bv.byteOffset % 4 === 0, String(bv.byteOffset));
    }

    check("and the format detector agrees it is a GLB",
      detectGltfFormat(b) === "glb", String(detectGltfFormat(b)));
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

  console.log("\nAnything that is not a glTF is refused rather than stored");
  {
    check("an HTML error page is not a model",
      detectGltfFormat(Buffer.from("<html><body>502 Bad Gateway</body></html>")) === null);
    check("nor is empty", detectGltfFormat(Buffer.alloc(0)) === null);
    check("but the JSON form is recognised",
      detectGltfFormat(Buffer.from('{"asset":{"version":"2.0"},"scenes":[]}')) === "gltf-json");

    /*
     * A gateway returning HTML with a 200 is a shape this integration has met
     * before. Storing it would put a file on a part record that no viewer can
     * open, with nothing to say why.
     */
    const gateway = {
      ...client,
      exportGltf: async () => ({
        data: Buffer.from("<html><head><title>502 Bad Gateway</title></head></html>"),
        contentType: "text/html",
        via: "direct" as const,
        elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;

    const r = await captureReleasedGeometry(gateway, eid, String(part._id), coords, { revision: "F" });
    check("an HTML body is refused", !r.ok);
    check("and the reason says it is not a glTF", /not a glTF/i.test(r.reason ?? ""), r.reason ?? "");
    const row: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "F",
    }).lean();
    check("nothing was stored", geometryBytes(row?.data).length === 0);
  }

  console.log("\nAn assembly's zipped export is unpacked, not refused as 'not a glTF'");
  {
    /*
     * A translation job's result can only be one download, so when Onshape
     * cannot hand an assembly back as one binary file it zips the loose form
     * instead — a .gltf JSON plus a separate .bin. See gltf-package.ts. This
     * checks the two things a naive detectGltfFormat pass would get wrong:
     * a zip is not "not a glTF", and what ends up stored is a real, usable
     * GLB, not the zip bytes themselves.
     */
    const mesh = Buffer.from("stand-in mesh bytes for the zipped-export test");
    const doc = {
      asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } } ] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: mesh.length }],
      buffers: [{ uri: "scene.bin", byteLength: mesh.length }],
    };
    const zip = new JSZip();
    zip.file("scene.gltf", JSON.stringify(doc));
    zip.file("scene.bin", mesh);
    const zipped = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const zippedAssembly = {
      ...client,
      exportGltf: async () => ({
        data: zipped, contentType: "application/zip;charset=utf-8",
        via: "translation" as const, translationId: "tr-zip-1", elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;

    const r = await captureReleasedGeometry(zippedAssembly, eid, String(part._id), coords, {
      revision: "G", releaseId: null, isAssembly: true,
    });
    check("the capture succeeds", r.ok, r.reason ?? "");

    const row: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "G",
    }).lean();
    const stored = geometryBytes(row?.data);
    check("a real GLB was stored, not the zip bytes", stored.subarray(0, 4).toString("ascii") === "glTF");
    check("declared as a GLB", row?.contentType === "model/gltf-binary", row?.contentType);
    check("smaller than the zip it was unpacked from",
      stored.length < zipped.length, `${stored.length} vs ${zipped.length}`);
    check("and the activity log says it was repacked",
      !!(await ActivityLog.findOne({
        enterpriseId: ent._id, partId: part._id, message: /repacked from Onshape's zipped export/,
      }).lean()));
  }

  console.log("\nA zip that cannot be unpacked at all is refused, naming why");
  {
    const zip = new JSZip();
    zip.file("readme.txt", "not a model");
    const zipped = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    const brokenZip = {
      ...client,
      exportGltf: async () => ({
        data: zipped, contentType: "application/zip", via: "translation" as const, elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;

    const r = await captureReleasedGeometry(brokenZip, eid, String(part._id), coords, {
      revision: "H", releaseId: null, isAssembly: true,
    });
    check("the capture fails", !r.ok);
    check("naming the zip specifically, not a generic 'not a glTF'",
      /zip/i.test(r.reason ?? "") && /readme\.txt/.test(r.reason ?? ""), r.reason ?? "");
    const row: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "H",
    }).lean();
    check("nothing was stored", geometryBytes(row?.data).length === 0);
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

  console.log("\nA model too big to sit inline a document, but under the real ceiling, goes to GridFS");
  {
    /*
     * A real GLB, just padded well past the inline threshold — detectGltfFormat
     * only looks at the first bytes, so this is a valid capture as far as this
     * test needs, without constructing 20MB of genuine mesh data.
     */
    const smallGlb = (await client.exportGltf(coords, {})).data;
    const big = Buffer.concat([smallGlb, Buffer.alloc(20 * 1024 * 1024)]);
    check("bigger than the old 12MB ceiling", big.length > 12 * 1024 * 1024, String(big.length));
    check("comfortably under the real one", big.length < MAX_GEOMETRY_BYTES, String(big.length));

    const bigClient = {
      ...client,
      exportGltf: async () => ({
        data: big, contentType: "model/gltf-binary", via: "direct" as const, elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;

    const r = await captureReleasedGeometry(bigClient, eid, String(part._id), coords, { revision: "GF1" });
    check("the capture succeeds", r.ok, r.reason ?? "");
    check("reports the real size", r.bytes === big.length, String(r.bytes));

    const row: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "GF1",
    }).lean();
    check("nothing inline — it would blow the document past 16MB", !row?.data);
    check("a GridFS file id is recorded instead", !!row?.gridfsFileId);
    check("the stored size still reflects the real byte count", row?.size === big.length, String(row?.size));

    const roundTripped = await readGeometryBytes(row);
    check("readGeometryBytes recovers it from GridFS, byte for byte", roundTripped.equals(big));

    check("and it is still listed on the part, without dragging the bytes along",
      (await geometryForPart(eid, String(part._id))).some((g) => g.revision === "GF1" && g.size === big.length));
  }

  console.log("\nRe-capturing a GridFS-backed revision does not leave the old file behind");
  {
    const smallGlb = (await client.exportGltf(coords, {})).data;
    const bigger = Buffer.concat([smallGlb, Buffer.alloc(25 * 1024 * 1024)]);

    const before: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "GF1",
    }).lean();
    const oldFileId = before.gridfsFileId;
    check("there is a previous GridFS file to replace", !!oldFileId);

    const client2 = {
      ...client,
      exportGltf: async () => ({
        data: bigger, contentType: "model/gltf-binary", via: "direct" as const, elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;
    const r = await captureReleasedGeometry(client2, eid, String(part._id), coords, { revision: "GF1" });
    check("the re-capture succeeds", r.ok, r.reason ?? "");

    const after: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "GF1",
    }).lean();
    check("a new GridFS file replaced it", String(after.gridfsFileId) !== String(oldFileId));
    check("the new bytes round-trip correctly",
      (await readGeometryBytes(after)).equals(bigger));

    /* The old file is actually gone, not just unlinked. */
    const orphan = await readGeometryBytes({ gridfsFileId: oldFileId });
    check("the old GridFS file was deleted, not left as an orphan", orphan.length === 0);
  }

  console.log("\nDeleting a part's captures also removes their GridFS files");
  {
    const smallGlb = (await client.exportGltf(coords, {})).data;
    const big = Buffer.concat([smallGlb, Buffer.alloc(13 * 1024 * 1024)]);
    const bigClient = {
      ...client,
      exportGltf: async () => ({
        data: big, contentType: "model/gltf-binary", via: "direct" as const, elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;

    const doomed: any = await Part.create({
      enterpriseId: ent._id, documentId: "dDel", elementId: "eDel", partId: "PDel",
      number: "PN-DEL-001", name: "Doomed", kind: "part", lifecycleState: "In Work",
    });
    await captureReleasedGeometry(bigClient, eid, String(doomed._id), coords, { revision: "" });
    const row: any = await PartGeometry.findOne({ partId: doomed._id }).lean();
    check("a GridFS-backed capture exists", !!row?.gridfsFileId);
    check("and can be read back", (await readGeometryBytes(row)).length === big.length);

    await deleteGeometryForPart(doomed._id);
    check("the rows are gone", (await PartGeometry.countDocuments({ partId: doomed._id })) === 0);
    check("and so is the GridFS file, not orphaned",
      (await readGeometryBytes({ gridfsFileId: row.gridfsFileId })).length === 0);
    await Part.deleteOne({ _id: doomed._id });
  }

  console.log("\nA clean-slate reset also removes GridFS files");
  {
    const smallGlb = (await client.exportGltf(coords, {})).data;
    const big = Buffer.concat([smallGlb, Buffer.alloc(13 * 1024 * 1024)]);
    const bigClient = {
      ...client,
      exportGltf: async () => ({
        data: big, contentType: "model/gltf-binary", via: "direct" as const, elapsedMs: 1,
      }),
    } as unknown as OnshapeClient;
    await captureReleasedGeometry(bigClient, eid, String(part._id), coords, { revision: "RS1" });
    const row: any = await PartGeometry.findOne({
      enterpriseId: ent._id, partId: part._id, revision: "RS1",
    }).lean();
    check("a GridFS-backed capture exists", !!row?.gridfsFileId);

    const { clearEnterpriseWorkData } = await import("../src/lib/reset");
    await clearEnterpriseWorkData(eid);
    check("the rows are gone", (await PartGeometry.countDocuments({ enterpriseId: ent._id })) === 0);
    check("and the GridFS file is not left behind",
      (await readGeometryBytes({ gridfsFileId: row.gridfsFileId })).length === 0);

    // Later sections need the part back.
    await Part.create({
      _id: part._id, enterpriseId: ent._id, documentId: "dG", elementId: "eG", partId: "PG1",
      number: "PN-3D-001", name: "Bracket", kind: "part", lifecycleState: "Released", revision: "A",
    });
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

  console.log("\nA newly synced part gets its geometry captured too, before any release");
  {
    await MockOnshapePart.create({
      companyId: COMPANY, documentId: "dSync", elementId: "eSync", partId: "PSync1",
      elementType: "PARTSTUDIO", properties: {},
    });
    const syncCoords = {
      documentId: "dSync", elementId: "eSync", partId: "PSync1", configuration: "default",
      workspaceId: "w1", versionId: null,
    };

    const r = await syncPartFromOnshape(eid, syncCoords, { client, create: true, trigger: "test" });
    check("the part is created", r.action === "created", r.action);

    const row: any = await PartGeometry.findOne({
      enterpriseId: eid, partId: r.partId, revision: "",
    }).lean();
    check("an unreleased capture exists", !!row);
    check("with bytes", geometryBytes(row?.data).length > 0);
    check("no failure recorded", row?.failureReason === null);

    /*
     * A re-sync is not a creation, so it must not spend a second Onshape call
     * re-capturing the same unreleased snapshot.
     */
    const capturedAt = row?.capturedAt ? new Date(row.capturedAt).toISOString() : null;
    await syncPartFromOnshape(eid, syncCoords, { client, create: true, trigger: "test" });
    const again: any = await PartGeometry.findOne({
      enterpriseId: eid, partId: r.partId, revision: "",
    }).lean();
    check("re-syncing does not recapture",
      (again?.capturedAt ? new Date(again.capturedAt).toISOString() : null) === capturedAt);

    const count = await PartGeometry.countDocuments({ enterpriseId: eid, partId: r.partId });
    check("still exactly one capture for this part", count === 1, String(count));
  }

  console.log("\nA release-driven sync does not also capture the workspace");
  {
    /*
     * fromRelease is release.ts's own sync of the part it just released — that
     * caller captures the released VERSION itself, right after. Capturing the
     * workspace here too would spend a redundant Onshape call to store a row
     * this same release is about to make stale.
     */
    await MockOnshapePart.create({
      companyId: COMPANY, documentId: "dSync2", elementId: "eSync2", partId: "PSync2",
      elementType: "PARTSTUDIO", properties: {},
    });
    const r = await syncPartFromOnshape(eid, {
      documentId: "dSync2", elementId: "eSync2", partId: "PSync2", configuration: "default",
      workspaceId: "w1", versionId: null,
    }, { client, create: true, trigger: "test", fromRelease: true, releaseRevision: "A" });

    check("the part is created", r.action === "created", r.action);
    const row = await PartGeometry.findOne({ enterpriseId: eid, partId: r.partId }).lean();
    check("no workspace capture was made", !row);
  }

  console.log("\nSync-time capture is off unless the enterprise asks for it");
  {
    await Enterprise.updateOne({ _id: ent._id }, { $set: { releaseGltfEnabled: false } });
    await MockOnshapePart.create({
      companyId: COMPANY, documentId: "dSync3", elementId: "eSync3", partId: "PSync3",
      elementType: "PARTSTUDIO", properties: {},
    });
    const r = await syncPartFromOnshape(eid, {
      documentId: "dSync3", elementId: "eSync3", partId: "PSync3", configuration: "default",
      workspaceId: "w1", versionId: null,
    }, { client, create: true, trigger: "test" });

    const row = await PartGeometry.findOne({ enterpriseId: eid, partId: r.partId }).lean();
    check("no capture when the toggle is off", !row);
    await Enterprise.updateOne({ _id: ent._id }, { $set: { releaseGltfEnabled: true } });
  }

  console.log("\nA standard-content part is never even attempted");
  {
    /*
     * `writeBackBlocked` already means "read-only to this account" — the same
     * population the property write-back refuses, discovered by BOM import
     * from the owning document's canWrite. Onshape's gltf export 403s for
     * these exactly like a property write does, so a sync must not attempt it
     * and store the refusal as a "failed" row that will never clear.
     */
    await MockOnshapePart.create({
      companyId: COMPANY, documentId: "dStd", elementId: "eStd", partId: "PStd1",
      elementType: "PARTSTUDIO", properties: {},
    });
    const r = await syncPartFromOnshape(eid, {
      documentId: "dStd", elementId: "eStd", partId: "PStd1", configuration: "default",
      workspaceId: "w1", versionId: null,
    }, {
      client, create: true, trigger: "test",
      writeBackBlocked: "Read-only standard-content document.",
    });

    check("the part is still created", r.action === "created", r.action);
    const row = await PartGeometry.findOne({ enterpriseId: eid, partId: r.partId }).lean();
    check("no capture was attempted, and no failure was recorded either", !row);
  }

  for (const M of [Part, PartGeometry, ActivityLog]) {
    await (M as any).deleteMany({ enterpriseId: ent._id });
  }
  await MockOnshapePart.deleteMany({ companyId: COMPANY });
  await Enterprise.deleteOne({ _id: ent._id });
  await dropGeometryBucket();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
