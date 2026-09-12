/**
 * Products: the grouping every part belongs to.
 *
 * The design decision worth pinning is that "Unassigned" is an ordinary
 * product, created on demand, rather than `productId: null` with a special
 * case at every filter, count and picker. That keeps "every part belongs to a
 * product" true everywhere without a null branch anywhere — so these tests are
 * mostly about the edges where that invariant could quietly break: a name
 * retyped with different capitalisation, two syncs racing, a rename leaving
 * stale copies behind, and a delete taking parts with it.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import { ActivityLog, Enterprise, Part, Product, User } from "../src/lib/models";
import {
  assignParts, countUnfiled, currentProductFor, deleteProduct, fileUnfiled, listProducts,
  productNameKey, renameProduct, resolveProduct, resolveProductById,
  resolveUnassignedProduct, UNASSIGNED_PRODUCT,
} from "../src/lib/products";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  await connectDb();

  const ent: any = await Enterprise.create({
    name: "Products Test Co", onshapeCompanyId: "mock-company-products",
  });
  const other: any = await Enterprise.create({
    name: "Someone Else Ltd", onshapeCompanyId: "mock-company-other",
  });
  const eid = String(ent._id);

  let seq = 0;
  const makePart = async (over: Record<string, unknown> = {}) =>
    Part.create({
      enterpriseId: ent._id,
      documentId: "d1", elementId: `e${++seq}`, partId: `P${seq}`,
      number: `PN-${String(seq).padStart(3, "0")}`,
      name: `Part ${seq}`,
      kind: "part",
      lifecycleState: "In Work",
      ...over,
    });

  console.log("\nA name is matched, not stored twice");
  {
    const a = await resolveProduct(eid, "Bracket Kit");
    const b = await resolveProduct(eid, "bracket kit");
    const c = await resolveProduct(eid, "  Bracket   Kit  ");
    check("differing case resolves to the same product", a!.productId === b!.productId);
    check("and so does incidental whitespace", a!.productId === c!.productId);
    check("the first spelling is the one kept", a!.productName === "Bracket Kit", a!.productName);
    check("a blank name resolves to nothing", (await resolveProduct(eid, "   ")) === null);
    check("the key ignores case and whitespace",
      productNameKey(" Bracket  Kit ") === productNameKey("bracket kit"));
  }

  console.log("\nA product id from elsewhere is not honoured");
  {
    const mine = await resolveProduct(eid, "Mine");
    const theirs = await resolveProduct(String(other._id), "Theirs");
    check("a product in this enterprise resolves",
      (await resolveProductById(eid, mine!.productId))?.productName === "Mine");
    /*
     * The point of resolveProductById returning null rather than the row: an
     * id arriving in a request is not to be trusted, and filing a part into
     * another tenant's product would be a cross-tenant leak that no filter
     * would ever show.
     */
    check("one from another enterprise does not",
      (await resolveProductById(eid, theirs!.productId)) === null);
    check("neither does a malformed id",
      (await resolveProductById(eid, "not-an-object-id")) === null);
  }

  console.log("\nCounts are per product, and split by kind and state");
  {
    const pumps = await resolveProduct(eid, "Pump");
    await makePart({ productId: pumps!.productId, productName: "Pump" });
    await makePart({ productId: pumps!.productId, productName: "Pump", kind: "assembly" });
    await makePart({
      productId: pumps!.productId, productName: "Pump", lifecycleState: "Released",
    });

    const all = await listProducts(eid);
    const pump = all.find((p) => p.name === "Pump")!;
    check("the total is right", pump.total === 3, String(pump.total));
    check("assemblies are counted apart from parts",
      pump.assemblies === 1 && pump.parts === 2, `${pump.assemblies}/${pump.parts}`);
    check("released is counted", pump.released === 1, String(pump.released));
    check("in-work is counted", pump.inWork === 2, String(pump.inWork));

    /*
     * An empty product still appears. A product somebody just created is
     * exactly when they need to see it in the list, and a product that has
     * emptied is worth noticing.
     */
    check("a product with nothing in it is still listed",
      all.some((p) => p.name === "Mine" && p.total === 0));

    check("another enterprise's products are not listed",
      !all.some((p) => p.name === "Theirs"), JSON.stringify(all.map((p) => p.name)));
  }

  console.log("\nParts predating the field are unfiled, not unassigned");
  {
    // No productId at all — the state of every part before this feature.
    const legacy: any = await makePart({});
    check("an unfiled part is counted", (await countUnfiled(eid)) >= 1);

    const unassigned = await resolveUnassignedProduct(eid);
    check("Unassigned is an ordinary product",
      productNameKey(unassigned.productName) === productNameKey(UNASSIGNED_PRODUCT));
    check("and is flagged as such in the listing",
      (await listProducts(eid)).find((p) => p.id === unassigned.productId)?.isUnassigned === true);

    const filed = await fileUnfiled(eid);
    check("filing moves them", filed.filed >= 1, String(filed.filed));
    check("and nothing is left unfiled", (await countUnfiled(eid)) === 0);

    const after: any = await Part.findById(legacy._id).lean();
    check("the part now has both id and name",
      String(after.productId) === unassigned.productId && after.productName === unassigned.productName,
      `${after.productId} / ${after.productName}`);
  }

  console.log("\nMoving parts writes the denormalised name too");
  {
    const target = await resolveProduct(eid, "Chassis");
    const part: any = await makePart({});
    const result = await assignParts(eid, [String(part._id)], target!.productId, {
      email: "tester@example.com",
    });
    check("it reports what moved", result.moved === 1, String(result.moved));

    const after: any = await Part.findById(part._id).lean();
    check("the id is set", String(after.productId) === target!.productId);
    /*
     * The name is denormalised onto every part so the list and the counts need
     * no join. If a move set only the id, the row would keep displaying the
     * product it used to be in.
     */
    check("and so is the name", after.productName === "Chassis", after.productName);

    const again = await assignParts(eid, [String(part._id)], target!.productId);
    check("moving it where it already is moves nothing", again.moved === 0, String(again.moved));
    check("the move is recorded",
      !!(await ActivityLog.findOne({ enterpriseId: ent._id, trigger: "product" }).lean()));
  }

  console.log("\nA released part can be moved between products");
  {
    /*
     * Products are a grouping, not part of the release record, so re-filing a
     * released part is an ordinary act — and it is the common one: products get
     * reorganised long after their parts are released.
     *
     * Worth asserting because the dashboard's multi-select originally refused
     * to tick anything that was not In Work. That limit belonged to release
     * submission and was inherited by the product move, which made the feature
     * unusable on most of a mature system's parts.
     */
    const from = await resolveProduct(eid, "Old Programme");
    const to = await resolveProduct(eid, "New Programme");
    const released: any = await makePart({
      productId: from!.productId, productName: "Old Programme",
      lifecycleState: "Released", revision: "B",
    });
    const obsolete: any = await makePart({
      productId: from!.productId, productName: "Old Programme",
      lifecycleState: "Obsolete", revision: "A",
    });

    const moved = await assignParts(
      eid, [String(released._id), String(obsolete._id)], to!.productId
    );
    check("both moved regardless of lifecycle state", moved.moved === 2, String(moved.moved));

    const afterR: any = await Part.findById(released._id).lean();
    check("the released part is in the new product",
      afterR.productName === "New Programme", afterR.productName);
    check("and its revision and state are untouched",
      afterR.revision === "B" && afterR.lifecycleState === "Released",
      `${afterR.revision}/${afterR.lifecycleState}`);
  }

  console.log("\nRenaming carries the copies with it");
  {
    const p = await resolveProduct(eid, "Gearbox");
    const part: any = await makePart({ productId: p!.productId, productName: "Gearbox" });

    const renamed = await renameProduct(eid, p!.productId, "Gearbox Mk2");
    check("the product is renamed", renamed?.name === "Gearbox Mk2", renamed?.name);

    const after: any = await Part.findById(part._id).lean();
    check("every part's copy of the name is rewritten",
      after.productName === "Gearbox Mk2", after.productName);

    check("the old spelling no longer resolves to a different product",
      (await resolveProduct(eid, "Gearbox Mk2"))!.productId === p!.productId);

    /*
     * Renaming onto an existing name would merge two products by accident, and
     * the unique index would throw a duplicate-key error somewhere unhelpful.
     */
    let clashed = false;
    try {
      await renameProduct(eid, p!.productId, "Chassis");
    } catch (e: any) {
      clashed = /already called/i.test(e.message);
    }
    check("renaming onto another product's name is refused", clashed);

    // Changing only capitalisation is not a clash with itself.
    const recased = await renameProduct(eid, p!.productId, "GEARBOX MK2");
    check("re-casing its own name is allowed", recased?.name === "GEARBOX MK2", recased?.name);
  }

  console.log("\nDeleting a product never deletes its parts");
  {
    const doomed = await resolveProduct(eid, "Cancelled Programme");
    const part: any = await makePart({
      productId: doomed!.productId, productName: "Cancelled Programme",
      lifecycleState: "Released",
    });

    const result = await deleteProduct(eid, doomed!.productId);
    check("the product is deleted", result.deleted);
    check("its contents moved rather than went", result.moved === 1, String(result.moved));

    const after: any = await Part.findById(part._id).lean();
    check("the released part still exists", !!after);
    check("and is now in Unassigned",
      after.productName === UNASSIGNED_PRODUCT, after.productName);

    /*
     * Something has to be the fallback, so the fallback cannot be removed —
     * otherwise a delete would have nowhere to put what it displaced.
     */
    const unassigned = await resolveUnassignedProduct(eid);
    const refused = await deleteProduct(eid, unassigned.productId);
    check("Unassigned cannot be deleted", !refused.deleted);
    check("and says why", /cannot be deleted/i.test(refused.reason ?? ""), refused.reason);

    check("deleting one from another enterprise is refused",
      !(await deleteProduct(String(other._id), doomed!.productId)).deleted);
  }

  console.log("\nThe current product is remembered per user");
  {
    const p = await resolveProduct(eid, "Current Thing");
    const user: any = await User.create({
      enterpriseId: ent._id, email: "who@example.com", name: "Who",
      passwordHash: "x", role: "user",
    });

    check("with nothing chosen, there is no current product",
      (await currentProductFor(String(user._id))) === null);

    await User.updateOne({ _id: user._id }, { $set: { currentProductId: p!.productId } });
    check("once chosen, it resolves",
      (await currentProductFor(String(user._id)))?.productName === "Current Thing");

    /*
     * A product deleted while it was somebody's current one leaves a dangling
     * id. Resolving it must come back null so a sync falls back to Unassigned
     * rather than throwing on the part somebody is trying to bring in.
     */
    await Product.deleteOne({ _id: p!.productId });
    check("a deleted current product resolves to nothing, not an error",
      (await currentProductFor(String(user._id))) === null);

    await User.deleteOne({ _id: user._id });
  }

  await Promise.all([
    Part.deleteMany({ enterpriseId: { $in: [ent._id, other._id] } }),
    Product.deleteMany({ enterpriseId: { $in: [ent._id, other._id] } }),
    ActivityLog.deleteMany({ enterpriseId: { $in: [ent._id, other._id] } }),
    Enterprise.deleteMany({ _id: { $in: [ent._id, other._id] } }),
  ]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
