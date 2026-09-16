/**
 * A personal shortlist of parts, assemblies and tasks.
 *
 * Favoriting is per user, not per enterprise or per object — the rules worth
 * pinning down are the ones a shared "starred" flag on the object itself
 * would get wrong: two people must not see each other's stars, starring
 * twice must not create two rows, and a star on something since deleted
 * must not crash the dashboard that reads it back.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";

import { connectDb } from "../src/lib/db";
import { Enterprise, Favorite, Part, Task } from "../src/lib/models";
import { addFavorite, isFavorited, listFavorites, removeFavorite } from "../src/lib/favorites";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-favorites";

async function main() {
  await connectDb();

  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [Part, Task, Favorite]) await (M as any).deleteMany({ enterpriseId: stale._id });
    await Enterprise.deleteOne({ _id: stale._id });
  }

  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Favorites Co" });
  const eid = String(ent._id);
  const userA = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const userB = "bbbbbbbbbbbbbbbbbbbbbbbb";

  const part: any = await Part.create({
    enterpriseId: ent._id, documentId: "d1", elementId: "e1", partId: "P1",
    number: "PN-001", name: "Bracket", kind: "part", lifecycleState: "In Work",
  });
  const asm: any = await Part.create({
    enterpriseId: ent._id, documentId: "d1", elementId: "e2", partId: "",
    number: "PN-002", name: "Gearbox", kind: "assembly", lifecycleState: "Released",
  });
  const task: any = await Task.create({
    enterpriseId: ent._id, onshapeTaskId: "t1", name: "Check fit", state: "OPEN",
  });

  console.log("\nStarring something puts it on this user's list, and nobody else's");
  {
    await addFavorite(eid, userA, "part", String(part._id));
    check("A has starred it", await isFavorited(userA, "part", String(part._id)));
    check("B has not", !(await isFavorited(userB, "part", String(part._id))));

    const listA = await listFavorites(eid, userA);
    const listB = await listFavorites(eid, userB);
    check("it appears on A's list", listA.some((r) => r.id === String(part._id)));
    check("and not on B's", listB.length === 0, `${listB.length} row(s)`);
  }

  console.log("\nStarring twice is one row, not two");
  {
    await addFavorite(eid, userA, "part", String(part._id));
    const count = await Favorite.countDocuments({ userId: userA, kind: "part", targetId: part._id });
    check("still exactly one row", count === 1, String(count));
  }

  console.log("\nAn assembly and a task can be starred too, and each keeps its own shape");
  {
    await addFavorite(eid, userA, "part", String(asm._id));
    await addFavorite(eid, userA, "task", String(task._id));

    const list = await listFavorites(eid, userA);
    const asmRow = list.find((r) => r.id === String(asm._id));
    const taskRow = list.find((r) => r.id === String(task._id));

    check("the assembly is marked as one, not a plain part",
      asmRow?.kind === "part" && (asmRow as any).partKind === "assembly", JSON.stringify(asmRow));
    check("the task carries its own fields, not a part's",
      taskRow?.kind === "task" && (taskRow as any).name === "Check fit", JSON.stringify(taskRow));
    check("newest star first", list[0]?.id === String(task._id), JSON.stringify(list.map((r) => r.id)));
  }

  console.log("\nUnstarring removes it, and doing it again is a no-op, not an error");
  {
    await removeFavorite(userA, "part", String(asm._id));
    check("gone from the list", !(await listFavorites(eid, userA)).some((r) => r.id === String(asm._id)));

    let threw = false;
    try { await removeFavorite(userA, "part", String(asm._id)); } catch { threw = true; }
    check("removing an unstarred thing does not throw", !threw);
  }

  console.log("\nA star on something since deleted does not break the list that reads it back");
  {
    const doomed: any = await Part.create({
      enterpriseId: ent._id, documentId: "d1", elementId: "e3", partId: "P3",
      number: "PN-003", name: "Retired bracket", kind: "part", lifecycleState: "Obsolete",
    });
    await addFavorite(eid, userA, "part", String(doomed._id));
    await Part.deleteOne({ _id: doomed._id });

    const list = await listFavorites(eid, userA);
    check("the dangling favorite is silently dropped, not shown broken",
      !list.some((r) => r.id === String(doomed._id)));
    check("and the rest of the list still reads fine", list.some((r) => r.id === String(part._id)));

    // The star itself is untouched — it would resolve again if the part came back.
    const row = await Favorite.findOne({ userId: userA, kind: "part", targetId: doomed._id }).lean();
    check("the favorite row itself was not cleaned up", !!row);
  }

  for (const M of [Part, Task, Favorite]) await (M as any).deleteMany({ enterpriseId: ent._id });
  await Enterprise.deleteOne({ _id: ent._id });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
