/**
 * End-to-end test of the release takeover, against the mock Onshape tenant.
 *
 * This exercises the whole of requirements 2, 4 and 5 without an Onshape
 * enterprise: a designer raises a release candidate, PLM adopts the package,
 * an approver approves, PLM transitions Onshape, Onshape creates revisions,
 * and PLM re-captures the drawing at the released version.
 *
 * The assertions that matter are the last few: that both drawing sheets are
 * kept, that only the second carries a revision, and that the PDFs actually
 * differ. Requirement 5 is precisely the claim that they do.
 */
// Set directly rather than through dotenv: this script needs three values and
// adding a dependency to read them from a file it does not otherwise use would
// be the larger change.
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, Drawing, DrawingFile, Enterprise, MockOnshapeDrawing,
  MockOnshapePart, MockPropertyDef, MockReleasePackage, NumberIssuedLog, NumberingSequence,
  OAuthClient, OAuthToken, Part, PartIteration, Release, User,
} from "../src/lib/models";
import { seedAttributeDefinitions } from "../src/lib/attributes";
import { discoverProperties } from "../src/lib/onshape/properties";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { decideRelease, refreshReleasedDrawings, takeOverReleasePackage } from "../src/lib/release";
import { registerClient, exchangeAuthCode, issueAuthCode, authenticateBearer } from "../src/lib/oauth-server";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-plm";
const DOC = "d1a2b3c4d5e6f70819202122";
const PS = "e1a2b3c4d5e6f70819202123";
const DWG = "e9a8b7c6d5e4f30219202199";

