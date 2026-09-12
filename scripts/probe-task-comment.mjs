/**
 * Find out what Onshape actually wants for a comment on a task.
 *
 * Three attempts have now failed, each differently, and each fix was an
 * inference:
 *
 *   {message, objectId}                  -> 500 with a support code
 *   ...same, after a gateway outage      -> 502 (not the request at all)
 *   {message, objectId, objectType: 14}  -> 400 "An illegal argument"
 *
 * 14 is TASK's ordinal in Onshape's declared `BTMetadataObjectType` enum. The
 * enum is real and ordered; that its ordinals are the comment API's codes was
 * a guess, and the 400 says the guess is wrong.
 *
 * So this stops guessing. It reads what Onshape itself puts on a comment, and
 * — only if asked — tries candidate bodies one at a time and reports which one
 * Onshape accepts. Evidence, not another inference.
 *
 * Run it from the deployment directory, so .env.local is found:
 *
 *   node probe-task-comment.mjs                 # read only: what is there
 *   node probe-task-comment.mjs --task <id>     # a particular task
 *   node probe-task-comment.mjs --apply         # also TRY posting, one variant
 *                                               at a time, stopping at the
 *                                               first that works
 *
 * `--apply` creates real comments on a real task — one per variant tried, up
 * to the first success. Each is prefixed so they are easy to find and delete,
 * and the id of every one created is printed.
 */
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const taskFlag = argv.indexOf("--task");
const WANT_TASK = taskFlag >= 0 ? argv[taskFlag + 1] : null;

