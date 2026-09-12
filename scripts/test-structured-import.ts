/**
 * Importing an assembly's real structure, and keeping it current.
 *
 * Two questions, both asked of live data:
 *
 *   Can PLM get the complete structure out of Onshape?  It could not. The
 *   client asked for `indented=false`, so every row came back at indentLevel 0
 *   and the hierarchy was gone before PLM saw it; subassemblies were refused
 *   outright as a MOS inheritance; and every imported row was linked to the
 *   top assembly, flattening whatever survived.
 *
 *   Can it update an existing BOM as the assembly changes?  Adding worked.
 *   Removing did not — the import only ever upserted, so a part deleted in CAD
 *   stayed in PLM's structure for ever, overstating what the product is built
 *   from in the direction that gets parts ordered.
 *
 * Run against the simulator, whose BOM now nests half its parts under a
 * subassembly. A flat simulator could not have caught any of this, which is
 * how it survived.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, BomLink, Enterprise, MockOnshapeDrawing, MockOnshapePart,
  MockPropertyDef, NumberingSequence, NumberIssuedLog, Part, PartIteration, Product, User,
} from "../src/lib/models";
import { seedAttributeDefinitions } from "../src/lib/attributes";
import { seedMockOnshape } from "../src/lib/mock-seed";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { importBomLines, importableLines } from "../src/lib/bom-import";
import { structureFromIndent } from "../src/lib/bom-structure";
import { buildProductBom } from "../src/lib/product-bom";
import { resolveProduct } from "../src/lib/products";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-structimport";
const DOC = "d1a2b3c4d5e6f70819202122";
const ASM = "e7a2b3c4d5e6f70819202141";
const SUB = "e7a2b3c4d5e6f70819202143";

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [BomLink, Part, PartIteration, Product, AttributeDefinition, User,
      NumberingSequence, NumberIssuedLog, ActivityLog]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }
  for (const M of [MockOnshapePart, MockPropertyDef, MockOnshapeDrawing]) {
    await (M as any).deleteMany({ companyId: COMPANY });
  }

  const ent: any = await Enterprise.create({
    onshapeCompanyId: COMPANY, name: "Structured Import Co",
  });
  const eid = String(ent._id);
  const user: any = await User.create({
    enterpriseId: ent._id, email: "des@test", passwordHash: "x", name: "Des", role: "admin",
  });
  await seedAttributeDefinitions(eid);
  await seedMockOnshape(COMPANY);

  const client = new MockOnshapeClient(COMPANY, {
    id: "mock-u", email: "des@test", name: "Des",
  });
  const session = { userId: String(user._id), email: user.email, enterpriseId: eid };
  const coords = { documentId: DOC, elementId: ASM, workspaceId: "w1a2b3c4d5e6f70819202199", versionId: null };

  console.log("\nOnshape is asked for structure, and gives it");
  const table = await client.getAssemblyBom(coords, { multiLevel: true });
  check("the table says it is indented", table.indented, String(table.indented));
  check("it has more than one level",
    table.lines.some((l) => l.indentLevel > 0),
    JSON.stringify(table.lines.map((l) => `${l.indentLevel}:${l.name}`)));
  check("the subassembly row is present and flagged",
    table.lines.some((l) => l.isAssembly), JSON.stringify(table.lines.map((l) => l.isAssembly)));
  check("and it is importable, not refused",
    importableLines(table).some((l) => l.isAssembly));

  const structure = structureFromIndent(table);
  check("the hierarchy has a parent with children",
    structure.rows.some((r) => r.childIndexes.length > 0),
    JSON.stringify(structure.rows.map((r) => `${r.line.name}<-${r.childIndexes.length}`)));
  check("and no indent gaps", structure.gaps.length === 0, JSON.stringify(structure.gaps));

  console.log("\nImporting it builds the same shape in PLM");
  const prod = (await resolveProduct(eid, "Gearbox"))!;
  await User.updateOne({ _id: user._id }, { $set: { currentProductId: prod.productId } });

  const all = importableLines(table).map((l) => l.key);
  const first = await importBomLines(session, coords, all, { multiLevel: true });
  check("rows were imported", first.result.created > 0, JSON.stringify(first.result));
  check("nothing was removed on a first import", first.result.removedLinks === 0,
    String(first.result.removedLinks));

  const subPart: any = await Part.findOne({ enterpriseId: ent._id, elementId: SUB }).lean();
  check("the subassembly is now a PLM part", !!subPart, "not found");
  check("recorded as an assembly", subPart?.kind === "assembly", subPart?.kind);
  check("with no Onshape part id, because it is an element",
    subPart?.partId === "", JSON.stringify(subPart?.partId));
  /* Assemblies have their own numbering sequence, so the prefix differs. */
  check("and it was issued a PLM number", /^[A-Z]{2}-\d{5}/.test(subPart?.number ?? ""),
    subPart?.number);

  /*
   * The point of the whole exercise: the subassembly's children hang off IT,
   * not off the top assembly. Before, every row was linked to the top and the
   * structured BOM view showed one level however deep the CAD went.
   */
  const underSub = await BomLink.countDocuments({ enterpriseId: ent._id, parentId: subPart._id });
  check("parts hang off the subassembly", underSub > 0, String(underSub));

  const topPart: any = await Part.findOne({ enterpriseId: ent._id, elementId: ASM }).lean();
  const underTop: any[] = await BomLink.find({ enterpriseId: ent._id, parentId: topPart._id }).lean();
  const childIds = underTop.map((l) => String(l.childId));
  check("the subassembly hangs off the top assembly",
    childIds.includes(String(subPart._id)), JSON.stringify(childIds.length));
  check("and the subassembly's children do NOT also hang off the top",
    !(await BomLink.exists({
      enterpriseId: ent._id,
      parentId: topPart._id,
      childId: { $in: (await BomLink.find({ parentId: subPart._id }).lean()).map((l: any) => l.childId) },
    })),
    "a child of the subassembly was also linked to the top");

  console.log("\nThe product BOM reads back as a real tree");
  {
    const bom = await buildProductBom(eid, prod.productId);
    check("it has depth", bom.totals.maxDepth >= 2, String(bom.totals.maxDepth));
    const top = bom.roots.find((r) => String(r.partId) === String(topPart._id));
    check("the top assembly is a root", !!top);
    const sub = top?.children.find((c) => String(c.partId) === String(subPart._id));
    check("the subassembly is under it", !!sub, JSON.stringify(top?.children.map((c) => c.number)));
    check("and has children of its own", (sub?.children.length ?? 0) > 0,
      String(sub?.children.length));
  }

  console.log("\nAdding a part in Onshape and re-importing picks it up");
  {
    const before = await BomLink.countDocuments({ enterpriseId: ent._id });
    await MockOnshapePart.create({
      companyId: COMPANY, documentId: DOC, documentName: "Gearbox Assembly",
      elementId: "e1a2b3c4d5e6f70819209999", elementName: "New Tab",
      elementType: "PARTSTUDIO", partId: "NEWP", configuration: "default",
      workspaceId: "w1a2b3c4d5e6f70819202199",
      properties: { "57f3fb8efa3416c06701d60d": "Brand New Bracket" },
    });

    const t2 = await client.getAssemblyBom(coords, { multiLevel: true });
    const keys2 = importableLines(t2).map((l) => l.key);
    const second = await importBomLines(session, coords, keys2, { multiLevel: true });

    check("the new part came in", second.result.created >= 1, JSON.stringify({
      created: second.result.created, existing: second.result.existing,
    }));
    check("more edges exist than before",
      (await BomLink.countDocuments({ enterpriseId: ent._id })) > before);
    check("the new part is in PLM",
      !!(await Part.findOne({ enterpriseId: ent._id, partId: "NEWP" }).lean()));
  }

  console.log("\nRemoving a part in Onshape and re-importing takes it out");
  {
    const gone: any = await Part.findOne({ enterpriseId: ent._id, partId: "NEWP" }).lean();
    const hadEdge = await BomLink.exists({ enterpriseId: ent._id, childId: gone._id });
    check("it has a structure edge to begin with", !!hadEdge);

    await MockOnshapePart.deleteOne({ companyId: COMPANY, partId: "NEWP" });

    const t3 = await client.getAssemblyBom(coords, { multiLevel: true });
    const keys3 = importableLines(t3).map((l) => l.key);
    const third = await importBomLines(session, coords, keys3, { multiLevel: true });

    check("the stale edge was removed", third.result.removedLinks >= 1,
      String(third.result.removedLinks));
    check("and it is gone from the structure",
      !(await BomLink.exists({ enterpriseId: ent._id, childId: gone._id })));
    /*
     * The PART is not deleted, only its place in this assembly. It may be used
     * elsewhere, it may be released, and a BOM import is not the right event to
     * destroy a record on.
     */
    check("but the part itself still exists",
      !!(await Part.findOne({ _id: gone._id }).lean()), "the part was deleted");
  }

  console.log("\nEverything under one assembly stays in one product");
  {
    /*
     * The scenario the inheritance exists for.
     *
     * The assembly was first imported while "Gearbox" was the current product.
     * Months later a subassembly is added in Onshape, and by then the importer
     * is working in a different product. Filing the new parts into *that* would
     * split one product structure across two — nobody would have chosen it; it
     * was simply the only answer the code had.
     */
    const other = (await resolveProduct(eid, "Something Else"))!;
    await User.updateOne({ _id: user._id }, { $set: { currentProductId: other.productId } });

    await MockOnshapePart.create({
      companyId: COMPANY, documentId: DOC, documentName: "Gearbox Assembly",
      elementId: "e7a2b3c4d5e6f70819208888", elementName: "Late Subassembly",
      elementType: "ASSEMBLY", partId: "", configuration: "default",
      isSubassembly: false,
      workspaceId: "w1a2b3c4d5e6f70819202199",
      properties: { "57f3fb8efa3416c06701d60d": "Late Subassembly" },
    });
    await MockOnshapePart.create({
      companyId: COMPANY, documentId: DOC, documentName: "Gearbox Assembly",
      elementId: "e1a2b3c4d5e6f70819208887", elementName: "Late Tab",
      elementType: "PARTSTUDIO", partId: "LATE", configuration: "default",
      workspaceId: "w1a2b3c4d5e6f70819202199",
      properties: { "57f3fb8efa3416c06701d60d": "Late Bracket" },
    });

    const t = await client.getAssemblyBom(coords, { multiLevel: true });
    const keys = importableLines(t).map((l) => l.key);
    const again = await importBomLines(session, coords, keys, { multiLevel: true });

    check("the product came from the assembly, not the current selection",
      again.result.product.source === "assembly", again.result.product.source);
    check("and it is the assembly's product", again.result.product.name === "Gearbox",
      again.result.product.name);

    const late: any = await Part.findOne({ enterpriseId: ent._id, partId: "LATE" }).lean();
    check("the newly added part is in PLM", !!late, "not found");
    check("filed under the assembly's product, not the importer's current one",
      late?.productName === "Gearbox", late?.productName);
    check("and specifically NOT the one that was selected",
      late?.productName !== "Something Else", late?.productName);

    /* Every part under the assembly agrees on the product. */
    const all: any[] = await Part.find({ enterpriseId: ent._id, documentId: DOC })
      .select("number productName").lean();
    const products = [...new Set(all.map((x) => x.productName))];
    check("every part under the assembly is in one product", products.length === 1,
      JSON.stringify(products));

    /* A part deliberately moved elsewhere is named, not dragged back. */
    await Part.updateOne(
      { _id: late._id },
      { $set: { productId: other.productId, productName: "Something Else" } }
    );
    const t2 = await client.getAssemblyBom(coords, { multiLevel: true });
    const after = await importBomLines(
      session, coords, importableLines(t2).map((l) => l.key), { multiLevel: true }
    );
    check("a part moved elsewhere is reported",
      after.result.elsewhere.some((x) => x.number === late.number),
      JSON.stringify(after.result.elsewhere));
    const stillThere: any = await Part.findById(late._id).lean();
    check("but it is not dragged back by the import",
      stillThere.productName === "Something Else", stillThere.productName);
  }

  console.log("\nA partial selection never deletes structure");
  {
    const t4 = await client.getAssemblyBom(coords, { multiLevel: true });
    const keys = importableLines(t4).map((l) => l.key);
    const before = await BomLink.countDocuments({ enterpriseId: ent._id });

    /*
     * Half the rows. "Not selected" is not "no longer there" — reconciling on
     * a partial import would delete structure on the strength of a checkbox.
     */
    const fourth = await importBomLines(session, coords, keys.slice(0, 1), { multiLevel: true });
    check("nothing was removed", fourth.result.removedLinks === 0,
      String(fourth.result.removedLinks));
    check("and the edge count is unchanged",
      (await BomLink.countDocuments({ enterpriseId: ent._id })) === before);
  }

  for (const M of [BomLink, Part, PartIteration, Product, AttributeDefinition, User,
    NumberingSequence, NumberIssuedLog, ActivityLog]) {
    await (M as any).deleteMany({ enterpriseId: ent._id });
  }
  await Enterprise.deleteOne({ _id: ent._id });
  for (const M of [MockOnshapePart, MockPropertyDef, MockOnshapeDrawing]) {
    await (M as any).deleteMany({ companyId: COMPANY });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
