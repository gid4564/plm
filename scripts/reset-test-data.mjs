/**
 * Clear PLM's test data, keeping the configuration you had to set up by hand.
 *
 * Testing against a real Onshape enterprise means syncing the same parts over
 * and over, and a demo is much easier to read from an empty system. What is
 * tedious to recreate, though, is exactly what a blunt "drop the database"
 * would take with it: your login, the Onshape connection and its tokens, the
 * OAuth client Onshape's extensions are registered against, and the attribute
 * metamodel. So this removes the *work* and leaves the *setup*.
 *
 * Runs with plain `node` using the driver already in the deployed bundle. Run it
 * from the directory the release was extracted into, so .env.local is found.
 *
 *   node reset-test-data.mjs                  # dry run: counts what would go
 *   node reset-test-data.mjs --apply          # remove parts, drawings, releases
 *   node reset-test-data.mjs --apply --all    # also numbering, simulator, tokens
 *
 * Groups, each off unless named (or implied by --all):
 *   (default)              parts, assemblies, iterations, BOM links, drawings,
 *                          drawing PDFs, captured 3D models, releases,
 *                          thumbnails, products, tasks, echo fingerprints,
 *                          activity log
 *   --numbering            reset the number sequences, so PLM-000001 comes back
 *   --simulator            the mock Onshape tenant's parts, drawings, packages
 *   --oauth-sessions       issued auth codes and access tokens (Onshape and any
 *                          external app must authorise again)
 *   --forget-onshape-schema  the cached Onshape property definitions, so the
 *                          next sync rediscovers them
 *   --attributes           the attribute metamodel. NOT in --all: it is
 *                          configuration, and reseeding it is a separate step
 *   --oauth-clients        the registered OAuth clients. NOT in --all: this is
 *                          what Onshape's extensions authenticate against, and
 *                          removing it means re-registering them in Onshape
 *
 * Never touched: users and enterprises. Losing either mid-test costs you the
 * login and the Onshape connection, which is the opposite of convenient.
 *
 * What this cannot do: reset Onshape. A part already released there keeps its
 * revision and its released state, and re-syncing will bring that back — as it
 * should. Clearing PLM is not an undo for a release.
 */
import fs from "node:fs";
import path from "node:path";
import { GridFSBucket, MongoClient } from "mongodb";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALL = argv.includes("--all");
/* Configuration, not test data — so --all leaves both alone and each needs
 * naming explicitly. */
const NOT_IN_ALL = ["--attributes", "--oauth-clients"];
const has = (f) => argv.includes(f) || (ALL && !NOT_IN_ALL.includes(f));

const entFlag = argv.indexOf("--enterprise");
const ENTERPRISE = entFlag >= 0 ? argv[entFlag + 1] : null;

const UNKNOWN = argv.filter(
  (a) =>
    a.startsWith("--") &&
    ![
      "--apply", "--all", "--numbering", "--simulator", "--oauth-sessions",
      "--forget-onshape-schema", "--attributes", "--oauth-clients", "--enterprise",
    ].includes(a)
);
if (UNKNOWN.length) {
  console.error(`Unknown option(s): ${UNKNOWN.join(", ")}`);
  console.error("Run with no arguments to see what a dry run reports.");
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
      // Real environment variables win, matching how Next resolves them.
      if (!(k in process.env)) out[k] = t.slice(i + 1).trim();
    }
  }
  return out;
}

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

const DB_NAME = env.MONGODB_DB || "plm";
const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

/* Collections by group. Named explicitly rather than derived, so a new
 * collection has to be classified deliberately instead of being swept up or
 * silently missed. */
const WORK = [
  "parts", "partiterations", "bomlinks", "drawings", "drawingfiles",
  /* Captured glTF snapshots — see src/lib/geometry.ts. Per-revision records
   * kept alongside a part, not configuration, so they leave with it. */
  "partgeometries",
  "releases", "partthumbnails",
  /* Groupings built on top of the parts being cleared, not configuration —
   * see ProductSchema. An empty product left behind after every part in it
   * is gone is exactly the clutter this script exists to remove. */
  "products",
  "selfwrites", "activitylogs",
  /*
   * Tasks are mirrored from Onshape, so clearing them loses nothing that is
   * not re-syncable — and a task board left over from a previous demo is
   * exactly the kind of clutter this script exists to remove.
   */
  "tasks",
];
const NUMBERING = ["numberingsequences", "numberissuedlogs"];
const SIMULATOR = ["mockonshapeparts", "mockonshapedrawings", "mockpropertydefs", "mockreleasepackages", "mockonshapetasks"];
const OAUTH_SESSIONS = ["oauthauthcodes", "oauthtokens"];
const ATTRIBUTES = ["attributedefinitions"];
const OAUTH_CLIENTS = ["oauthclients"];
const NEVER = ["users", "enterprises"];

