/**
 * Checks for enum-label resolution, and for the released-shown-as-obsolete bug.
 *
 * Run with:  npm run test:enum
 *
 * The MOS mirrors Onshape's State onto a manufacturing record, where a wrong
 * value is not cosmetic — "Obsolete" next to a released part is the sort of
 * thing somebody scraps stock over. These cases exist to keep a positional
 * guess from creeping back in: the resolver must match on codes, and say
 * "unknown" when it cannot.
 */
import { resolveEnumLabel, mapStandardProperties } from "../src/lib/onshape/standard-properties";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

/** Onshape's stock release states, in the order they are usually listed. */
const STATES = [
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "PENDING", label: "Pending" },
  { value: "RELEASED", label: "Released" },
  { value: "OBSOLETE", label: "Obsolete" },
  { value: "REJECTED", label: "Rejected" },
];

console.log("Matching by code");
check("exact code", resolveEnumLabel("RELEASED", STATES) === "Released");
check("case/spacing-insensitive", resolveEnumLabel("Released", STATES) === "Released");
check("numeric option values", resolveEnumLabel(2, [{ value: 2, label: "Released" }]) === "Released");
check("option with only a value", resolveEnumLabel("Released", [{ value: "Released" }]) === "Released");
check("empty value stays empty", resolveEnumLabel("", STATES) === "");
check("no options: value passes through", resolveEnumLabel("RELEASED") === "RELEASED");

console.log("\nThe released-shown-as-obsolete regression");
{
  // The exact shape of the bug: a bare ordinal against a list whose order does
  // not correspond to it. Index 3 is "Obsolete"; nothing may return that.
  const got = resolveEnumLabel(3, STATES);
  check("an unmatched ordinal is NEVER resolved positionally", got !== "Obsolete", got);
  check("it is reported as unknown", got.startsWith("Unknown ("), got);
  check("the raw code stays visible", got.includes("3"), got);

  for (let i = 0; i < STATES.length; i++) {
    const r = resolveEnumLabel(i, STATES);
    check(`ordinal ${i} does not become a state name`, r.startsWith("Unknown ("), r);
  }
}

console.log("\nA bare State code with no option list");
{
  const out = mapStandardProperties([{ propertyId: "p1", name: "State", value: 3 }]);
  check("not named from a hardcoded list", out.state !== "Obsolete" && out.state !== "Released", out.state);
  check("reported as unknown, code intact", out.state === "Unknown (3)", out.state);
}

console.log("\nState resolves properly when Onshape supplies the options");
{
  const out = mapStandardProperties([
    { propertyId: "p1", name: "State", value: "RELEASED", enumValues: STATES },
  ]);
  check("released reads as Released", out.state === "Released", out.state);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
