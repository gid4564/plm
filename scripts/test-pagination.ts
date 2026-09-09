/**
 * Checks for the dashboard's cursor pagination.
 *
 * Run with:  npm run test:pagination
 *
 * A cursor pins a page to the exact row it ended on rather than an offset, so
 * paging stays correct while the list underneath it keeps changing — which a
 * manufacturing list, being edited constantly, always is. These cases pin the
 * encode/decode round trip down, and — more importantly — that a cursor which
 * has been tampered with or comes from a different build never throws; it
 * just falls back to page one.
 */
import { decodeCursor, encodeCursor } from "../src/lib/pagination";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

console.log("Round trip");
{
  const c = { updatedAtMs: 1735689600000, id: "6a91cc116644a195a9150699" };
  const encoded = encodeCursor(c);
  const decoded = decodeCursor(encoded);
  check("decodes back to the same value", JSON.stringify(decoded) === JSON.stringify(c), decoded);
  check("the encoding is a plain string with no JSON punctuation",
    !/[{}\[\]"]/.test(encoded), encoded);
}

console.log("\nMalformed input never throws — it just means page one");
for (const bad of [null, undefined, "", "not-a-cursor", "123", "123_short", "abc_6a91cc116644a195a9150699", "-1_6a91cc116644a195a9150699"]) {
  let threw = false;
  let result: unknown;
  try {
    result = decodeCursor(bad as any);
  } catch {
    threw = true;
  }
  check(`${JSON.stringify(bad)} does not throw`, !threw);
  check(`${JSON.stringify(bad)} decodes to null`, result === null, result);
}

console.log("\nA valid-looking id with a negative or non-numeric timestamp is rejected");
check("negative timestamp rejected", decodeCursor("-5_6a91cc116644a195a9150699") === null);
check("non-numeric timestamp rejected", decodeCursor("abc_6a91cc116644a195a9150699") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
