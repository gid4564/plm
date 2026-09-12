/**
 * Print what Onshape actually returns for a release package.
 *
 * Written because a release refused with
 *   The Onshape package offers no approve transition from state "". Available: none.
 * and the empty state was the tell: a package whose transitions are merely out
 * of an account's reach still reports the state it is in. PLM was not finding
 * the workflow information in the payload, and the message blamed the service
 * account's approver rights on no evidence at all.
 *
 * Which field carries the available actions on this endpoint is unknown U2 in
 * docs/ONSHAPE-INTEGRATION-SPEC.md, and the plan recorded there is to read them
 * off a live package rather than infer them from the docs. This is that read —
 * and it needs no second release attempt, because the package already exists.
 *
 * Runs with plain `node` using the driver already in the deployed bundle. Run it
 * from the directory the release was extracted into, so .env.local is found.
 *
 *   node dump-release-package.mjs               # newest release with a package
 *   node dump-release-package.mjs REL-000004    # a particular one
 *   node dump-release-package.mjs --rpid <id>   # a package id directly
 *   node dump-release-package.mjs --full        # whole payload, not just shape
 *
 * Default output is the payload's *shape* — keys and types, with values shown
 * only where they look like a state or an action. That is what settles the
 * question, and it is safe to paste. `--full` prints everything, which includes
 * part names, numbers and whoever is named as approver.
 */
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const argv = process.argv.slice(2);
const FULL = argv.includes("--full");
const rpidFlag = argv.indexOf("--rpid");
const RPID = rpidFlag >= 0 ? argv[rpidFlag + 1] : null;
const RELEASE_NUMBER = argv.find((a) => !a.startsWith("--") && a !== RPID) ?? null;

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

/** Keys and types. Values only where the key looks like the thing being hunted. */
const WORTH_SHOWING = /state|status|action|transition|type|workflow|approver|id$/i;

function shape(v, depth = 4, key = "") {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) {
    if (v.length === 0) return "array[0]";
    if (depth <= 0) return `array[${v.length}]`;
    return `array[${v.length}] of ${shape(v[0], depth - 1)}`;
  }
  if (typeof v === "object") {
    if (depth <= 0) return "object";
    return `{\n${Object.entries(v)
      .map(([k, x]) => `  ${k}: ${shape(x, depth - 1, k).replace(/\n/g, "\n  ")}`)
      .join("\n")}\n}`;
  }
  if (typeof v === "string") {
    if (WORTH_SHOWING.test(key) && v.length <= 60) return JSON.stringify(v);
    return `string(${v.length})`;
  }
  return String(v);
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

