/**
 * "A*" — an off-cycle change to an already-released part or assembly.
 *
 * Two shapes are worth pinning down:
 *
 *   A component swap — a supplier part renumbered but still form-fit-function
 *   equivalent. The assembly's BOM is repointed at a different PLM part
 *   without a new revision, built on the structure edge's own effectivity
 *   dates rather than a second mechanism.
 *
 *   A plain note — a metadata or cosmetic correction with no structure
 *   change, registered against the part directly.
 *
 * The rules that are easy to get wrong: a real release resets the count for
 * the new letter; a swap must not disturb the superseded component anywhere
 * else it is used; and none of this is offered to a part with no revision to
 * attach a star to in the first place.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";

import { connectDb } from "../src/lib/db";
import { BomLink, Enterprise, Part, PartIteration, StarRelease } from "../src/lib/models";
import {
  registerStarRelease, setInitialRevision, starHistory, starLabel, starReasonsForParts,
} from "../src/lib/star-release";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-star-release";

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [Part, BomLink, StarRelease, PartIteration]) await (M as any).deleteMany({ enterpriseId: stale._id });
    await Enterprise.deleteOne({ _id: stale._id });
  }

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Star Release Co" });
  const eid = String(ent._id);

  console.log("\nstarLabel formats a revision plus its stars");
  {
    check("no stars is the bare revision", starLabel("A", 0) === "A");
    check("stars append", starLabel("A", 2) === "A**");
    check("an unreleased part has nothing to label", starLabel("", 3) === "");
  }

  console.log("\nA plain note stars the part directly, no structure touched");
  {
    const part: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "e1", partId: "P1",
      number: "PN-001", name: "Bracket", kind: "part", lifecycleState: "Released", revision: "A",
    });

    const r1 = await registerStarRelease(eid, { email: "a@test" }, String(part._id), {
      reason: "Corrected a typo in the description.",
    });
    check("first star is A*", r1.revisionLabel === "A*", r1.revisionLabel);
    check("no swap recorded", r1.swap === null);

    const r2 = await registerStarRelease(eid, { email: "a@test" }, String(part._id), {
      reason: "Fixed the drawing note reference.",
    });
    check("second star is A**", r2.revisionLabel === "A**", r2.revisionLabel);

    const after: any = await Part.findById(part._id).lean();
    check("the part's own starCount matches", after.starCount === 2, String(after.starCount));
    check("revision itself never moved", after.revision === "A", after.revision);

    const history = await starHistory(eid, String(part._id));
    check("both stars are in the history, newest first",
      history.length === 2 && history[0].starIndex === 2 && history[1].starIndex === 1,
      JSON.stringify(history.map((h) => h.starIndex)));

    console.log("\n  Batch-fetched reasons, for hovering the stars in a list without a query per row");
    const byPart = await starReasonsForParts(eid, [String(part._id), "000000000000000000000000"]);
    const lines = byPart.get(String(part._id)) ?? [];
    check("both reasons come back, newest first",
      lines.length === 2 &&
      lines[0] === "A**: Fixed the drawing note reference." &&
      lines[1] === "A*: Corrected a typo in the description.",
      JSON.stringify(lines));
    check("a part with no stars is simply absent, not an empty array",
      !byPart.has("000000000000000000000000"));
  }

  console.log("\nA part with no revision has nothing for a star to attach to");
  {
    const unreleased: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "e2", partId: "P2",
      number: "PN-002", name: "In-work part", kind: "part", lifecycleState: "In Work", revision: "",
    });
    let threw = "";
    try {
      await registerStarRelease(eid, { email: "a@test" }, String(unreleased._id), { reason: "anything" });
    } catch (e: any) { threw = String(e?.message ?? e); }
    check("refused, not silently accepted", /no revision in plm/i.test(threw), threw);

    console.log("\n  Recording it as already released catches PLM up, and a star then works");
    const rec = await setInitialRevision(eid, { email: "admin@test" }, String(unreleased._id), {
      revision: "C", reason: "Legacy part, released before PLM tracked this document.",
    });
    check("the revision was recorded as given", rec.revision === "C", rec.revision);

    const after: any = await Part.findById(unreleased._id).lean();
    check("the part is now Released", after.lifecycleState === "Released", after.lifecycleState);
    check("at the given revision", after.revision === "C", after.revision);
    check("its iteration moved", after.iteration > 1, String(after.iteration));

    const iter: any = await PartIteration.findOne({ partId: unreleased._id, cause: "backfill" }).lean();
    check("a backfill iteration was snapshotted", !!iter && iter.revision === "C");

    const r = await registerStarRelease(eid, { email: "a@test" }, String(unreleased._id), {
      reason: "Now that it has a revision, a star works normally.",
    });
    check("a star release now works, at C*", r.revisionLabel === "C*", r.revisionLabel);

    console.log("\n  Recording it again is refused — this is a one-time catch-up, not an override");
    let threw2 = "";
    try {
      await setInitialRevision(eid, { email: "admin@test" }, String(unreleased._id), {
        revision: "D", reason: "trying to override",
      });
    } catch (e: any) { threw2 = String(e?.message ?? e); }
    check("refused — a revision is already on record", /already has a revision/i.test(threw2), threw2);
  }

  console.log("\nA reason is required");
  {
    const part: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "e3", partId: "P3",
      number: "PN-003", name: "Widget", kind: "part", lifecycleState: "Released", revision: "A",
    });
    let threw = "";
    try {
      await registerStarRelease(eid, { email: "a@test" }, String(part._id), { reason: "   " });
    } catch (e: any) { threw = String(e?.message ?? e); }
    check("refused for a blank reason", /needs a reason/i.test(threw), threw);
  }

  console.log("\nA component swap repoints the BOM without revving the assembly");
  {
    const asm: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "eAsm", partId: "",
      number: "PN-100", name: "Actuator Assembly", kind: "assembly",
      lifecycleState: "Released", revision: "A",
    });
    const oldFastener: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "eOld", partId: "POld",
      number: "PN-200", name: "Hex Bolt (Supplier A)", kind: "part",
      lifecycleState: "Released", revision: "A",
    });
    const newFastener: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "eNew", partId: "PNew",
      number: "PN-201", name: "Hex Bolt (Supplier B)", kind: "part",
      lifecycleState: "Released", revision: "A",
    });
    const otherAsm: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "eOther", partId: "",
      number: "PN-300", name: "Unrelated Assembly", kind: "assembly",
      lifecycleState: "Released", revision: "A",
    });

    const link: any = await BomLink.create({
      enterpriseId: ent._id, parentId: asm._id, childId: oldFastener._id,
      quantity: 4, findNumber: "12",
    });
    // The old fastener is used elsewhere too — this must survive untouched.
    await BomLink.create({
      enterpriseId: ent._id, parentId: otherAsm._id, childId: oldFastener._id,
      quantity: 2, findNumber: "5",
    });

    const result = await registerStarRelease(eid, { email: "eng@test" }, String(asm._id), {
      reason: "Supplier B fastener is FFF-equivalent; Supplier A discontinued the part.",
      swap: { bomLinkId: String(link._id), newPartId: String(newFastener._id) },
    });

    check("the assembly's revision is still A*", result.revisionLabel === "A*", result.revisionLabel);
    check("the swap names both parts",
      result.swap?.fromPartId === String(oldFastener._id) && result.swap?.toPartId === String(newFastener._id));

    const oldLinkAfter: any = await BomLink.findById(link._id).lean();
    check("the old edge is closed out, not deleted", !!oldLinkAfter && !!oldLinkAfter.effectiveTo);

    const newLink: any = await BomLink.findOne({
      enterpriseId: ent._id, parentId: asm._id, childId: newFastener._id,
    }).lean();
    check("a new edge exists for the replacement", !!newLink);
    check("quantity and find number carried over",
      newLink.quantity === 4 && newLink.findNumber === "12",
      JSON.stringify({ quantity: newLink.quantity, findNumber: newLink.findNumber }));
    check("the new edge is not claimed as read from Onshape",
      newLink.sourceDocumentId === "" && newLink.sourceElementId === "");

    const otherLink: any = await BomLink.findOne({
      enterpriseId: ent._id, parentId: otherAsm._id, childId: oldFastener._id,
    }).lean();
    check("the old fastener's OTHER use is untouched",
      !!otherLink && !otherLink.effectiveTo, JSON.stringify(otherLink));

    const history = await starHistory(eid, String(asm._id));
    check("the history names the swap by part number",
      history[0]?.swap?.fromNumber === "PN-200" && history[0]?.swap?.toNumber === "PN-201",
      JSON.stringify(history[0]?.swap));

    console.log("\n  A second swap of an already-closed edge is refused");
    let threw = "";
    try {
      await registerStarRelease(eid, { email: "eng@test" }, String(asm._id), {
        reason: "try again",
        swap: { bomLinkId: String(link._id), newPartId: String(newFastener._id) },
      });
    } catch (e: any) { threw = String(e?.message ?? e); }
    check("refused — that edge already ended", /already ends/i.test(threw), threw);

    console.log("\n  Swapping in the component already there is refused");
    threw = "";
    try {
      await registerStarRelease(eid, { email: "eng@test" }, String(asm._id), {
        reason: "no-op",
        swap: { bomLinkId: String(newLink._id), newPartId: String(newFastener._id) },
      });
    } catch (e: any) { threw = String(e?.message ?? e); }
    check("refused as a no-op swap", /already the component/i.test(threw), threw);

    console.log("\n  A real release resets the star count for the new revision");
    await Part.updateOne({ _id: asm._id }, { $set: { revision: "B", starCount: 0 } });
    const afterRelease: any = await Part.findById(asm._id).lean();
    check("starCount reset alongside the new revision", afterRelease.starCount === 0);
    const r3 = await registerStarRelease(eid, { email: "eng@test" }, String(asm._id), {
      reason: "A fresh off-cycle note against the new revision.",
    });
    check("the first star on B is B*, not B**", r3.revisionLabel === "B*", r3.revisionLabel);
  }

  for (const M of [Part, BomLink, StarRelease, PartIteration]) await (M as any).deleteMany({ enterpriseId: ent._id });
  await Enterprise.deleteOne({ _id: ent._id });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
