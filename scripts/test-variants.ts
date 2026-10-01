/**
 * Named variants of one assembly's BOM — the "150%" super-BOM approach.
 *
 * The scenario this exists for: three sized configurations of the same part,
 * each its own PLM part (configuration is already part of a Part's identity),
 * sitting as three sibling BomLink edges under one assembly. Nothing in
 * Onshape says which model uses which size — that is PLM's own concept, a
 * Variant, and tagging is how one edge says "only Model A/B/C uses me."
 * Untagged is the common case and always shows, in every variant.
 *
 * This checks the whole mechanism: creating and naming variants, tagging and
 * untagging a link, the filtered view actually narrowing the BOM, the
 * unfiltered "150%" view showing everything regardless of tags, and that
 * deleting a variant untags its links rather than leaving a dangling id
 * nothing can ever filter by again.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import { BomLink, Enterprise, Part, Variant } from "../src/lib/models";
import { buildProductBom } from "../src/lib/product-bom";
import { resolveProduct } from "../src/lib/products";
import { createVariant, deleteVariant, listVariants, setLinkVariants, updateVariant } from "../src/lib/variants";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  await connectDb();
  // Waits for the brand-new collection's unique index to actually be built —
  // see instrumentation-node.ts's own comment on why this race is real.
  await Variant.init();

  const ent: any = await Enterprise.create({
    name: "Variant Test Co", onshapeCompanyId: "mock-company-variants",
  });
  const eid = String(ent._id);
  const prod = (await resolveProduct(eid, "Gearbox"))!;

  let seq = 0;
  async function part(number: string, over: Record<string, unknown> = {}) {
    seq++;
    return Part.create({
      enterpriseId: ent._id,
      documentId: "d1", elementId: `e${seq}`, partId: `P${seq}`,
      number, name: `Name ${number}`,
      kind: "part", lifecycleState: "In Work",
      productId: prod.productId, productName: "Gearbox",
      attributes: {},
      ...over,
    });
  }
  const link = (parentDoc: any, childDoc: any, quantity = 1) =>
    BomLink.create({ enterpriseId: ent._id, parentId: parentDoc._id, childId: childDoc._id, quantity });

  /*
   *   GEARBOX (assembly)
   *     ├─ 1 × BRACKET-SM   (configuration: Small)
   *     ├─ 1 × BRACKET-MD   (configuration: Medium)
   *     ├─ 1 × BRACKET-LG   (configuration: Large)
   *     └─ 4 × BOLT         (common to every model)
   */
  const asm = await part("GEARBOX", { kind: "assembly" });
  const small = await part("BRACKET-SM", { configuration: "Size=Small" });
  const medium = await part("BRACKET-MD", { configuration: "Size=Medium" });
  const large = await part("BRACKET-LG", { configuration: "Size=Large" });
  const bolt = await part("BOLT");

  const smallLink = await link(asm, small);
  const mediumLink = await link(asm, medium);
  const largeLink = await link(asm, large);
  await link(asm, bolt, 4);

  console.log("\nBefore any variant is defined, the BOM is unfiltered — every sibling shows");
  {
    const bom = await buildProductBom(eid, prod.productId);
    const root = bom.roots.find((r) => r.number === "GEARBOX")!;
    const numbers = root.children.map((c) => c.number).sort();
    check("all three sizes and the bolt are present with nothing tagged",
      JSON.stringify(numbers) === JSON.stringify(["BOLT", "BRACKET-LG", "BRACKET-MD", "BRACKET-SM"]),
      JSON.stringify(numbers));
    check("no variants exist yet", bom.availableVariants.length === 0);
  }

  console.log("\nDefining three variants of the gearbox");
  const modelA = await createVariant(eid, String(asm._id), "Model A");
  const modelB = await createVariant(eid, String(asm._id), "Model B");
  const modelC = await createVariant(eid, String(asm._id), "Model C");
  check("three variants exist, in creation order",
    (await listVariants(eid, String(asm._id))).map((v) => v.name).join(",") === "Model A,Model B,Model C");

  console.log("\nNaming a variant the assembly already has is refused");
  let dupThrew = false;
  try {
    await createVariant(eid, String(asm._id), "Model A");
  } catch { dupThrew = true; }
  check("duplicate variant name on the same assembly is refused", dupThrew);

  console.log("\nA variant of a DIFFERENT assembly can reuse the same name");
  const otherAsm = await part("OTHER-ASM", { kind: "assembly" });
  const otherVariant = await createVariant(eid, String(otherAsm._id), "Model A");
  check("no collision across assemblies", !!otherVariant.id);

  console.log("\nTagging each sized bracket to its own model");
  await setLinkVariants(eid, String(smallLink._id), [modelA.id]);
  await setLinkVariants(eid, String(mediumLink._id), [modelB.id]);
  await setLinkVariants(eid, String(largeLink._id), [modelC.id]);

  console.log("\nA link cannot be tagged with a variant of a different assembly");
  let crossAsmThrew = false;
  try {
    await setLinkVariants(eid, String(smallLink._id), [otherVariant.id]);
  } catch { crossAsmThrew = true; }
  check("cross-assembly variant id is refused", crossAsmThrew);
  // The earlier valid tag is untouched by the refused attempt.
  const smallLinkAfter: any = await BomLink.findById(smallLink._id).lean();
  check("the rejected write left the link's real tag alone",
    smallLinkAfter.variantIds.map(String).join(",") === modelA.id);

  console.log("\nViewing Model A shows only its own bracket, plus everything untagged");
  {
    const bom = await buildProductBom(eid, prod.productId, { variantId: modelA.id });
    const root = bom.roots.find((r) => r.number === "GEARBOX")!;
    const numbers = root.children.map((c) => c.number).sort();
    check("Model A's own bracket and the common bolt, nothing else",
      JSON.stringify(numbers) === JSON.stringify(["BOLT", "BRACKET-SM"]), JSON.stringify(numbers));
    check("the other two sizes are reported as excluded, not silently dropped",
      bom.excludedLinks.some((x) => x.childNumber === "BRACKET-MD") &&
      bom.excludedLinks.some((x) => x.childNumber === "BRACKET-LG"),
      JSON.stringify(bom.excludedLinks));
    check("the exclusion reason names the variant",
      Boolean(bom.excludedLinks.find((x) => x.childNumber === "BRACKET-MD")?.reason.includes("Model A")),
      bom.excludedLinks.find((x) => x.childNumber === "BRACKET-MD")?.reason);
  }

  console.log("\nViewing Model B shows only its own bracket");
  {
    const bom = await buildProductBom(eid, prod.productId, { variantId: modelB.id });
    const root = bom.roots.find((r) => r.number === "GEARBOX")!;
    const numbers = root.children.map((c) => c.number).sort();
    check("Model B's own bracket and the common bolt",
      JSON.stringify(numbers) === JSON.stringify(["BOLT", "BRACKET-MD"]), JSON.stringify(numbers));
  }

  console.log("\nThe unfiltered view still shows all three — a super-BOM, not a lossy one");
  {
    const bom = await buildProductBom(eid, prod.productId);
    const root = bom.roots.find((r) => r.number === "GEARBOX")!;
    const numbers = root.children.map((c) => c.number).sort();
    check("nothing is hidden without a variant selected",
      JSON.stringify(numbers) === JSON.stringify(["BOLT", "BRACKET-LG", "BRACKET-MD", "BRACKET-SM"]),
      JSON.stringify(numbers));
    check("availableVariants lists all three of the gearbox's own variants",
      bom.availableVariants.filter((v) => v.parentPartId === String(asm._id)).length === 3,
      JSON.stringify(bom.availableVariants));
    check("plus OTHER-ASM's own, since it shares this product too",
      bom.availableVariants.some((v) => v.parentPartId === String(otherAsm._id)),
      JSON.stringify(bom.availableVariants));
  }

  console.log("\nRenaming a variant");
  await updateVariant(eid, modelC.id, { name: "Model C (export)" });
  const renamed = await listVariants(eid, String(asm._id));
  check("the rename stuck", renamed.some((v) => v.name === "Model C (export)"));

  console.log("\nDeleting a variant untags its link rather than orphaning the tag");
  await deleteVariant(eid, modelC.id);
  const largeLinkAfter: any = await BomLink.findById(largeLink._id).lean();
  check("the large bracket's tag was cleared", largeLinkAfter.variantIds.length === 0);

  const bomAfterDelete = await buildProductBom(eid, prod.productId);
  check("the deleted variant is gone from availableVariants",
    !bomAfterDelete.availableVariants.some((v) => v.id === modelC.id),
    JSON.stringify(bomAfterDelete.availableVariants));

  console.log("\nAnd the large bracket, now untagged, shows in every remaining variant view");
  {
    const bomA = await buildProductBom(eid, prod.productId, { variantId: modelA.id });
    const rootA = bomA.roots.find((r) => r.number === "GEARBOX")!;
    check("BRACKET-LG now appears under Model A too, since it is untagged",
      rootA.children.some((c) => c.number === "BRACKET-LG"),
      JSON.stringify(rootA.children.map((c) => c.number)));
  }

  console.log("\nDeleting a variant no BomLink references at all is still clean");
  const lonely = await createVariant(eid, String(asm._id), "Unused");
  const removed = await deleteVariant(eid, lonely.id);
  check("delete reports success", removed === true);
  const removedAgain = await deleteVariant(eid, lonely.id);
  check("deleting it again reports nothing to remove, not an error", removedAgain === false);

  for (const M of [BomLink, Part, Variant]) await (M as any).deleteMany({ enterpriseId: ent._id });
  await Enterprise.deleteOne({ _id: ent._id });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