try {
  await client.connect();
  const db = client.db(DB_NAME);
  const present = (await db.listCollections().toArray()).map((c) => c.name);

  /*
   * Make sure this is PLM's database.
   *
   * MOS runs on the same box with its own database, and this script carries
   * unrecoverable deletes. MOS's core collections are `manufacturingitems` and
   * `synclogs` and it has no `parts` or `releases`, so the two are easy to tell
   * apart — and worth telling apart before deleting anything, not after.
   */
  const looksLikeMos = present.includes("manufacturingitems") || present.includes("synclogs");
  const looksLikePlm = present.includes("parts") || present.includes("releases");

  if (looksLikeMos && !looksLikePlm) {
    console.error(
      `Refusing to touch "${DB_NAME}": it has ${
        present.filter((c) => ["manufacturingitems", "synclogs"].includes(c)).join(" and ")
      } and no parts/releases, which makes it MOS's database, not PLM's.\n` +
      `Check MONGODB_DB in .env.local.`
    );
    process.exit(1);
  }
  if (!looksLikePlm && present.length > 0) {
    console.error(
      `Refusing to touch "${DB_NAME}": it has neither a parts nor a releases collection, ` +
      `so it does not look like a PLM database.\nIt holds: ${present.join(", ")}`
    );
    process.exit(1);
  }
  if (present.length === 0) {
    console.log(`"${DB_NAME}" is empty — nothing to clear.`);
    process.exit(0);
  }

  /* Which enterprise, if scoped. */
  let scope = {};
  let scopeLabel = "every enterprise";
  if (ENTERPRISE) {
    const ents = await db.collection("enterprises").find({}).toArray();
    const match = ents.find(
      (e) => String(e._id) === ENTERPRISE || e.name === ENTERPRISE || e.onshapeCompanyId === ENTERPRISE
    );
    if (!match) {
      console.error(
        `No enterprise matches "${ENTERPRISE}". Known: ` +
        ents.map((e) => `${e.name || "(unnamed)"} [${e._id}]`).join(", ")
      );
      process.exit(1);
    }
    scope = { enterpriseId: match._id };
    scopeLabel = `${match.name || "(unnamed)"} [${match._id}]`;
  }

  const groups = [
    ["the work (parts, drawings, releases)", WORK, true],
    ["numbering sequences", NUMBERING, has("--numbering")],
    ["the Onshape simulator's tenant", SIMULATOR, has("--simulator")],
    ["issued OAuth codes and tokens", OAUTH_SESSIONS, has("--oauth-sessions")],
    ["the attribute metamodel", ATTRIBUTES, argv.includes("--attributes")],
    ["registered OAuth clients", OAUTH_CLIENTS, argv.includes("--oauth-clients")],
  ];

  console.log(`database : ${DB_NAME}`);
  console.log(`scope    : ${scopeLabel}`);
  console.log(`mode     : ${APPLY ? "APPLY — this deletes" : "dry run — nothing will change"}\n`);

  let total = 0;

  for (const [label, collections, on] of groups) {
    if (!on) continue;
    console.log(`${label}:`);
    for (const name of collections) {
      if (!present.includes(name)) continue;
      const col = db.collection(name);

      /*
       * The simulator's collections are keyed by Onshape company, not by PLM
       * enterprise, so an enterprise-scoped filter would match nothing there
       * and silently leave the simulator untouched.
       */
      const filter = SIMULATOR.includes(name) || !scope.enterpriseId ? {} : scope;

      const n = await col.countDocuments(filter);
      if (n === 0) { console.log(`  ${name.padEnd(22)} 0`); continue; }

      if (APPLY) {
        /* Models over 12MB live in GridFS, and deleting their rows leaves the
         * files behind — remove those first, while the rows still name them. */
        if (name === "partgeometries") {
          const bucket = new GridFSBucket(db, { bucketName: "part-geometry" });
          const withFiles = await col.find({ ...filter, gridfsFileId: { $ne: null } }).project({ gridfsFileId: 1 }).toArray();
          for (const r of withFiles) await bucket.delete(r.gridfsFileId).catch(() => {});
          if (withFiles.length) console.log(`  ${"(GridFS models)".padEnd(22)} ${String(withFiles.length).padStart(6)}  removed`);
        }
        const res = await col.deleteMany(filter);
        console.log(`  ${name.padEnd(22)} ${String(n).padStart(6)}  removed ${res.deletedCount}`);
      } else {
        console.log(`  ${name.padEnd(22)} ${String(n).padStart(6)}  would be removed`);
      }
      total += n;
    }
    console.log("");
  }

  /* Counters and caches that live on the enterprise, which is never deleted. */
  const unset = {};
  const set = { releasesIgnored: 0, lastReleaseIgnoredAt: null };
  if (has("--forget-onshape-schema")) {
    set.onshapePropertyDefs = [];
    set.onshapePropertyDefsCheckedAt = null;
  }

  const entFilter = scope.enterpriseId ? { _id: scope.enterpriseId } : {};
  const entCount = await db.collection("enterprises").countDocuments(entFilter);
  console.log("on the enterprise (never deleted, only reset):");
  console.log(`  release-ignored counters   ${entCount} enterprise(s)`);
  if (has("--forget-onshape-schema")) {
    console.log(`  cached Onshape property definitions cleared`);
  }
  if (APPLY && entCount) {
    await db.collection("enterprises").updateMany(entFilter, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  }

  const kept = NEVER.filter((c) => present.includes(c));
  console.log(`\nkept as-is: ${kept.join(", ")}`);
  if (!argv.includes("--attributes")) console.log("            attributedefinitions (pass --attributes to clear)");
  if (!argv.includes("--oauth-clients")) console.log("            oauthclients (pass --oauth-clients to clear)");

  if (!APPLY) {
    console.log(`\nDry run: ${total} document(s) would be removed. Re-run with --apply.`);
  } else {
    console.log(`\nRemoved ${total} document(s).`);
    console.log(
      "\nNote: this does not reset Onshape. Anything already released there keeps its " +
      "revision\nand released state, and the next sync will bring that back."
    );
    if (has("--numbering")) {
      console.log(
        "Numbering restarts from 1, so PLM will reissue numbers that Onshape parts may " +
        "still\ncarry. Fine on a scratch tenant; confusing on a shared one."
      );
    }
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
