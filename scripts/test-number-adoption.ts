/**
 * PLM never overwrites a part number Onshape already had — but only once.
 *
 * "PLM is the number master" used to mean PLM minted a fresh number for
 * every part the instant it was first synced, whatever Onshape's own Part
 * number property already said — silently replacing a legacy number, or one
 * somebody typed by hand before the part ever touched PLM. That is
 * indistinguishable, from the CAD side, from PLM getting it wrong.
 *
 * The fix is scoped deliberately narrow: Onshape's existing value wins only
 * on the very first sync (and the equivalent backfill case — a record that
 * predates numbering). From the moment a part has a PLM number, whether
 * adopted or minted, PLM owns it exactly as before — a later hand-edit in
 * Onshape is still overwritten on the next sync, matching the design
 * decision that PLM stays authoritative once it has taken a part on.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, Enterprise, MockOnshapePart, MockPropertyDef,
  NumberingSequence, Part,
} from "../src/lib/models";
import { seedAttributeDefinitions } from "../src/lib/attributes";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { syncPartFromOnshape } from "../src/lib/sync";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-number-adoption";
const DOC = "d1a2b3c4d5e6f70819202166";
const PS_LEGACY = "e1a2b3c4d5e6f70819202167";
const PS_FRESH = "e1a2b3c4d5e6f70819202168";
const NUMBER_ID = "57f3fb8efa3416c06701d60e";

async function main() {
  await connectDb();

  for (const M of [Enterprise, AttributeDefinition, Part, MockOnshapePart, MockPropertyDef, ActivityLog, NumberingSequence]) {
    await (M as any).deleteMany({});
  }

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Number Adoption Test Co" });
  const entId = String(ent._id);
  await seedAttributeDefinitions(entId);
  await MockPropertyDef.create({
    companyId: COMPANY, propertyId: NUMBER_ID, name: "Part number", valueType: "STRING", builtIn: true,
  });

  const client = new MockOnshapeClient(COMPANY, {
    id: "mock-user-1", email: "designer@mockenterprise.test", name: "Des Designer",
  });

  console.log("\nA part that already has a number in Onshape keeps it on first sync");
  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Widgets",
    elementId: PS_LEGACY, elementName: "Legacy Part Studio", elementType: "PARTSTUDIO",
    partId: "LEG1", configuration: "default",
    properties: { [NUMBER_ID]: "LEGACY-042" },
  });
  const legacyCoords = {
    documentId: DOC, elementId: PS_LEGACY, partId: "LEG1",
    configuration: "default", workspaceId: "w1", versionId: null,
  };
  const first = await syncPartFromOnshape(entId, legacyCoords, { client, create: true });
  check("the part was created", first.action === "created", first.action);

  const legacyPart: any = await Part.findById(first.partId).lean();
  check("PLM adopted Onshape's existing number rather than minting one",
    legacyPart?.number === "LEGACY-042", legacyPart?.number);

  const seqAfterAdopt: any = await NumberingSequence.findOne({ enterpriseId: ent._id, type: "PART" }).lean();
  check("PLM's own counter was not spent on the adopted number",
    !seqAfterAdopt || seqAfterAdopt.counter === 0, String(seqAfterAdopt?.counter));

  console.log("\nA part with no existing number still gets one minted, as before");
  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Widgets",
    elementId: PS_FRESH, elementName: "Fresh Part Studio", elementType: "PARTSTUDIO",
    partId: "FRESH1", configuration: "default",
    properties: {},
  });
  const freshCoords = {
    documentId: DOC, elementId: PS_FRESH, partId: "FRESH1",
    configuration: "default", workspaceId: "w1", versionId: null,
  };
  const second = await syncPartFromOnshape(entId, freshCoords, { client, create: true });
  const freshPart: any = await Part.findById(second.partId).lean();
  check("a part with nothing in Onshape gets a freshly minted PLM number",
    /^PN-\d{5}$/.test(freshPart?.number ?? ""), freshPart?.number);

  const seqAfterMint: any = await NumberingSequence.findOne({ enterpriseId: ent._id, type: "PART" }).lean();
  check("this one did spend PLM's counter",
    seqAfterMint?.counter === 1, String(seqAfterMint?.counter));

  console.log("\nA number present in Onshape always wins — a renumber pulled in Onshape is kept, not undone");
  await MockOnshapePart.updateOne(
    { companyId: COMPANY, partId: "LEG1" },
    { $set: { [`properties.${NUMBER_ID}`]: "RENUMBERED-001" } }
  );
  await syncPartFromOnshape(entId, legacyCoords, { client, create: false });

  const legacyAfterEdit: any = await Part.findById(first.partId).lean();
  check("PLM adopted the number now in Onshape",
    legacyAfterEdit?.number === "RENUMBERED-001", legacyAfterEdit?.number);

  const onshapeAfterSync: any = await MockOnshapePart.findOne({ companyId: COMPANY, partId: "LEG1" }).lean();
  check("and Onshape's value was left alone",
    onshapeAfterSync?.properties?.[NUMBER_ID] === "RENUMBERED-001",
    String(onshapeAfterSync?.properties?.[NUMBER_ID]));

  console.log("\nThe same rule applies to the backfill path — a record synced before numbering existed");
  await Part.updateOne({ _id: first.partId }, { $set: { number: null } });
  await MockOnshapePart.updateOne(
    { companyId: COMPANY, partId: "LEG1" },
    { $set: { [`properties.${NUMBER_ID}`]: "BACKFILL-007" } }
  );
  await syncPartFromOnshape(entId, legacyCoords, { client, create: false });
  const backfilled: any = await Part.findById(first.partId).lean();
  check("backfilling a numberless record also prefers Onshape's own value",
    backfilled?.number === "BACKFILL-007", backfilled?.number);

  for (const M of [Enterprise, AttributeDefinition, Part, MockOnshapePart, MockPropertyDef, ActivityLog, NumberingSequence]) {
    await (M as any).deleteMany({});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
