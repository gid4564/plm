/**
 * Does a part's Name actually come across when it is synced from Onshape?
 *
 * Two separate mechanisms both claim to carry it, and this checks both rather
 * than trusting either from a read of the code:
 *
 *   `part.name` — the top-level field every list and page title reads.
 *   Populated from `mapStandardProperties`, which matches a property named
 *   "Name" (or "Part Name"/"Title") among whatever Onshape's metadata
 *   response returns, independent of the attribute-mapping metamodel.
 *
 *   `part.attributes.name` — the seeded "Name" AttributeDefinition
 *   (owner: "onshape", onshapePropertyName: "Name"), shown on the part page's
 *   Attributes panel. This one depends on the binding actually resolving —
 *   the same mechanism a mis-mapped custom attribute can fail at and read
 *   "Not found".
 *
 * Both are exercised on a *brand-new* enterprise's *first* sync, with no
 * discovery step run by hand first — `syncPartFromOnshape` is supposed to
 * self-heal the binding on every sync (see bindAttributeProperties' own
 * comment), and that claim is exactly what is worth confirming rather than
 * assuming.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, Enterprise, MockOnshapePart, MockPropertyDef, Part,
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

const COMPANY = "mock-company-name-sync";
const DOC = "d1a2b3c4d5e6f70819202155";
const PS = "e1a2b3c4d5e6f70819202156";
const NAME_ID = "57f3fb8efa3416c06701d60d";

async function main() {
  await connectDb();

  for (const M of [Enterprise, AttributeDefinition, Part, MockOnshapePart, MockPropertyDef, ActivityLog]) {
    await (M as any).deleteMany({});
  }

  console.log("\nA brand-new enterprise, no discovery run by hand");
  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Name Sync Test Co" });
  const entId = String(ent._id);
  await seedAttributeDefinitions(entId);

  const nameDef: any = await AttributeDefinition.findOne({
    enterpriseId: entId, objectType: "PART", key: "name",
  }).lean();
  check("the Name attribute is seeded by default, pointed at Onshape's \"Name\"",
    nameDef?.owner === "onshape" && nameDef?.onshapePropertyName === "Name", JSON.stringify(nameDef));
  check("and starts unbound — no propertyId yet, nothing has synced",
    !nameDef?.onshapePropertyId, nameDef?.onshapePropertyId);

  await MockPropertyDef.create({
    companyId: COMPANY, propertyId: NAME_ID, name: "Name", valueType: "STRING", builtIn: true,
  });
  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Widgets",
    elementId: PS, elementName: "Bracket Part Studio", elementType: "PARTSTUDIO",
    partId: "JHD", configuration: "default",
    properties: { [NAME_ID]: "Widget Bracket" },
  });

  const client = new MockOnshapeClient(COMPANY, {
    id: "mock-user-1", email: "designer@mockenterprise.test", name: "Des Designer",
  });
  const coords = {
    documentId: DOC, elementId: PS, partId: "JHD",
    configuration: "default", workspaceId: "w1", versionId: null,
  };

  console.log("\nFirst sync — creating the part");
  const first = await syncPartFromOnshape(entId, coords, { client, create: true });
  check("the part was created", first.action === "created", first.action);

  const created: any = await Part.findById(first.partId).lean();
  check("part.name carries Onshape's Name property",
    created?.name === "Widget Bracket", created?.name);
  check("and so does the Name attribute, with no discovery step run by hand first",
    created?.attributes?.name === "Widget Bracket", JSON.stringify(created?.attributes?.name));

  const boundNow: any = await AttributeDefinition.findOne({
    enterpriseId: entId, objectType: "PART", key: "name",
  }).lean();
  check("the binding self-healed — a propertyId is filled in now",
    boundNow?.onshapePropertyId === NAME_ID, boundNow?.onshapePropertyId);

  console.log("\nThe name changes in Onshape, and a re-sync picks it up");
  await MockOnshapePart.updateOne(
    { companyId: COMPANY, partId: "JHD" },
    { $set: { [`properties.${NAME_ID}`]: "Widget Bracket Mk2" } }
  );
  const second = await syncPartFromOnshape(entId, coords, { client, create: false });
  check("reported as a real update", second.action === "updated", second.action);

  const updated: any = await Part.findById(first.partId).lean();
  check("part.name follows the change", updated?.name === "Widget Bracket Mk2", updated?.name);
  check("so does the Name attribute", updated?.attributes?.name === "Widget Bracket Mk2",
    JSON.stringify(updated?.attributes?.name));

  console.log("\nA part with no Name property at all falls back to the tab's own name");
  const NOPROP_ID = "e1a2b3c4d5e6f70819202157";
  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Widgets",
    elementId: NOPROP_ID, elementName: "Unnamed Tab", elementType: "PARTSTUDIO",
    partId: "JHE", configuration: "default",
    properties: {},
  });
  const third = await syncPartFromOnshape(
    entId,
    { documentId: DOC, elementId: NOPROP_ID, partId: "JHE", configuration: "default", workspaceId: "w1", versionId: null },
    { client, create: true }
  );
  const noNameProp: any = await Part.findById(third.partId).lean();
  check("part.name falls back to the tab's element name, not blank",
    noNameProp?.name === "Unnamed Tab", noNameProp?.name);
  check("but the Name ATTRIBUTE has nothing to mirror, and stays empty",
    !noNameProp?.attributes?.name, JSON.stringify(noNameProp?.attributes?.name));

  for (const M of [Enterprise, AttributeDefinition, Part, MockOnshapePart, MockPropertyDef, ActivityLog]) {
    await (M as any).deleteMany({});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
