/**
 * Checks for the part-numbering formatter.
 *
 * Run with:  npm run test:numbering
 *
 * This is the only pure logic in the numbering feature — the surrounding
 * counter increment and Onshape write are side effects, exercised by hand in
 * the browser instead. Formatting is worth pinning down anyway: padding,
 * empty prefix/suffix, and a counter that has outgrown its own padding width
 * are all easy to get subtly wrong.
 */
import { formatNumber } from "../src/lib/numbering";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

console.log("Prefix, padded counter, suffix");
check("basic case", formatNumber("PN-", 7, 5, "") === "PN-00007", formatNumber("PN-", 7, 5, ""));
check("prefix and suffix both present",
  formatNumber("AS-", 12, 4, "-A") === "AS-0012-A", formatNumber("AS-", 12, 4, "-A"));

console.log("\nNo prefix or suffix — just the padded number");
check("empty prefix and suffix", formatNumber("", 3, 5, "") === "00003", formatNumber("", 3, 5, ""));

console.log("\nCounter wider than its own padding — never truncated");
check("counter overruns padding, number stays intact",
  formatNumber("PN-", 123456, 3, "") === "PN-123456", formatNumber("PN-", 123456, 3, ""));

console.log("\nZero padding — no leading zeros at all");
check("zero padding", formatNumber("PN-", 7, 0, "") === "PN-7", formatNumber("PN-", 7, 0, ""));

console.log("\nDegenerate inputs — never throw, never go negative");
check("negative counter floors to 0", formatNumber("PN-", -5, 5, "") === "PN-00000", formatNumber("PN-", -5, 5, ""));
check("negative padding treated as 0", formatNumber("PN-", 7, -2, "") === "PN-7", formatNumber("PN-", 7, -2, ""));
check("fractional counter truncates", formatNumber("PN-", 7.9, 5, "") === "PN-00007", formatNumber("PN-", 7.9, 5, ""));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
