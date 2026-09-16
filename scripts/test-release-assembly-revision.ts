/**
 * An assembly's own revision, when the release package does not report it.
 *
 * Reported live: releasing an assembly left its child parts correctly at
 * revision A, but the assembly itself stayed lifecycleState Released with no
 * revision at all ("–.N") — Onshape's release-package item for the assembly
 * simply did not carry a `revision` the way an ordinary part's item does.
 *
 * `decideRelease` now falls back to asking the object's own metadata for its
 * revision — the same source an ordinary sync already trusts — rather than
 * leaving a released part looking unreleased. This reproduces the exact
 * asymmetry by monkey-patching the mock client, the same technique already
 * used for a genuinely hard-to-reach race in test-sync-retry.ts: real Onshape
 * traffic is not available to prove the shape any other way.
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

const COMPANY = "mock-company-asm-revision";
const DOC = "d1a2b3c4d5e6f70819202122";
const ASM = "e1a2b3c4d5e6f70819202124";

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
    onshapeCompanyId: COMPANY, name: "Asm Revision Co",
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
    elementId: ASM, elementName: "Gearbox Assembly", elementType: "ASSEMBLY",
    partId: "", configuration: "default",
    properties: { "p-name": "Gearbox Assembly" },
  });

  const client = new MockOnshapeClient(COMPANY, {
    id: "mock-user-1", email: "designer@mockenterprise.test", name: "Des Designer",
  });
  await discoverProperties(client, entId, COMPANY);

  const pkg = await client.createReleasePackage("mock-workflow", {
    items: [{ documentId: DOC, elementId: ASM, partId: "" }],
  });
  const takeover = await takeOverReleasePackage(entId, pkg.id, { client });
  const asm: any = await Part.findOne({ enterpriseId: entId, kind: "assembly" });
  check("the assembly was brought in", !!asm, JSON.stringify(takeover));

  const asmItemId = pkg.items.find((i) => i.elementType === "ASSEMBLY")?.id;
  check("its release-package item id is known", !!asmItemId, JSON.stringify(pkg.items));

  console.log("\nOnshape's release package omits the assembly's own revision");

  // The exact asymmetry reported live: every OTHER field updates correctly —
  // state moves to RELEASED, versionId is set — but this one item's
  // `revision` stays blank where a part's does not.
  const origGetReleasePackage = MockOnshapeClient.prototype.getReleasePackage;
  MockOnshapeClient.prototype.getReleasePackage = async function (this: any, rpid: string) {
    const p = await origGetReleasePackage.call(this, rpid);
    for (const it of p.items) if (it.id === asmItemId) (it as any).revision = "";
    return p;
  };

  // What the assembly's OWN metadata says regardless — the fallback source,
  // proven already-reliable for an ordinary sync (see sync.ts's meta.revision).
  const origGetPartMetadata = MockOnshapeClient.prototype.getPartMetadata;
  MockOnshapeClient.prototype.getPartMetadata = async function (this: any, coords: any) {
    const meta = await origGetPartMetadata.call(this, coords);
    if (coords.documentId === DOC && coords.elementId === ASM) {
      return { ...meta, revision: "A" };
    }
    return meta;
  };

  const origWarn = console.log;
  const logs: string[] = [];
  console.log = (...args: any[]) => { logs.push(args.join(" ")); origWarn(...args); };

  let decision: any;
  try {
    decision = await decideRelease(String(takeover.releaseId), {
      intent: "approve", userId: String(approver._id), email: approver.email,
    });
  } finally {
    MockOnshapeClient.prototype.getReleasePackage = origGetReleasePackage;
    MockOnshapeClient.prototype.getPartMetadata = origGetPartMetadata;
    console.log = origWarn;
  }

  check("the decision still succeeds", decision.ok, decision.transitionError ?? decision.message);

  const after: any = await Part.findById(asm._id).lean();
  check("the assembly is Released", after.lifecycleState === "Released", after.lifecycleState);
  check("and carries the revision read from its own metadata, not left blank",
    after.revision === "A", `"${after.revision}"`);

  const rel: any = await Release.findById(takeover.releaseId).lean();
  const item = rel.items.find((i: any) => String(i.partId) === String(asm._id));
  check("the release's own record of the item was corrected too",
    item?.revision === "A", JSON.stringify(item));

  check("the fallback was logged",
    logs.some((l) => /revision was blank on the release package item/.test(l)),
    JSON.stringify(logs));

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
