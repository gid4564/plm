/**
 * Releasing the same part twice: what survives.
 *
 * The question this answers is whether a part's earlier revisions are still
 * there after a later one — asked about real data, so it is worth an actual
 * second release rather than a reading of the code.
 *
 * PLM keeps three separate records of a release, and this exercises all of
 * them, because each could plausibly have been the one that overwrites:
 *
 *   Part            one row, always current. Its revision and iteration are
 *                   overwritten — this is the "now" of the part.
 *   PartIteration   one row per iteration, never rewritten. This is the history:
 *                   the attributes, revision and Onshape version as they stood.
 *   Release         one row per release, with the items and revisions it
 *                   produced, plus its own drawing sheets.
 *
 * The assertions below are mostly of the form "the rev A record still says A",
 * which is the failure mode worth guarding: a snapshot that is rewritten in
 * place looks exactly like history until you need it.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, Drawing, DrawingFile, Enterprise, MockOnshapeDrawing,
  MockOnshapePart, MockPropertyDef, MockReleasePackage, NumberIssuedLog, NumberingSequence,
  Part, PartIteration, Product, Release, User,
} from "../src/lib/models";
import { seedAttributeDefinitions } from "../src/lib/attributes";
import { discoverProperties } from "../src/lib/onshape/properties";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { decideRelease, refreshReleasedDrawings, takeOverReleasePackage } from "../src/lib/release";
import { syncPartFromOnshape } from "../src/lib/sync";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-rerelease";
const DOC = "d5a2b3c4d5e6f70819202150";
const PS = "e5a2b3c4d5e6f70819202151";
const DWG = "e5a2b3c4d5e6f70819202152";
const NAME_ID = "57f3fb8efa3416c06701d60d";
const DESC_ID = "57f3fb8efa3416c06701d610";

const PROPS = [
  { propertyId: NAME_ID, name: "Name", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d60e", name: "Part number", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d60f", name: "Revision", valueType: "STRING", builtIn: true },
  { propertyId: DESC_ID, name: "Description", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d611", name: "Material", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d612", name: "State", valueType: "ENUM", builtIn: true },
];

async function main() {
  await connectDb();

  for (const M of [
    Enterprise, User, AttributeDefinition, Part, PartIteration, Drawing, DrawingFile,
    Release, ActivityLog, NumberingSequence, NumberIssuedLog, Product,
  ]) await (M as any).deleteMany({});
  for (const M of [MockOnshapePart, MockPropertyDef, MockReleasePackage, MockOnshapeDrawing]) {
    await (M as any).deleteMany({ companyId: COMPANY });
  }

  const ent: any = await Enterprise.create({
    onshapeCompanyId: COMPANY, name: "Re-release Co",
    releaseTakeoverEnabled: true, onshapeReleaseWorkflowId: "mock-workflow",
  });
  const entId = String(ent._id);
  const approver: any = await User.create({
    email: "approver@rerelease.test", passwordHash: "x", name: "Ann", role: "approver",
    enterpriseId: ent._id,
  });

  await MockPropertyDef.insertMany(PROPS.map((p) => ({ ...p, companyId: COMPANY })));
  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Widget",
    elementId: PS, elementName: "Widget Part Studio", elementType: "PARTSTUDIO",
    partId: "WGT", configuration: "default",
    properties: {
      [NAME_ID]: "Widget",
      "57f3fb8efa3416c06701d60e": "WG-1",
      [DESC_ID]: "First design",
      "57f3fb8efa3416c06701d611": { displayName: "Steel 1018" },
    },
  });
  await MockOnshapeDrawing.create({
    companyId: COMPANY, documentId: DOC, documentName: "Widget",
    elementId: DWG, elementName: "Widget Drawing", partIds: ["WGT"],
  });

  await seedAttributeDefinitions(entId);
  const client = new MockOnshapeClient(COMPANY, {
    id: "mock-user-rr", email: "designer@rerelease.test", name: "Des",
  });
  await discoverProperties(client, entId, COMPANY);

  /** Raise a candidate in Onshape, adopt it, fill what release needs, approve. */
  async function releaseOnce(label: string) {
    const pkg = await client.createReleasePackage("mock-workflow", {
      items: [{ documentId: DOC, elementId: PS, partId: "WGT" }],
    });
    const takeover = await takeOverReleasePackage(entId, pkg.id, { trigger: "test", client });

    // Fill the attributes a release requires, as a person would before approving.
    const part: any = await Part.findOne({ enterpriseId: ent._id, partId: "WGT" });
    part.attributes = {
      ...(part.attributes ?? {}),
      classification: "Make",
      unitOfMeasure: "each",
      responsibleEngineer: "R. Engineer",
    };
    part.markModified("attributes");
    await part.save();

    const decision = await decideRelease(String(takeover.releaseId), {
      intent: "approve", userId: String(approver._id), email: approver.email,
      note: `Approved for ${label}.`,
    });
    await refreshReleasedDrawings(String(takeover.releaseId), { client, trigger: "test" });
    return { releaseId: String(takeover.releaseId), decision, rpid: pkg.id };
  }

  console.log("\nFirst release");
  const first = await releaseOnce("rev A");
  check("it succeeded", first.decision.ok, first.decision.transitionError ?? first.decision.message);

  const afterFirst: any = await Part.findOne({ enterpriseId: ent._id, partId: "WGT" }).lean();
  check("the part is at revision A", afterFirst.revision === "A", afterFirst.revision);
  check("and is Released", afterFirst.lifecycleState === "Released", afterFirst.lifecycleState);

  const itersAfterFirst = await PartIteration.countDocuments({ partId: afterFirst._id });
  const firstIteration = afterFirst.iteration;

  /*
   * A designer changes the part in Onshape and releases again. The description
   * is changed so the snapshots are distinguishable by content, not only by
   * revision letter — a snapshot rewritten in place would otherwise be
   * invisible here.
   */
  console.log("\nThe designer edits the part and releases again");
  await MockOnshapePart.updateOne(
    { companyId: COMPANY, documentId: DOC, elementId: PS, partId: "WGT" },
    { $set: { [`properties.${DESC_ID}`]: "Second design, thicker wall" } }
  );
  // The part goes back to work, as a new release candidate implies.
  await Part.updateOne({ _id: afterFirst._id }, { $set: { lifecycleState: "In Work" } });
  await syncPartFromOnshape(
    entId,
    { documentId: DOC, elementId: PS, partId: "WGT", configuration: "default",
      workspaceId: null, versionId: null },
    { trigger: "test", client }
  );

  const second = await releaseOnce("rev B");
  check("the second release succeeded", second.decision.ok,
    second.decision.transitionError ?? second.decision.message);
  check("it is a different release record", second.releaseId !== first.releaseId);

  console.log("\nThe part row is the current state, and only that");
  const afterSecond: any = await Part.findOne({ _id: afterFirst._id }).lean();
  check("the part is now at revision B", afterSecond.revision === "B", afterSecond.revision);
  check("its iteration moved on", afterSecond.iteration > firstIteration,
    `${firstIteration} -> ${afterSecond.iteration}`);
  check("it carries the new description",
    String(afterSecond.attributes?.description).includes("Second design"),
    String(afterSecond.attributes?.description));

  console.log("\nThe earlier revision's history is intact");
  const iters: any[] = await PartIteration.find({ partId: afterFirst._id })
    .sort({ iteration: 1 }).lean();

  check("iterations were added, not replaced", iters.length > itersAfterFirst,
    `${itersAfterFirst} -> ${iters.length}`);

  const revA = iters.filter((i) => i.revision === "A");
  const revB = iters.filter((i) => i.revision === "B");
  check("a revision A iteration still exists", revA.length >= 1, JSON.stringify(iters.map((i) => `${i.iteration}:${i.revision}`)));
  check("and a revision B one too", revB.length >= 1);

  /*
   * The point of the whole exercise: the rev A snapshot still holds the values
   * that were released as A, not the values that later became B.
   */
  const releasedA = revA.find((i) => i.cause === "release");
  check("the rev A release snapshot is still there", !!releasedA);
  check("it still holds the description released as A",
    String(releasedA?.attributes?.description).includes("First design"),
    String(releasedA?.attributes?.description));
  check("it still records the Onshape version it came from", !!releasedA?.onshapeVersionId);
  check("and the release that produced it",
    String(releasedA?.releaseId) === first.releaseId,
    `${releasedA?.releaseId} vs ${first.releaseId}`);

  const releasedB = revB.find((i) => i.cause === "release");
  check("the rev B snapshot is a different row", String(releasedB?._id) !== String(releasedA?._id));
  check("with a different Onshape version",
    releasedB?.onshapeVersionId !== releasedA?.onshapeVersionId,
    `${releasedA?.onshapeVersionId} vs ${releasedB?.onshapeVersionId}`);

  console.log("\nBoth releases are still on record");
  const releases: any[] = await Release.find({ enterpriseId: ent._id }).sort({ createdAt: 1 }).lean();
  check("two releases exist", releases.length === 2, String(releases.length));
  check("the first still names revision A",
    releases[0].items.some((i: any) => i.revision === "A"),
    JSON.stringify(releases[0].items.map((i: any) => i.revision)));
  check("the second names revision B",
    releases[1].items.some((i: any) => i.revision === "B"),
    JSON.stringify(releases[1].items.map((i: any) => i.revision)));
  check("both are Released", releases.every((r) => r.state === "Released"),
    releases.map((r) => r.state).join(", "));

  console.log("\nAnd so are both releases' drawing sheets");
  const dwg: any = await Drawing.findOne({ enterpriseId: ent._id }).lean();
  if (dwg) {
    const sheets: any[] = await DrawingFile.find({ drawingId: dwg._id }).sort({ version: 1 }).lean();
    check("sheets from both releases are kept",
      new Set(sheets.map((f) => String(f.releaseId))).size === 2,
      `${sheets.length} sheet(s) across ${new Set(sheets.map((f) => String(f.releaseId))).size} release(s)`);
    check("each release kept its as-submitted and as-released sheet",
      sheets.filter((f) => f.stage === "as-released").length === 2 &&
      sheets.filter((f) => f.stage === "as-submitted").length === 2,
      sheets.map((f) => `${f.stage}@${f.revision || "-"}`).join(", "));
    check("the rev A sheet still says A",
      sheets.some((f) => f.stage === "as-released" && f.revision === "A"),
      sheets.map((f) => `${f.stage}:${f.revision}`).join(", "));
  } else {
    check("a drawing came into PLM with the release", false, "no drawing found");
  }

  console.log("\nWhat PLM does NOT keep, stated plainly");
  /*
   * Iteration numbering does not restart per revision: it is a single
   * monotonic count of changes to the part, so rev B continues from where rev A
   * left off rather than returning to 1. Asserted because it is a deliberate
   * choice that a reader might otherwise take for a bug — and because a change
   * to it would silently renumber every part's history.
   */
  check("iteration numbering is continuous across revisions, not restarted",
    iters.every((it, n) => it.iteration === iters[0].iteration + n) &&
      (releasedB?.iteration ?? 0) > (releasedA?.iteration ?? 0),
    JSON.stringify(iters.map((i) => `${i.iteration}:${i.revision || "-"}`)));

  await Promise.all([
    Part.deleteMany({ enterpriseId: ent._id }),
    PartIteration.deleteMany({ enterpriseId: ent._id }),
    Drawing.deleteMany({ enterpriseId: ent._id }),
    DrawingFile.deleteMany({}),
    Release.deleteMany({ enterpriseId: ent._id }),
    ActivityLog.deleteMany({ enterpriseId: ent._id }),
    Product.deleteMany({ enterpriseId: ent._id }),
    User.deleteMany({ enterpriseId: ent._id }),
    Enterprise.deleteOne({ _id: ent._id }),
    MockOnshapePart.deleteMany({ companyId: COMPANY }),
    MockPropertyDef.deleteMany({ companyId: COMPANY }),
    MockReleasePackage.deleteMany({ companyId: COMPANY }),
    MockOnshapeDrawing.deleteMany({ companyId: COMPANY }),
  ]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
