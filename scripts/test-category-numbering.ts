/**
 * Numbering schemes scoped to a specific Onshape category.
 *
 * A category with a configured scheme is numbered from it; a category with
 * none — including one PLM has simply never seen — falls straight through to
 * the type's plain scheme, unchanged. There is no inheritance walk: this is
 * the flat, single-level version described as good enough "for this
 * exercise" — matching a specific category id, nothing walked up a tree.
 *
 * CategoryNumberingSequence is a separate collection from NumberingSequence
 * on purpose (see its own comment in lib/models/index.ts): widening the
 * existing {enterpriseId, type} unique index to include a category would be
 * the one kind of schema change this project's deployment notes say does
 * need a migration, on an index a live server already has built. A new
 * collection needs nothing done to the old one, so this also pins that the
 * two schemes' counters are genuinely independent.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";

import { connectDb } from "../src/lib/db";
import { CategoryNumberingSequence, Enterprise, NumberIssuedLog, NumberingSequence } from "../src/lib/models";
import { nextNumber } from "../src/lib/numbering";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-category-numbering";

async function main() {
  await connectDb();
  /*
   * Mongoose builds a new model's indexes in the background after connecting
   * — `connectDb()` resolving does not mean they exist yet. On an established
   * database every other collection's indexes were already built by an
   * earlier run, so this race is specific to a collection this database has
   * never seen before. Explicitly waited for, rather than assumed: the
   * uniqueness check below is worthless against an index that has not
   * finished building.
   */
  await CategoryNumberingSequence.init();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [CategoryNumberingSequence, NumberingSequence, NumberIssuedLog]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }

  const ent: any = await Enterprise.create({
    onshapeCompanyId: COMPANY, name: "Category Numbering Test Co",
  });
  const eid = String(ent._id);

  console.log("\nNo category given — the plain type scheme, as before this feature existed");
  const a = await nextNumber(eid, "PART");
  check("issued from the default scheme", a.number === "PN-00001", a.number);
  check("nothing matched", a.matchedCategoryId === null);

  console.log("\nA category nobody has configured a scheme for falls back to the default");
  const b = await nextNumber(eid, "PART", { onshapeCategoryId: "cat-fasteners" });
  check("still the default scheme, next in its own sequence", b.number === "PN-00002", b.number);
  check("nothing matched", b.matchedCategoryId === null);

  console.log("\nOnce a scheme is configured for that category, it is used");
  await CategoryNumberingSequence.create({
    enterpriseId: eid, type: "PART", onshapeCategoryId: "cat-fasteners",
    onshapeCategoryName: "Fasteners", prefix: "FS-", suffix: "", padding: 4, counter: 0,
  });
  const c = await nextNumber(eid, "PART", { onshapeCategoryId: "cat-fasteners" });
  check("issued from the category's own scheme", c.number === "FS-0001", c.number);
  check("reports which category matched", c.matchedCategoryId === "cat-fasteners", String(c.matchedCategoryId));

  console.log("\nThe default scheme's counter is untouched by a category issue");
  const d = await nextNumber(eid, "PART");
  check("continues where the default left off, not affected by Fasteners",
    d.number === "PN-00003", d.number);

  console.log("\nA second, unconfigured category still falls back — independently of the first");
  const e = await nextNumber(eid, "PART", { onshapeCategoryId: "cat-brackets" });
  check("falls back to the default, not to Fasteners' scheme", e.number === "PN-00004", e.number);

  console.log("\nOnly one scheme per (enterprise, type, category) — a duplicate is refused");
  let duplicateRefused = false;
  try {
    await CategoryNumberingSequence.create({
      enterpriseId: eid, type: "PART", onshapeCategoryId: "cat-fasteners",
      onshapeCategoryName: "Fasteners (duplicate)", prefix: "FZ-", suffix: "", padding: 4, counter: 0,
    });
  } catch (err: any) {
    duplicateRefused = err?.code === 11000;
  }
  check("Mongo's own unique index refuses the duplicate", duplicateRefused);

  console.log("\nRemoving a category's scheme returns it to the default, cleanly");
  await CategoryNumberingSequence.deleteOne({
    enterpriseId: eid, type: "PART", onshapeCategoryId: "cat-fasteners",
  });
  const f = await nextNumber(eid, "PART", { onshapeCategoryId: "cat-fasteners" });
  check("back on the default scheme's next number", f.number === "PN-00005", f.number);
  check("nothing matched any more", f.matchedCategoryId === null);

  console.log("\nA different numbering type keeps its own, separate category schemes");
  await CategoryNumberingSequence.create({
    enterpriseId: eid, type: "ASSEMBLY", onshapeCategoryId: "cat-fasteners",
    onshapeCategoryName: "Fasteners", prefix: "AF-", suffix: "", padding: 3, counter: 0,
  });
  const g = await nextNumber(eid, "ASSEMBLY", { onshapeCategoryId: "cat-fasteners" });
  check("ASSEMBLY has its own scheme for the same category id",
    g.number === "AF-001" && g.matchedCategoryId === "cat-fasteners", JSON.stringify(g));
  const h = await nextNumber(eid, "PART", { onshapeCategoryId: "cat-fasteners" });
  check("PART's own Fasteners scheme is still gone — types do not share a category's scheme",
    h.number === "PN-00006" && h.matchedCategoryId === null, JSON.stringify(h));

  for (const M of [CategoryNumberingSequence, NumberingSequence, NumberIssuedLog]) {
    await (M as any).deleteMany({ enterpriseId: eid });
  }
  await Enterprise.deleteOne({ _id: ent._id });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
