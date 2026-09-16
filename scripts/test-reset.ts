/**
 * Clearing an enterprise's work, so PLM can start over from a clean slate.
 *
 * The rules worth testing are the ones a careless implementation gets wrong:
 *
 *   It clears every kind of work — parts, assemblies, iterations, BOM links,
 *   drawings, drawing files, captured 3D models, releases, thumbnails,
 *   products, tasks and the activity log.
 *   It NEVER touches another enterprise's data — this runs from a web
 *   request, so cross-tenant leakage here is a real incident, not a demo bug.
 *   It NEVER touches settings or mappings — the attribute schema, OAuth
 *   clients and tokens, numbering sequences, users, or the enterprise record
 *   itself (beyond the release-ignored counters, which are reset because they
 *   describe a backlog of releases that no longer exist).
 *   A dry run (no apply) counts without deleting anything.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, BomLink, Drawing, DrawingFile, Enterprise,
  NumberingSequence, OAuthClient, Part, PartGeometry, PartIteration, PartThumbnail,
  Product, Release, Task, User,
} from "../src/lib/models";
import { clearEnterpriseWorkData, countEnterpriseWorkData } from "../src/lib/reset";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY_A = "mock-company-reset-a";
const COMPANY_B = "mock-company-reset-b";

async function main() {
  await connectDb();

  for (const company of [COMPANY_A, COMPANY_B]) {
    const stale: any = await Enterprise.findOne({ onshapeCompanyId: company }).lean();
    if (stale) {
      for (const M of [
        Part, PartIteration, BomLink, Drawing, DrawingFile, PartGeometry, Release,
        PartThumbnail, Product, Task, ActivityLog, AttributeDefinition, User,
      ]) await (M as any).deleteMany({ enterpriseId: stale._id });
      await Enterprise.deleteOne({ _id: stale._id });
    }
  }

  const entA: any = await Enterprise.create({
    onshapeCompanyId: COMPANY_A, name: "Reset Co A",
    releaseGltfEnabled: true, releasesIgnored: 3, lastReleaseIgnoredAt: new Date(),
  });
  const entB: any = await Enterprise.create({ onshapeCompanyId: COMPANY_B, name: "Reset Co B" });
  const aId = String(entA._id);
  const bId = String(entB._id);

  console.log("\nSeed a full set of work for A, and a matching set for B");
  const seedWork = async (enterpriseId: string) => {
    const part: any = await Part.create({
      enterpriseId, documentId: "d1", elementId: "e1", partId: "p1",
      number: "PN-1", name: "Bracket", kind: "part", lifecycleState: "Released", revision: "A",
    });
    const child: any = await Part.create({
      enterpriseId, documentId: "d1", elementId: "e2", partId: "p2",
      number: "PN-2", name: "Screw", kind: "part", lifecycleState: "In Work",
    });
    await PartIteration.create({
      enterpriseId, partId: part._id, iteration: 1, revision: "A", lifecycleState: "Released",
    });
    await BomLink.create({ enterpriseId, parentId: part._id, childId: child._id });
    const drawing: any = await Drawing.create({
      enterpriseId, documentId: "d1", elementId: "eD", lifecycleState: "Released",
    });
    await DrawingFile.create({
      enterpriseId, drawingId: drawing._id, version: 1, stage: "as-released",
    });
    await PartGeometry.create({ enterpriseId, partId: part._id, revision: "A", size: 0 });
    const release: any = await Release.create({ enterpriseId, number: "REL-1" });
    await PartThumbnail.create({
      enterpriseId, partId: part._id, contentType: "image/png", data: Buffer.from("x"),
    });
    await Product.create({ enterpriseId, name: "Widgets", nameLower: "widgets" });
    await Task.create({ enterpriseId, onshapeTaskId: "t1" });
    await ActivityLog.create({ enterpriseId, direction: "plm", action: "created", trigger: "test", ok: true });
    return { part, release };
  };

  await seedWork(aId);
  await seedWork(bId);

  // Configuration, seeded for A only, so a false positive (this getting swept
  // up too) is obvious rather than hidden by both sides looking empty.
  await AttributeDefinition.create({
    enterpriseId: aId, objectType: "PART", key: "material", label: "Material", dataType: "STRING",
  });
  const client: any = await OAuthClient.create({
    enterpriseId: aId, name: "Onshape", clientId: "client-reset-a", clientSecretHash: "hash",
  });
  await User.create({
    email: "reset-admin@test", passwordHash: "x", name: "Admin", role: "admin",
    enterpriseId: aId, currentProductId: null,
  });
  await NumberingSequence.create({ enterpriseId: aId, type: "PART", counter: 42 });

  console.log("\nA dry run counts without deleting anything");
  {
    const before = await countEnterpriseWorkData(aId);
    const total = before.reduce((n, c) => n + c.count, 0);
    check("it found the seeded work", total === 12, String(total));

    const stillThere = await Part.countDocuments({ enterpriseId: aId });
    check("nothing was actually removed", stillThere === 2, String(stillThere));
  }

  console.log("\nClearing enterprise A removes every kind of work");
  {
    const result = await clearEnterpriseWorkData(aId);
    check("it reports what it removed", result.total === 12, String(result.total));

    for (const [label, M] of [
      ["parts", Part], ["iterations", PartIteration], ["BOM links", BomLink],
      ["drawings", Drawing], ["drawing files", DrawingFile], ["3D captures", PartGeometry],
      ["releases", Release], ["thumbnails", PartThumbnail], ["products", Product],
      ["tasks", Task], ["activity log", ActivityLog],
    ] as const) {
      const n = await (M as any).countDocuments({ enterpriseId: aId });
      check(`${label} are gone`, n === 0, String(n));
    }
  }

  console.log("\nIt never touches enterprise B's work");
  {
    for (const [label, M, expected] of [
      ["parts", Part, 2], ["iterations", PartIteration, 1], ["BOM links", BomLink, 1],
      ["drawings", Drawing, 1], ["drawing files", DrawingFile, 1], ["3D captures", PartGeometry, 1],
      ["releases", Release, 1], ["thumbnails", PartThumbnail, 1], ["products", Product, 1],
      ["tasks", Task, 1], ["activity log", ActivityLog, 1],
    ] as const) {
      const n = await (M as any).countDocuments({ enterpriseId: bId });
      check(`B still has its ${label}`, n === expected, String(n));
    }
  }

  console.log("\nIt never touches settings or mappings");
  {
    check("the attribute schema survives",
      await AttributeDefinition.countDocuments({ enterpriseId: aId }) === 1);
    check("the OAuth client survives",
      await OAuthClient.countDocuments({ _id: client._id }) === 1);
    check("numbering sequences survive",
      await NumberingSequence.countDocuments({ enterpriseId: aId }) === 1);
    check("the user survives",
      await User.countDocuments({ enterpriseId: aId }) === 1);
    const entAfter: any = await Enterprise.findById(aId).lean();
    check("the enterprise record survives", !!entAfter);
    check("its own settings are untouched", entAfter.releaseGltfEnabled === true);
    check("the release-ignored counter is reset", entAfter.releasesIgnored === 0);
    check("and its timestamp with it", entAfter.lastReleaseIgnoredAt === null);
  }

  console.log("\nClearing an enterprise with nothing to clear is a no-op, not an error");
  {
    const again = await clearEnterpriseWorkData(aId);
    check("nothing left to remove", again.total === 0, String(again.total));
  }

  for (const M of [
    Part, PartIteration, BomLink, Drawing, DrawingFile, PartGeometry, Release,
    PartThumbnail, Product, Task, ActivityLog, AttributeDefinition, OAuthClient,
    NumberingSequence, User,
  ]) {
    await (M as any).deleteMany({ enterpriseId: { $in: [aId, bId] } });
  }
  await Enterprise.deleteMany({ _id: { $in: [aId, bId] } });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
