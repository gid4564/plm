/**
 * Which numbering scheme an Onshape part-number request belongs to.
 *
 * Written from a real payload that defeated two earlier attempts: Onshape sends
 * `elementType` as an integer, not the string its own reference sample implies,
 * and the numeric mapping is not documented anywhere I could find. So the
 * classifier leans on the structure of the request — only a part carries a
 * partId — and treats the numeric table as the last resort it is.
 */
import { classify } from "../src/lib/onshape/element-type";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\nThe live payload that prompted this");
{
  // Captured verbatim: elementType and resourceType are integers, mimeType null.
  const r = classify({
    id: "abc", elementType: 0, workSpaceId: "w1", configuration: "default",
    documentId: "d1", elementId: "e1", partNumber: "", versionId: null,
    partId: "JMD", mimeType: null, companyId: "5d0bc3f88b2b42166e7182e8",
    resourceType: 0, categories: [],
  });
  check("classified as a part", r.type === "PART", r.type);
  check("from the part id, not the enum", r.from.includes("partId"), r.from);
  check("and confidently, because that signal is structural", r.confident, r.from);
}

console.log("\nWords win when Onshape sends them");
{
  for (const [given, want] of [
    ["PARTSTUDIO", "PART"], ["Part Studio", "PART"], ["PART_STUDIO", "PART"],
    ["ASSEMBLY", "ASSEMBLY"], ["Drawing", "DRAWING"], ["sub assembly", "ASSEMBLY"],
  ] as const) {
    const r = classify({ elementType: given });
    check(`"${given}" -> ${want}`, r.type === want && r.confident, `${r.type} via ${r.from}`);
  }
}

console.log("\nA part id identifies a part whatever the code says");
{
  // The point of preferring structure: even a type code meaning something else
  // cannot turn an item carrying a part id into a drawing.
  const r = classify({ elementType: 2, partId: "JHD" });
  check("part id beats the numeric code", r.type === "PART", `${r.type} via ${r.from}`);
}
{
  const r = classify({ elementType: 1, partId: "" });
  check("an empty part id does not claim a part", r.type === "ASSEMBLY", r.from);
  check("and an inferred code is not called confident", !r.confident, r.from);
}
{
  const r = classify({ elementType: 1, partId: "{$partId}" });
  check("an unsubstituted placeholder is not a part id", r.type === "ASSEMBLY", r.from);
}

console.log("\nmimeType and resourceType, when they carry words");
{
  const r = classify({ elementType: null, mimeType: "application/vnd.onshape.ins-assembly" });
  check("a mime type naming assembly classifies", r.type === "ASSEMBLY" && r.confident, r.from);
}
{
  const r = classify({ elementType: null, mimeType: null, resourceType: "DRAWING" });
  check("a resourceType word classifies", r.type === "DRAWING" && r.confident, r.from);
}
{
  // The live payload has resourceType: 0 — a number, which says nothing.
  const r = classify({ elementType: 9, resourceType: 0, mimeType: null });
  check("a numeric resourceType is not mistaken for a word",
    !r.from.includes("resourceType"), r.from);
}

console.log("\nThe numeric table, and how much it is trusted");
{
  const zero = classify({ elementType: 0, partId: "" });
  check("0 is a part", zero.type === "PART", zero.from);
  check("and confident, because 0 was observed live", zero.confident);

  for (const [code, want] of [[1, "ASSEMBLY"], [2, "DRAWING"]] as const) {
    const r = classify({ elementType: code, partId: "" });
    check(`${code} -> ${want}`, r.type === want, r.type);
    check(`  and marked unconfident, since ${code} is inferred`, !r.confident);
  }
}

console.log("\nNothing identifiable still yields a number");
{
  // Refusing here would leave the Release candidate dialog unable to number
  // anything. The scheme only picks a prefix, so a logged guess is the better
  // trade — that is the whole reason this returns a value rather than null.
  const r = classify({ elementType: 99, resourceType: 0, mimeType: null, partId: "" });
  check("falls back to a part number", r.type === "PART", r.type);
  check("but says it was a guess", !r.confident);
  check("and quotes what it saw", r.from.includes("99"), r.from);
}
{
  const r = classify({});
  check("an empty item still classifies", r.type === "PART");
  check("unconfidently", !r.confident);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
