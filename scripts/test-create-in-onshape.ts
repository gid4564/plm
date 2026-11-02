/**
 * A part created in PLM from a file, then created in Onshape.
 *
 * What is worth pinning down: a new PLM part starts PLM-only with a number;
 * "Create in Onshape" makes a document, imports the CAD file, and links the
 * part to the body it produced; PLM's name and number land on that body
 * rather than the file's own names; mapped attributes are written through
 * the mapping table; other attachments go to the document as file tabs;
 * a file with several bodies waits for a person to choose rather than
 * guessing; and a failed attempt's document is reused on retry, not made
 * twice.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, Enterprise, MockOnshapePart, MockPropertyDef, Part, PartIteration, Product,
} from "../src/lib/models";
import { seedAttributeDefinitions } from "../src/lib/attributes";
import { MOCK_PROPS } from "../src/lib/mock-seed";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import {
  addAttachment, assignBodies, cancelPlan, confirmPlan, createPlmPart, readAttachment, removeAttachment,
  startCreateInOnshape,
} from "../src/lib/onshape-create";
import { knownNumberFor } from "../src/lib/numbering";
import type { UploadFile } from "../src/lib/onshape/types";
import { stepFixture } from "./step-fixture";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-create-in-onshape";
const actor = { userId: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "eng@test" };

/** A STEP file of loose parts, one solid each. */
const stepFile = (names: string[]) => stepFixture(names.map((name) => ({ name, solids: 1 })));

/** A real Parasolid text transmit file starts with this line. */
const PARASOLID_HEADER = "**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**************************\n";

/** Onshape naming every imported body "Part n", as it does for unnamed solids. */
class GenericNamesClient extends MockOnshapeClient {
  async listElementParts(c: any) {
    return (await super.listElementParts(c)).map((p, i) => ({ ...p, name: `Part ${i + 1}` }));
  }
}

/** A non-STEP file whose import makes several parts — read only after importing. */
class MultiPartParasolidClient extends MockOnshapeClient {
  async importFile(coords: { documentId: string; workspaceId: string }, file: UploadFile) {
    return super.importFile(coords, {
      ...file, filename: "x.step",
      data: stepFixture([{ name: "Lid", solids: 1 }, { name: "Base", solids: 1 }, { name: "Screw", solids: 1 }]),
    });
  }
}

