/**
 * Regression test for the empty-body bug.
 *
 * A `.lean()` query returns a BSON Binary, and `new Uint8Array(binary)` gives a
 * zero-length array without throwing — so a route served HTTP 200 with the
 * right Content-Type and Content-Length and no body at all. The only symptom
 * was the client reporting a truncated transfer.
 *
 * These assertions pin the shapes that actually occur, including the one that
 * caused it.
 */
import { toBuffer } from "../src/lib/binary";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** The shape a .lean() query produces. `length` is a method, not a number. */
class FakeBinary {
  sub_type = 0;
  position: number;
  constructor(public buffer: Buffer) { this.position = buffer.length; }
  length() { return this.position; }
}

console.log("\nWhat the bug actually was");
{
  const bytes = Buffer.from("%PDF-1.4 hello");
  const binary = new FakeBinary(bytes);

  // The failure, demonstrated rather than described.
  check("Uint8Array over a BSON Binary is silently empty",
    new Uint8Array(binary as unknown as ArrayLike<number>).length === 0);
  check("and its own length is a function, not a number",
    typeof (binary as any).length === "function");

  const out = toBuffer(binary);
  check("toBuffer recovers the real bytes", out?.length === bytes.length, String(out?.length));
  check("and the content is intact", out?.toString() === "%PDF-1.4 hello");
}

console.log("\nEvery shape a binary field arrives in");
{
  const b = Buffer.from([1, 2, 3]);
  check("a Buffer passes through", toBuffer(b)?.length === 3);
  check("a Uint8Array converts", toBuffer(new Uint8Array([1, 2, 3]))?.length === 3);
  check("an ArrayBuffer converts", toBuffer(new Uint8Array([1, 2, 3]).buffer)?.length === 3);
  check("a Binary wrapping a Uint8Array converts",
    toBuffer({ buffer: new Uint8Array([1, 2, 3]), sub_type: 0 })?.length === 3);
}

console.log("\nNothing stored is distinguishable from something stored");
{
  // The distinction matters: a route must answer 404 for "never captured"
  // rather than serve a valid, empty PDF that a person would try to open.
  check("null is nothing", toBuffer(null) === null);
  check("undefined is nothing", toBuffer(undefined) === null);
  check("an empty Buffer is nothing", toBuffer(Buffer.alloc(0)) === null);
  check("an empty Binary is nothing", toBuffer(new FakeBinary(Buffer.alloc(0))) === null);
  check("an unrelated object is nothing", toBuffer({ nope: true }) === null);
  check("a string is nothing", toBuffer("not bytes") === null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
