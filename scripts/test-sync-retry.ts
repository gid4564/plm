/**
 * A webhook sync that races another write is retried, not lost.
 *
 * A live tenant logged "[PLM] webhook sync failed: No matching document
 * found for id ... version 3 modifiedPaths ...": Mongoose's VersionError,
 * from `part.save()` — meaning something else saved the same Part between
 * this sync's read and its own save. Two webhook deliveries close enough
 * together to overlap is a real situation, not a hypothetical one, and the
 * old behaviour dropped the whole sync on the floor and logged an error.
 *
 * Reproducing the race itself needs no luck: `Part.prototype.save` is
 * monkey-patched to bump the document's `__v` behind syncPartFromOnshape's
 * back, once, right before its first real save — the same effect a second,
 * genuinely concurrent writer would have — so the first attempt hits a real
 * VersionError from real Mongoose. The question this answers is only what
 * syncPartFromOnshape does about it.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, AttributeDefinition, Enterprise, MockOnshapePart, MockPropertyDef, Part,
} from "../src/lib/models";
import { seedAttributeDefinitions } from "../src/lib/attributes";
import { discoverProperties } from "../src/lib/onshape/properties";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { syncPartFromOnshape } from "../src/lib/sync";

const MATERIAL_ID = "57f3fb8efa3416c06701d611";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-sync-retry";
const DOC = "d1a2b3c4d5e6f70819202122";
const PS = "e1a2b3c4d5e6f70819202123";

async function main() {
  await connectDb();

  for (const M of [Enterprise, AttributeDefinition, Part, MockOnshapePart, MockPropertyDef, ActivityLog])
    await (M as any).deleteMany({});

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Sync Retry Co" });
  const entId = String(ent._id);
  await seedAttributeDefinitions(entId);

  await MockPropertyDef.create({
    companyId: COMPANY, propertyId: MATERIAL_ID, name: "Material", valueType: "STRING", builtIn: true,
  });

  await MockOnshapePart.create({
    companyId: COMPANY, documentId: DOC, documentName: "Widgets",
    elementId: PS, elementName: "Bracket Part Studio", elementType: "PARTSTUDIO",
    partId: "JHD", configuration: "default",
    properties: { [MATERIAL_ID]: "Steel" },
  });

  const client = new MockOnshapeClient(COMPANY, {
    id: "mock-user-1", email: "designer@mockenterprise.test", name: "Des Designer",
  });

  // Binds the "material" attribute to the Onshape property above, by name —
  // without this the sync has an unresolved onshapePropertyName and nothing
  // to mirror, whatever Onshape reports.
  await discoverProperties(client, entId, COMPANY);

  const coords = {
    documentId: DOC, elementId: PS, partId: "JHD",
    configuration: "default", workspaceId: "w1", versionId: null,
  };

  console.log("\nBringing the part into PLM");
  const first = await syncPartFromOnshape(entId, coords, { client, create: true });
  check("the part was created", first.action === "created", first.action);

  console.log("\nA second write lands between this sync's read and its save");

  const origSave = (Part as any).prototype.save;
  let armed = true;
  (Part as any).prototype.save = async function (this: any, ...args: any[]) {
    if (armed) {
      armed = false;
      // The effect a second, real writer landing first would have: the
      // in-memory document's __v is now behind the one stored.
      await Part.updateOne({ _id: this._id }, { $inc: { __v: 1 } });
    }
    return origSave.apply(this, args);
  };

  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: any[]) => { warnings.push(args.join(" ")); };

  let result: any = null;
  let threw: any = null;
  try {
    // A real change, so this attempt actually reaches save() rather than
    // short-circuiting on "nothing changed".
    await MockOnshapePart.updateOne(
      { companyId: COMPANY, partId: "JHD" },
      { $set: { [`properties.${MATERIAL_ID}`]: "Aluminium" } }
    );
    result = await syncPartFromOnshape(entId, coords, { client, create: false });
  } catch (err) {
    threw = err;
  } finally {
    (Part as any).prototype.save = origSave;
    console.warn = origWarn;
  }

  check("the sync did not throw despite the collision", !threw, String(threw?.message ?? threw));
  check("it reports the retried update, not a skip", result?.action === "updated", result?.action);
  check("armed was consumed — the race actually happened once, not zero times", !armed);
  check("the retry was logged",
    warnings.some((w) => /concurrent write/.test(w) && /retrying once/.test(w)),
    JSON.stringify(warnings));

  const stored: any = await Part.findOne({ enterpriseId: entId }).lean();
  check("the retried write is the one on record",
    stored?.attributes?.material === "Aluminium", stored?.attributes?.material);

  const errorLogs = await ActivityLog.countDocuments({ enterpriseId: entId, action: "error" });
  check("nothing was logged as a failed sync", errorLogs === 0, `${errorLogs} error log(s)`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
