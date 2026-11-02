/**
 * Reading a STEP file's parts before importing it.
 *
 * Pinned down: a lone part is one part; an assembly's parts are found with how
 * many times each is used, multiplied through subassemblies; the assemblies
 * themselves are not parts; a part with several solids is one part with that
 * many bodies; placement relationships are not mistaken for a part's shape;
 * quoting and comments do not trip the reader; and a file that is not STEP
 * says so. Real files from ~/Downloads are scanned too when they are present.
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { scanStep } from "../src/lib/step-scan";
import { stepFixture } from "./step-fixture";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const byName = (scan: ReturnType<typeof scanStep>, name: string) => scan.parts.find((p) => p.name === name);

console.log("\nOne part");
let s = scanStep(stepFixture([{ name: "Bracket", solids: 1 }]));
check("reads", s.ok, s.error);
check("one part", s.parts.length === 1, JSON.stringify(s.parts));
check("named from the product", s.parts[0]?.name === "Bracket", s.parts[0]?.name);
check("used once, one body", s.parts[0]?.instances === 1 && s.parts[0]?.bodiesPerInstance === 1);
check("not an assembly", s.assembly === false);

console.log("\nAn assembly with repeats and a subassembly used twice");
s = scanStep(stepFixture([
  { name: "Gate", children: [
    { product: "Frame", count: 1 }, { product: "Bolt", count: 4 }, { product: "Hinge", count: 2 },
  ] },
  { name: "Hinge", children: [{ product: "Pin", count: 1 }, { product: "Leaf", count: 2 }] },
  { name: "Frame", solids: 1 },
  { name: "Bolt", solids: 1 },
  { name: "Pin", solids: 1 },
  { name: "Leaf", solids: 1 },
]));
check("reads", s.ok, s.error);
check("is an assembly", s.assembly === true);
check("four distinct parts, assemblies left out", s.parts.length === 4, s.parts.map((p) => p.name).join(","));
check("the bolt is used 4 times", byName(s, "Bolt")?.instances === 4, String(byName(s, "Bolt")?.instances));
check("the pin twice, through the hinge", byName(s, "Pin")?.instances === 2, String(byName(s, "Pin")?.instances));
check("the leaf four times (2 × 2)", byName(s, "Leaf")?.instances === 4, String(byName(s, "Leaf")?.instances));
check("eleven bodies in all", s.totalBodies === 11, String(s.totalBodies));
check("placements are not counted as the assembly's own shape", !byName(s, "Gate") && !byName(s, "Hinge"));

console.log("\nOne part with several solids");
s = scanStep(stepFixture([{ name: "Weldment", solids: 3 }]));
check("is one part", s.parts.length === 1);
check("with three bodies", s.parts[0]?.bodiesPerInstance === 3 && s.totalBodies === 3, JSON.stringify(s.parts[0]));

console.log("\nAwkward text");
s = scanStep(stepFixture([{ name: "O'Ring; large", solids: 1 }]));
check("an escaped quote and a semicolon in a name", s.parts[0]?.name === "O'Ring; large", s.parts[0]?.name);

const loose = Buffer.from(
  "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=MANIFOLD_SOLID_BREP('',#9);\n#2=MANIFOLD_SOLID_BREP('',#9);\nENDSEC;\nEND-ISO-10303-21;\n"
);
s = scanStep(loose);
check("solids with no product structure become one entry", s.ok && s.parts.length === 1 && s.totalBodies === 2,
  JSON.stringify(s));

s = scanStep(Buffer.from("solid ascii-stl\nendsolid\n"));
check("a file that is not STEP is refused", !s.ok && /not a STEP file/i.test(s.error ?? ""), s.error);
s = scanStep(Buffer.from("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=PRODUCT('a','a','',(#2));\nENDSEC;\n"));
check("a STEP with no solids says so", !s.ok && /no solid/i.test(s.error ?? ""), s.error);

// Real exports, when this machine has them.
const real: [string, (x: ReturnType<typeof scanStep>) => boolean, string][] = [
  ["Plastic Bottle.step", (x) => x.parts.length === 2 && x.assembly && !!byName(x, "cap") && !!byName(x, "bottle"),
    "two parts, cap and bottle"],
  ["PRT-01320_RevA_MO-00029.step", (x) => x.parts.length === 1 && !x.assembly, "one part"],
];
let headed = false;
for (const [file, ok, what] of real) {
  const path = join(homedir(), "Downloads", file);
  if (!existsSync(path)) continue;
  if (!headed) { console.log("\nReal exports"); headed = true; }
  const r = scanStep(readFileSync(path));
  check(`${file}: ${what}`, r.ok && ok(r), JSON.stringify(r.parts));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
