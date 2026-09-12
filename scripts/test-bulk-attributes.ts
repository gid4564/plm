/**
 * Setting the same attribute on many parts.
 *
 * The problem is ordinary and tedious: a product's worth of parts each missing
 * a Make/Buy, a unit of measure and a responsible engineer is dozens of
 * identical edits, and the values are usually the same across the set.
 *
 * What must not happen is a fast path that also becomes a way *around* the
 * governance the single-part edit enforces. So these tests are mostly about the
 * refusals: a field locked by a part's state stays locked, a value the
 * metamodel rejects stays rejected, and one refusal does not take the rest of
 * the batch with it.
 *
 * Exercised through the library the route uses rather than over HTTP, because
 * the governance lives there — the route is a thin wrapper around
 * validateAttributes, and testing it through a session would test the session.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import { AttributeDefinition, Enterprise, Part, PartIteration } from "../src/lib/models";
import {
  listDefinitions, missingForRelease, missingForReleaseKeys, seedAttributeDefinitions,
  validateAttributes,
} from "../src/lib/attributes";
import { plainAttributes } from "../src/lib/sync";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/**
 * The route's own logic, over the same library it uses.
 *
 * Mirrors src/app/api/parts/bulk-attributes/route.ts: skip what already holds
 * the value, validate per part, save per part, and report each outcome.
 */
async function bulkSet(
  enterpriseId: string,
  partIds: string[],
  attributes: Record<string, unknown>
) {
  const defs = await listDefinitions(enterpriseId, "PART");
  const parts: any[] = await Part.find({ enterpriseId, _id: { $in: partIds } });
  const results: { number: string; ok: boolean; changed: string[]; error?: string }[] = [];

  for (const part of parts) {
    const current = plainAttributes(part.attributes);
    const wanted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (String(current[k] ?? "") !== String(v ?? "")) wanted[k] = v;
    }
    if (!Object.keys(wanted).length) {
      results.push({ number: part.number, ok: true, changed: [] });
      continue;
    }
    const validated = validateAttributes(defs, wanted, current, String(part.lifecycleState));
    if (!validated.ok) {
      results.push({
        number: part.number, ok: false, changed: [],
        error: Object.values(validated.errors)[0],
      });
      continue;
    }
    part.attributes = validated.values;
    part.markModified("attributes");
    part.iteration = (part.iteration ?? 1) + 1;
    await part.save();
    await PartIteration.create({
      enterpriseId: part.enterpriseId, partId: part._id, iteration: part.iteration,
      revision: part.revision ?? "", lifecycleState: part.lifecycleState,
      attributes: plainAttributes(part.attributes), cause: "edit",
      changedKeys: Object.keys(wanted), createdByEmail: "bulk@test",
    });
    results.push({ number: part.number, ok: true, changed: Object.keys(wanted) });
  }
  return results;
}

