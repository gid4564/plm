/**
 * A drawing-refresh retry chain interrupted by a restart is resumed, not lost.
 *
 * `scheduleDrawingRefresh`'s chain lives only in the process's memory — a
 * `setTimeout` in a module-level Map — so a deploy or a crash partway through
 * one used to drop it silently: `drawingRefreshPending` stayed true forever,
 * with nothing logged and nothing retried, until a lucky webhook redelivery or
 * a person noticing the release page still said "outstanding". Given how often
 * this process gets redeployed, that was a plausible cause of a released
 * drawing that "sometimes" never shows up — not a genuine Onshape failure.
 *
 * `resumePendingDrawingRefreshes` (called once from `instrumentation.ts` at
 * boot) is the fix: sweep for releases still marked pending and restart their
 * chains. This proves it actually collects the drawing once resumed, and that
 * it does not reach back for a release whose outstanding collection is old
 * enough to have already been logged as given-up-on.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";
// A near-instant schedule, so the resumed chain actually fires during this run
// instead of the test needing to wait out the real default (15s+).
process.env.PLM_DRAWING_REFRESH_RETRIES_MS = "60";

import { connectDb } from "../src/lib/db";
import {
  ActivityLog, Drawing, DrawingFile, Enterprise, MockOnshapeDrawing, MockReleasePackage,
  Release, User,
} from "../src/lib/models";
import { resumePendingDrawingRefreshes } from "../src/lib/release";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMPANY = "mock-company-drawing-resume";
const DOC = "d1a2b3c4d5e6f70819202188";
const DWG = "e9a8b7c6d5e4f30219202188";
const RPID = "mock-rp-resume-test";

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [Drawing, DrawingFile, Release, User, ActivityLog]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }
  for (const M of [MockOnshapeDrawing, MockReleasePackage]) {
    await (M as any).deleteMany({ companyId: COMPANY });
  }

  const ent: any = await Enterprise.create({
    onshapeCompanyId: COMPANY, name: "Resume Test Co", releaseTakeoverEnabled: true,
  });
  await User.create({
    email: "approver@resume-test.test", passwordHash: "x", name: "Ann Approver",
    role: "approver", enterpriseId: ent._id,
  });

  await MockOnshapeDrawing.create({
    companyId: COMPANY, documentId: DOC, documentName: "Resume Test Doc",
    elementId: DWG, elementName: "Resume Test Drawing", partIds: [],
    revisions: [{ revision: "A", versionId: "mock-v-resume", createdAt: new Date() }],
  });
  await MockReleasePackage.create({
    companyId: COMPANY, rpid: RPID, wfid: "mock-workflow", state: "RELEASED",
    changeOrderId: "CO-RESUME",
    items: [{
      id: "i1", documentId: DOC, elementId: DWG, partId: "", elementType: "DRAWING",
      name: "Resume Test Drawing", partNumber: "", revisionId: "", revision: "A",
      versionId: "mock-v-resume",
    }],
  });

  const drawing: any = await Drawing.create({
    enterpriseId: ent._id, documentId: DOC, elementId: DWG, workspaceId: "w1",
    number: "DWG-90001", name: "Resume Test Drawing", lifecycleState: "Released",
    attributes: {},
  });

  console.log("\nA recent release still marked pending, and a stale one");
  const recent: any = await Release.create({
    enterpriseId: ent._id, number: "REL-90001", origin: "onshape", state: "Released",
    onshapeReleasePackageId: RPID, drawingRefreshPending: true,
    items: [{ kind: "drawing", drawingId: drawing._id, onshapeItemId: "i1", revision: "", versionId: "" }],
  });
  const staleRel: any = await Release.create({
    enterpriseId: ent._id, number: "REL-90002", origin: "onshape", state: "Released",
    onshapeReleasePackageId: RPID, drawingRefreshPending: true,
    items: [{ kind: "drawing", drawingId: drawing._id, onshapeItemId: "i1", revision: "", versionId: "" }],
  });
  // Backdated with the raw driver: Mongoose's timestamps plugin overwrites
  // `updatedAt` on every `save`/`updateOne` it sees, so going through the
  // model would just stamp "now" right back on.
  await Release.collection.updateOne(
    { _id: staleRel._id },
    { $set: { updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } }
  );
  const staleBefore: any = await Release.findById(staleRel._id).lean();
  check("the stale release really is outside the 24h window",
    Date.now() - new Date(staleBefore.updatedAt).getTime() > 24 * 60 * 60 * 1000);

  console.log("\nResuming at startup picks up only the recent one");
  const result = await resumePendingDrawingRefreshes();
  check("one release was found pending inside the window", result.found === 1,
    JSON.stringify(result));
  check("and its chain was scheduled", result.resumed === 1, JSON.stringify(result));

  // The schedule is 60ms; give the timer and the capture it triggers room to
  // run before checking what happened.
  await sleep(500);

  const afterRecent: any = await Release.findById(recent._id).lean();
  check("the resumed release is no longer marked pending",
    afterRecent?.drawingRefreshPending === false, JSON.stringify(afterRecent?.drawingRefreshPending));
  check("its refresh timestamp was stamped",
    !!afterRecent?.drawingRefreshedAt, String(afterRecent?.drawingRefreshedAt));

  const file: any = await DrawingFile.findOne({
    drawingId: drawing._id, releaseId: recent._id, stage: "as-released",
  }).lean();
  check("a released PDF was actually captured", !!file && !file.failedAt,
    JSON.stringify(file && { failedAt: file.failedAt, size: file.size }));
  check("carrying the revision the package reported",
    file?.revision === "A", String(file?.revision));

  console.log("\nThe stale release was left alone — nothing retried it silently");
  const afterStale: any = await Release.findById(staleRel._id).lean();
  check("still marked pending", afterStale?.drawingRefreshPending === true);
  const staleFile = await DrawingFile.findOne({
    drawingId: drawing._id, releaseId: staleRel._id,
  }).lean();
  check("and nothing was captured for it", !staleFile);

  console.log("\nA second sweep finds nothing left to resume");
  const again = await resumePendingDrawingRefreshes();
  check("the recent release is not offered again", again.found === 0, JSON.stringify(again));

  for (const M of [Drawing, DrawingFile, Release, User, ActivityLog]) {
    await (M as any).deleteMany({ enterpriseId: ent._id });
  }
  await Enterprise.deleteOne({ _id: ent._id });
  for (const M of [MockOnshapeDrawing, MockReleasePackage]) {
    await (M as any).deleteMany({ companyId: COMPANY });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
