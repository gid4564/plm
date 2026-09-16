/**
 * Onshape's revision designation is respected exactly, per item — PLM never
 * invents one of its own.
 *
 * A release package can bump some items and leave others exactly where they
 * were: a part that actually changed goes from A to B, while a sibling in
 * the same package that did not goes on reading C, because nothing about it
 * needed a new revision. `decideRelease` must record whatever Onshape
 * reports for each item independently — never assume every item in one
 * transition moves, and never derive a letter from PLM's own state.
 *
 * The mock's own `transitionReleasePackage` always bumps every item by one
 * letter (see `nextRevision` in mock-client.ts) — a fine default for the
 * common case, but it cannot produce the mixed shape this is about. The
 * same technique as test-release-assembly-revision.ts is used instead:
 * `getReleasePackage` is monkey-patched to report the exact per-item
 * revisions a live tenant can return, so decideRelease's own handling is
 * what is actually under test, not the simulator's approximation of Onshape.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, Enterprise, MockOnshapePart, MockPropertyDef,
  MockReleasePackage, Part, PartIteration, Release, User,
} from "../src/lib/models";
import { seedAttributeDefinitions } from "../src/lib/attributes";
import { discoverProperties } from "../src/lib/onshape/properties";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { decideRelease, takeOverReleasePackage } from "../src/lib/release";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-mixed-revision";
const DOC = "d1a2b3c4d5e6f70819202122";
const CHANGED = "e1a2b3c4d5e6f70819202131";
const UNCHANGED = "e1a2b3c4d5e6f70819202132";

const PROPS = [
  { propertyId: "p-name", name: "Name", valueType: "STRING", builtIn: true },
  { propertyId: "p-number", name: "Part number", valueType: "STRING", builtIn: true },
  { propertyId: "p-revision", name: "Revision", valueType: "STRING", builtIn: true },
];

async function main() {
  await connectDb();

  for (const M of [
    Enterprise, User, AttributeDefinition, Part, PartIteration, Release, ActivityLog,
    MockOnshapePart, MockPropertyDef, MockReleasePackage,
  ]) await (M as any).deleteMany({});

  const ent: any = await Enterprise.create({
    onshapeCompanyId: COMPANY, name: "Mixed Revision Co",
    releaseTakeoverEnabled: true, onshapeReleaseWorkflowId: "mock-workflow",
  });
  const entId = String(ent._id);

  const approver: any = await User.create({
    email: "approver@mockenterprise.test", passwordHash: "x",
    name: "Ann Approver", role: "approver", enterpriseId: ent._id,
  });

  await MockPropertyDef.insertMany(PROPS.map((p) => ({ ...p, companyId: COMPANY })));
  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Gearbox",
    elementId: CHANGED, elementName: "Housing", elementType: "PARTSTUDIO",
    partId: "JHD", configuration: "default", properties: { "p-name": "Housing" },
  });
  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Gearbox",
    elementId: UNCHANGED, elementName: "Shaft", elementType: "PARTSTUDIO",
    partId: "JHE", configuration: "default", properties: { "p-name": "Shaft" },
  });

  const client = new MockOnshapeClient(COMPANY, {
    id: "mock-user-1", email: "designer@mockenterprise.test", name: "Des Designer",
  });
  await discoverProperties(client, entId, COMPANY);

  const pkg = await client.createReleasePackage("mock-workflow", {
    items: [
      { documentId: DOC, elementId: CHANGED, partId: "JHD" },
      { documentId: DOC, elementId: UNCHANGED, partId: "JHE" },
    ],
  });
  const takeover = await takeOverReleasePackage(entId, pkg.id, { client });

  const changedPart: any = await Part.findOne({ enterpriseId: entId, elementId: CHANGED });
  const unchangedPart: any = await Part.findOne({ enterpriseId: entId, elementId: UNCHANGED });
  check("both parts were brought in", !!changedPart && !!unchangedPart);

  // Both were already released once, at different letters — exactly what a
  // real re-release finds waiting.
  changedPart.revision = "A";
  changedPart.lifecycleState = "In Work";
  await changedPart.save();
  unchangedPart.revision = "C";
  unchangedPart.starCount = 2; // C**, an off-cycle change since it was last actually revised
  unchangedPart.lifecycleState = "In Work";
  await unchangedPart.save();

  const changedItemId = pkg.items.find((i) => i.elementId === CHANGED)?.id;
  const unchangedItemId = pkg.items.find((i) => i.elementId === UNCHANGED)?.id;
  check("both release-package item ids are known", !!changedItemId && !!unchangedItemId);

  console.log("\nOne item is revved, its sibling in the same package is not");

  const origGetReleasePackage = MockOnshapeClient.prototype.getReleasePackage;
  MockOnshapeClient.prototype.getReleasePackage = async function (this: any, rpid: string) {
    const p = await origGetReleasePackage.call(this, rpid);
    for (const it of p.items) {
      if (it.id === changedItemId) (it as any).revision = "B";       // actually changed: A -> B
      else if (it.id === unchangedItemId) (it as any).revision = "C"; // untouched: stays C
    }
    return p;
  };

  let decision: any;
  try {
    decision = await decideRelease(String(takeover.releaseId), {
      intent: "approve", userId: String(approver._id), email: approver.email,
    });
  } finally {
    MockOnshapeClient.prototype.getReleasePackage = origGetReleasePackage;
  }

  check("the decision succeeds", decision.ok, decision.transitionError ?? decision.message);

  const afterChanged: any = await Part.findById(changedPart._id).lean();
  const afterUnchanged: any = await Part.findById(unchangedPart._id).lean();

  check("the changed part moved to the revision Onshape actually assigned",
    afterChanged.revision === "B", afterChanged.revision);
  check("the unchanged part kept exactly the revision Onshape reported — not bumped, not reset",
    afterUnchanged.revision === "C", afterUnchanged.revision);
  check("PLM invented neither letter — both came straight from the release package's own items",
    afterChanged.revision !== "A" && afterUnchanged.revision !== "D");

  const rel: any = await Release.findById(takeover.releaseId).lean();
  const changedItem = rel.items.find((i: any) => String(i.partId) === String(changedPart._id));
  const unchangedItem = rel.items.find((i: any) => String(i.partId) === String(unchangedPart._id));
  check("the release's own record agrees for the changed item",
    changedItem?.revision === "B", JSON.stringify(changedItem));
  check("and for the unchanged one",
    unchangedItem?.revision === "C", JSON.stringify(unchangedItem));

  check("both ended up Released regardless of whether their letter moved",
    afterChanged.lifecycleState === "Released" && afterUnchanged.lifecycleState === "Released",
    `${afterChanged.lifecycleState} / ${afterUnchanged.lifecycleState}`);

  for (const M of [User, AttributeDefinition, Part, PartIteration, Release, ActivityLog]) {
    await (M as any).deleteMany({ enterpriseId: entId });
  }
  for (const M of [MockOnshapePart, MockPropertyDef, MockReleasePackage]) {
    await (M as any).deleteMany({ companyId: COMPANY });
  }
  await Enterprise.deleteOne({ _id: ent._id });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