async function main() {
  await connectDb();

  /*
   * Clear first, not only at the end.
   *
   * A run that fails partway leaves its enterprise behind, and the next run
   * then dies on a duplicate key before reaching a single assertion — so the
   * first thing a re-run reports is unrelated to whatever it was meant to
   * check.
   */
  const stale: any = await Enterprise.findOne({ onshapeCompanyId: "mock-company-bulk" }).lean();
  if (stale) {
    await Promise.all([
      PartIteration.deleteMany({ enterpriseId: stale._id }),
      Part.deleteMany({ enterpriseId: stale._id }),
      AttributeDefinition.deleteMany({ enterpriseId: stale._id }),
      Enterprise.deleteOne({ _id: stale._id }),
    ]);
  }

  const ent: any = await Enterprise.create({
    name: "Bulk Test Co", onshapeCompanyId: "mock-company-bulk",
  });
  const eid = String(ent._id);
  await seedAttributeDefinitions(eid);

  let seq = 0;
  /**
   * A part as sync creates one.
   *
   * `number` and `name` are seeded into the attributes because they are the
   * only always-`required` definitions in the schema, and sync fills them when
   * it creates a part. A fixture without them is not a realistic part: since
   * validateAttributes checks every always-required attribute against the
   * merged result, such a part refuses *any* edit with "Part number is
   * required" — which is correct behaviour on an impossible part, and was this
   * test's first mistake.
   */
  const makePart = async (over: Record<string, unknown> = {}) => {
    seq++;
    const number = `PN-${String(seq).padStart(3, "0")}`;
    const name = `Part ${seq}`;
    return Part.create({
      enterpriseId: ent._id,
      documentId: "d1", elementId: `e${seq}`, partId: `P${seq}`,
      number, name,
      kind: "part", lifecycleState: "In Work", iteration: 1,
      ...over,
      attributes: { number, name, ...((over.attributes as object) ?? {}) },
    });
  };

  console.log("\nThe same value across several parts");
  {
    const a = await makePart();
    const b = await makePart();
    const c = await makePart();
    const results = await bulkSet(eid, [a, b, c].map((x) => String(x._id)), {
      classification: "Make",
    });
    check("all three were set", results.filter((r) => r.ok && r.changed.length).length === 3,
      JSON.stringify(results));

    const after: any = await Part.findById(a._id).lean();
    check("the value is stored", after.attributes.classification === "Make",
      String(after.attributes.classification));
    check("and an iteration was recorded for each",
      (await PartIteration.countDocuments({ partId: a._id })) === 1);
  }

  console.log("\nA part that already holds the value is not touched");
  {
    const a = await makePart({ attributes: { classification: "Buy" } });
    const before: any = await Part.findById(a._id).lean();

    const results = await bulkSet(eid, [String(a._id)], { classification: "Buy" });
    check("it reports no change", results[0].ok && results[0].changed.length === 0,
      JSON.stringify(results));

    /*
     * A PLM-side edit earns an iteration, so re-setting a value a part already
     * holds would add one recording nothing. Over fifty parts that is fifty
     * meaningless rows in a history people are supposed to be able to read.
     */
    check("no iteration was added",
      (await PartIteration.countDocuments({ partId: a._id })) === 0);
    const after: any = await Part.findById(a._id).lean();
    check("and the iteration number did not move", after.iteration === before.iteration,
      `${before.iteration} -> ${after.iteration}`);
  }

  console.log("\nGovernance is not bypassed by going in bulk");
  {
    /*
     * The seeded schema restricts `responsibleEngineer` (and `classification`)
     * to In Work and Under Review — so a *Released* part must refuse them, and
     * the refusal has to be the same one the single-part edit gives. This is a
     * faster path to the rules, not a way around them.
     *
     * A Released part in a selection is not contrived: it is the normal result
     * of ticking a filtered BOM, and it is exactly the case where an
     * all-or-nothing batch would be most annoying.
     */
    const defs = await listDefinitions(eid, "PART");
    const restricted = defs.find(
      (d) => (d.editableInStates ?? []).length > 0 && !(d.editableInStates ?? []).includes("Released")
    );
    check("the seeded schema has a state-restricted attribute", !!restricted,
      JSON.stringify(defs.filter((d) => (d.editableInStates ?? []).length)
        .map((d) => `${d.key}:${d.editableInStates}`)));

    if (restricted) {
      const inWork = await makePart();
      const review = await makePart({ lifecycleState: "Released", revision: "A" });

      /*
       * A value the definition will accept, whichever one was found. Hardcoding
       * a string picked a fight with an ENUM and made every assertion below
       * fail for a reason unrelated to what they test.
       */
      const value =
        restricted.dataType === "ENUM"
          ? (restricted.enumValues ?? [])[0]
          : restricted.dataType === "NUMBER" || restricted.dataType === "INTEGER"
            ? 1
            : "R. Engineer";

      const results = await bulkSet(
        eid, [inWork, review].map((x) => String(x._id)), { [restricted.key]: value }
      );
      const okOne = results.find((r) => r.number === inWork.number);
      const refused = results.find((r) => r.number === review.number);

      check("the In Work part is set", okOne?.ok === true && okOne.changed.length === 1,
        JSON.stringify(okOne));
      check("the Released part is refused", refused?.ok === false, JSON.stringify(refused));
      check("with a reason a person can act on",
        /released|cannot be edited|In Work/i.test(refused?.error ?? ""), refused?.error);

      /*
       * One refusal must not take the batch with it. The useful outcome is
       * "one saved, one refused because it is Under Review", not nothing at
       * all — which is why this is deliberately not a transaction.
       */
      const savedRow: any = await Part.findById(inWork._id).lean();
      check("the other part keeps its value despite the refusal",
        String(savedRow.attributes[restricted.key]) === String(value),
        String(savedRow.attributes[restricted.key]));
      const refusedRow: any = await Part.findById(review._id).lean();
      check("and the refused part was not written",
        !refusedRow.attributes[restricted.key], String(refusedRow.attributes[restricted.key]));
    }
  }

  console.log("\nA value the metamodel rejects is refused");
  {
    const a = await makePart();
    const results = await bulkSet(eid, [String(a._id)], { classification: "Borrow" });
    check("an off-list enum value is refused", results[0].ok === false, JSON.stringify(results));
    check("and names the permitted values",
      /Make|Buy|Standard/.test(results[0].error ?? ""), results[0].error);

    const after: any = await Part.findById(a._id).lean();
    check("nothing was written", !after.attributes.classification);
  }

  console.log("\nThe gaps a BOM reports, by key and by label");
  {
    const a = await makePart();
    const defs = await listDefinitions(eid, "PART");
    const attrs = plainAttributes((await Part.findById(a._id).lean() as any).attributes);

    const labels = missingForRelease(defs, attrs);
    const keys = missingForReleaseKeys(defs, attrs);
    check("a fresh part is missing several release-required attributes", labels.length > 0,
      JSON.stringify(labels));
    check("keys and labels describe the same set", keys.length === labels.length,
      `${keys.length} keys, ${labels.length} labels`);
    /*
     * The panel matches definitions on keys rather than labels because a label
     * is the one part of a definition an admin can rename — matching on it
     * would break the field list the moment somebody did.
     */
    check("every key names a real definition",
      keys.every((k) => defs.some((d) => d.key === k)), JSON.stringify(keys));

    // Filling one removes exactly one.
    await bulkSet(eid, [String(a._id)], { classification: "Make" });
    const after = plainAttributes((await Part.findById(a._id).lean() as any).attributes);
    const left = missingForReleaseKeys(defs, after);
    check("filling one closes exactly one gap", left.length === keys.length - 1,
      `${keys.length} -> ${left.length}`);
    check("and it is no longer listed", !left.includes("classification"), JSON.stringify(left));
  }

  await Promise.all([
    PartIteration.deleteMany({ enterpriseId: ent._id }),
    Part.deleteMany({ enterpriseId: ent._id }),
    AttributeDefinition.deleteMany({ enterpriseId: ent._id }),
    Enterprise.deleteOne({ _id: ent._id }),
  ]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