const PROPS = [
  { propertyId: "57f3fb8efa3416c06701d60d", name: "Name", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d60e", name: "Part number", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d60f", name: "Revision", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d610", name: "Description", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d611", name: "Material", valueType: "STRING", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d612", name: "State", valueType: "ENUM", builtIn: true },
  { propertyId: "57f3fb8efa3416c06701d613", name: "Vendor", valueType: "STRING", builtIn: false },
];

async function main() {
  await connectDb();

  // A clean slate, so a re-run proves the same thing as the first run.
  for (const M of [
    Enterprise, User, AttributeDefinition, Part, PartIteration, Drawing, DrawingFile,
    Release, ActivityLog, NumberingSequence, NumberIssuedLog, OAuthClient, OAuthToken,
    MockOnshapePart, MockPropertyDef, MockReleasePackage, MockOnshapeDrawing,
  ]) await (M as any).deleteMany({});

  console.log("\n1. Set up the enterprise and the mock tenant");

  const ent: any = await Enterprise.create({
    onshapeCompanyId: COMPANY,
    name: "Mock Enterprise",
    releaseTakeoverEnabled: true,
    onshapeReleaseWorkflowId: "mock-workflow",
  });
  const entId = String(ent._id);

  const approver: any = await User.create({
    email: "approver@mockenterprise.test",
    passwordHash: "x", name: "Ann Approver", role: "approver", enterpriseId: ent._id,
  });

  await MockPropertyDef.insertMany(PROPS.map((p) => ({ ...p, companyId: COMPANY })));

  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Gearbox",
    elementId: PS, elementName: "Housing Part Studio", elementType: "PARTSTUDIO",
    partId: "JHD", configuration: "default",
    properties: {
      "57f3fb8efa3416c06701d60d": "Gearbox Housing",
      "57f3fb8efa3416c06701d60e": "GB-1001",
      "57f3fb8efa3416c06701d610": "Cast aluminium main housing",
      "57f3fb8efa3416c06701d611": { displayName: "Aluminium 6061-T6" },
      "57f3fb8efa3416c06701d613": "Precision Castings Ltd",
    },
  });

  await MockOnshapeDrawing.create({
    companyId: COMPANY, documentId: DOC, documentName: "Gearbox",
    elementId: DWG, elementName: "Housing Drawing", partIds: ["JHD"],
  });

  const created = await seedAttributeDefinitions(entId);
  check("seeded the attribute schema", created > 0, `${created} definitions`);

  const client = new MockOnshapeClient(COMPANY, {
    id: "mock-user-1", email: "designer@mockenterprise.test", name: "Des Designer",
  });

  const disc = await discoverProperties(client, entId, COMPANY);
  check("bound attributes to Onshape properties", disc.bound.length >= 4,
    `${disc.bound.length} bound, ${disc.unmatched.length} unmatched, ${disc.plmOnly} PLM-only`);

  console.log("\n2. A designer raises a release candidate in Onshape");

  const pkg = await client.createReleasePackage("mock-workflow", {
    changeOrderId: "designer-raised",
    items: [{ documentId: DOC, elementId: PS, partId: "JHD" }],
  });
  check("Onshape created a release package", pkg.state === "PENDING", `state ${pkg.state}`);
  check("Onshape added the drawing itself",
    pkg.items.some((i) => i.elementType === "DRAWING"),
    `items: ${pkg.items.map((i) => i.elementType).join(", ")}`);
  check("the package offers an APPROVE transition",
    pkg.availableActions.some((a) => a.type === "APPROVE"),
    pkg.availableActions.map((a) => a.type).join(", "));

  console.log("\n3. PLM takes over the release");

  const takeover = await takeOverReleasePackage(entId, pkg.id, { client });
  check("PLM opened a release", takeover.action === "opened", takeover.message);
  check("the part came into PLM", takeover.parts === 1, `${takeover.parts} part(s)`);
  check("the drawing came into PLM", takeover.drawings === 1, `${takeover.drawings} drawing(s)`);

  const part: any = await Part.findOne({ enterpriseId: entId });
  check("PLM issued a part number", /^PN-\d{5}$/.test(part?.number ?? ""), part?.number);
  check("the part is Under Review, not Released",
    part?.lifecycleState === "Under Review", part?.lifecycleState);
  check("the part has no revision before release",
    (part?.revision ?? "") === "", `revision "${part?.revision}"`);
  check("material was mirrored from Onshape",
    part?.attributes?.material === "Aluminium 6061-T6", String(part?.attributes?.material));
  check("PLM-owned defaults were applied",
    part?.attributes?.unitOfMeasure === "Each", String(part?.attributes?.unitOfMeasure));

  const pushedNumber = (await MockOnshapePart.findOne({ partId: "JHD" }).lean() as any)
    ?.properties?.["57f3fb8efa3416c06701d60e"];
  check("the PLM number was written back to Onshape",
    pushedNumber === part?.number, `Onshape holds "${pushedNumber}"`);

  // Both the part and the drawing have release-required attributes unset, and
  // both should be reported — an approver needs the whole list, not the first.
  const partGaps = takeover.validationFailures.find((f) => f.itemLabel.startsWith("PN-"));
  const dwgGaps = takeover.validationFailures.find((f) => f.itemLabel.startsWith("DWG-"));
  check("the part's missing release attributes were reported",
    Boolean(partGaps?.missing.includes("Make or buy")) &&
    Boolean(partGaps?.missing.includes("Responsible engineer")),
    JSON.stringify(partGaps));
  check("the drawing's missing release attributes were reported too",
    Boolean(dwgGaps?.missing.includes("Checked by")), JSON.stringify(dwgGaps));

  const submitted: any = await DrawingFile.findOne({ stage: "as-submitted" }).lean();
  check("the as-submitted PDF was captured", Boolean(submitted?.size), `${submitted?.size} bytes`);
  check("the as-submitted PDF carries no revision",
    (submitted?.revision ?? "") === "", `revision "${submitted?.revision}"`);

  console.log("\n4. A PLM approver approves; PLM transitions Onshape");

  // Fill the gap the validation reported, the way a person would.
  part.attributes = {
    ...part.attributes,
    classification: "Make",
    responsibleEngineer: "R. Engineer",
  };
  part.markModified("attributes");
  await part.save();

  const decision = await decideRelease(String(takeover.releaseId), {
    intent: "approve", userId: String(approver._id), email: approver.email,
    note: "Reviewed against drawing rev A.",
  });

  check("the decision succeeded", decision.ok, decision.transitionError ?? decision.message);
  check("PLM used the workflow's APPROVE transition",
    (decision.transition ?? "").includes("APPROVE"), decision.transition ?? "none");
  check("the release is Released", decision.state === "Released", decision.state);
  check("Onshape assigned revision A",
    decision.revisions.some((r) => r.revision === "A"),
    JSON.stringify(decision.revisions));

  const afterPkg = await client.getReleasePackage(pkg.id);
  check("the Onshape package is RELEASED", afterPkg.state === "RELEASED", afterPkg.state);

  const released: any = await Part.findById(part._id).lean();
  check("the part is Released in PLM", released?.lifecycleState === "Released", released?.lifecycleState);
  check("the part carries revision A", released?.revision === "A", released?.revision);

  const iterations: any[] = await PartIteration.find({ partId: part._id }).sort({ iteration: 1 }).lean();
  check("iterations were recorded", iterations.length >= 2,
    iterations.map((i) => `${i.iteration}${i.revision ? `/${i.revision}` : ""}(${i.cause})`).join(" "));
  check("the release iteration is stamped with the revision",
    iterations.at(-1)?.revision === "A" && iterations.at(-1)?.cause === "release",
    `${iterations.at(-1)?.revision} / ${iterations.at(-1)?.cause}`);

  console.log("\n5. Onshape finished; PLM re-captures the released drawing");

  const rel: any = await Release.findById(takeover.releaseId).lean();
  check("the drawing refresh was flagged as pending", rel?.drawingRefreshPending === true);

  const refresh = await refreshReleasedDrawings(String(takeover.releaseId), { client });
  check("the released sheet was captured", refresh.captured === 1, refresh.message);
  check("nothing is left outstanding", !refresh.stillPending, refresh.message);

  const files: any[] = await DrawingFile.find({}).sort({ version: 1 }).lean();
  check("both sheets are kept", files.length === 2,
    files.map((f) => `v${f.version} ${f.stage}`).join(", "));
  check("the released sheet carries revision A",
    files[1]?.stage === "as-released" && files[1]?.revision === "A",
    `${files[1]?.stage} / revision "${files[1]?.revision}"`);
  check("the released sheet was exported from a version, not the workspace",
    Boolean(files[1]?.onshapeVersionId), String(files[1]?.onshapeVersionId));

  // The whole point of requirement 5: the two PDFs are genuinely different.
  const a = files[0]?.data?.toString("latin1") ?? "";
  const b = files[1]?.data?.toString("latin1") ?? "";
  check("the two PDFs differ", a !== b, `${files[0]?.size} vs ${files[1]?.size} bytes`);
  check("only the released sheet says RELEASED",
    !a.includes("RELEASED") && b.includes("RELEASED"));
  check("the submitted sheet is marked preliminary", a.includes("PRELIMINARY"));

  const dwg: any = await Drawing.findOne({}).lean();
  check("the released sheet is the current one",
    String(dwg?.currentFileId) === String(files[1]?._id));
  check("the drawing is Released at revision A",
    dwg?.lifecycleState === "Released" && dwg?.revision === "A",
    `${dwg?.lifecycleState} / ${dwg?.revision}`);
  check("the drawing is linked to the part it documents",
    (dwg?.partIds ?? []).some((p: any) => String(p) === String(part._id)));

  console.log("\n6. Repeat delivery of the revision event changes nothing");

  const again = await refreshReleasedDrawings(String(takeover.releaseId), { client });
  const stillTwo = await DrawingFile.countDocuments({});
  check("a second refresh is a no-op", again.captured === 0 && stillTwo === 2,
    `captured ${again.captured}, ${stillTwo} files`);

  const secondTakeover = await takeOverReleasePackage(entId, pkg.id, { client });
  const releaseCount = await Release.countDocuments({});
  check("a repeated webhook does not open a second release",
    secondTakeover.action === "already-open" && releaseCount === 1,
    `${secondTakeover.action}, ${releaseCount} release(s)`);

  console.log("\n7. Onshape authenticates to PLM by OAuth (requirement 1)");

  const reg = await registerClient("Onshape", ["https://oauth.onshape.com/callback"], entId);
  check("PLM registered Onshape as an OAuth client", reg.clientId.startsWith("plm-"));

  const code = await issueAuthCode({
    clientId: reg.clientId,
    redirectUri: "https://oauth.onshape.com/callback",
    userId: String(approver._id),
    enterpriseId: entId,
  });
  const ex = await exchangeAuthCode({
    code, clientId: reg.clientId, redirectUri: "https://oauth.onshape.com/callback",
  });
  check("the authorization code exchanged for tokens", ex.ok);

  if (ex.ok) {
    const identity = await authenticateBearer(
      new Request("https://plm.test/api/numbering/onshape-extension", {
        headers: { authorization: `Bearer ${ex.tokens.accessToken}` },
      })
    );
    check("a bearer token resolves to the consenting user and tenant",
      identity?.userId === String(approver._id) && identity?.enterpriseId === entId);

    const replay = await exchangeAuthCode({
      code, clientId: reg.clientId, redirectUri: "https://oauth.onshape.com/callback",
    });
    check("a replayed code is refused", !replay.ok, replay.ok ? "accepted" : replay.error);

    const afterReplay = await authenticateBearer(
      new Request("https://plm.test/x", {
        headers: { authorization: `Bearer ${ex.tokens.accessToken}` },
      })
    );
    check("a replay revokes the tokens the code produced", afterReplay === null);
  }

  const bad = await authenticateBearer(
    new Request("https://plm.test/x", { headers: { authorization: "Bearer not-a-real-token" } })
  );
  check("an unknown bearer token is refused", bad === null);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\nTest run failed:", err);
  process.exit(1);
});
