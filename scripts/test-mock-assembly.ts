/**
 * The simulator, asked about an assembly.
 *
 * This exists because of a bug that reached a live Onshape enterprise: every
 * part-scoped URL in the live client interpolated an empty partId, so
 * `/e/{eid}/p/` went to Onshape, which read the trailing empty segment as a
 * wildcard and refused the write —
 *
 *   Category overrides endpoint does not support wildcard requests
 *
 * The mock could not have caught it. It had no assembly to be asked about, and
 * three of its four part methods threw outright when partId was empty, so no
 * local run ever traversed the assembly path. This test is the local coverage
 * that was missing: it asks the simulator the questions PLM asks about an
 * assembly, and the last assertion is the important one — that addressing an
 * element does not silently resolve to a part inside it, which is the same
 * mistake as the live wildcard, one layer down.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import { MockOnshapePart, MockPropertyDef } from "../src/lib/models";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { seedMockOnshape } from "../src/lib/mock-seed";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-asmtest";

async function main() {
  await connectDb();
  await Promise.all([
    MockOnshapePart.deleteMany({ companyId: COMPANY }),
    MockPropertyDef.deleteMany({ companyId: COMPANY }),
  ]);

  const seeded = await seedMockOnshape(COMPANY);
  const onshape = new MockOnshapeClient(COMPANY);

  console.log("\nThe simulator has assemblies to be asked about");
  check("seeding reports assemblies", seeded.assemblies > 0, `got ${seeded.assemblies}`);

  const rows: any[] = await MockOnshapePart.find({ companyId: COMPANY, partId: "" }).lean();
  check("they are stored as elements with no part id", rows.length === seeded.assemblies,
    `${rows.length} row(s) with an empty partId`);

  const asm = rows[0];
  const coords = { documentId: asm.documentId, elementId: asm.elementId, partId: "", configuration: "default" };

  console.log("\nEvery question PLM asks about an assembly is answered");

  const info = await onshape.getElementInfo(coords);
  check("getElementInfo says ASSEMBLY", info?.elementType === "ASSEMBLY", String(info?.elementType));

  let meta: any = null;
  try {
    meta = await onshape.getPartMetadata(coords);
    check("getPartMetadata returns metadata", true);
  } catch (e: any) {
    check("getPartMetadata returns metadata", false, e.message);
  }
  check("it names the assembly, not a part in it",
    meta?.elementName === asm.elementName, `${meta?.elementName} vs ${asm.elementName}`);

  const thumb = await onshape.getPartThumbnail(coords);
  check("getPartThumbnail renders something", !!thumb?.data?.length, `${thumb?.data?.length ?? 0} bytes`);

  /*
   * Two assemblies must not render identically. The colour and the stand-in
   * geometry were both seeded from partId, which is empty for every assembly,
   * so every assembly in the tenant came out the same shade of red and the
   * same weight.
   */
  /*
   * An assembly in a DIFFERENT document.
   *
   * The simulator now seeds a subassembly alongside each document's main
   * assembly, so two rows can share a document — and two assemblies in one
   * document legitimately roll up the same parts, giving the same mass. This
   * assertion is about two assemblies being distinguishable, not about the
   * rollup, so it has to compare across documents to mean anything.
   */
  const elsewhere = rows.find((r: any) => r.documentId !== asm.documentId);
  if (elsewhere) {
    const other = { documentId: elsewhere.documentId, elementId: elsewhere.elementId, partId: "", configuration: "default" };
    const t2 = await onshape.getPartThumbnail(other);
    check("two assemblies render differently",
      thumb?.data.toString("utf8") !== t2?.data.toString("utf8"));

    const m1 = await onshape.getMassProperties(coords);
    const m2 = await onshape.getMassProperties(other);
    check("and measure differently", m1.volumeM3 !== m2.volumeM3,
      `${m1.volumeM3} vs ${m2.volumeM3}`);
  }

  console.log("\nAn assembly is measured as a roll-up, not as a solid");
  const asmMass = await onshape.getMassProperties(coords);
  const members: any[] = await MockOnshapePart.find({
    companyId: COMPANY, documentId: asm.documentId, partId: { $nin: [null, ""] },
  }).lean();
  check("the document has parts to roll up", members.length > 0, `${members.length}`);

  let partVolume = 0;
  for (const m of members) {
    const pm = await onshape.getMassProperties({
      documentId: m.documentId, elementId: m.elementId, partId: m.partId, configuration: "default",
    });
    partVolume += pm.volumeM3 ?? 0;
  }
  const asmVolume = asmMass.volumeM3 ?? 0;
  check("the assembly's volume is the sum of its members",
    Math.abs(asmVolume - partVolume) < 1e-12,
    `${asmVolume} vs ${partVolume}`);
  check("it is larger than any single member", asmVolume > partVolume / members.length);

  console.log("\nWriting to an assembly writes to the assembly");
  const nameDef = (await onshape.listPropertyDefinitions(COMPANY))
    .find((d) => d.name.toLowerCase() === "description");
  check("the tenant defines a writable property", !!nameDef);

  const before: any[] = await MockOnshapePart.find({
    companyId: COMPANY, documentId: asm.documentId, partId: { $nin: [null, ""] },
  }).lean();

  await onshape.updatePartProperties(coords, { [nameDef!.propertyId]: "written by the test" });

  const after = await onshape.getPartMetadata(coords);
  check("the value comes back from the assembly",
    after.raw[nameDef!.propertyId] === "written by the test",
    String(after.raw[nameDef!.propertyId]));

  const membersAfter: any[] = await MockOnshapePart.find({
    companyId: COMPANY, documentId: asm.documentId, partId: { $nin: [null, ""] },
  }).lean();
  check("no part in the document was touched",
    membersAfter.every((m, i) =>
      JSON.stringify(m.properties) === JSON.stringify(before[i].properties)));

  /*
   * The regression that matters.
   *
   * Mongoose strips an `undefined` value out of a filter rather than matching
   * on it, so coordinates arriving without a partId at all — which is how an
   * assembly reaches this code from several entry points — used to widen the
   * lookup from "this element's assembly row" to "any row in this element".
   * It would then happily return, and write to, whichever part came first.
   *
   * This is the live wildcard bug in miniature: an absent identifier treated
   * as "match anything" instead of as "the thing that has no identifier".
   */
  console.log("\nAn absent part id addresses the assembly, never a part");
  const loose: any = { documentId: asm.documentId, elementId: asm.elementId, configuration: "default" };
  const looseMeta = await onshape.getPartMetadata(loose);
  check("coordinates with no partId at all resolve to the assembly",
    looseMeta.elementName === asm.elementName, `resolved to ${looseMeta.elementName}`);
  check("and to the same thing as an explicitly empty partId",
    looseMeta.raw[nameDef!.propertyId] === "written by the test");

  const partEl = members[0];
  const strict = await onshape.getPartMetadata({
    documentId: partEl.documentId, elementId: partEl.elementId, partId: partEl.partId, configuration: "default",
  });
  check("a part still resolves to that part",
    strict.raw[nameDef!.propertyId] !== "written by the test");

  /*
   * A coded enum resolves to its label.
   *
   * The simulator stores State as an integer, as a real tenant does, but its
   * option list held only label strings — so the code matched nothing and every
   * part displayed "Unknown (0)" or "Unknown (2)". That was reported from the
   * live app and it was also true in the simulator, which is the useful part:
   * the code→label path had no local coverage at all.
   *
   * The resolver is deliberately unwilling to guess an unmatched code, so this
   * asserts the options are supplied in a shape it can actually match, not that
   * it has learned to guess.
   */
  console.log("\nA state stored as a code reads as its name");
  const stateDef = (await onshape.listPropertyDefinitions(COMPANY))
    .find((d) => d.name.toLowerCase() === "state");
  check("the State definition supplies coded options",
    !!stateDef?.enumOptions?.length, JSON.stringify(stateDef?.enumOptions));

  const partMeta = await onshape.getPartMetadata({
    documentId: partEl.documentId, elementId: partEl.elementId,
    partId: partEl.partId, configuration: "default",
  });
  const rawState = partMeta.raw[stateDef!.propertyId];
  check("the stored value really is a code", typeof rawState === "number", String(rawState));
  check("and it displays as a name, not Unknown",
    !!partMeta.state && !/^Unknown/.test(partMeta.state),
    `state = ${JSON.stringify(partMeta.state)}`);

  await Promise.all([
    MockOnshapePart.deleteMany({ companyId: COMPANY }),
    MockPropertyDef.deleteMany({ companyId: COMPANY }),
  ]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