try {
  await client.connect();
  const db = client.db(env.MONGODB_DB || "plm");

  let rpid = RPID;
  let enterpriseId = null;

  if (!rpid) {
    const q = RELEASE_NUMBER
      ? { number: RELEASE_NUMBER }
      : { onshapeReleasePackageId: { $nin: [null, ""] } };
    const release = await db.collection("releases").findOne(q, { sort: { createdAt: -1 } });
    if (!release) {
      console.error(
        RELEASE_NUMBER
          ? `No release numbered ${RELEASE_NUMBER}.`
          : "No release in this database has an Onshape release package id."
      );
      process.exit(1);
    }
    rpid = release.onshapeReleasePackageId;
    enterpriseId = release.enterpriseId;
    console.log(`release ${release.number}  state=${release.state}  onshapeState=${release.onshapeState || "-"}`);
    console.log(`  package id : ${rpid || "(none stored)"}`);
    console.log(`  workflow   : ${release.onshapeWorkflowId || "(not recorded)"}`);
    console.log(`  items      : ${(release.items ?? []).length}`);
    if ((release.items ?? []).length === 0) {
      console.log(
        `  NOTE: this release has no items. A takeover reads them from the package, so ` +
        `an\n        empty release is a second sign that the stored id does not name a ` +
        `real\n        release package.`
      );
    }
    console.log("");
    if (!rpid) {
      console.error("This release has no Onshape package, so there is nothing to read.");
      process.exit(1);
    }
  }

  /*
   * What PLM itself recorded, alongside what Onshape says.
   *
   * The part page finds a drawing with `Drawing.find({ partIds: <part id> })`,
   * so an association that looks missing in the UI is either an empty
   * `partIds` or a mismatch — and those are different problems. Printed here
   * because guessing between them from a screenshot is how three wrong
   * hypotheses got written.
   */
  if (!RPID) {
    const rel = await db.collection("releases").findOne(
      RELEASE_NUMBER ? { number: RELEASE_NUMBER } : { onshapeReleasePackageId: rpid }
    );
    const items = rel?.items ?? [];
    console.log("what PLM recorded for this release:");
    for (const it of items) {
      if (it.kind === "part") {
        const part = await db.collection("parts").findOne({ _id: it.partId });
        const drawingsFor = await db.collection("drawings")
          .find({ partIds: it.partId }).project({ number: 1, name: 1 }).toArray();
        console.log(`  part    ${part?.number ?? "(missing)"}  ${part?.name ?? ""}`);
        console.log(`          _id ${it.partId}  kind=${part?.kind ?? "?"}  state=${part?.lifecycleState ?? "?"}`);
        console.log(
          `          drawings whose partIds contain it: ` +
          `${drawingsFor.length ? drawingsFor.map((d) => d.number || d.name).join(", ") : "NONE"}`
        );
      } else if (it.kind === "drawing") {
        const dwg = await db.collection("drawings").findOne({ _id: it.drawingId });
        const ids = (dwg?.partIds ?? []).map(String);
        console.log(`  drawing ${dwg?.number ?? "(missing)"}  ${dwg?.name ?? ""}`);
        console.log(`          _id ${it.drawingId}  state=${dwg?.lifecycleState ?? "?"}`);
        console.log(`          partIds: ${ids.length ? ids.join(", ") : "EMPTY — this is the association that is missing"}`);
        const sheets = await db.collection("drawingfiles")
          .find({ drawingId: it.drawingId }).project({ stage: 1, version: 1, releaseId: 1 }).toArray();
        console.log(
          `          sheets : ${sheets.length
            ? sheets.map((f) => `v${f.version} ${f.stage}`).join(", ")
            : "none captured"}`
        );
      }
    }

    /* A part row created for a drawing is the older bug's leftover. */
    const suspect = await db.collection("parts")
      .find({ partId: "" , kind: "part" }).project({ number: 1, name: 1, elementName: 1 }).toArray();
    if (suspect.length) {
      console.log(
        `\n  ${suspect.length} part row(s) have no Onshape partId and are typed "part":`
      );
      for (const x of suspect) console.log(`    ${x.number}  ${x.name || x.elementName}`);
      console.log(
        `  An assembly legitimately has no partId, but it would be typed "assembly". A\n` +
        `  row like this is most likely a drawing that was synced as a part before that\n` +
        `  was fixed — clear it with reset-test-data.mjs.`
      );
    }
    console.log("");
  }

  /*
   * The token of the account PLM transitions as.
   *
   * The same account, deliberately: a package's available actions depend on who
   * is asking, so reading them as anybody else would answer a different
   * question than the one that failed.
   */
  const enterprise = enterpriseId
    ? await db.collection("enterprises").findOne({ _id: enterpriseId })
    : await db.collection("enterprises").findOne({});
  if (!enterprise) {
    console.error("No enterprise found.");
    process.exit(1);
  }

  let user = enterprise.integrationUserId
    ? await db.collection("users").findOne({ _id: enterprise.integrationUserId })
    : null;
  if (!user?.onshapeAccessToken) {
    user = await db.collection("users").findOne(
      { enterpriseId: enterprise._id, onshapeAccessToken: { $nin: [null, ""] } },
      { sort: { role: 1, onshapeConnectedAt: -1 } }
    );
  }
  if (!user?.onshapeAccessToken) {
    console.error("No connected Onshape account to read as. Connect one in Settings.");
    process.exit(1);
  }

  const who = user.onshapeEmail || user.email || "(unknown)";
  const isIntegration = String(user._id) === String(enterprise.integrationUserId ?? "");
  console.log(`reading as ${who}${isIntegration ? " (the configured service account)" : " (NOT the service account — no service account is set)"}\n`);

  const res = await fetch(`${API}/releasepackages/${encodeURIComponent(rpid)}`, {
    headers: {
      Authorization: `Bearer ${user.onshapeAccessToken}`,
      Accept: "application/json;charset=UTF-8; qs=0.09",
    },
  });

  const text = await res.text();
  console.log(`GET /releasepackages/${rpid} -> ${res.status}\n`);

  if (!res.ok) {
    console.log(text.slice(0, 2000));
    console.log(
      res.status === 401
        ? "\nThe token is rejected. Reconnect the account in Settings."
        : res.status === 404
          ? "\nOnshape does not know this package id. PLM may have stored the wrong id."
          : ""
    );
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log("Response is not JSON:\n");
    console.log(text.slice(0, 2000));
    process.exit(1);
  }

  if (FULL) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log("Payload shape (values shown where the key looks relevant):\n");
    console.log(shape(data));
  }

  /*
   * Say plainly which of the candidate field names hold something, because that
   * is the whole question. A name listed here is a name PLM already looks in;
   * the useful answer is either which one hit, or that none did — in which case
   * the shape above names the field nobody has thought of yet.
   */
  const at = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
  const STATE_PATHS = [
    "state", "stateName", "workflowState", "workflowState.name", "workflowState.state",
    "workflow.state", "workflow.stateName", "workflow.currentState",
    "currentState", "currentState.name", "stateInfo.name",
  ];
  const ACTION_PATHS = [
    "workflowActions", "actions", "availableActions", "transitions",
    "workflow.actions", "workflow.availableActions", "workflow.transitions",
    "workflow.workflowActions", "actionableInfo.actions", "nextActions", "allowedActions",
  ];

  console.log("\nWhere PLM looks for the state:");
  let anyState = false;
  for (const p of STATE_PATHS) {
    const v = at(data, p);
    if (typeof v === "string" && v !== "") { console.log(`  ${p} = ${JSON.stringify(v)}`); anyState = true; }
  }
  if (!anyState) console.log("  nothing in any of them");

  console.log("\nWhere PLM looks for the available actions:");
  let anyAction = false;
  for (const p of ACTION_PATHS) {
    const v = at(data, p);
    if (Array.isArray(v) && v.length) {
      console.log(`  ${p} = ${JSON.stringify(v).slice(0, 600)}`);
      anyAction = true;
    }
  }
  if (!anyAction) console.log("  nothing in any of them");

  /*
   * Who Onshape will actually let act.
   *
   * This is the part that matters when Onshape accepts a transition and does
   * nothing: it returns 200, leaves transitionStatus HEALTHY, and never moves
   * the package. The action's own flags and the approver list explain it, and
   * nothing else does.
   */
  const wf = data.workflow ?? {};
  const actions = Array.isArray(wf.actions) ? wf.actions : [];
  if (actions.length) {
    console.log("\nWho may perform each action:");
    const approvers = (Array.isArray(wf.approverIds) ? wf.approverIds : []).map(String);

    // The account this script authenticated as — the same one PLM transitions
    // as, which is the only identity worth comparing against.
    let me = null;
    const meRes = await fetch(`${API}/users/sessioninfo`, {
      headers: {
        Authorization: `Bearer ${user.onshapeAccessToken}`,
        Accept: "application/json;charset=UTF-8; qs=0.09",
      },
    });
    if (meRes.ok) {
      try { me = JSON.parse(await meRes.text()); } catch {}
    }
    const myId = me?.id ? String(me.id) : null;

    console.log(`  acting Onshape user : ${myId ?? "(could not read /users/sessioninfo)"}${me?.email ? ` (${me.email})` : ""}`);
    console.log(`  designated approvers: ${approvers.length ? approvers.join(", ") : "(none named)"}`);
    console.log(`  raised the package  : ${wf.isCreator ? "yes, this account did" : "no"}`);
    console.log(`  createdBy           : ${data.createdBy?.id ?? "-"}`);
    console.log(`  am I an approver    : ${myId ? (approvers.includes(myId) ? "YES" : "NO") : "unknown"}`);
    console.log("");

    for (const a of actions) {
      const id = a.action ?? a.id ?? "?";
      const flags = [
        a.isApproverAction ? "approvers only" : null,
        a.alwaysAllow ? "always allowed" : null,
        a.allowIfNoApprovers ? "allowed if no approvers named" : null,
        a.isCreatorOverride ? "creator may override" : null,
        a.isAdminOverride ? "admin may override" : null,
      ].filter(Boolean);
      console.log(`  ${String(id).padEnd(16)} type=${String(a.type).padEnd(10)} ${flags.join(", ") || "no restrictions stated"}`);
    }

    /* The verdict, for the APPROVE action specifically. */
    const approve = actions.find((a) => String(a.type).toUpperCase() === "APPROVE");
    if (approve && myId) {
      const permitted =
        approve.alwaysAllow ||
        !approve.isApproverAction ||
        (approvers.length === 0 && approve.allowIfNoApprovers) ||
        approvers.includes(myId) ||
        (wf.isCreator && approve.isCreatorOverride);

      console.log(
        permitted
          ? `\n  -> Nothing on this package rules this account out of "${approve.action ?? approve.id}".`
          : `\n  -> This account CANNOT perform "${approve.action ?? approve.id}".\n` +
            `     It is restricted to designated approvers${wf.isCreator ? ", and this account raised\n     the package, which is not the same thing" : ""}.\n` +
            `     Onshape reports no error for this — it accepts the POST and ignores it, which is\n` +
            `     exactly the "accepted but still Pending" symptom.\n` +
            `     Fix: add ${myId} as a designated approver on the release workflow, or nominate an\n` +
            `     account that already is as the service account in PLM's Settings.`
      );
    }
  }

  console.log("\nTop-level keys:");
  console.log(`  ${Object.keys(data).join(", ")}`);

  /*
   * Is this id even a release package?
   *
   * The webhook that starts a takeover falls back to `objectId` /
   * `workflowObjectId` when the payload names no release package explicitly —
   * and which field distinguishes a release-package transition from a revision
   * transition is unknown U1 in the spec. If Onshape sent a *workflow object*
   * id, PLM stored that, and asking /releasepackages for it can answer 200 with
   * a stub carrying no state and no actions: exactly the reported symptom.
   *
   * /workflow/obj/{id} is the discriminator. If that answers for this id while
   * /releasepackages returns a stub, the stored id is the wrong kind of thing
   * and no amount of workflow reconfiguration will fix the release.
   */
  if (!anyState && !anyAction) {
    console.log("\nChecking whether this id is a release package at all:");
    const wf = await fetch(`${API}/workflow/obj/${encodeURIComponent(rpid)}`, {
      headers: {
        Authorization: `Bearer ${user.onshapeAccessToken}`,
        Accept: "application/json;charset=UTF-8; qs=0.09",
      },
    });
    const wfText = await wf.text();
    console.log(`  GET /workflow/obj/${rpid} -> ${wf.status}`);
    if (wf.ok) {
      let wfData = null;
      try { wfData = JSON.parse(wfText); } catch {}
      if (wfData) {
        console.log(`  keys: ${Object.keys(wfData).join(", ")}`);
        console.log(`  shape: ${shape(wfData, 3).replace(/\n/g, "\n  ")}`);
        console.log(
          "\n  -> This id IS a workflow object. If /releasepackages returned a stub for " +
          "it,\n     then PLM stored a workflow-object id where a release-package id " +
          "belongs.\n     That is a PLM bug in the webhook, not a workflow " +
          "misconfiguration:\n     releasePackageIdFrom() in the webhook route falls back to " +
          "objectId."
        );
      }
    } else {
      console.log(`  not a workflow object either: ${wfText.slice(0, 300)}`);
    }
  }

  if (!anyState && !anyAction) {
    console.log(
      "\nNeither is where PLM looks. The top-level keys above are the answer — " +
      "whichever of them holds the workflow is the field to add."
    );
  } else if (!anyAction) {
    console.log(
      `\nThe state reads fine, so the package is being read correctly; it offers this ` +
      `account no transitions. That is consistent with the service account not being a ` +
      `designated approver on the release workflow${isIntegration ? "" : " — and note no service account is configured, so this was read as somebody else"}.`
    );
  }
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
