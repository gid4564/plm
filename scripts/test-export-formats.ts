/**
 * Checks for the export catalogue and filenames.
 *
 * Run with:  npm run test:export
 *
 * Filenames matter more than they look: these files leave the building. A
 * supplier quotes against the part number and the MOS reconciles against the MO
 * number, so both have to survive whatever characters a designer typed.
 */
import { EXPORT_FORMATS, exportFilename, findFormat } from "../src/lib/onshape/export-formats";
import { TRANSLATION_POLL_SCHEDULE_MS, TRANSLATION_TIMEOUT_MS } from "../src/lib/onshape/live-client";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

console.log("The catalogue");
check("every format has a strategy that is implementable",
  EXPORT_FORMATS.every((f) =>
    (f.strategy === "direct" && !!f.directPath) || (f.strategy === "translation" && !!f.formatName)),
  EXPORT_FORMATS.filter((f) => !f.directPath && !f.formatName).map((f) => f.id));
check("ids are unique", new Set(EXPORT_FORMATS.map((f) => f.id)).size === EXPORT_FORMATS.length);
check("every format has an extension and a content type",
  EXPORT_FORMATS.every((f) => f.extension && f.contentType));
check("STEP is offered — the one a shop actually asks for", !!findFormat("STEP"));
check("lookup is case-insensitive", findFormat("step")?.id === "STEP");
check("an unknown format is rejected, not guessed", findFormat("DWG") === undefined);

console.log("\nFilenames");
const step = findFormat("STEP")!;
{
  check("the PLM number and revision both appear",
    exportFilename({ number: "PN-00042", name: "Gearbox Housing", revision: "C" }, step)
      === "PN-00042_RevC.step");

  check("falls back to the name when there is no number",
    exportFilename({ number: "", name: "Gearbox Housing" }, step)
      === "Gearbox-Housing.step");

  check("no revision, no Rev segment",
    exportFilename({ number: "PN-1", revision: "" }, step) === "PN-1.step");

  // An unreleased part has no revision, and its export must still be nameable.
  // Parts sync to PLM before release, so this is the common case, not an edge.
  check("an unreleased part exports under its number alone",
    exportFilename({ number: "PN-9", revision: null }, step) === "PN-9.step");

  const nasty = exportFilename({ number: 'a/b\\c:d*e?f"g<h>i|j', revision: "" }, step);
  check("path separators and shell characters are stripped",
    !/[\/\\:*?"<>|]/.test(nasty), nasty);
  check("still ends in the right extension", nasty.endsWith(".step"), nasty);

  const bare = exportFilename({}, step);
  check("an empty part still yields a usable name", bare === "part.step", bare);

  const long = exportFilename({ number: "X".repeat(200), revision: "A" }, step);
  check("absurd input does not produce an absurd filename", long.length < 100, long.length);
}

console.log("\nWhat a translation costs in Onshape calls");
{
  /*
   * This is a budget, not an implementation detail. Onshape's rate limit is
   * shared across the whole tenant, and an earlier geometric backoff spent up
   * to 48 calls waiting on one export. If a change to the schedule pushes these
   * numbers up, that should be a decision rather than a surprise.
   */
  const checksToFinishAt = (seconds: number) => {
    let elapsed = 0, checks = 0;
    while (elapsed < seconds * 1000 && checks < 100) {
      elapsed += TRANSLATION_POLL_SCHEDULE_MS[Math.min(checks, TRANSLATION_POLL_SCHEDULE_MS.length - 1)];
      checks++;
    }
    return checks;
  };

  check("a translation finishing within 3s costs one check", checksToFinishAt(3) === 1, checksToFinishAt(3));
  check("within 8s costs no more than two", checksToFinishAt(8) <= 2, checksToFinishAt(8));
  check("within 20s costs no more than four", checksToFinishAt(20) <= 4, checksToFinishAt(20));

  // Worst case: every wait clamped so none runs past the deadline.
  let elapsed = 0, worst = 0;
  while (elapsed < TRANSLATION_TIMEOUT_MS && worst < 100) {
    const scheduled = TRANSLATION_POLL_SCHEDULE_MS[Math.min(worst, TRANSLATION_POLL_SCHEDULE_MS.length - 1)];
    elapsed += Math.min(scheduled, TRANSLATION_TIMEOUT_MS - elapsed);
    worst++;
  }
  check("a job that never finishes costs at most 8 checks", worst <= 8, worst);
  check("and stops at the stated timeout, not past it", elapsed === TRANSLATION_TIMEOUT_MS, elapsed);

  check("the schedule only ever widens",
    TRANSLATION_POLL_SCHEDULE_MS.every((w, i, a) => i === 0 || w >= a[i - 1]),
    TRANSLATION_POLL_SCHEDULE_MS);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