const bodyProps = async (documentId: string) =>
  (await MockOnshapePart.find({ companyId: COMPANY, documentId }).sort({ partId: 1 }).lean()) as any[];

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [Part, PartIteration, ActivityLog, AttributeDefinition, Product]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }
  await MockOnshapePart.deleteMany({ companyId: COMPANY });
  await MockPropertyDef.deleteMany({ companyId: COMPANY });

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Create In Onshape Co" });
  const eid = String(ent._id);
  await seedAttributeDefinitions(eid);
  for (const d of Object.values(MOCK_PROPS)) {
    await MockPropertyDef.create({ companyId: COMPANY, ...d });
  }
  // Supplier is PLM-authoritative and sent to Onshape's Vendor — the mapping
  // the write is expected to follow. Bound by id, as a sync would have bound it.
  await AttributeDefinition.updateOne(
    { enterpriseId: eid, objectType: "PART", key: "supplier" },
    { $set: { onshapePropertyId: MOCK_PROPS.vendor.propertyId, onshapePropertyName: "Vendor" } }
  );
  await AttributeDefinition.updateOne(
    { enterpriseId: eid, objectType: "PART", key: "number" },
    { $set: { onshapePropertyId: MOCK_PROPS.partNumber.propertyId } }
  );

  const client = new MockOnshapeClient(COMPANY);

  /* ---------------------------------------------------------------------- */
  console.log("\nA new part starts in PLM only");
  const created = await createPlmPart(eid, actor, { name: "Mounting Bracket" });
  let part: any = await Part.findById(created.id).lean();
  check("it exists with a number", !!part?.number && part.number === created.number, part?.number);
  check("it is PLM-only", part.plmOnly === true);
  check("it is In Work", part.lifecycleState === "In Work", part.lifecycleState);
  check("it is filed to Unassigned", part.productName === "Unassigned", part.productName);
  check("its attributes carry its number and name, as a synced part's do",
    part.attributes?.number === part.number && part.attributes?.name === "Mounting Bracket",
    JSON.stringify(part.attributes));
  check("and the schema's defaults", part.attributes?.unitOfMeasure === "Each", JSON.stringify(part.attributes));

  let refused = "";
  await createPlmPart(eid, actor, { name: "   " }).catch((e) => { refused = e.message; });
  check("a blank name is refused", /name/.test(refused), refused);

  await Part.updateOne({ _id: created.id }, { $set: { "attributes.supplier": "Acme Castings" } });

  /* ---------------------------------------------------------------------- */
  console.log("\nFiles attach and read back");
  const step = await addAttachment(eid, created.id, actor, {
    filename: "bracket.step", contentType: "application/step", data: stepFile(["Supplier Bracket"]),
  });
  const pdf = await addAttachment(eid, created.id, actor, {
    filename: "spec.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4 spec"),
  });
  const back = await readAttachment(eid, created.id, step.id);
  check("the STEP reads back byte for byte", back?.data.equals(stepFile(["Supplier Bracket"])) === true);
  part = await Part.findById(created.id).lean();
  check("two attachments recorded", part.attachments.length === 2, String(part.attachments.length));

  refused = "";
  await startCreateInOnshape(eid, created.id, actor, pdf.id, { client, wait: true })
    .catch((e) => { refused = e.message; });
  check("a PDF cannot be the source of a part", /not a CAD format/.test(refused), refused);

  /* ---------------------------------------------------------------------- */
  console.log("\nCreate in Onshape, one body");
  await startCreateInOnshape(eid, created.id, actor, step.id, { client, wait: true });
  part = await Part.findById(created.id).lean();
  check("the run finished", part.onshapeCreate?.state === "done",
    `${part.onshapeCreate?.state}: ${part.onshapeCreate?.error}`);
  check("the part is no longer PLM-only", part.plmOnly === false);
  check("it points at the new document", /^mockdoc/.test(part.documentId), part.documentId);
  check("and at the imported body", part.partId === "J0D" && /^mockel/.test(part.elementId),
    `${part.elementId}/${part.partId}`);
  check("with a workspace to write to", /^mockws/.test(part.workspaceId ?? ""), part.workspaceId);
  check("the document is named after the part", part.documentName === `${part.number} Mounting Bracket`,
    part.documentName);

  const body: any = await MockOnshapePart.findOne({
    companyId: COMPANY, documentId: part.documentId, partId: "J0D",
  }).lean();
  check("Onshape's Name is PLM's name, not the file's",
    body?.properties?.[MOCK_PROPS.name.propertyId] === "Mounting Bracket",
    body?.properties?.[MOCK_PROPS.name.propertyId]);
  check("Onshape's Part number is PLM's number",
    body?.properties?.[MOCK_PROPS.partNumber.propertyId] === part.number,
    body?.properties?.[MOCK_PROPS.partNumber.propertyId]);
  check("a mapped attribute was written through the mapping",
    body?.properties?.[MOCK_PROPS.vendor.propertyId] === "Acme Castings",
    body?.properties?.[MOCK_PROPS.vendor.propertyId]);
  check("PLM's name survived the first sync", part.name === "Mounting Bracket", part.name);
  check("the first sync ran", !!part.lastSyncedFromOnshapeAt);
  check("no write is left pending", !part.pushPending, part.lastPushError);

  const stepRow = part.attachments.find((a: any) => String(a._id) === step.id);
  const pdfRow = part.attachments.find((a: any) => String(a._id) === pdf.id);
  check("the STEP is recorded as the imported tab", stepRow?.onshapeElementId === part.elementId,
    stepRow?.onshapeElementId);
  check("the PDF went to the document as a file tab", /^mockblob/.test(pdfRow?.onshapeElementId ?? ""),
    pdfRow?.onshapeElementId);

  refused = "";
  await startCreateInOnshape(eid, created.id, actor, step.id, { client, wait: true })
    .catch((e) => { refused = e.message; });
  check("it cannot be created twice", /already linked/.test(refused), refused);

  check("the generator hands back the number PLM already holds",
    (await knownNumberFor(eid, { documentId: part.documentId, elementId: part.elementId, partId: part.partId }))
      === part.number);
  check("and nothing for a part PLM does not track",
    (await knownNumberFor(eid, { documentId: part.documentId, elementId: part.elementId, partId: "ZZZ" })) === null);

  /* ---------------------------------------------------------------------- */
  console.log("\nA multi-part STEP waits for review, and nothing is created first");
  const kit = await createPlmPart(eid, actor, { name: "Frame" });
  const kitStep = await addAttachment(eid, kit.id, actor, {
    filename: "gate.step", contentType: "application/step",
    data: stepFixture([
      { name: "Gate", children: [{ product: "Frame", count: 1 }, { product: "Bolt", count: 4 }, { product: "Cap", count: 1 }] },
      { name: "Frame", solids: 1 }, { name: "Bolt", solids: 1 }, { name: "Cap", solids: 1 },
    ]),
  });
  const partsBefore = await Part.countDocuments({ enterpriseId: eid });
  const started = await startCreateInOnshape(eid, kit.id, actor, kitStep.id, { client, wait: true });
  part = await Part.findById(kit.id).lean();
  check("it stops at review", started.review && part.onshapeCreate?.state === "review", part.onshapeCreate?.state);
  check("with one entry per distinct part", part.onshapeCreate.plan.length === 3,
    part.onshapeCreate.plan.map((x: any) => x.fileName).join(","));
  const bolt = part.onshapeCreate.plan.find((x: any) => x.fileName === "Bolt");
  check("the bolt is one entry, used four times", bolt?.instances === 4, String(bolt?.instances));
  const frame = part.onshapeCreate.plan.find((x: any) => x.fileName === "Frame");
  check("this part is matched to the entry with its name", frame?.primary === true);
  check("no Onshape document yet", !part.onshapeCreate.documentId);
  check("and no PLM parts yet", (await Part.countDocuments({ enterpriseId: eid })) === partsBefore);

  refused = "";
  await confirmPlan(eid, kit.id, actor, [{ key: frame.key, include: false }], { client, wait: true })
    .catch((e) => { refused = e.message; });
  check("the part chosen as this one cannot be left out", /has to be included/.test(refused), refused);

  const cap = part.onshapeCreate.plan.find((x: any) => x.fileName === "Cap");
  const confirmed = await confirmPlan(eid, kit.id, actor, [
    { key: bolt.key, name: "M6 x 20 Bolt" },
    { key: cap.key, include: false },
  ], { client, wait: true });
  part = await Part.findById(kit.id).lean();
  check("confirming finishes the run", part.onshapeCreate?.state === "done",
    `${part.onshapeCreate?.state}: ${part.onshapeCreate?.error}`);
  check("one new PLM part, for the bolt", confirmed.created.length === 1 && confirmed.created[0].name === "M6 x 20 Bolt",
    JSON.stringify(confirmed.created));
  const boltPart: any = await Part.findById(confirmed.created[0].id).lean();
  check("the bolt has its own number", !!boltPart.number && boltPart.number !== part.number, boltPart.number);
  check("is linked into the same document", boltPart.plmOnly === false && boltPart.documentId === part.documentId);
  check("in the same Part Studio", boltPart.elementId === part.elementId);
  check("and filed with this part", String(boltPart.productId) === String(part.productId));
  check("this part keeps its own name", part.name === "Frame", part.name);

  const kitBodies = await bodyProps(part.documentId);
  const boltBodies = kitBodies.filter((b) => /^Bolt/.test(b.elementName) || b.properties?.[MOCK_PROPS.partNumber.propertyId] === boltPart.number);
  check("all four bolt bodies carry the bolt's number",
    boltBodies.length === 4 && boltBodies.every((b) => b.properties?.[MOCK_PROPS.partNumber.propertyId] === boltPart.number),
    String(boltBodies.length));
  check("and its name", boltBodies.every((b) => b.properties?.[MOCK_PROPS.name.propertyId] === "M6 x 20 Bolt"));
  const capBody = kitBodies.find((b) => b.properties?.[MOCK_PROPS.name.propertyId] === "Cap");
  check("the left-out cap stays in the document, unnumbered",
    !!capBody && !capBody.properties?.[MOCK_PROPS.partNumber.propertyId]);
  check("and is mentioned", (part.onshapeCreate.warnings ?? []).some((w: string) => /1 imported body was left/.test(w)),
    JSON.stringify(part.onshapeCreate.warnings));

  /* ---------------------------------------------------------------------- */
  console.log("\nThis part can be any of the file's parts");
  const swap = await createPlmPart(eid, actor, { name: "Clamp" });
  const swapStep = await addAttachment(eid, swap.id, actor, {
    filename: "clamp.stp", contentType: "application/step", data: stepFile(["Clamp Upper", "Clamp Lower"]),
  });
  await startCreateInOnshape(eid, swap.id, actor, swapStep.id, { client, wait: true });
  part = await Part.findById(swap.id).lean();
  const [upper, lower] = part.onshapeCreate.plan;
  check("with no name match, the first is proposed", upper.primary && !lower.primary);
  await confirmPlan(eid, swap.id, actor, [{ key: upper.key, primary: false }, { key: lower.key, primary: true }],
    { client, wait: true });
  part = await Part.findById(swap.id).lean();
  check("choosing the second links this part to it", part.onshapeCreate?.state === "done" && part.partId === "J1D",
    `${part.onshapeCreate?.state} ${part.partId} ${part.onshapeCreate?.error}`);
  const upperPart: any = await Part.findOne({ enterpriseId: eid, name: "Clamp Upper" }).lean();
  check("and the first becomes a new part under its file name", upperPart?.partId === "J0D", upperPart?.partId);

  /* ---------------------------------------------------------------------- */
  console.log("\nCancelling at review");
  const cancel = await createPlmPart(eid, actor, { name: "Hinge" });
  const cancelStep = await addAttachment(eid, cancel.id, actor, {
    filename: "hinge.step", contentType: "application/step", data: stepFile(["Leaf", "Pin"]),
  });
  await startCreateInOnshape(eid, cancel.id, actor, cancelStep.id, { client, wait: true });
  await cancelPlan(eid, cancel.id);
  part = await Part.findById(cancel.id).lean();
  check("leaves nothing planned", part.onshapeCreate?.state === "failed" && !part.onshapeCreate.plan?.length);
  const again = await startCreateInOnshape(eid, cancel.id, actor, cancelStep.id, { client, wait: true });
  check("and starting again asks again", again.review === true);

  /* ---------------------------------------------------------------------- */
  console.log("\nBodies that do not match by name are placed by hand");
  const generic = new GenericNamesClient(COMPANY);
  const odd = await createPlmPart(eid, actor, { name: "Lever" });
  const oddStep = await addAttachment(eid, odd.id, actor, {
    filename: "lever.step", contentType: "application/step", data: stepFile(["Lever", "Spring"]),
  });
  await startCreateInOnshape(eid, odd.id, actor, oddStep.id, { client: generic, wait: true });
  await confirmPlan(eid, odd.id, actor, [], { client: generic, wait: true });
  part = await Part.findById(odd.id).lean();
  check("it stops at map", part.onshapeCreate?.state === "map", `${part.onshapeCreate?.state}: ${part.onshapeCreate?.error}`);
  check("with both bodies waiting", part.onshapeCreate.unassignedBodies.length === 2);
  const [b1, b2] = part.onshapeCreate.unassignedBodies;
  const [lever, spring] = part.onshapeCreate.plan;
  await assignBodies(eid, odd.id, actor, [
    { key: lever.key, elementId: b2.elementId, partId: b2.partId },
    { key: spring.key, elementId: b1.elementId, partId: b1.partId },
  ], { client: generic, wait: true });
  part = await Part.findById(odd.id).lean();
  check("placing them finishes the run", part.onshapeCreate?.state === "done", `${part.onshapeCreate?.state}: ${part.onshapeCreate?.error}`);
  check("this part is on the body chosen for it", part.partId === b2.partId, part.partId);
  check("and its name was written over \"Part n\"", part.name === "Lever", part.name);

  /* ---------------------------------------------------------------------- */
  console.log("\nA non-STEP file with several parts is reviewed after importing");
  const multiClient = new MultiPartParasolidClient(COMPANY);
  const box = await createPlmPart(eid, actor, { name: "Base" });
  const boxFile = await addAttachment(eid, box.id, actor, {
    filename: "box.x_t", contentType: "application/octet-stream", data: Buffer.from(PARASOLID_HEADER + "**END"),
  });
  const boxStart = await startCreateInOnshape(eid, box.id, actor, boxFile.id, { client: multiClient, wait: true });
  part = await Part.findById(box.id).lean();
  check("it imports first", boxStart.review === false && !!part.onshapeCreate.documentId);
  check("then waits for review", part.onshapeCreate?.state === "review" && part.onshapeCreate.planFrom === "import",
    `${part.onshapeCreate?.state} ${part.onshapeCreate?.planFrom}`);
  check("of the three parts it made", part.onshapeCreate.plan.length === 3);
  check("this part proposed as the body with its name",
    part.onshapeCreate.plan.find((x: any) => x.primary)?.fileName === "Base");
  await confirmPlan(eid, box.id, actor, [], { client: multiClient, wait: true });
  part = await Part.findById(box.id).lean();
  check("confirming links without importing again", part.onshapeCreate?.state === "done",
    `${part.onshapeCreate?.state}: ${part.onshapeCreate?.error}`);
  check("three parts in that document", (await Part.countDocuments({ enterpriseId: eid, documentId: part.documentId })) === 3);

  /* ---------------------------------------------------------------------- */
  console.log("\nA failed import keeps its document for the retry");
  const retry = await createPlmPart(eid, actor, { name: "Spacer" });
  const bad = await addAttachment(eid, retry.id, actor, {
    filename: "spacer.x_t", contentType: "application/octet-stream", data: Buffer.from("not really parasolid"),
  });
  await startCreateInOnshape(eid, retry.id, actor, bad.id, { client, wait: true });
  part = await Part.findById(retry.id).lean();
  check("the run failed", part.onshapeCreate?.state === "failed", part.onshapeCreate?.state);
  check("saying why", /not a Parasolid/.test(part.onshapeCreate?.error ?? ""), part.onshapeCreate?.error);
  check("still PLM-only", part.plmOnly === true);
  const firstDoc = part.onshapeCreate?.documentId;
  check("the document it made is remembered", /^mockdoc/.test(firstDoc ?? ""), firstDoc);

  const good = await addAttachment(eid, retry.id, actor, {
    filename: "spacer-fixed.x_t", contentType: "application/octet-stream", data: Buffer.from(PARASOLID_HEADER + "**END"),
  });
  await startCreateInOnshape(eid, retry.id, actor, good.id, { client, wait: true });
  part = await Part.findById(retry.id).lean();
  check("the retry finished", part.onshapeCreate?.state === "done",
    `${part.onshapeCreate?.state}: ${part.onshapeCreate?.error}`);
  check("in the same document, not a second one", part.documentId === firstDoc,
    `${firstDoc} vs ${part.documentId}`);

  refused = "";
  const unreadable = await createPlmPart(eid, actor, { name: "Unreadable" });
  const junk = await addAttachment(eid, unreadable.id, actor, {
    filename: "junk.step", contentType: "application/step", data: Buffer.from("not a step file"),
  });
  await startCreateInOnshape(eid, unreadable.id, actor, junk.id, { client, wait: true })
    .catch((e) => { refused = e.message; });
  part = await Part.findById(unreadable.id).lean();
  check("an unreadable STEP is refused before anything is made",
    /could not be read/.test(refused) && !part.onshapeCreate, refused);

  /* ---------------------------------------------------------------------- */
  console.log("\nA running job is not started twice");
  const busy = await createPlmPart(eid, actor, { name: "Busy" });
  const busyStep = await addAttachment(eid, busy.id, actor, {
    filename: "busy.step", contentType: "application/step", data: stepFile(["Busy"]),
  });
  await Part.updateOne({ _id: busy.id }, { $set: { onshapeCreate: { state: "running", startedAt: new Date() } } });
  refused = "";
  await startCreateInOnshape(eid, busy.id, actor, busyStep.id, { client, wait: true })
    .catch((e) => { refused = e.message; });
  check("a second start is refused while one runs", /already being created/.test(refused), refused);

  await Part.updateOne(
    { _id: busy.id },
    { $set: { "onshapeCreate.startedAt": new Date(Date.now() - 60 * 60_000) } }
  );
  await startCreateInOnshape(eid, busy.id, actor, busyStep.id, { client, wait: true });
  part = await Part.findById(busy.id).lean();
  check("but a run abandoned an hour ago can be restarted", part.onshapeCreate?.state === "done",
    `${part.onshapeCreate?.state}: ${part.onshapeCreate?.error}`);

  /* ---------------------------------------------------------------------- */
  console.log("\nRemoving an attachment");
  await removeAttachment(eid, retry.id, actor, bad.id);
  part = await Part.findById(retry.id).lean();
  check("it leaves the part", !part.attachments.some((a: any) => String(a._id) === bad.id));
  check("and its bytes are gone", (await readAttachment(eid, retry.id, bad.id)) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
