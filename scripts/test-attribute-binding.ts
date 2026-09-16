/**
 * Resolving an attribute's Onshape property name to this tenant's id.
 *
 * A definition names a property; Onshape's actual property ids are per-tenant
 * and not published as stable constants, so the name is what an admin can
 * type and the id is what discovery resolves it to afterward.
 *
 * The bug this exists to catch: creating or editing a mapping in the UI used
 * to leave `onshapePropertyId` empty until the next sync or a separate "Run
 * discovery" click — so a mapping typed correctly, matching a property the
 * tenant genuinely has, still showed "not found" the instant it was saved.
 * The fix is that the create and edit routes now call bindAttributeProperties
 * immediately, against whatever was already discovered. This is the function
 * both routes call, and the id-fills-in-immediately behaviour is exactly what
 * it has to guarantee.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";

import { connectDb } from "../src/lib/db";
import { AttributeDefinition, Enterprise } from "../src/lib/models";
import { bindAttributeProperties } from "../src/lib/onshape/properties";
import type { PropertyDef } from "../src/lib/onshape/types";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-attrbind";

const CATALOG: PropertyDef[] = [
  { propertyId: "p-material", name: "Material", valueType: "STRING" },
  { propertyId: "p-vendor", name: "Vendor", valueType: "STRING" },
];

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    await AttributeDefinition.deleteMany({ enterpriseId: stale._id });
    await Enterprise.deleteOne({ _id: stale._id });
  }

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Attr Bind Co" });
  const eid = String(ent._id);

  console.log("\nWhat POST /api/attributes now does: save a name, then bind it against the cache");
  {
    // Exactly what the route creates: a name, no id — there is no UI control
    // for the id at all, only the name.
    const def: any = await AttributeDefinition.create({
      enterpriseId: eid, objectType: "PART", key: "material", label: "Material",
      dataType: "STRING", syncDirection: "from-onshape", owner: "onshape",
      onshapePropertyName: "Material", onshapePropertyId: "",
    });
    check("saved with no id yet — this is the state that used to read \"not found\"",
      def.onshapePropertyId === "");

    const result = await bindAttributeProperties(eid, CATALOG);
    check("it is reported as newly bound", result.bound.some((b) => b.key === "material"));

    const after: any = await AttributeDefinition.findById(def._id).lean();
    check("and the id is filled in immediately", after.onshapePropertyId === "p-material",
      after.onshapePropertyId);
  }

  console.log("\nMatching is forgiving of case and surrounding whitespace");
  {
    const def: any = await AttributeDefinition.create({
      enterpriseId: eid, objectType: "PART", key: "vendorName", label: "Vendor",
      dataType: "STRING", syncDirection: "from-onshape", owner: "onshape",
      onshapePropertyName: "  vendor  ",
    });
    await bindAttributeProperties(eid, CATALOG);
    const after: any = await AttributeDefinition.findById(def._id).lean();
    check("it still resolves to the real property", after.onshapePropertyId === "p-vendor",
      after.onshapePropertyId);
  }

  console.log("\nA name the tenant genuinely does not have stays unmatched, not silently accepted");
  {
    const def: any = await AttributeDefinition.create({
      enterpriseId: eid, objectType: "PART", key: "certification", label: "Certification",
      dataType: "STRING", syncDirection: "from-onshape", owner: "onshape",
      onshapePropertyName: "Certification",
    });
    const result = await bindAttributeProperties(eid, CATALOG);
    check("reported as unmatched, with the reason it can act on",
      result.unmatched.some((u) => u.key === "certification" && u.wanted === "Certification"),
      JSON.stringify(result.unmatched));
    const after: any = await AttributeDefinition.findById(def._id).lean();
    check("no id was invented for it", !after.onshapePropertyId, after.onshapePropertyId);
  }

  console.log("\nA PLM-only attribute (no Onshape name at all) is left alone");
  {
    const def: any = await AttributeDefinition.create({
      enterpriseId: eid, objectType: "PART", key: "internalNote", label: "Internal note",
      dataType: "TEXT", syncDirection: "none", owner: "plm",
    });
    const result = await bindAttributeProperties(eid, CATALOG);
    check("counted as plm-only, not unmatched",
      result.plmOnly > 0 && !result.unmatched.some((u) => u.key === "internalNote"));
    const after: any = await AttributeDefinition.findById(def._id).lean();
    check("still has no id — there was never anything to bind",
      !after.onshapePropertyId);
  }

  console.log("\nA property deleted and recreated in Onshape gets its new id, not the stale one");
  {
    // The exact failure this re-check exists for: a stale id reads and writes
    // nothing while the definition looks perfectly configured.
    const def: any = await AttributeDefinition.create({
      enterpriseId: eid, objectType: "PART", key: "material2", label: "Material 2",
      dataType: "STRING", syncDirection: "from-onshape", owner: "onshape",
      onshapePropertyName: "Recreated",
      onshapePropertyId: "p-recreated-OLD",
    });

    await bindAttributeProperties(eid, [{ propertyId: "p-recreated-OLD", name: "Recreated", valueType: "STRING" }]);
    const same: any = await AttributeDefinition.findById(def._id).lean();
    check("matches its current id, so nothing changes yet", same.onshapePropertyId === "p-recreated-OLD");

    const result = await bindAttributeProperties(
      eid, [{ propertyId: "p-recreated-NEW", name: "Recreated", valueType: "STRING" }]
    );
    check("reported as re-bound, not silently skipped",
      result.bound.some((b) => b.key === "material2"), JSON.stringify(result.bound));
    const after: any = await AttributeDefinition.findById(def._id).lean();
    check("carries the new id", after.onshapePropertyId === "p-recreated-NEW", after.onshapePropertyId);
  }

  console.log("\nRe-binding something already correctly bound is a no-op");
  {
    await bindAttributeProperties(eid, CATALOG);
    const result = await bindAttributeProperties(eid, CATALOG);
    check("nothing reported as newly bound the second time",
      !result.bound.some((b) => b.key === "material"), JSON.stringify(result.bound));
  }

  await AttributeDefinition.deleteMany({ enterpriseId: eid });
  await Enterprise.deleteOne({ _id: ent._id });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
