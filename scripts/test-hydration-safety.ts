/**
 * No client component may read browser-only state during render.
 *
 * A `useState` initialiser runs on the server too. Reaching for `window`,
 * `localStorage` or `document` in one renders one value into the server's HTML
 * and a different value on the client — a hydration mismatch, which React
 * reports in production only as the unreadable "Minified React error #418".
 *
 * This is not hypothetical and not a style rule. The tasks board did it twice:
 * the deep-link `?task=` read `window.location.search`, and the closed-task
 * window read `localStorage`. The page threw #418, and inside Onshape's right
 * panel — a third-party iframe — it surfaced as the panel "erroring out" with
 * nothing to explain it. The fix in both cases is an effect: it runs after
 * mount, so the first client render matches the server's.
 *
 * The same trap is already called out in src/app/panel/page.tsx, which is why
 * a comment was not enough and this is a test.
 */
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const BROWSER_ONLY = /\b(window|localStorage|sessionStorage|document|navigator)\b/;

/** Every .tsx under a directory. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * The body of every lazy `useState(() => …)` initialiser in a file.
 *
 * Brace-counted rather than regexed to a fixed length: an initialiser with a
 * try/catch in it is exactly the shape that reads localStorage, and a fixed
 * window would miss the half of it that matters.
 */
function lazyInitialisers(src: string): { body: string; line: number }[] {
  const out: { body: string; line: number }[] = [];
  const re = /useState\s*(?:<[^>]*>)?\s*\(\s*\(\s*\)\s*=>/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(" || c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    out.push({ body: src.slice(start, i), line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

console.log("No client component reads browser state during render");

const roots = ["src/app", "src/components"].filter((d) => fs.existsSync(d));
const files = roots.flatMap((d) => walk(d));
const offenders: string[] = [];

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes('"use client"') && !src.includes("'use client'")) continue;

  for (const init of lazyInitialisers(src)) {
    if (BROWSER_ONLY.test(init.body)) {
      offenders.push(
        `${file}:${init.line} — useState initialiser reads ` +
        `${init.body.match(BROWSER_ONLY)?.[0]}. Move it into a useEffect.`
      );
    }
  }
}

check(
  `no useState initialiser reads browser-only state (${files.length} files scanned)`,
  offenders.length === 0,
  offenders.join(" | ")
);

/* The detector has to actually detect, or this test passes by being blind. */
const BAD = `"use client";
const [a, setA] = useState<string | null>(() => {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem("k"); } catch { return null; }
});`;
const GOOD = `"use client";
const [a, setA] = useState<string | null>(null);
useEffect(() => { setA(window.localStorage.getItem("k")); }, []);`;

check("the check catches the shape it exists for",
  lazyInitialisers(BAD).some((i) => BROWSER_ONLY.test(i.body)));
check("and does not flag the effect that fixes it",
  !lazyInitialisers(GOOD).some((i) => BROWSER_ONLY.test(i.body)));
/* A lazy initialiser doing something harmless must not be flagged. */
check("nor a plain lazy initialiser",
  !lazyInitialisers(`useState(() => new Set<string>())`).some((i) => BROWSER_ONLY.test(i.body)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
