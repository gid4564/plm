/**
 * Find (and optionally merge) manufacturing items that describe the same Onshape
 * part more than once.
 *
 * Runs with plain `node` using the MongoDB driver already present in the
 * deployed bundle — no mongosh, no extra install. Run it from the directory the
 * release was extracted into, so `mongodb` resolves and .env.local is found.
 *
 *   node find-duplicates.mjs            # dry run
 *   node find-duplicates.mjs --merge    # apply
 *
 * Cause: before the {$configuration} fix, a panel load could file a part under
 * the literal string "{$configuration}" while a webhook filed the same part
 * under "default" — two rows, two MO numbers, one physical part.
 */
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const MERGE = process.argv.includes("--merge");

function loadEnv() {
  const out = { ...process.env };
  const file = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      // Real environment variables win, matching how Next resolves them.
      if (!(k in process.env)) out[k] = t.slice(i + 1).trim();
    }
  }
  return out;
}

// Print the build stamp first — an unexpected result is often a stale bundle
// rather than a bug in the logic below.
try {
  const info = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "build-info.json"), "utf8"));
  console.log(`build ${info.buildId} (source ${info.sourceHash})\n`);
} catch {
  console.log("build: unknown — no build-info.json here (running from source?)\n");
}

const env = loadEnv();
if (!env.MONGODB_URI) {
  console.error("MONGODB_URI not set. Run this from the deployment directory, or export it.");
  process.exit(1);
}

const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db(env.MONGODB_DB || "mos");
  const items = db.collection("manufacturingitems");
  const logs = db.collection("synclogs");

  // Group on partId alone (within an enterprise). Grouping on the full identity
  // would hide the very duplicates worth finding — if documentId or elementId is
  // what differs, a strict grouping never puts the rows side by side.
  const groups = await items.aggregate([
    { $group: {
        _id: { e: "$enterpriseId", p: "$partId" },
        n: { $sum: 1 },
        rows: { $push: {
          id: "$_id", mo: "$moNumber", cfg: "$configuration", status: "$status",
          remarks: "$remarks", partName: "$partName", partNumber: "$partNumber",
          doc: "$documentId", el: "$elementId", ws: "$workspaceId",
          docName: "$documentName", elName: "$elementName", created: "$createdAt" } },
    }},
    { $match: { n: { $gt: 1 } } },
  ]).toArray();

  /** Report which identity fields actually differ across a group. */
  const differingFields = (rows) => {
    const fields = ["doc", "el", "cfg"];
    return fields.filter((f) => new Set(rows.map((r) => String(r[f]))).size > 1);
  };

  if (groups.length === 0) {
    console.log("No duplicates found.");
  } else {
    console.log(`${groups.length} part(s) have more than one MOS record:\n`);

    for (const g of groups) {
      const diff = differingFields(g.rows);
      console.log(`  ${g.rows[0].partName || g._id.p}  (part ${g._id.p})`);
      console.log(`    differs by: ${diff.length ? diff.map((d) => ({doc:"documentId",el:"elementId",cfg:"configuration"}[d])).join(", ") : "nothing — identical identity, index may be missing"}`);

      for (const r of g.rows) {
        console.log(`    ${r.mo}`);
        console.log(`      documentId    ${r.doc}   ${r.docName ? `(${r.docName})` : "(name not recorded)"}`);
        console.log(`      elementId     ${r.el}   ${r.elName ? `(${r.elName})` : "(name not recorded)"}`);
        console.log(`      workspaceId   ${r.ws ?? "-"}`);
        console.log(`      configuration ${JSON.stringify(r.cfg)}`);
        console.log(`      status=${r.status}  remarks=${r.remarks ? JSON.stringify(r.remarks.slice(0, 30)) : "-"}`);
      }

      // Prefer the plainest configuration, then the oldest row — that is the MO
      // number Onshape is most likely already carrying.
      const keep = g.rows.find((r) => r.cfg === "default")
        ?? [...g.rows].sort((a, b) => new Date(a.created) - new Date(b.created))[0];
      const drop = g.rows.filter((r) => String(r.id) !== String(keep.id));

      console.log(`    -> keep ${keep.mo}, remove ${drop.map((d) => d.mo).join(", ")}`);

      if (MERGE) {
        const donor = drop.find((d) => d.remarks && !keep.remarks);
        if (donor) {
          await items.updateOne({ _id: keep.id }, { $set: { remarks: donor.remarks } });
          console.log(`       carried remarks across from ${donor.mo}`);
        }
        for (const d of drop) {
          await logs.deleteMany({ itemId: d.id });
          await items.deleteOne({ _id: d.id });
        }
        console.log("       merged.");
      }
      console.log("");
    }
    if (!MERGE) console.log("Dry run. Re-run with --merge to apply.");
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
