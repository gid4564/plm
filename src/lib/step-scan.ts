/**
 * What a STEP file contains, read before it is sent anywhere.
 *
 * A STEP file (ISO 10303-21) is plain text: a list of numbered entities that
 * refer to one another. That makes it possible to tell, without a CAD kernel,
 * whether a file is one part or several — which decides whether "Create in
 * Onshape" can go straight ahead or should first show what it found.
 *
 * The chain followed, per part:
 *
 *   PRODUCT ← PRODUCT_DEFINITION_FORMATION ← PRODUCT_DEFINITION
 *     ← PRODUCT_DEFINITION_SHAPE ← SHAPE_DEFINITION_REPRESENTATION → representation
 *     → (SHAPE_REPRESENTATION_RELATIONSHIP)* → items → MANIFOLD_SOLID_BREP
 *
 * and NEXT_ASSEMBLY_USAGE_OCCURRENCE (parent → child definition) says how many
 * times each part is used, multiplied down through subassemblies.
 *
 * Only the *simple* SHAPE_REPRESENTATION_RELATIONSHIP is followed. The complex
 * one (written `#n=(REPRESENTATION_RELATIONSHIP(..)..WITH_TRANSFORMATION(..)..)`)
 * is an assembly placement — it ties a parent's shape to a child's — and
 * following it would count every child's solids as the assembly's own.
 *
 * This is a reading for a person to confirm, never the last word: Onshape's
 * own import is what is linked to (see lib/onshape-create.ts).
 */

export type ScannedPart = {
  /** Stable within the file: the PRODUCT_DEFINITION's entity id. */
  key: string;
  name: string;
  /** How many times the part is used, through every level of the assembly. */
  instances: number;
  /** Solid bodies in one use of it. */
  bodiesPerInstance: number;
};

export type StepScan = {
  ok: boolean;
  /** Why the file could not be read, when it could not. */
  error?: string;
  parts: ScannedPart[];
  /** Bodies a flattened import should produce: Σ instances × bodies. */
  totalBodies: number;
  /** The file carries assembly structure, not only loose parts. */
  assembly: boolean;
};

type Ref = { ref: number };
type Value = string | number | null | Ref | Value[] | { enum: string };
type Entity = { type: string; args: Value[]; complex: boolean };

const SOLID_TYPES = new Set(["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "FACETED_BREP"]);

const isRef = (v: Value | undefined): v is Ref =>
  !!v && typeof v === "object" && !Array.isArray(v) && "ref" in v;

/** Split the DATA section into one string per entity, respecting quoted text. */
function records(text: string): string[] {
  const start = text.search(/\bDATA\s*;/);
  if (start < 0) return [];
  const body = text.slice(text.indexOf(";", start) + 1);

  const out: string[] = [];
  let cur = "";
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      cur += c;
      if (c === "'") {
        // '' is an escaped quote inside a string, not its end.
        if (body[i + 1] === "'") { cur += "'"; i++; }
        else inString = false;
      }
      continue;
    }
    if (c === "'") { inString = true; cur += c; continue; }
    if (c === ";") {
      const r = cur.trim();
      if (/^ENDSEC$/i.test(r)) break;
      if (r) out.push(r);
      cur = "";
      continue;
    }
    // Comments are /* ... */ and may sit between entities.
    if (c === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      i = end < 0 ? body.length : end + 1;
      continue;
    }
    cur += c === "\n" || c === "\r" ? " " : c;
  }
  return out;
}

/** Parse a parenthesised argument list starting at `s[i] === "("`. */
function parseList(s: string, i: number): [Value[], number] {
  const out: Value[] = [];
  i++; // past "("
  while (i < s.length) {
    while (s[i] === " " || s[i] === ",") i++;
    const c = s[i];
    if (c === ")") return [out, i + 1];
    if (c === "(") {
      const [v, j] = parseList(s, i);
      out.push(v); i = j; continue;
    }
    if (c === "'") {
      let j = i + 1, str = "";
      while (j < s.length) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") { str += "'"; j += 2; continue; }
          break;
        }
        str += s[j++];
      }
      out.push(str); i = j + 1; continue;
    }
    if (c === "#") {
      const m = /^#(\d+)/.exec(s.slice(i, i + 16));
      out.push(m ? { ref: Number(m[1]) } : null);
      i += m ? m[0].length : 1; continue;
    }
    if (c === "$" || c === "*") { out.push(null); i++; continue; }
    if (c === ".") {
      const end = s.indexOf(".", i + 1);
      out.push({ enum: s.slice(i + 1, end) }); i = end + 1; continue;
    }
    // A typed value, e.g. LENGTH_MEASURE(2.5), or a number.
    const m = /^[A-Z0-9_]+(?=\s*\()/i.exec(s.slice(i, i + 80));
    if (m) {
      const [v, j] = parseList(s, s.indexOf("(", i));
      out.push(v.length === 1 ? v[0] : v); i = j; continue;
    }
    const n = /^[-+0-9.Ee]+/.exec(s.slice(i, i + 40));
    if (n) { out.push(Number(n[0])); i += n[0].length; continue; }
    i++; // Unknown character: skip rather than fail the whole file.
  }
  return [out, i];
}

