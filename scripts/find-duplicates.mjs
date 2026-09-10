/**
 * Find (and optionally merge) PLM parts that describe the same Onshape part
 * more than once.
 *
 * Runs with plain `node` using the MongoDB driver already present in the
 * deployed bundle — no mongosh, no extra install. Run it from the directory the
 * release was extracted into, so `mongodb` resolves and .env.local is found.
 *
 *   node find-duplicates.mjs            # dry run
 *   node find-duplicates.mjs --merge    # apply
 *
 * Cause: configuration is part of the identity key, and Onshape reports the
 * configuration string inconsistently across entry points. A panel load could
 * file a part under the literal string "{$configuration}" while a webhook filed
 * the same part under "default" — two rows, two PLM numbers, one physical part.
 * `ignoreConfigurations` (on by default) prevents new ones; this finds any that
 * predate it, or that arrived some other way.
 *
 * A released part is never removed. That is a records decision, not a cleanup
 * one — the same rule the application applies in lib/sync.ts deletePart.
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
  const db = client.db(env.MONGODB_DB || "plm");
  const parts = db.collection("parts");
  const logs = db.collection("activitylogs");
  const iterations = db.collection("partiterations");
  const links = db.collection("bomlinks");
  const thumbs = db.collection("partthumbnails");
  const drawings = db.collection("drawings");

  /*
   * Group on partId alone, within an enterprise. Grouping on the full identity
   * would hide the very duplicates worth finding — if documentId or elementId
   * is what differs, a strict grouping never puts the rows side by side.
   *
   * Assemblies are excluded, and this is the one place PLM has to differ from
   * MOS: an assembly is an element with no partId, so every assembly in the
   * tenant shares the empty string and would group together as one enormous
   * false positive. They are keyed by their own elementId instead, so a genuine
   * assembly duplicate is still found.
   */
  const groupsByPart = await parts.aggregate([
    { $match: { partId: { $nin: [null, ""] } } },
    { $group: {
        _id: { e: "$enterpriseId", p: "$partId" },
        n: { $sum: 1 },
        rows: { $push: {
          id: "$_id", number: "$number", cfg: "$configuration", kind: "$kind",
          state: "$lifecycleState", revision: "$revision", iteration: "$iteration",
          name: "$name", doc: "$documentId", el: "$elementId", ws: "$workspaceId",
          docName: "$documentName", elName: "$elementName", created: "$createdAt" } },
    }},
    { $match: { n: { $gt: 1 } } },
  ]).toArray();

  const groupsByElement = await parts.aggregate([
    { $match: { kind: "assembly" } },
    { $group: {
        _id: { e: "$enterpriseId", el: "$elementId" },
        n: { $sum: 1 },
        rows: { $push: {
          id: "$_id", number: "$number", cfg: "$configuration", kind: "$kind",
          state: "$lifecycleState", revision: "$revision", iteration: "$iteration",
          name: "$name", doc: "$documentId", el: "$elementId", ws: "$workspaceId",
          docName: "$documentName", elName: "$elementName", created: "$createdAt" } },
    }},
    { $match: { n: { $gt: 1 } } },
  ]).toArray();

  const groups = [
    ...groupsByPart.map((g) => ({ ...g, label: `part ${g._id.p}` })),
    ...groupsByElement.map((g) => ({ ...g, label: `assembly element ${g._id.el}` })),
  ];

  /** Report which identity fields actually differ across a group. */
  const differingFields = (rows) =>
    ["doc", "el", "cfg"].filter((f) => new Set(rows.map((r) => String(r[f]))).size > 1);

  const FIELD_NAMES = { doc: "documentId", el: "elementId", cfg: "configuration" };

  if (groups.length === 0) {
    console.log("No duplicates found.");
  } else {
    console.log(`${groups.length} object(s) have more than one PLM record:\n`);

    let blocked = 0;

    for (const g of groups) {
      const diff = differingFields(g.rows);
      console.log(`  ${g.rows[0].name || g.label}  (${g.label})`);
      console.log(
        `    differs by: ${diff.length
          ? diff.map((d) => FIELD_NAMES[d]).join(", ")
          : "nothing — identical identity, the unique index may be missing"}`
      );

      for (const r of g.rows) {
        const ver = `${r.revision || "–"}.${r.iteration ?? 1}`;
        console.log(`    ${r.number}  ${ver}  ${r.state}`);
        console.log(`      documentId    ${r.doc}   ${r.docName ? `(${r.docName})` : "(name not recorded)"}`);
        console.log(`      elementId     ${r.el}   ${r.elName ? `(${r.elName})` : "(name not recorded)"}`);
        console.log(`      workspaceId   ${r.ws ?? "-"}`);
        console.log(`      configuration ${JSON.stringify(r.cfg)}`);
      }

      /*
       * A released row is never dropped, whichever one it is.
       *
       * If two rows for one part are both released they have separate revision
       * histories, and picking one to delete would destroy a record of what was
       * approved. That needs a person, so the group is reported and skipped.
       */
      const released = g.rows.filter((r) => r.revision || r.state === "Released" || r.state === "Obsolete");
      if (released.length > 1) {
        blocked++;
        console.log(
          `    -> SKIPPED: ${released.length} of these are released ` +
          `(${released.map((r) => `${r.number} rev ${r.revision || "?"}`).join(", ")}). ` +
          `Merging would destroy a release record — decide this one by hand.`
        );
        console.log("");
        continue;
      }

      /*
       * Keep the released row if there is exactly one — it is the record with
       * history behind it. Otherwise prefer the plainest configuration, then the
       * oldest row, which is the number Onshape is most likely already carrying.
       */
      const keep = released[0]
        ?? g.rows.find((r) => r.cfg === "default")
        ?? [...g.rows].sort((a, b) => new Date(a.created) - new Date(b.created))[0];
      const drop = g.rows.filter((r) => String(r.id) !== String(keep.id));

      console.log(
        `    -> keep ${keep.number}${released[0] ? " (released)" : ""}, ` +
        `remove ${drop.map((d) => d.number).join(", ")}`
      );

      if (MERGE) {
        for (const d of drop) {
          /*
           * Structure edges are repointed, not deleted. A BOM import may have
           * recorded children against the row being removed, and dropping those
           * would silently empty an assembly.
           *
           * Repointing can collide with an edge the kept row already has, since
           * (enterpriseId, parentId, childId) is unique. The collision means the
           * relationship is already recorded, so the duplicate edge is removed
           * rather than forced.
           */
          for (const field of ["parentId", "childId"]) {
            const other = field === "parentId" ? "childId" : "parentId";
            for (const link of await links.find({ [field]: d.id }).toArray()) {
              /*
               * Repointing can collapse both ends onto the kept row — if the
               * other end already IS the kept row, the edge becomes a part
               * containing itself. That renders as nonsense ("contains ×7
               * itself") and would make any tree walk non-terminating, so the
               * edge is dropped rather than moved. lib/bom-import.ts refuses
               * the same shape on the way in; this is the path that could
               * create one after the fact.
               */
              if (String(link[other]) === String(keep.id)) {
                await links.deleteOne({ _id: link._id });
                console.log(`       dropped a structure edge that would have self-referenced`);
                continue;
              }
              try {
                await links.updateOne({ _id: link._id }, { $set: { [field]: keep.id } });
              } catch {
                // The kept row already records this relationship; the duplicate
                // edge is the one to lose.
                await links.deleteOne({ _id: link._id });
              }
            }
          }

          /*
           * Drawings point at the parts they document, so the reference has to
           * move rather than just go.
           *
           * Read first, then write. Pulling the old id before finding out which
           * drawings held it loses the list — and the drawings would then be
           * left documenting nothing, which reads exactly like a drawing that
           * was never associated with a part.
           */
          const documenting = await drawings.find({ partIds: d.id }).project({ _id: 1 }).toArray();
          if (documenting.length) {
            const ids = documenting.map((x) => x._id);
            // $addToSet, so a drawing already pointing at the kept row does not
            // end up listing it twice.
            await drawings.updateMany({ _id: { $in: ids } }, { $addToSet: { partIds: keep.id } });
            await drawings.updateMany({ _id: { $in: ids } }, { $pull: { partIds: d.id } });
          }

          await iterations.deleteMany({ partId: d.id });
          await thumbs.deleteMany({ partId: d.id });
          await logs.deleteMany({ partId: d.id });
          await parts.deleteOne({ _id: d.id });
        }
        console.log("       merged.");
      }
      console.log("");
    }

    if (blocked) {
      console.log(`${blocked} group(s) were skipped because more than one row is released.\n`);
    }
    if (!MERGE) console.log("Dry run. Re-run with --merge to apply.");
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
