/**
 * Remove specific PLM parts by id — the duplicate a release created, say, that
 * the interface will not delete because it is sitting in a workflow.
 *
 * Runs with plain `node` from the directory the release was extracted or
 * deployed into, so `mongodb` resolves and .env.local is found.
 *
 *   node remove-part.mjs <partId> [<partId> ...]            # dry run
 *   node remove-part.mjs <partId> [<partId> ...] --apply    # do it
 *
 * Deliberately not `find-duplicates.mjs --merge`: that groups every record of
 * one Onshape part, including real per-configuration variants, and keeps the
 * "default" one — which can be the duplicate. This removes only what is named.
 *
 * Refuses, and says why, for:
 *   - a part that is released or obsolete (a records decision, not a cleanup),
 *   - a part that is a parent or child in any BOM (would silently reshape one).
 *
 * It takes the part out of any release it is listed on. A release left with no
 * items is deleted too: it is an empty shell that nothing can act on.
 *
 * It does NOT touch Onshape. The release package that created the duplicate is
 * still pending there — reject or discard it in Onshape as well.
 */
import fs from "node:fs";
import path from "node:path";
import { MongoClient, ObjectId } from "mongodb";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ids = args.filter((a) => !a.startsWith("--"));

if (!ids.length) {
  console.error("Give at least one part _id.  node remove-part.mjs <partId> [--apply]");
  process.exit(1);
}

function loadEnv() {
  const out = { ...process.env };
  const file = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      if (!(k in process.env)) out[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

try {
  const info = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "build-info.json"), "utf8"));
  console.log(`build ${info.buildId} (source ${info.sourceHash})\n`);
} catch {
  console.log("build: unknown — no build-info.json here\n");
}

const env = loadEnv();
if (!env.MONGODB_URI) {
  console.error("MONGODB_URI not set. Run this from the deployment directory, or export it.");
  process.exit(1);
}

const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db(env.MONGODB_DB || "plm");
  const parts = db.collection("parts");
  const releases = db.collection("releases");
  const links = db.collection("bomlinks");
  const drawings = db.collection("drawings");
  const iterations = db.collection("partiterations");
  const thumbs = db.collection("partthumbnails");
  const logs = db.collection("activitylogs");

  for (const raw of ids) {
    let oid;
    try { oid = new ObjectId(raw); } catch { console.log(`${raw}: not a valid id — skipped\n`); continue; }

    const part = await parts.findOne({ _id: oid });
    if (!part) { console.log(`${raw}: no such part — skipped\n`); continue; }

    console.log(`${part.number}  "${part.name}"  (${raw})`);
    console.log(`  configuration ${JSON.stringify(part.configuration)}, state ${part.lifecycleState}, revision ${part.revision || "-"}`);

    if (part.revision || part.lifecycleState === "Released" || part.lifecycleState === "Obsolete") {
      console.log("  -> REFUSED: released or obsolete. Decide this one by hand.\n");
      continue;
    }

    const linkCount = await links.countDocuments({ $or: [{ parentId: oid }, { childId: oid }] });
    if (linkCount) {
      console.log(`  -> REFUSED: it is in ${linkCount} BOM link(s). Removing it would reshape a BOM.\n`);
      continue;
    }

    const rels = await releases.find({ "items.partId": oid }).project({ number: 1, state: 1, items: 1 }).toArray();
    for (const r of rels) {
      console.log(`  on release ${r.number} (${r.state}, ${r.items.length} item(s))`);
    }

    if (!APPLY) { console.log("  -> would remove (dry run)\n"); continue; }

    for (const r of rels) {
      await releases.updateOne({ _id: r._id }, { $pull: { items: { partId: oid } } });
      const left = await releases.findOne({ _id: r._id }, { projection: { items: 1 } });
      if (!left?.items?.length) {
        await releases.deleteOne({ _id: r._id });
        console.log(`  release ${r.number} had nothing else on it — deleted`);
      }
    }
    await drawings.updateMany({ partIds: oid }, { $pull: { partIds: oid } });
    await iterations.deleteMany({ partId: oid });
    await thumbs.deleteMany({ partId: oid });
    await logs.deleteMany({ partId: oid });
    await parts.deleteOne({ _id: oid });
    console.log("  -> removed\n");
  }

  if (!APPLY) console.log("Dry run. Re-run with --apply to remove.");
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
