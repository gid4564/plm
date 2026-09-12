/**
 * Rebuilding an assembly's hierarchy from an indented BOM.
 *
 * Onshape returns a multi-level BOM as a flat list whose ORDER carries the
 * tree: a row's parent is the nearest row above it exactly one level
 * shallower. There is no parent pointer — indentLevel and position are the
 * whole of it. So the failure mode is not an error but an invented structure,
 * and that is what these tests are for.
 */
import { structureFromIndent, inImportOrder } from "../src/lib/bom-structure";
import type { BomLine, BomTable } from "../src/lib/onshape/bom";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** A row: name, indent level, and whether it is a subassembly. */
const row = (name: string, indentLevel: number, isAssembly = false): BomLine => ({
  key: `${name}`,
  quantity: 1,
  partNumber: "",
  name,
  description: "",
  material: "",
  revision: "",
  state: "",
  vendor: "",
  project: "",
  indentLevel,
  isAssembly,
  source: { documentId: "d", elementId: `e-${name}`, partId: isAssembly ? "" : `p-${name}`, configuration: "" },
  sourceWvmType: "w",
  unresolvable: null,
});

const table = (lines: BomLine[]): BomTable =>
  ({ lines, headers: [], shape: "test", indented: true });

/** Parent name for a row, for readable assertions. */
const parentOf = (s: ReturnType<typeof structureFromIndent>, name: string) => {
  const r = s.rows.find((x) => x.line.name === name)!;
  return r.parentIndex === null ? null : s.rows[r.parentIndex].line.name;
};

function main() {
  console.log("\nA flat list is all top level");
  {
    const s = structureFromIndent(table([row("A", 0), row("B", 0), row("C", 0)]));
    check("every row is top level", s.topLevel.length === 3, String(s.topLevel.length));
    check("none has a parent", s.rows.every((r) => r.parentIndex === null));
    check("and no gaps are reported", s.gaps.length === 0);
  }

  console.log("\nOne level of nesting");
  {
    /*
     *  SUB          level 0
     *    BOLT       level 1
     *    WASHER     level 1
     *  PLATE        level 0
     */
    const s = structureFromIndent(table([
      row("SUB", 0, true), row("BOLT", 1), row("WASHER", 1), row("PLATE", 0),
    ]));
    check("the subassembly and the plate are top level",
      s.topLevel.map((i) => s.rows[i].line.name).join(",") === "SUB,PLATE",
      s.topLevel.map((i) => s.rows[i].line.name).join(","));
    check("the bolt hangs off the subassembly", parentOf(s, "BOLT") === "SUB", String(parentOf(s, "BOLT")));
    check("so does the washer", parentOf(s, "WASHER") === "SUB");
    check("the plate does not", parentOf(s, "PLATE") === null);
    check("the subassembly lists both children",
      s.rows[s.topLevel[0]].childIndexes.length === 2);
  }

  console.log("\nDeeper nesting, and coming back up");
  {
    /*
     *  A            0
     *    B          1
     *      C        2
     *      D        2
     *    E          1     <- back up a level: parent is A again, not C
     *  F            0     <- all the way back up
     */
    const s = structureFromIndent(table([
      row("A", 0, true), row("B", 1, true), row("C", 2), row("D", 2), row("E", 1), row("F", 0),
    ]));
    check("C is under B", parentOf(s, "C") === "B", String(parentOf(s, "C")));
    check("D is under B too", parentOf(s, "D") === "B");
    /*
     * The assertion that matters. Returning to level 1 after two rows at level
     * 2 must re-parent to A — the most recent level-0 row — not to C, which is
     * what a naive "previous row" rule would give.
     */
    check("E goes back under A, not under C", parentOf(s, "E") === "A", String(parentOf(s, "E")));
    check("F is top level again", parentOf(s, "F") === null, String(parentOf(s, "F")));
    check("A has two children, not four",
      s.rows[0].childIndexes.length === 2,
      JSON.stringify(s.rows[0].childIndexes.map((i) => s.rows[i].line.name)));
  }

  console.log("\nThe same part in two subassemblies is two positions");
  {
    const s = structureFromIndent(table([
      row("SUB1", 0, true), row("BOLT", 1), row("SUB2", 0, true), row("BOLT", 1),
    ]));
    const bolts = s.rows.filter((r) => r.line.name === "BOLT");
    check("both rows survive", bolts.length === 2, String(bolts.length));
    /*
     * Collapsing them — which the flat parser does deliberately, to answer
     * "how many in total" — would merge two edges into one and lose the
     * structure the indent was requested for.
     */
    check("each hangs off its own subassembly",
      s.rows[bolts[0].index].parentIndex === 0 && s.rows[bolts[1].index].parentIndex === 2,
      JSON.stringify(bolts.map((b) => b.parentIndex)));
  }

  console.log("\nAn indent that jumps is reported, not guessed at");
  {
    /*
     *  A            0
     *      C        2     <- skipped level 1
     *
     * A row filtered out upstream, or a payload that interleaves something
     * unexpected. Attaching C to A would invent a relationship Onshape never
     * described, so the jump is recorded.
     */
    const s = structureFromIndent(table([row("A", 0, true), row("C", 2)]));
    check("the gap is reported", s.gaps.length === 1, JSON.stringify(s.gaps));
    check("it names the levels it jumped between",
      s.gaps[0].from === 0 && s.gaps[0].to === 2, JSON.stringify(s.gaps[0]));
  }

  console.log("\nA child before any parent");
  {
    // A BOM starting at level 1 has nothing above it to hang from.
    const s = structureFromIndent(table([row("ORPHAN", 1), row("A", 0, true)]));
    check("it is treated as top level rather than dropped",
      s.topLevel.includes(0), JSON.stringify(s.topLevel));
    check("and has no parent", s.rows[0].parentIndex === null);
  }

  console.log("\nImport order puts parents before their children");
  {
    const s = structureFromIndent(table([
      row("A", 0, true), row("B", 1, true), row("C", 2), row("D", 0),
    ]));
    const order = inImportOrder(s).map((r) => r.line.name);
    check("depth first, parents first", order.join(",") === "A,B,C,D", order.join(","));
    /*
     * A child's edge cannot be written until its parent exists in PLM, so this
     * ordering is a precondition of the import rather than a presentational
     * nicety.
     */
    for (const r of inImportOrder(s)) {
      if (r.parentIndex === null) continue;
      const parentPos = order.indexOf(s.rows[r.parentIndex].line.name);
      check(`${r.line.name} comes after its parent`, parentPos < order.indexOf(r.line.name));
    }
  }

  console.log("\nEdge cases");
  {
    check("an empty table gives an empty structure",
      structureFromIndent(table([])).rows.length === 0);
    const negative = structureFromIndent(table([row("A", -1)]));
    check("a negative indent is clamped to top level",
      negative.rows[0].level === 0 && negative.rows[0].parentIndex === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