function loadEnv() {
  const out = { ...process.env };
  const file = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
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

const API = env.ONSHAPE_API_URL || "https://cad.onshape.com/api";
const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

/** BTMetadataObjectType, in declared order — the enum the 14 came from. */
const BT_METADATA_OBJECT_TYPE = [
  "GLOBAL", "DOCUMENT", "PART", "ASSEMBLY", "DRAWING", "PART_STUDIO",
  "BLOB_ELEMENT", "APP_ELEMENT", "VERSION", "WORKSPACE", "PROJECT", "ITEM",
  "FEATURE_STUDIO", "CHANGE_REQUEST", "TASK", "CHANGE_ORDER", "CHANGE_TASK",
  "VARIABLE_STUDIO", "DRAWING_ANNOTATIONS", "FOLDER",
];

try {
  await client.connect();
  const db = client.db(env.MONGODB_DB || "plm");

  const task = WANT_TASK
    ? await db.collection("tasks").findOne({
        $or: [{ onshapeTaskId: WANT_TASK }, { name: WANT_TASK }],
      })
    : await db.collection("tasks").findOne({}, { sort: { updatedAt: -1 } });

  if (!task) {
    console.error("No task in PLM to probe. Press Sync from Onshape on the Tasks page first.");
    process.exit(1);
  }

  const ent = await db.collection("enterprises").findOne({ _id: task.enterpriseId });
  let user = ent?.integrationUserId
    ? await db.collection("users").findOne({ _id: ent.integrationUserId })
    : null;
  if (!user?.onshapeAccessToken) {
    user = await db.collection("users").findOne(
      { enterpriseId: task.enterpriseId, onshapeAccessToken: { $nin: [null, ""] } },
      { sort: { role: 1, onshapeConnectedAt: -1 } }
    );
  }
  if (!user?.onshapeAccessToken) {
    console.error("No connected Onshape account to act as. Connect one in Settings.");
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${user.onshapeAccessToken}`,
    Accept: "application/json;charset=UTF-8; qs=0.09",
    "Content-Type": "application/json;charset=UTF-8; qs=0.09",
  };

  console.log(`task     : ${task.name || "(untitled)"}`);
  console.log(`  id     : ${task.onshapeTaskId}`);
  console.log(`  state  : ${task.state}`);
  console.log(`  doc    : ${task.documentId || "(none — the task is not about a document)"}`);
  console.log(`  element: ${task.elementId || "-"}`);
  console.log(`  reading as ${user.onshapeEmail || user.email}\n`);

  /* ---------------------------------------------------------------- 1. read */

  console.log("1. What Onshape says about the task");
  const tRes = await fetch(`${API}/tasks/${encodeURIComponent(task.onshapeTaskId)}`, { headers });
  const tText = await tRes.text();
  console.log(`   GET /tasks/${task.onshapeTaskId} -> ${tRes.status}`);
  if (!tRes.ok) {
    console.log(`   ${tText.slice(0, 300)}`);
    process.exit(1);
  }
  const live = JSON.parse(tText);
  console.log(`   documentId  : ${live.documentId || "(empty)"}`);
  console.log(`   workspaceId : ${live.workspaceId || "(empty)"}`);
  console.log(`   versionId   : ${live.versionId || "(empty)"}`);
  console.log(`   elementId   : ${live.elementId || "(empty)"}`);
  console.log(`   objectId    : ${live.objectId || "(empty)"}`);
  console.log(`   taskType    : ${live.taskType || "(empty)"}`);
  console.log(`   comments    : ${(live.comments ?? []).length}`);

  /*
   * The task's own metadata properties.
   *
   * `updateTask` takes `propertyValues` — documented as "Task metadata
   * properties" — and `BTTaskInfo.properties` is the list of what a task has.
   * If one of them is a comment or notes field, then a "comment" on a task is
   * a property write through `POST /tasks/{tid}`, not a `/comments` POST at
   * all, and every attempt so far has been at the wrong endpoint.
   */
  const props = Array.isArray(live.properties) ? live.properties : [];
  console.log(`\n   The task's metadata properties (${props.length}):`);
  if (!props.length) {
    console.log("     none — so a comment is not a property on this task");
  }
  for (const pr of props) {
    const flags = [
      pr.editable ? "editable" : "read-only",
      pr.required ? "required" : null,
      pr.valueType,
    ].filter(Boolean).join(", ");
    const val = pr.value == null ? "" : ` = ${JSON.stringify(pr.value).slice(0, 60)}`;
    console.log(`     ${String(pr.name ?? "(unnamed)").padEnd(24)} ${pr.propertyId}  [${flags}]${val}`);
  }

  const commentish = props.filter(
    (pr) => /comment|note|remark|reason|message/i.test(String(pr.name ?? "")) && pr.editable
  );
  if (commentish.length) {
    console.log(
      `\n   -> ${commentish.length} editable property/properties look like a comment field: ` +
      `${commentish.map((pr) => `"${pr.name}" (${pr.propertyId})`).join(", ")}.`
    );
    console.log(
      "      If one of these is it, a task comment is a property write through\n" +
      "      POST /tasks/{tid} with propertyValues — not a /comments POST."
    );
  }

  /*
   * An existing comment is the whole answer if there is one: it carries the
   * exact fields Onshape itself set, and copying those needs no inference.
   */
  if ((live.comments ?? []).length) {
    console.log("\n   An existing comment — these are the fields to copy:");
    const c = live.comments[0];
    for (const k of ["id", "objectId", "objectType", "documentId", "workspaceId",
                     "versionId", "elementId", "parentId", "topLevel", "state"]) {
      if (c[k] !== undefined) console.log(`     ${k.padEnd(12)} ${JSON.stringify(c[k])}`);
    }
    const code = c.objectType;
    if (typeof code === "number") {
      console.log(
        `\n   -> objectType for a task comment on this tenant is ${code}` +
        `${BT_METADATA_OBJECT_TYPE[code] ? ` (${BT_METADATA_OBJECT_TYPE[code]} in BTMetadataObjectType)` : ""}.`
      );
      console.log(`      Set ONSHAPE_COMMENT_OBJECT_TYPE_TASK=${code} and PLM will use it.`);
    }
  } else {
    console.log(
      "\n   No comments on this task yet, so there is nothing to copy the fields from.\n" +
      "   THE QUICKEST FIX: add one comment to this task in Onshape's own UI, press Sync\n" +
      "   from Onshape on the Tasks page, and run this again — PLM copies the objectType\n" +
      "   off an existing comment automatically, so it may then just work."
    );
  }

  /* ------------------------------------------------------- 2. what is queryable */

  console.log("\n2. Whether the comment API can see this task");
  for (const q of [
    `objectId=${encodeURIComponent(task.onshapeTaskId)}`,
    `did=${encodeURIComponent(live.documentId || "")}`,
  ]) {
    if (q.endsWith("=")) continue;
    const r = await fetch(`${API}/comments?${q}&limit=5`, { headers });
    const body = await r.text();
    console.log(`   GET /comments?${q} -> ${r.status}`);
    if (r.ok) {
      try {
        const j = JSON.parse(body);
        const items = j.items ?? j ?? [];
        console.log(`     ${Array.isArray(items) ? items.length : 0} comment(s)`);
        if (Array.isArray(items) && items.length) {
          const types = [...new Set(items.map((x) => x.objectType))];
          console.log(`     objectType values present: ${JSON.stringify(types)}`);
        }
      } catch { console.log(`     (unparsed) ${body.slice(0, 160)}`); }
    } else {
      console.log(`     ${body.slice(0, 200)}`);
    }
  }

  /* ------------------------------------------------------------- 3. probe */

  if (!APPLY) {
    console.log(
      "\n3. Candidate request bodies (not sent — re-run with --apply to try them)\n"
    );
  } else {
    console.log("\n3. Trying candidate bodies, stopping at the first Onshape accepts\n");
  }

  const stamp = Date.now().toString(36);
  const base = { message: `PLM probe ${stamp} — safe to delete` };

  /*
   * Ordered cheapest-to-most-specific. Each differs from the last by ONE
   * thing, so whichever succeeds says what the missing piece was — a body that
   * changed three fields at once would prove nothing.
   */
  const candidates = [
    { label: "objectId + TASK(14)", body: { ...base, objectId: task.onshapeTaskId, objectType: 14 } },
    { label: "objectId only", body: { ...base, objectId: task.onshapeTaskId } },
    { label: "objectId + CHANGE_TASK(16)", body: { ...base, objectId: task.onshapeTaskId, objectType: 16 } },
    { label: "objectId + CHANGE_REQUEST(13)", body: { ...base, objectId: task.onshapeTaskId, objectType: 13 } },
    { label: "objectId + DOCUMENT(1) + did", body: { ...base, objectId: task.onshapeTaskId, objectType: 1, documentId: live.documentId } },
    /*
     * A task's `objectId` is the workflowable object it is ABOUT — a release
     * package, say — which is not the same as the task's own id. If a task's
     * comments are really comments on that object, this is the body that
     * works and none of the others will.
     */
    ...(live.objectId && live.objectId !== task.onshapeTaskId
      ? [
          { label: "the task's objectId + TASK(14)", body: { ...base, objectId: live.objectId, objectType: 14 } },
          { label: "the task's objectId, no type", body: { ...base, objectId: live.objectId } },
        ]
      : []),
    ...(live.documentId
      ? [
          { label: "TASK(14) + did", body: { ...base, objectId: task.onshapeTaskId, objectType: 14, documentId: live.documentId } },
          { label: "TASK(14) + did + wid", body: { ...base, objectId: task.onshapeTaskId, objectType: 14, documentId: live.documentId, workspaceId: live.workspaceId } },
          { label: "did only (a plain document comment)", body: { ...base, documentId: live.documentId, workspaceId: live.workspaceId } },
        ]
      : []),
  ];

  /*
   * Property writes through updateTask, which is a different endpoint.
   *
   * Tried first, because if this is the mechanism then no /comments body will
   * ever work and the other candidates are all noise.
   */
  for (const pr of commentish) {
    candidates.unshift({
      label: `updateTask propertyValues "${pr.name}"`,
      endpoint: `/tasks/${encodeURIComponent(task.onshapeTaskId)}`,
      body: { propertyValues: [{ propertyId: pr.propertyId, value: base.message }] },
    });
  }

  const created = [];
  for (const c of candidates) {
    const endpoint = c.endpoint ?? "/comments";
    if (!APPLY) {
      console.log(`   POST ${endpoint.padEnd(30)} ${c.label.padEnd(34)} ${JSON.stringify(c.body)}`);
      continue;
    }
    const r = await fetch(`${API}${endpoint}`, {
      method: "POST", headers, body: JSON.stringify(c.body),
    });
    const body = await r.text();
    console.log(`   ${c.label.padEnd(38)} -> ${r.status}  (POST ${endpoint})`);
    if (r.ok) {
      let id = null;
      try { id = JSON.parse(body).id; } catch {}
      if (id) created.push(id);
      console.log(`\n   -> ACCEPTED by POST ${endpoint}: ${JSON.stringify(c.body)}`);
      if (c.endpoint) {
        console.log(
          "      So a task comment is a PROPERTY WRITE, not a /comments POST. PLM needs to\n" +
          "      send it through updateTask instead — tell me and I will change it."
        );
      }
      if (typeof c.body.objectType === "number") {
        console.log(`      Set ONSHAPE_COMMENT_OBJECT_TYPE_TASK=${c.body.objectType} in .env.local.`);
      }
      if (c.body.documentId) {
        console.log(
          `      It also needed documentId — PLM sends that when the task has one, and this\n` +
          `      task's is ${live.documentId || "(empty)"}.`
        );
      }
      console.log(`      Comment id ${id ?? "(not reported)"} — delete it in Onshape.`);
      break;
    }
    const msg = (() => { try { return JSON.parse(body).message; } catch { return body.slice(0, 120); } })();
    console.log(`      ${msg}`);
  }

  if (APPLY && created.length) {
    console.log(`\n   Created ${created.length} probe comment(s): ${created.join(", ")}`);
    console.log("   They are prefixed \"PLM probe\" so they are easy to find and remove.");
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