function parse(text: string): Map<number, Entity> {
  const map = new Map<number, Entity>();
  for (const r of records(text)) {
    const m = /^#(\d+)\s*=\s*(.*)$/s.exec(r);
    if (!m) continue;
    const id = Number(m[1]);
    const rest = m[2].trim();
    if (rest.startsWith("(")) {
      // A complex entity: several types in one. Only the type names matter here.
      map.set(id, { type: "", args: [], complex: true });
      continue;
    }
    const t = /^([A-Z0-9_]+)\s*\(/i.exec(rest);
    if (!t) continue;
    const [args] = parseList(rest, rest.indexOf("("));
    map.set(id, { type: t[1].toUpperCase(), args, complex: false });
  }
  return map;
}

export function scanStep(data: Buffer | string): StepScan {
  const text = typeof data === "string" ? data : data.toString("latin1");
  const empty = (error: string): StepScan => ({ ok: false, error, parts: [], totalBodies: 0, assembly: false });

  if (!/ISO-10303-21/.test(text.slice(0, 2000))) return empty("Not a STEP file (no ISO-10303-21 header).");
  const ents = parse(text);
  if (ents.size === 0) return empty("The STEP file has no data section.");

  const ref = (v: Value | undefined) => (isRef(v) ? v.ref : null);
  const byType = (pred: (t: string) => boolean) =>
    [...ents.entries()].filter(([, e]) => !e.complex && pred(e.type));

  // Product → name, and the chain down to its definition.
  const productName = new Map<number, string>();
  for (const [id, e] of byType((t) => t === "PRODUCT")) {
    const [pid, name] = e.args;
    productName.set(id, String((typeof name === "string" && name.trim()) || (typeof pid === "string" && pid.trim()) || `Part ${id}`));
  }
  const formationProduct = new Map<number, number>();
  for (const [id, e] of byType((t) => t.startsWith("PRODUCT_DEFINITION_FORMATION"))) {
    const p = ref(e.args[2]);
    if (p != null) formationProduct.set(id, p);
  }
  const definitions = new Map<number, string>(); // definition → product name
  for (const [id, e] of byType((t) => t === "PRODUCT_DEFINITION" || t.startsWith("PRODUCT_DEFINITION_WITH"))) {
    const f = ref(e.args[2]);
    const p = f != null ? formationProduct.get(f) : undefined;
    definitions.set(id, p != null ? productName.get(p) ?? `Part ${id}` : `Part ${id}`);
  }

  // Definition → its representations.
  const pdsDefinition = new Map<number, number>();
  for (const [id, e] of byType((t) => t === "PRODUCT_DEFINITION_SHAPE")) {
    const d = ref(e.args[2]);
    if (d != null && definitions.has(d)) pdsDefinition.set(id, d);
  }
  const defReps = new Map<number, number[]>();
  for (const [, e] of byType((t) => t === "SHAPE_DEFINITION_REPRESENTATION")) {
    const pds = ref(e.args[0]);
    const rep = ref(e.args[1]);
    const d = pds != null ? pdsDefinition.get(pds) : undefined;
    if (d == null || rep == null) continue;
    defReps.set(d, [...(defReps.get(d) ?? []), rep]);
  }

  // Simple shape-representation relationships link a part's representations
  // together (e.g. its SHAPE_REPRESENTATION to its ADVANCED_BREP_...).
  const links = new Map<number, number[]>();
  for (const [, e] of byType((t) => t === "SHAPE_REPRESENTATION_RELATIONSHIP")) {
    const a = ref(e.args[2]), b = ref(e.args[3]);
    if (a == null || b == null) continue;
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }

  const solidsIn = (rep: number): number => {
    const items = ents.get(rep)?.args[1];
    if (!Array.isArray(items)) return 0;
    return items.filter((v) => isRef(v) && SOLID_TYPES.has(ents.get(v.ref)?.type ?? "")).length;
  };
  const bodiesOf = (d: number): number => {
    const seen = new Set<number>();
    const queue = [...(defReps.get(d) ?? [])];
    let n = 0;
    while (queue.length) {
      const r = queue.pop()!;
      if (seen.has(r)) continue;
      seen.add(r);
      n += solidsIn(r);
      queue.push(...(links.get(r) ?? []));
    }
    return n;
  };

  // How many times each definition is used.
  const usesOf = new Map<number, number[]>(); // child → parents, one entry per use
  let occurrences = 0;
  for (const [, e] of byType((t) => t === "NEXT_ASSEMBLY_USAGE_OCCURRENCE")) {
    const parent = ref(e.args[3]), child = ref(e.args[4]);
    if (parent == null || child == null) continue;
    usesOf.set(child, [...(usesOf.get(child) ?? []), parent]);
    occurrences++;
  }
  const memo = new Map<number, number>();
  const instancesOf = (d: number, depth = 0): number => {
    if (memo.has(d)) return memo.get(d)!;
    const parents = usesOf.get(d);
    // A root, or a cycle in a malformed file, counts once.
    const n = !parents || depth > 50 ? 1 : parents.reduce((sum, p) => sum + instancesOf(p, depth + 1), 0);
    memo.set(d, n);
    return n;
  };

  const parts: ScannedPart[] = [];
  for (const d of definitions.keys()) {
    const bodies = bodiesOf(d);
    if (bodies === 0) continue; // an assembly, or a definition with no solid
    parts.push({ key: String(d), name: definitions.get(d)!, instances: instancesOf(d), bodiesPerInstance: bodies });
  }

  // Solids that no product claims — a file written without product structure.
  if (parts.length === 0) {
    const loose = byType((t) => SOLID_TYPES.has(t)).length;
    if (loose === 0) return empty("The STEP file contains no solid bodies.");
    const name = [...productName.values()][0] ?? "Part";
    parts.push({ key: "file", name, instances: 1, bodiesPerInstance: loose });
  }

  return {
    ok: true,
    parts,
    totalBodies: parts.reduce((n, p) => n + p.instances * p.bodiesPerInstance, 0),
    assembly: occurrences > 0,
  };
}

export const isStepFile = (filename: string) => /\.(step|stp)$/i.test(filename);
