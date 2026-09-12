/**
 * A product's bill of materials: quantities, effectivity, and not looping.
 *
 * The structured and flattened views come out of one walk, which is the whole
 * point — computing them separately is how the two come to disagree about
 * quantities, and a BOM that gives two answers is worse than one that gives
 * none. So these tests check the two against each other as much as against
 * expected numbers.
 *
 * The cycle test is not hypothetical. A part containing itself has happened in
 * this database: a duplicate merge repointed both ends of a structure edge onto
 * the same row. It renders as "contains itself" and makes a naive walk
 * non-terminating, so it is guarded and reported rather than assumed away.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import { BomLink, Enterprise, Part, Product, Task } from "../src/lib/models";
import { buildProductBom, isEffectiveAt, parseAsOf } from "../src/lib/product-bom";
import { resolveProduct } from "../src/lib/products";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  await connectDb();

  const ent: any = await Enterprise.create({
    name: "BOM Test Co", onshapeCompanyId: "mock-company-bom",
  });
  const eid = String(ent._id);
  const prod = (await resolveProduct(eid, "Pump"))!;
  const otherProd = (await resolveProduct(eid, "Elsewhere"))!;

  let seq = 0;
  async function part(
    number: string,
    over: Record<string, unknown> = {},
    productId = prod.productId
  ) {
    seq++;
    return Part.create({
      enterpriseId: ent._id,
      documentId: "d1", elementId: `e${seq}`, partId: `P${seq}`,
      number, name: `Name ${number}`,
      kind: "part", lifecycleState: "In Work",
      productId, productName: productId === prod.productId ? "Pump" : "Elsewhere",
      attributes: { description: `Desc ${number}`, material: "Steel 1018" },
      ...over,
    });
  }
  const link = (parent: any, child: any, quantity: number, findNumber = "") =>
    BomLink.create({ enterpriseId: ent._id, parentId: parent._id, childId: child._id, quantity, findNumber });

  /*
   *   PUMP-ASM  (root, assembly)
   *     ├─ 2 × HOUSING (assembly)
   *     │    └─ 4 × BOLT
   *     └─ 1 × BOLT          <- the same bolt, in two places
   *   LOOSE                  <- in the product, in nobody's structure
   */
  const asm = await part("PUMP-ASM", { kind: "assembly", attributes: { description: "Pump", material: "" } });
  const housing = await part("HOUSING", {
    kind: "assembly", attributes: { description: "Housing", material: "Aluminium 6061" },
  });
  const bolt = await part("BOLT", { attributes: { description: "M6 bolt", material: "Steel 1018", mass: 0.01 } });
  const loose = await part("LOOSE", { attributes: { description: "Spare", material: "Steel 1018", mass: 0.5 } });

  await link(asm, housing, 2, "10");
  await link(housing, bolt, 4, "20");
  await link(asm, bolt, 1, "30");

  console.log("\nRoots are the parts nothing contains");
  {
    const bom = await buildProductBom(eid, prod.productId);
    const rootNumbers = bom.roots.map((r) => r.number).sort();
    check("the assembly and the loose part are roots",
      JSON.stringify(rootNumbers) === JSON.stringify(["LOOSE", "PUMP-ASM"]),
      JSON.stringify(rootNumbers));
    /*
     * A part that is somebody's child must not also be a root, or its quantity
     * is counted twice in the flattened view.
     */
    check("a contained part is not also a root",
      !bom.roots.some((r) => r.number === "BOLT" || r.number === "HOUSING"));
  }

  console.log("\nQuantities multiply down the tree");
  {
    const bom = await buildProductBom(eid, prod.productId);
    const pump = bom.roots.find((r) => r.number === "PUMP-ASM")!;
    const h = pump.children.find((c) => c.number === "HOUSING")!;
    const boltUnderHousing = h.children.find((c) => c.number === "BOLT")!;
    const boltUnderPump = pump.children.find((c) => c.number === "BOLT")!;

    check("the housing is 2 per pump", h.quantity === 2 && h.totalQuantity === 2,
      `${h.quantity}/${h.totalQuantity}`);
    check("a bolt in the housing is 4 each, 8 in total",
      boltUnderHousing.quantity === 4 && boltUnderHousing.totalQuantity === 8,
      `${boltUnderHousing.quantity}/${boltUnderHousing.totalQuantity}`);
    check("the bolt straight under the pump is 1",
      boltUnderPump.totalQuantity === 1, String(boltUnderPump.totalQuantity));

    console.log("\nThe flattened view sums what the tree shows");
    const flatBolt = bom.flat.find((r) => r.number === "BOLT")!;
    check("the bolt totals 9 across both places", flatBolt.totalQuantity === 9,
      String(flatBolt.totalQuantity));
    check("and reports appearing in 2 places", flatBolt.usedIn === 2, String(flatBolt.usedIn));
    check("it is listed once, not twice",
      bom.flat.filter((r) => r.number === "BOLT").length === 1);
    check("the tree marks it as shared", boltUnderPump.alsoUsedElsewhere);

    /*
     * The invariant that matters: the flattened total for every part equals the
     * sum of its totalQuantity everywhere it appears in the tree. If these ever
     * diverge, one of the two views is lying.
     */
    const fromTree = new Map<string, number>();
    const walk = (ns: typeof bom.roots) => {
      for (const n of ns) {
        fromTree.set(n.partId, (fromTree.get(n.partId) ?? 0) + n.totalQuantity);
        walk(n.children);
      }
    };
    walk(bom.roots);
    check("every flattened total matches the tree",
      bom.flat.every((r) => fromTree.get(r.partId) === r.totalQuantity),
      JSON.stringify(bom.flat.map((r) => `${r.number}:${r.totalQuantity} vs ${fromTree.get(r.partId)}`)));

    check("distinct parts counts rows, not pieces", bom.totals.distinctParts === 4,
      String(bom.totals.distinctParts));
    check("total pieces sums the quantities",
      bom.totals.totalPieces === 1 + 2 + 9 + 1, String(bom.totals.totalPieces));
    check("depth is counted from zero", bom.totals.maxDepth === 2, String(bom.totals.maxDepth));
  }

  console.log("\nMass rolls up from the leaves only");
  {
    const bom = await buildProductBom(eid, prod.productId);
    /*
     * 9 bolts at 10g plus one 0.5kg spare. The assemblies are skipped on
     * purpose: an assembly's own recorded mass is itself a rollup of its
     * children, so counting both would double everything under it.
     */
    check("the rollup is the leaves times their quantities",
      bom.totals.massKg === 0.59, String(bom.totals.massKg));

    // A leaf with no mass makes the total unknowable rather than merely lower.
    const noMass = await part("NOMASS", { attributes: { description: "?", material: "Steel" } });
    await link(asm, noMass, 1);
    const after = await buildProductBom(eid, prod.productId);
    check("one missing mass makes the total null, not understated",
      after.totals.massKg === null, String(after.totals.massKg));
    check("and says how many are missing", after.totals.missingMass === 1,
      String(after.totals.missingMass));
    await BomLink.deleteOne({ parentId: asm._id, childId: noMass._id });
    await Part.deleteOne({ _id: noMass._id });
  }

  console.log("\nA part from another product still appears");
  {
    const shared = await part("SHARED-FASTENER", { attributes: { description: "Shared", material: "Steel" } }, otherProd.productId);
    await link(housing, shared, 6);
    const bom = await buildProductBom(eid, prod.productId);
    const row = bom.flat.find((r) => r.number === "SHARED-FASTENER");
    /*
     * An assembly in this product can contain a part filed under another one —
     * a shared fastener, a part that moved. Dropping it would understate what
     * the product is built from, so the walk follows the structure and the row
     * says which product it belongs to.
     */
    check("it is in the BOM", !!row, "missing");
    check("with its quantity multiplied through", row?.totalQuantity === 12,
      String(row?.totalQuantity));
    check("and it says which product it is filed under",
      row?.productName === "Elsewhere", row?.productName);
    await BomLink.deleteOne({ parentId: housing._id, childId: shared._id });
    await Part.deleteOne({ _id: shared._id });
  }

  console.log("\nEffectivity is open at both ends");
  {
    check("a part with no dates is effective on any date",
      isEffectiveAt({}, new Date("2020-01-01")).effective);
    check("before its start date it is not",
      !isEffectiveAt({ effectiveFrom: new Date("2026-06-01") }, new Date("2026-01-01")).effective);
    check("on its start date it is",
      isEffectiveAt({ effectiveFrom: new Date("2026-06-01") }, new Date("2026-06-01")).effective);
    check("after its end date it is not",
      !isEffectiveAt({ effectiveTo: new Date("2026-06-01") }, new Date("2026-07-01")).effective);
    check("on its end date it still is",
      isEffectiveAt({ effectiveTo: new Date("2026-06-01") }, new Date("2026-06-01")).effective);
    check("with no date to resolve at, everything is effective",
      isEffectiveAt({ effectiveTo: new Date("2000-01-01") }, null).effective);
    check("a reason is given when it is not",
      /superseded after 2026-06-01/.test(
        isEffectiveAt({ effectiveTo: new Date("2026-06-01") }, new Date("2026-07-01")).reason));
  }

  console.log("\nThe date filter prunes a part and everything under it");
  {
    // The housing is superseded; the bolts reached through it go with it.
    await Part.updateOne(
      { _id: housing._id },
      { $set: { "attributes.effectiveTo": new Date("2026-01-31") } }
    );

    const before = await buildProductBom(eid, prod.productId, { asOf: new Date("2026-01-01") });
    check("before that date the housing is present",
      before.flat.some((r) => r.number === "HOUSING"));
    check("and the bolt totals 9", before.flat.find((r) => r.number === "BOLT")?.totalQuantity === 9,
      String(before.flat.find((r) => r.number === "BOLT")?.totalQuantity));

    const after = await buildProductBom(eid, prod.productId, { asOf: new Date("2026-03-01") });
    check("after it, the housing is gone", !after.flat.some((r) => r.number === "HOUSING"));
    check("the exclusion is reported rather than silent",
      after.excludedByDate.some((x) => x.number === "HOUSING"),
      JSON.stringify(after.excludedByDate));
    /*
     * The bolts under the housing go with it, but the one attached straight to
     * the pump remains — so the bolt stays in the BOM at the lower quantity.
     * That is the whole point of pruning the subtree rather than the node.
     */
    check("the bolts reached only through it are gone too",
      after.flat.find((r) => r.number === "BOLT")?.totalQuantity === 1,
      String(after.flat.find((r) => r.number === "BOLT")?.totalQuantity));
    check("the mass rollup follows the filtered tree",
      after.totals.massKg === 0.51, String(after.totals.massKg));

    await Part.updateOne({ _id: housing._id }, { $unset: { "attributes.effectiveTo": "" } });
  }

  console.log("\nLink effectivity: a substitution, which part effectivity cannot express");
  {
    /*
     * The pump used the old bolt until the end of March, and the new one from
     * April. Both bolts stay perfectly current parts — the old one is still
     * used by other assemblies, and is still stocked. Retiring the *part* would
     * remove it from every other BOM, which is precisely the mistake this
     * exists to avoid.
     */
    const oldBolt = await part("BOLT-OLD", { attributes: { description: "M6 × 20", material: "Steel 1018", mass: 0.01 } });
    const newBolt = await part("BOLT-NEW", { attributes: { description: "M6 × 25", material: "Steel 1018", mass: 0.012 } });
    const sub = await part("SUB-ASM", { kind: "assembly", attributes: { description: "Bracket", material: "" } });
    await link(asm, sub, 1, "40");

    const oldLink: any = await link(sub, oldBolt, 4);
    const newLink: any = await link(sub, newBolt, 4);
    await BomLink.updateOne({ _id: oldLink._id }, { $set: { effectiveTo: new Date("2026-03-31") } });
    await BomLink.updateOne({ _id: newLink._id }, { $set: { effectiveFrom: new Date("2026-04-01") } });

    const inMarch = await buildProductBom(eid, prod.productId, { asOf: new Date("2026-03-15") });
    check("in March the assembly uses the old bolt",
      inMarch.flat.some((r) => r.number === "BOLT-OLD"),
      JSON.stringify(inMarch.flat.map((r) => r.number)));
    check("and not the new one", !inMarch.flat.some((r) => r.number === "BOLT-NEW"));

    const inMay = await buildProductBom(eid, prod.productId, { asOf: new Date("2026-05-15") });
    check("in May it uses the new bolt", inMay.flat.some((r) => r.number === "BOLT-NEW"));
    check("and not the old one", !inMay.flat.some((r) => r.number === "BOLT-OLD"),
      JSON.stringify(inMay.flat.map((r) => r.number)));

    /*
     * The distinction that matters: the superseded component is reported as a
     * link exclusion, not a part exclusion. A reader must be able to tell "this
     * assembly stopped using it" from "this part is retired".
     */
    /*
     * The bug this pair of assertions exists for: the "unreachable" fallback
     * (which shows parts nothing contains, so a cycle or a cross-product parent
     * cannot hide them) was resurrecting date-pruned components as top-level
     * rows. A superseded bolt came back at the top of the BOM having just been
     * correctly removed from its assembly, which defeats the filter and reads
     * as a bug in it. Structural reachability and date pruning are now separate
     * questions.
     */
    check("a pruned component is not resurrected as a top-level row",
      !inMay.roots.some((r) => r.number === "BOLT-OLD"),
      JSON.stringify(inMay.roots.map((r) => r.number)));
    check("nor reported as unreachable",
      !inMay.unreachable.some((x) => x.number === "BOLT-OLD"),
      JSON.stringify(inMay.unreachable));

    check("the superseded component is reported as a link, not a retired part",
      inMay.excludedLinks.some((x) => x.childNumber === "BOLT-OLD") &&
        !inMay.excludedByDate.some((x) => x.number === "BOLT-OLD"),
      JSON.stringify({ links: inMay.excludedLinks.map((x) => x.childNumber), parts: inMay.excludedByDate.map((x) => x.number) }));
    check("and names the assembly it left",
      inMay.excludedLinks.find((x) => x.childNumber === "BOLT-OLD")?.parentNumber === "SUB-ASM",
      JSON.stringify(inMay.excludedLinks));

    console.log("\nA link's window does not retire the part elsewhere");
    {
      /*
       * The same old bolt, used by a second assembly with no end date. The link
       * that expired must not follow the part into other assemblies.
       */
      const other = await part("OTHER-ASM", { kind: "assembly" });
      await link(other, oldBolt, 2);

      const later = await buildProductBom(eid, prod.productId, { asOf: new Date("2026-05-15") });
      check("it still appears under the assembly that never superseded it",
        later.flat.some((r) => r.number === "BOLT-OLD"),
        JSON.stringify(later.flat.map((r) => r.number)));
      check("at the quantity of only that assembly",
        later.flat.find((r) => r.number === "BOLT-OLD")?.totalQuantity === 2,
        String(later.flat.find((r) => r.number === "BOLT-OLD")?.totalQuantity));
      check("and in one place, not two",
        later.flat.find((r) => r.number === "BOLT-OLD")?.usedIn === 1,
        String(later.flat.find((r) => r.number === "BOLT-OLD")?.usedIn));

      await BomLink.deleteOne({ parentId: other._id, childId: oldBolt._id });
      await Part.deleteOne({ _id: other._id });
    }

    console.log("\nWithout a date, every position is shown");
    {
      const all = await buildProductBom(eid, prod.productId);
      check("both bolts appear when unfiltered",
        all.flat.some((r) => r.number === "BOLT-OLD") && all.flat.some((r) => r.number === "BOLT-NEW"));
      check("and nothing is reported as excluded", all.excludedLinks.length === 0,
        JSON.stringify(all.excludedLinks));
      /*
       * The window travels with the node so the BOM page can show and edit it
       * in place — it is a property of the position, not of either part.
       */
      const subNode = all.roots
        .flatMap((r) => r.children)
        .find((c) => c.number === "SUB-ASM");
      const oldNode = subNode?.children.find((c) => c.number === "BOLT-OLD");
      check("the node carries its link id", !!oldNode?.linkId);
      check("and the link's own window, distinct from the part's",
        oldNode?.linkEffectiveTo?.startsWith("2026-03-31") === true &&
          oldNode?.effectiveTo === null,
        JSON.stringify({ link: oldNode?.linkEffectiveTo, part: oldNode?.effectiveTo }));
    }

    await BomLink.deleteMany({ $or: [{ parentId: sub._id }, { childId: sub._id }] });
    await Part.deleteMany({ _id: { $in: [oldBolt._id, newBolt._id, sub._id] } });
  }

  console.log("\nA part that contains itself does not loop");
  {
    // Through a chain: bolt -> asm, which already reaches bolt.
    await link(bolt, asm, 1);
    const bom = await buildProductBom(eid, prod.productId);
    check("the walk terminates and returns a BOM", !!bom.roots.length);
    check("the cycle is reported", bom.cycles.length > 0, JSON.stringify(bom.cycles));
    const marked = JSON.stringify(bom.roots).includes('"cycle":true');
    check("and the node where it stopped is marked", marked);
    /*
     * The cycle also made every part in it somebody's child, so nothing was a
     * root and the BOM came back nearly empty — a structure fault presenting
     * as a page that merely looks wrong. Those parts are now walked as extra
     * roots and reported.
     */
    check("the parts caught in the cycle are still shown",
      bom.flat.some((r) => r.number === "PUMP-ASM") && bom.flat.some((r) => r.number === "BOLT"),
      JSON.stringify(bom.flat.map((r) => r.number)));
    check("and reported as unreachable rather than silently dropped",
      bom.unreachable.length > 0, JSON.stringify(bom.unreachable));

    await BomLink.deleteOne({ parentId: bolt._id, childId: asm._id });
  }

  console.log("\nA part whose only parent is in another product");
  {
    /*
     * Not a fault — a subassembly filed under a different product legitimately
     * contains a part filed under this one. The part is in this product, so it
     * has to appear; nothing this walk starts from reaches it.
     */
    const outsideParent = await part("OUTSIDE-ASM", { kind: "assembly" }, otherProd.productId);
    const inside = await part("INSIDE-PART", { attributes: { description: "In", material: "Steel", mass: 0.2 } });
    await link(outsideParent, inside, 3);

    const bom = await buildProductBom(eid, prod.productId);
    check("it still appears in this product's BOM",
      bom.flat.some((r) => r.number === "INSIDE-PART"),
      JSON.stringify(bom.flat.map((r) => r.number)));
    check("shown as a root, since nothing here contains it",
      bom.roots.some((r) => r.number === "INSIDE-PART"));
    check("and flagged as unreachable so it is explicable",
      bom.unreachable.some((x) => x.number === "INSIDE-PART"),
      JSON.stringify(bom.unreachable));

    await BomLink.deleteOne({ parentId: outsideParent._id, childId: inside._id });
    await Part.deleteMany({ _id: { $in: [outsideParent._id, inside._id] } });
  }

  {
    // Directly: a self-edge, which is the shape the merge bug produced.
    await BomLink.collection.insertOne({
      enterpriseId: ent._id, parentId: asm._id, childId: asm._id, quantity: 1,
    });
    const bom = await buildProductBom(eid, prod.productId);
    check("a self-edge does not loop either", !!bom.roots.length);
    check("it is reported as a cycle",
      bom.cycles.some((c) => c.number === "PUMP-ASM"), JSON.stringify(bom.cycles));
    check("and the assembly is still a root, not swallowed by its own edge",
      bom.roots.some((r) => r.number === "PUMP-ASM"),
      JSON.stringify(bom.roots.map((r) => r.number)));
    await BomLink.deleteOne({ parentId: asm._id, childId: asm._id });
  }

  console.log("\nOpen Onshape tasks travel with the BOM rows");
  {
    /*
     * The BOM is where a change request against a component changes a
     * decision: it is the thing that gets signed off without anybody opening
     * each part's own page. The badge was on the dashboard and the part page
     * but not here, so a BOM could be approved with an open task against one
     * of its parts and nothing on screen said so.
     */
    const target: any = await Part.findOne({ enterpriseId: ent._id, number: "SHAFT" }).lean()
      ?? await Part.findOne({ enterpriseId: ent._id }).lean();

    await Task.create({
      enterpriseId: ent._id, onshapeTaskId: "bom-task-open", name: "Re-check the shaft",
      state: "Open", taskType: "GENERAL",
      items: [{ partId: target._id, label: "Shaft", documentId: target.documentId,
                elementId: target.elementId, onshapePartId: target.partId }],
    });
    await Task.create({
      enterpriseId: ent._id, onshapeTaskId: "bom-task-done", name: "Already handled",
      state: "Complete", taskType: "GENERAL",
      items: [{ partId: target._id, label: "Shaft", documentId: target.documentId,
                elementId: target.elementId, onshapePartId: target.partId }],
    });

    const bom = await buildProductBom(eid, prod.productId, {});
    const row = bom.flat.find((r) => r.partId === String(target._id))!;
    check("the flattened row carries the open count", row.openTaskCount === 1,
      String(row.openTaskCount));
    check("and the total, including the closed one", row.taskCount === 2,
      String(row.taskCount));

    /* Every position of that part in the tree must agree with the row. */
    const seen: number[] = [];
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        if (n.partId === String(target._id)) seen.push(n.openTaskCount);
        walk(n.children);
      }
    };
    walk(bom.roots);
    check("the structured view has it too", seen.length > 0, JSON.stringify(seen));
    check("and every position reports the same count",
      seen.every((c) => c === 1), JSON.stringify(seen));

    check("a part with no tasks reads zero rather than undefined",
      bom.flat.filter((r) => r.partId !== String(target._id))
        .every((r) => r.openTaskCount === 0 && r.taskCount === 0));

    check("the summary counts parts, not tasks", bom.totals.withOpenTasks === 1,
      String(bom.totals.withOpenTasks));

    await Task.deleteMany({ enterpriseId: ent._id });
    const after = await buildProductBom(eid, prod.productId, {});
    check("and it goes back to zero when the tasks go",
      after.totals.withOpenTasks === 0 &&
      after.flat.every((r) => r.openTaskCount === 0));
  }

  console.log("\nEdge cases");
  {
    check("an unknown product returns an empty BOM, not an error",
      (await buildProductBom(eid, String(loose._id))).product === null);
    check("asOf parsing accepts a date", parseAsOf("2026-06-01") instanceof Date);
    check("'all' means no filter", parseAsOf("all") === null);
    check("'today' resolves to a date", parseAsOf("today") instanceof Date);
    check("nonsense is ignored rather than throwing", parseAsOf("not-a-date") === null);

    const empty = await buildProductBom(eid, otherProd.productId);
    check("a product with nothing in it has no roots", empty.roots.length === 0);
    check("and reports zero totals", empty.totals.totalPieces === 0);
  }

  await Promise.all([
    Task.deleteMany({ enterpriseId: ent._id }),
    BomLink.deleteMany({ enterpriseId: ent._id }),
    Part.deleteMany({ enterpriseId: ent._id }),
    Product.deleteMany({ enterpriseId: ent._id }),
    Enterprise.deleteOne({ _id: ent._id }),
  ]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
