/**
 * Collecting the released drawing sheets without a person pressing a button.
 *
 * Onshape applies the revision, the watermark and the title-block fields while
 * it completes a release, and it fires `onshape.revision.created` *before* that
 * work is done. PLM collected the sheets synchronously inside that webhook, so
 * its one attempt was the earliest possible moment — usually too early. When it
 * came up short the release was left pending "for the next revision event", but
 * that event fires once per item, so a single-item release produced no next one
 * and somebody had to press Collect drawings by hand at the right moment.
 *
 * The retry chain is what removes that. What is worth pinning is not the delays
 * — those are configuration — but the behaviour around them: one chain per
 * release however many events arrive, a stop as soon as there is nothing
 * pending, a bounded give-up, and no throw escaping a timer (which would be an
 * unhandled rejection and would take the process down, and every other
 * release's retries with it).
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";
// Tiny delays: this tests the decisions, not the clock.
process.env.PLM_DRAWING_REFRESH_RETRIES_MS = "10,10,10";

import { connectDb } from "../src/lib/db";
import { Drawing, Enterprise, Release } from "../src/lib/models";
import {
  cancelDrawingRefresh, drawingRefreshSchedule, scheduleDrawingRefresh,
} from "../src/lib/release";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await connectDb();

  /*
   * Read lazily, which is the point of this first check.
   *
   * `import` declarations are hoisted above every statement in the importing
   * module, so the `process.env` assignment at the top of THIS file runs after
   * lib/release.ts has already loaded. A schedule captured in a module-level
   * constant would therefore still be the default here — and would have been
   * un-overridable by anything but a process restart.
   */
  console.log("\nThe schedule is read when used, not when imported");
  check("the override set in this file is visible", drawingRefreshSchedule().length === 3,
    JSON.stringify(drawingRefreshSchedule()));

  const ent: any = await Enterprise.create({
    name: "Retry Test Co",
    onshapeCompanyId: "mock-company-retry",
    releaseTakeoverEnabled: true,
  });

  /**
   * A release that genuinely stays pending.
   *
   * The drawing exists but has no released version yet, which is exactly the
   * real situation: Onshape has announced the revision but has not finished
   * producing the version carrying the watermark and the title block. The
   * refresh leaves such an item alone rather than capturing an unwatermarked
   * sheet as the controlled document, so it reports still-pending — which is
   * what a retry is for.
   *
   * (A drawing item with no drawingId is skipped instead, and the refresh then
   * reports success with nothing captured. That was this fixture's first
   * mistake, and it tested the opposite of what it meant to.)
   */
  async function pendingRelease(number: string) {
    const drawing: any = await Drawing.create({
      enterpriseId: ent._id,
      documentId: "d-retry",
      elementId: `e-${number}`,
      number: `DWG-${number}`,
      name: "Sheet",
      lifecycleState: "Under Review",
      versionId: null,
    });
    return Release.create({
      enterpriseId: ent._id,
      number,
      title: "t",
      origin: "plm",
      state: "Approved",
      drawingRefreshPending: true,
      // No onshapeReleasePackageId either, so nothing can supply a version.
      items: [{ kind: "drawing", drawingId: drawing._id, onshapeItemId: "x" }],
    });
  }

  console.log("\nOne chain per release, however many events arrive");
  {
    const rel: any = await pendingRelease("REL-RETRY-1");
    const first = scheduleDrawingRefresh(String(rel._id), { trigger: "test" });
    const second = scheduleDrawingRefresh(String(rel._id), { trigger: "test" });
    const third = scheduleDrawingRefresh(String(rel._id), { trigger: "test" });

    check("the first event starts a chain", first.scheduled, first.reason);
    check("the second does not start another", !second.scheduled, second.reason);
    check("and says why", /already running/i.test(second.reason), second.reason);
    check("nor the third", !third.scheduled, third.reason);
    check("the first reports when it will run", first.inMs === 10, String(first.inMs));

    cancelDrawingRefresh(String(rel._id));
  }

  console.log("\nA chain can be cancelled, and cancelling twice is harmless");
  {
    const rel: any = await pendingRelease("REL-RETRY-2");
    scheduleDrawingRefresh(String(rel._id), { trigger: "test" });
    check("cancelling a running chain reports it", cancelDrawingRefresh(String(rel._id)));
    check("cancelling again reports nothing to cancel",
      !cancelDrawingRefresh(String(rel._id)));
    check("and a new chain can then start",
      scheduleDrawingRefresh(String(rel._id), { trigger: "test" }).scheduled);
    cancelDrawingRefresh(String(rel._id));
  }

  console.log("\nA chain that never succeeds gives up, and says so");
  {
    const rel: any = await pendingRelease("REL-RETRY-3");
    const id = String(rel._id);
    scheduleDrawingRefresh(id, { trigger: "test" });

    // Three attempts at 10ms, plus the database work between them.
    await settle(1200);

    check("the chain is no longer running — it gave up rather than looping",
      !cancelDrawingRefresh(id));

    const { ActivityLog } = await import("../src/lib/models");
    const gaveUp = await ActivityLog.findOne({ releaseId: rel._id, ok: false }).lean();
    check("giving up is recorded", !!gaveUp, "no activity log entry");
    check("the entry says how many attempts were made",
      /3 attempts/i.test(String((gaveUp as any)?.message)), String((gaveUp as any)?.message));
    check("and names the setting to raise",
      /PLM_DRAWING_REFRESH_RETRIES_MS/.test(String((gaveUp as any)?.message)),
      String((gaveUp as any)?.message));

    const after: any = await Release.findById(id).lean();
    check("the release is still marked pending, so Collect still works",
      after?.drawingRefreshPending === true, String(after?.drawingRefreshPending));
  }

  console.log("\nA chain stops as soon as there is nothing pending");
  {
    const rel: any = await Release.create({
      enterpriseId: ent._id,
      number: "REL-RETRY-4",
      title: "t",
      origin: "plm",
      state: "Released",
      // Not pending: refreshReleasedDrawings returns "Nothing pending."
      drawingRefreshPending: false,
      items: [],
    });
    const id = String(rel._id);
    scheduleDrawingRefresh(id, { trigger: "test" });
    await settle(300);
    check("it stopped after the first attempt", !cancelDrawingRefresh(id));

    const { ActivityLog } = await import("../src/lib/models");
    const gaveUp = await ActivityLog.findOne({ releaseId: rel._id, ok: false }).lean();
    check("and nothing was recorded as a failure", !gaveUp,
      String((gaveUp as any)?.message));
  }

  console.log("\nA release that does not exist does not crash the process");
  {
    /*
     * The important property here is negative: refreshReleasedDrawings throws
     * for some failures, and a throw inside a setTimeout callback is an
     * unhandled rejection. That would end the process and take every other
     * release's pending retries with it.
     */
    let unhandled: unknown = null;
    const onUnhandled = (e: unknown) => { unhandled = e; };
    process.on("unhandledRejection", onUnhandled);

    const bogus = "6aa0000000000000000000ff";
    scheduleDrawingRefresh(bogus, { trigger: "test" });
    await settle(400);

    process.off("unhandledRejection", onUnhandled);
    check("no unhandled rejection escaped the timer", unhandled === null, String(unhandled));
    check("and the chain cleaned itself up", !cancelDrawingRefresh(bogus));
  }

  await Promise.all([
    Drawing.deleteMany({ enterpriseId: ent._id }),
    Release.deleteMany({ enterpriseId: ent._id }),
    Enterprise.deleteOne({ _id: ent._id }),
  ]);
  const { ActivityLog } = await import("../src/lib/models");
  await ActivityLog.deleteMany({ enterpriseId: ent._id });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
