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
import { kindForElementType } from "../src/lib/sync";

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
  /*
   * Code 1 is confirmed now — a live task item carried `elementType: 1`
   * alongside `dataType: "onshape/assembly"`. An unseen code is what must not
   * be called confident, and the table records which is which.
   */
  check("and an observed code IS confident", r.confident, r.from);
  check("while a code nobody has seen is not",
    !classify({ elementType: 7, partId: "" }).confident,
    classify({ elementType: 7, partId: "" }).from);
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

  /*
   * Confidence tracks what has actually been observed, so this table is the
   * record of that — not a fixed expectation. Code 2 moved to confirmed when a
   * live release-package item arrived carrying both `elementType: 2` and
   * `mimeType: "onshape-app/drawing"`. Code 1 has still never been seen, and
   * Onshape's OpenAPI documents no enum values to check it against.
   */
  const CODES: [number, string, boolean][] = [
    /*
     * Code 1 moved to confirmed when a live task item arrived carrying both
     * `elementType: 1` and `dataType: "onshape/assembly"`.
     */
    [1, "ASSEMBLY", true],
    [2, "DRAWING", true],
  ];
  for (const [code, want, confirmed] of CODES) {
    const r = classify({ elementType: code, partId: "" });
    check(`${code} -> ${want}`, r.type === want, r.type);
    check(
      confirmed
        ? `  and confident, because ${code} was observed live`
        : `  and marked unconfident, since ${code} is inferred`,
      r.confident === confirmed
    );
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

/*
 * Absence of evidence is not code 0.
 *
 * `Number("")` is 0 and `Number(null)` is 0, so an item whose elementType was
 * an empty string was classified *confidently* as a Part Studio, on the
 * strength of a code it never sent. (`classify({})` was always fine — it is the
 * present-but-empty value that was wrong, which is why this went unnoticed.)
 *
 * The confidence is load-bearing: kindForElementType refuses anything it is not
 * confident about, so a false confidence here is what would let an unknown
 * element through as a part.
 */
console.log("\nAn empty elementType is not a code");
for (const empty of ["", "   ", null, undefined]) {
  const c = classify({ elementType: empty as never });
  check(`${JSON.stringify(empty)} is not confidently anything`, !c.confident,
    `${c.type} from ${c.from}`);
  check(`${JSON.stringify(empty)} does not claim to come from a code`,
    !/code/.test(c.from), c.from);
}

// A real numeric code still resolves, as a number or a string.
for (const [value, expected] of [[0, "PART"], ["0", "PART"], [2, "DRAWING"], ["2", "DRAWING"]] as const) {
  const c = classify({ elementType: value as never });
  check(`${JSON.stringify(value)} still reads as ${expected}`, c.type === expected,
    `${c.type} from ${c.from}`);
}

// A non-numeric string must not be coerced into one.
for (const junk of ["BLOB", "FEATURESTUDIO", "1.5", "-", "0x0"]) {
  const c = classify({ elementType: junk });
  check(`${JSON.stringify(junk)} is not read as a code`, !/code/.test(c.from), c.from);
}

/*
 * What may be synced is a different question from what something is.
 *
 * classify always produces an answer, because the numbering extension has to
 * allocate something. kindForElementType decides whether to sync at all, so it
 * refuses what it does not recognise rather than defaulting it to a part —
 * otherwise making the drawing refusal unconditional would have let every
 * unknown tab type through as one.
 */
console.log("\nOnly a recognised, syncable element may be synced");
const SYNCABLE: [string, string | null][] = [
  ["PARTSTUDIO", "part"],
  ["ASSEMBLY", "assembly"],
  ["0", "part"],
  ["DRAWING", null],
  // Code 2 is now confirmed as DRAWING, so it is confidently refused for sync
  // rather than refused for want of confidence.
  ["2", null],
  ["BLOB", null],
  ["FEATURESTUDIO", null],
  ["", null],
  ["BILLOFMATERIALS", null],
];
for (const [input, expected] of SYNCABLE) {
  const got = kindForElementType(input);
  check(`${JSON.stringify(input)} -> ${expected ?? "refused"}`, got === expected,
    `got ${String(got)}`);
}

/*
 * The mime type Onshape actually sends for a drawing.
 *
 * A live release-package item carried `mimeType: "onshape-app/drawing"` — note
 * `onshape-app/`, not `onshape/`, which is what the Part Studio items use
 * (`onshape/partstudio`). A substring match over the type words handles both,
 * and this pins that it does.
 */
/*
 * `dataType` carries the mime on a task item, where `mimeType` is null.
 *
 * Reading only mimeType meant every task item fell through to the numeric code
 * table and took an unconfident answer, with a confident one sitting in the
 * payload next to it.
 */
console.log("\nA task item's dataType is read like a mime type");
for (const [dataType, expected] of [
  ["onshape/assembly", "ASSEMBLY"],
  ["onshape/partstudio", "PART"],
  ["onshape-app/drawing", "DRAWING"],
] as const) {
  const c = classify({ dataType } as never);
  check(`dataType ${dataType} -> ${expected}`, c.type === expected, `${c.type} from ${c.from}`);
}
{
  /* The live task item exactly as it arrived: no mimeType, dataType set. */
  const c = classify({ elementType: 1, mimeType: null, dataType: "onshape/assembly", partId: "" } as never);
  check("the live task item classifies from its dataType",
    c.type === "ASSEMBLY" && c.confident, `${c.type} from ${c.from}`);
  check("and not by falling through to the code table",
    !/code/.test(c.from), c.from);
}

console.log("\nThe mime types seen on live items");
for (const [mime, expected] of [
  ["onshape/partstudio", "PART"],
  ["onshape-app/drawing", "DRAWING"],
  ["onshape/drawing", "DRAWING"],
  ["onshape/assembly", "ASSEMBLY"],
  ["application/vnd.onshape.ins-assembly", "ASSEMBLY"],
] as const) {
  const c = classify({ mimeType: mime });
  check(`${mime} -> ${expected}`, c.type === expected, `${c.type} from ${c.from}`);
}

/*
 * Two agreeing signals on one item, which is what confirmed code 2.
 */
{
  const c = classify({ elementType: 2, mimeType: "onshape-app/drawing", partId: "" });
  check("elementType 2 with a drawing mime type is a drawing", c.type === "DRAWING", c.type);
  check("and code 2 is now held confidently",
    classify({ elementType: 2 }).confident, "still unconfident");
  /*
   * Code 1 is confirmed too now — a live task item carried both
   * `elementType: 1` and `dataType: "onshape/assembly"`. All three codes in
   * the table have been seen on real data, each corroborated by a second
   * signal on the same item.
   */
  check("and so is code 1, from a live task item",
    classify({ elementType: 1 }).confident, "1 should be confident now");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
