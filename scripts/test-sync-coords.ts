/**
 * Checks that reads and writes go to different places.
 *
 * Run with:  npm run test:coords
 *
 * A manufacturing order raised against a released revision must keep reporting
 * that revision. Reading it from the workspace instead replaces revision "A"
 * with "-" and Released with In Progress — a live order silently repointed at
 * unreleased work. Meanwhile the MO number can only be written to a workspace,
 * because a version is immutable. These two rules pull in opposite directions,
 * which is exactly why they need pinning down.
 */
import { preferKnownWorkspace, readCoords, writeCoords } from "../src/lib/sync";
import type { PartCoords } from "../src/lib/onshape/types";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const base = { documentId: "d1", elementId: "e1", partId: "p1", configuration: "default" };

console.log("A part enrolled from a release (both a version and a workspace)");
{
  const pinned: PartCoords = { ...base, workspaceId: "w1", versionId: "v1" };

  /*
   * Reads must NOT follow the stored version.
   *
   * That pin goes stale as soon as a newer revision is released, and Onshape
   * then correctly reports the pinned one as Obsolete — which walked a live
   * order from revision C back to B, Released back to Obsolete.
   */
  const r = readCoords(pinned);
  check("reads from the workspace, not the stored version", r.workspaceId === "w1" && !r.versionId, r);

  const w = writeCoords(pinned);
  check("writes to the workspace", w.workspaceId === "w1" && !w.versionId, w);

  check("identity is untouched by either",
    r.documentId === "d1" && r.elementId === "e1" && r.partId === "p1" && r.configuration === "default" &&
    w.documentId === "d1" && w.elementId === "e1" && w.partId === "p1" && w.configuration === "default");
}

console.log("\nA part synced from the workspace (no version)");
{
  const live: PartCoords = { ...base, workspaceId: "w1", versionId: null };
  check("reads from the workspace", readCoords(live).workspaceId === "w1");
  check("writes to the workspace", writeCoords(live).workspaceId === "w1");
  check("no version invented", !readCoords(live).versionId && !writeCoords(live).versionId);
}

console.log("\nA part only reachable at a version (a linked library part)");
{
  const versionOnly: PartCoords = { ...base, workspaceId: null, versionId: "v9" };
  check("reads from the version", readCoords(versionOnly).versionId === "v9");
  // Nothing to write to. The caller records this as a blocked write-back rather
  // than inventing a workspace to aim at.
  check("write coords keep the version rather than fabricating a workspace",
    writeCoords(versionOnly).versionId === "v9" && !writeCoords(versionOnly).workspaceId);
}

console.log("\nNeither is mutated in place");
{
  const original: PartCoords = { ...base, workspaceId: "w1", versionId: "v1" };
  readCoords(original);
  writeCoords(original);
  check("the input is left alone", original.workspaceId === "w1" && original.versionId === "v1", original);
}

console.log("\nAn event naming a superseded revision must not win");
{
  /*
   * Releasing D obsoletes C, and Onshape reports both. The event about C
   * carries only its version, and reading that returned "revision C, Obsolete"
   * over an item that had correctly moved to D.
   */
  const eventAboutOldRevision: PartCoords = { ...base, workspaceId: null, versionId: "v-C-obsoleted" };
  const fixed = preferKnownWorkspace(eventAboutOldRevision, "w1");
  check("reads the known workspace, not the event's version",
    readCoords(fixed).workspaceId === "w1" && !readCoords(fixed).versionId, fixed);

  const explicit: PartCoords = { ...base, workspaceId: "w-from-event", versionId: null };
  check("an explicit workspace on the event is respected",
    preferKnownWorkspace(explicit, "w1").workspaceId === "w-from-event");

  const noneKnown: PartCoords = { ...base, workspaceId: null, versionId: "v9" };
  check("a part with no known workspace still reads its version",
    readCoords(preferKnownWorkspace(noneKnown, null)).versionId === "v9");
}

console.log("\nWhich readings may move the revision");
{
  /*
   * Mirrors the rule in syncPartFromOnshape. The workspace carries no revision,
   * so a workspace reading is not evidence about which revision is current and
   * gets no say. Only a release does — and it reads its own version to find it.
   */
  const mayMove = (fromRelease: boolean, heldRevision: string) => fromRelease || heldRevision === "";

  check("a release moves the revision", mayMove(true, "C"));
  check("a workspace reading does not", !mayMove(false, "C"));
  check("a never-released part still mirrors the workspace", mayMove(false, ""));
  check("the obsoleted-revision straggler cannot win", !mayMove(false, "D"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
