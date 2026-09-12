/**
 * Checks for the BOM parser.
 *
 * Run with:  npm run test:bom
 *
 * The parser is the part of the BOM feature most exposed to Onshape: its
 * response layout has changed between API versions and is not fully described
 * in the public documentation, so the parser accepts several shapes rather than
 * binding to one. These cases pin that behaviour down, and are the right place
 * to add a fixture the first time a real tenant returns something unexpected —
 * the server logs the top-level keys of any payload that parses to nothing.
 */
import { parseBom, parseOnshapeUrl } from "../src/lib/onshape/bom";
import { assessLine, importableLines } from "../src/lib/bom-import";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const src = (partId: string, extra: Record<string, unknown> = {}) => ({
  documentId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  elementId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  partId,
  wvmType: "w",
  wvmId: "cccccccccccccccccccccccc",
  fullConfiguration: "default",
  elementType: "PARTSTUDIO",
  ...extra,
});

/* --- Shape A: bomTable.items with headerIdToValue ------------------------ */
const shapeA = {
  bomTable: {
    headers: [
      { id: "h1", name: "Item", propertyName: "item" },
      { id: "h2", name: "Quantity", propertyName: "quantity" },
      { id: "h3", name: "Part number", propertyName: "partNumber" },
      { id: "h4", name: "Name", propertyName: "name" },
      { id: "h5", name: "Material", propertyName: "material" },
    ],
    items: [
      { itemSource: src("P1"), indentLevel: 0, headerIdToValue: { h1: "1", h2: 2, h3: "PN-1", h4: "Bracket", h5: { displayName: "Steel" } } },
      { itemSource: src("P2"), indentLevel: 1, headerIdToValue: { h1: "1.1", h2: 3, h3: "PN-2", h4: "Pin" } },
      { itemSource: src("P1"), indentLevel: 1, headerIdToValue: { h1: "1.2", h2: 5, h3: "PN-1", h4: "Bracket" } },
    ],
  },
};
console.log("Shape A — bomTable.items");
{
  const t = parseBom(shapeA);
  check("recognised", t.shape === "bomTable.items", t.shape);
  check("duplicate parts collapsed to 2 rows", t.lines.length === 2, t.lines.length);
  check("quantities rolled up 2+5=7", t.lines[0].quantity === 7, t.lines[0].quantity);
  check("part number mapped", t.lines[0].partNumber === "PN-1", t.lines[0].partNumber);
  check("object-valued material rendered", t.lines[0].material === "Steel", t.lines[0].material);
  check('"Item" column NOT read as a part number', t.lines[1].partNumber === "PN-2", t.lines[1].partNumber);
  check("source resolved to the Part Studio", t.lines[0].source?.workspaceId === "cccccccccccccccccccccccc");
}

/* --- Shape B: flat headers/rows ------------------------------------------ */
console.log("Shape B — headers/rows");
{
  const t = parseBom({
    headers: [{ id: "q", name: "QTY" }, { id: "n", name: "Part Number" }],
    rows: [{ itemSource: src("P9"), headerIdToValue: { q: "4", n: "PN-9" } }],
  });
  check("recognised", t.shape === "rows", t.shape);
  check("case/spacing-insensitive header match", t.lines[0].quantity === 4 && t.lines[0].partNumber === "PN-9", t.lines[0]);
}

/* --- Shape C: values straight on the row --------------------------------- */
console.log("Shape C — bare fields");
{
  const t = parseBom({ items: [{ itemSource: src("P3"), quantity: 6, partNumber: "PN-3", name: "Shaft" }] });
  check("reads fields without headers", t.lines[0].quantity === 6 && t.lines[0].name === "Shaft", t.lines[0]);
}

/* --- Subassembly and unresolvable rows ----------------------------------- */
console.log("Rows that cannot become items");
{
  const t = parseBom({
    items: [
      { itemSource: { documentId: "a".repeat(24), elementId: "b".repeat(24), elementType: "ASSEMBLY" }, quantity: 1, name: "Subassembly" },
      { quantity: 1, name: "Orphan row" },
      { itemSource: src("P4"), quantity: 1, name: "Real part" },
    ],
  });
  /*
   * A subassembly now resolves to a source and IS importable — as an assembly.
   * It used to be refused, which is what flattened a multi-level BOM: the
   * subassembly was skipped and its children were attached to whatever row was
   * above it.
   */
  check("subassembly is flagged as one", t.lines[0].isAssembly, JSON.stringify(t.lines[0]));
  check("and is addressable as an element, with no part id",
    t.lines[0].source?.elementId === "b".repeat(24) && t.lines[0].source?.partId === "",
    JSON.stringify(t.lines[0].source));
  check("and needs no reason, because nothing is wrong with it",
    t.lines[0].unresolvable === null, String(t.lines[0].unresolvable));
  check("sourceless row flagged", t.lines[1].source === null && !!t.lines[1].unresolvable, t.lines[1]);
  check("real part still importable", t.lines[2].source !== null, t.lines[2]);
  check("all three rows survive for display", t.lines.length === 3, t.lines.length);
}

/* --- Version / microversion sources -------------------------------------- */
console.log("Immutable sources");
{
  const t = parseBom({ items: [
    { itemSource: src("P5", { wvmType: "v", wvmId: "d".repeat(24) }), quantity: 1 },
    { itemSource: src("P6", { wvmType: "m", wvmId: "e".repeat(24) }), quantity: 1 },
  ]});
  check("version source recorded as v", t.lines[0].sourceWvmType === "v" && t.lines[0].source?.versionId === "d".repeat(24), t.lines[0]);
  check("microversion has no workspace or version", t.lines[1].sourceWvmType === "m" && !t.lines[1].source?.workspaceId && !t.lines[1].source?.versionId, t.lines[1]);
}

