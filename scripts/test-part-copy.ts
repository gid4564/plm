/**
 * Copying a part, entirely inside PLM.
 *
 * The rules worth pinning down: the copy gets a new number but the same
 * attributes and product; it keeps no Onshape link at all, even though the
 * schema still needs *something* non-empty in documentId/elementId; it
 * starts unreleased regardless of what the source was; and — the point of
 * the feature — once copied, it can be swapped into a BOM in place of the
 * original via a star release, which is what makes a supplier renumbering
 * actually completable without going anywhere near Onshape.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";

import { connectDb } from "../src/lib/db";
import { ActivityLog, BomLink, Enterprise, Part, PartIteration } from "../src/lib/models";
import { copyPart } from "../src/lib/part-copy";
import { registerStarRelease } from "../src/lib/star-release";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-part-copy";

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [Part, BomLink, PartIteration, ActivityLog]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Part Copy Co" });
  const eid = String(ent._id);

  const source: any = await Part.create({
    enterpriseId: ent._id, documentId: "d1", elementId: "e1", partId: "P1",
    configuration: "default", workspaceId: "w1", versionId: null,
    documentName: "Gearbox", elementName: "Housing Part Studio",
    kind: "part", number: "PN-001", name: "Hex Bolt (Supplier A)",
    productId: null, productName: "Gearbox Assy",
    attributes: { material: "Steel", classification: "Buy", vendor: "Supplier A" },
    lifecycleState: "Released", revision: "C", starCount: 2, iteration: 5,
  });

  console.log("\nCopying carries attributes forward and starts fresh otherwise");
  const actor = { userId: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "eng@test" };
  const result = await copyPart(eid, actor, String(source._id));
  const copy: any = await Part.findById(result.id).lean();

  check("a new part exists", !!copy);
  check("with a different number", copy.number !== source.number && copy.number === result.number,
    `${source.number} vs ${copy.number}`);
  check("the same kind", copy.kind === "part", copy.kind);
  check("the same name", copy.name === "Hex Bolt (Supplier A)", copy.name);
  check("the same attributes", JSON.stringify(copy.attributes) === JSON.stringify(source.attributes),
    JSON.stringify(copy.attributes));
  check("the same product filing", copy.productName === "Gearbox Assy", copy.productName);

  check("marked plmOnly", copy.plmOnly === true);
  check("no real Onshape document id", copy.documentId !== "d1", copy.documentId);
  check("no real Onshape element id", copy.elementId !== "e1", copy.elementId);
  check("no partId, workspace or version", !copy.partId && !copy.workspaceId && !copy.versionId,
    JSON.stringify({ partId: copy.partId, workspaceId: copy.workspaceId, versionId: copy.versionId }));

  check("starts In Work regardless of the source's state",
    copy.lifecycleState === "In Work", copy.lifecycleState);
  check("no revision carried over", copy.revision === "", `"${copy.revision}"`);
  check("no star count carried over", copy.starCount === 0, String(copy.starCount));
  check("iteration starts at 1", copy.iteration === 1, String(copy.iteration));
  check("write-back is blocked, with a reason", typeof copy.writeBackBlocked === "string" && copy.writeBackBlocked.length > 0);

  const iter: any = await PartIteration.findOne({ partId: copy._id, cause: "copy" }).lean();
  check("a 'copy' iteration was snapshotted", !!iter);

  const log: any = await ActivityLog.findOne({ partId: copy._id, action: "created" }).lean();
  check("the copy is in the activity log", !!log && /copied/i.test(log.message ?? ""), log?.message);

  console.log("\nCopying the same part again gets its own, still-unique identity");
  const second = await copyPart(eid, actor, String(source._id));
  const copy2: any = await Part.findById(second.id).lean();
  check("a different number from the first copy", second.number !== result.number,
    `${result.number} vs ${second.number}`);
  check("a different synthetic element id, so the unique index never collides",
    copy2.elementId !== copy.elementId, `${copy.elementId} vs ${copy2.elementId}`);

  console.log("\nCopying an unknown part is refused, not silently accepted");
  let threw = "";
  try {
    await copyPart(eid, actor, "000000000000000000000000");
  } catch (e: any) { threw = String(e?.message ?? e); }
  check("refused", /not found/i.test(threw), threw);

  console.log("\nThe copy completes a star-release swap — the actual point of the feature");
  {
    const asm: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "eAsm", partId: "",
      kind: "assembly", number: "PN-100", name: "Actuator Assembly",
      lifecycleState: "Released", revision: "A",
    });
    const link: any = await BomLink.create({
      enterpriseId: ent._id, parentId: asm._id, childId: source._id, quantity: 4, findNumber: "12",
    });

    const swapResult = await registerStarRelease(eid, { email: "eng@test" }, String(asm._id), {
      reason: "Supplier A discontinued; swapping to the PLM-only copy pending a new source.",
      swap: { bomLinkId: String(link._id), newPartId: String(copy._id) },
    });

    check("the swap succeeds using the copy as the replacement part",
      swapResult.swap?.toPartId === String(copy._id), JSON.stringify(swapResult.swap));

    const newLink: any = await BomLink.findOne({
      enterpriseId: ent._id, parentId: asm._id, childId: copy._id,
    }).lean();
    check("the assembly's BOM now contains the copy", !!newLink);
    check("quantity carried over to the copy's own link",
      newLink?.quantity === 4, String(newLink?.quantity));
  }

  for (const M of [Part, BomLink, PartIteration, ActivityLog]) {
    await (M as any).deleteMany({ enterpriseId: eid });
  }
  await Enterprise.deleteOne({ _id: ent._id });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