/* --- Junk in, diagnosable out -------------------------------------------- */
console.log("Unrecognised payloads");
for (const [label, payload] of [["null", null], ["empty object", {}], ["error body", { message: "Not found", status: 404 }]] as const) {
  const t = parseBom(payload);
  check(`${label} → no throw, 0 rows, shape reported`, t.lines.length === 0 && t.shape === "unrecognised", t.shape);
}

/* --- URL parsing ---------------------------------------------------------- */
console.log("Onshape URL parsing");
{
  const D = "1".repeat(24), W = "2".repeat(24), E = "3".repeat(24), V = "4".repeat(24);
  const cases: [string, string, boolean][] = [
    [`https://cad.onshape.com/documents/${D}/w/${W}/e/${E}`, "plain workspace URL", true],
    [`cad.onshape.com/documents/${D}/w/${W}/e/${E}`, "no protocol", true],
    [`https://acme.onshape.com/documents/${D}/w/${W}/e/${E}?renderMode=0&uiState=abc`, "enterprise host + query", true],
    [`https://cad.onshape.com/documents/${D}/v/${V}/e/${E}`, "version URL", true],
    ["https://cad.onshape.com/documents/", "truncated", false],
    ["not a url at all", "junk", false],
    ["", "empty", false],
  ];
  for (const [input, label, shouldParse] of cases) {
    const r = parseOnshapeUrl(input);
    check(label, Boolean(r) === shouldParse, r);
  }
  const ws = parseOnshapeUrl(`https://cad.onshape.com/documents/${D}/w/${W}/e/${E}`)!;
  check("workspace extracted", ws.workspaceId === W && ws.versionId === null, ws);
  const vs = parseOnshapeUrl(`https://cad.onshape.com/documents/${D}/v/${V}/e/${E}`)!;
  check("version extracted", vs.versionId === V && vs.workspaceId === null, vs);
  const cfg = parseOnshapeUrl(`https://cad.onshape.com/documents/${D}/w/${W}/e/${E}?configuration=size%3Dlarge`)!;
  check("configuration extracted", cfg.configuration === "size=large", cfg.configuration);
}

/*
 * What blocks a row from coming into PLM.
 *
 * A missing part number does not, and that is the whole point of these
 * assertions. PLM is the number master: it issues the number and writes it back
 * onto the Onshape part, so an unnumbered part is the normal case on the way in.
 *
 * The importer used to refuse one, greying the row out with "give the part a
 * number in Onshape and import the assembly again" — a rule inherited from MOS,
 * where a part number was a precondition for raising a manufacturing order
 * against an existing number. In PLM it asked the user to do by hand the one
 * job the system exists to do. Nothing tested it, which is how it survived the
 * fork.
 *
 * What does block a row is not being able to address the part in Onshape.
 */
console.log("Importability");
{
  const row = (over: Partial<Parameters<typeof assessLine>[0]>) =>
    assessLine({
      key: "k", partNumber: "", name: "Leg Structure", description: "", material: "",
      quantity: 1, vendor: "", project: "", indentLevel: 0, isAssembly: false,
      source: { documentId: "d", elementId: "e", partId: "P", configuration: "" },
      sourceWvmType: "w", unresolvable: null,
      ...over,
    } as Parameters<typeof assessLine>[0]);

  const noNumber = row({ partNumber: "" });
  check("a part with no part number is importable", noNumber.importable, String(noNumber.reason));
  check("and no reason is given, because there is nothing wrong",
    noNumber.reason === null, String(noNumber.reason));

  check("a numbered part is importable too", row({ partNumber: "PN-1" }).importable);

  // Addresses, not data PLM can supply.
  const noSource = row({ source: null, unresolvable: "Row has no part id." });
  check("a row PLM cannot address is refused", !noSource.importable);
  check("with the parser's own reason", noSource.reason === "Row has no part id.", String(noSource.reason));

  const asm = row({ isAssembly: true, source: null, unresolvable: "Subassembly — this import brings in its parts." });
  check("a subassembly row is still held back", !asm.importable);
  check("and its reason no longer mentions manufacturing orders",
    !/manufacturing order/i.test(asm.reason ?? ""), String(asm.reason));

  /* The filter used by the UI agrees with the per-row assessment. */
  const table = {
    lines: [
      row({}) && { key: "a", partNumber: "", name: "No number", description: "", material: "",
        quantity: 1, vendor: "", project: "", indentLevel: 0, isAssembly: false,
        source: { documentId: "d", elementId: "e", partId: "P1", configuration: "" },
        sourceWvmType: "w" as const, unresolvable: null },
      { key: "b", partNumber: "", name: "Unaddressable", description: "", material: "",
        quantity: 1, vendor: "", project: "", indentLevel: 0, isAssembly: false,
        source: null, sourceWvmType: null, unresolvable: "Row has no part id." },
    ],
    headers: [],
    shape: "test",
  } as never;
  const importable = importableLines(table);
  check("importableLines keeps the unnumbered part", importable.length === 1,
    JSON.stringify(importable.map((l) => l.name)));
  check("and drops only the unaddressable one", importable[0]?.name === "No number",
    importable[0]?.name);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
