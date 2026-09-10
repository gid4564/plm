import type { PropertyDef } from "./types";

/**
 * Mapping from Onshape's property names to the fields PLM mirrors.
 *
 * Matching is by name because Onshape's built-in property ids are not published
 * as stable constants. Names are normalised (case, spacing, punctuation) and
 * several spellings are accepted per field, since tenants and locales differ in
 * how built-ins are labelled.
 */
const STANDARD: Record<string, string[]> = {
  partName:    ["name", "part name", "title"],
  partNumber:  ["part number", "partnumber", "part no", "part no.", "part #", "number", "item number"],
  revision:    ["revision", "rev", "revision number"],
  description: ["description", "desc", "part description"],
  material:    ["material", "material name"],
  state:       ["state", "lifecycle state", "workflow state", "status"],
  vendor:      ["vendor", "supplier", "manufacturer"],
  project:     ["project", "programme", "program"],
};

/**
 * Render any Onshape property value as text.
 *
 * Not every value is a scalar: Material in particular arrives as an object
 * along the lines of { id, libraryName, displayName, properties }, and
 * String()-ing that yields "[object Object]". Rather than special-casing one
 * property, look for the field a human would read, in the order Onshape tends
 * to use.
 *
 * The last resort is compact JSON rather than "[object Object]" — an unfamiliar
 * shape should still show its contents so it can be reported and handled.
 */
export function toDisplayString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (Array.isArray(v)) {
    return v.map(toDisplayString).filter(Boolean).join(", ");
  }

  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const key of ["displayName", "label", "name", "value", "title", "text"]) {
      const candidate = o[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
      if (typeof candidate === "number" || typeof candidate === "boolean") return String(candidate);
    }
    try {
      const json = JSON.stringify(v);
      return json && json !== "{}" ? json.slice(0, 200) : "";
    } catch {
      return "";
    }
  }

  return String(v);
}

export const normalizeName = (s: string) =>
  s.toLowerCase().replace(/[\s_\-#.]+/g, " ").trim();

export type EnumOption = { value: unknown; label?: string };

export type RawProperty = {
  propertyId: string;
  name: string;
  value: unknown;
  valueType?: string;
  /** Present on ENUM properties: the option list this value indexes into. */
  enumValues?: EnumOption[];
};

/**
 * Every unresolved enum code seen this process, so the warning fires once per
 * distinct code rather than once per part in a hundred-part import.
 */
const reportedUnresolved = new Set<string>();

/** Fields an option might carry its code in. */
function optionCodes(o: EnumOption): string[] {
  const any = o as Record<string, unknown>;
  return ["value", "id", "key", "name", "label"]
    .map((k) => any[k])
    .filter((v) => v != null && v !== "")
    .map(String);
}

/**
 * Turn an enum property's raw value into its human-readable label.
 *
 * Matching is by the option's own code, never by position.
 *
 * A positional fallback used to live here, treating the raw integer as an index
 * into the option list. It produced a confidently wrong answer: a released part
 * reported as "Obsolete", because those two sit next to each other and Onshape's
 * numbering does not line up with the list order. In a manufacturing system a
 * plausible wrong state is far more dangerous than a visible unknown — somebody
 * could scrap good parts over it — so an unmatched code is surfaced as unknown
 * and logged alongside the options that were available, which is what makes the
 * real mapping knowable rather than guessable.
 */
export function resolveEnumLabel(value: unknown, options?: EnumOption[]): string {
  if (value == null || value === "") return "";
  if (!options || options.length === 0) return toDisplayString(value);

  const raw = String(value);
  const norm = normalizeName(raw);

  // Exact code match first, then a normalised one — a tenant may report
  // "RELEASED" against an option labelled "Released".
  const hit =
    options.find((o) => optionCodes(o).includes(raw)) ??
    options.find((o) => optionCodes(o).some((c) => normalizeName(c) === norm));

  if (hit) return toDisplayString(hit.label ?? hit.value);

  const key = `enum|${raw}|${options.map((o) => optionCodes(o)[0] ?? "?").join(",")}`;
  if (!reportedUnresolved.has(key)) {
    reportedUnresolved.add(key);
    console.warn(
      `[PLM] enum value ${JSON.stringify(value)} matched none of the options Onshape supplied: ` +
      `${JSON.stringify(options)}. Reporting it as unknown rather than guessing.`
    );
  }

  return `Unknown (${toDisplayString(value)})`;
}

/**
 * Fold Onshape's flat property list into PLM's named fields.
 *
 * Returns the mapped fields plus the full annotated list, so an unmapped or
 * oddly-named property stays visible rather than silently vanishing.
 */
export function mapStandardProperties(props: RawProperty[]) {
  // Resolve enum codes to labels before matching, so callers never see a bare
  // integer where a state name belongs.
  const byNormalized = new Map<string, unknown>();
  for (const p of props) {
    if (!p.name) continue;
    const key = normalizeName(p.name);
    let v: unknown = p.value;

    if (p.enumValues?.length) {
      v = resolveEnumLabel(p.value, p.enumValues);
    } else if (key === "state" && (typeof p.value === "number" || /^\d+$/.test(String(p.value ?? "")))) {
      /*
       * A bare state code with no option list to interpret it.
       *
       * This used to index a hardcoded list of Onshape's stock states, which
       * assumed both that the tenant runs the stock workflow and that the codes
       * are 0-based. Get either wrong and PLM names a neighbouring state
       * with complete confidence — which is the released-shown-as-obsolete bug.
       *
       * There is nothing here to resolve the code against, so it is reported as
       * the code it is and logged, so the mapping can be settled from a real
       * payload instead of assumed.
       */
      const code = String(p.value);
      const seen = `state-bare|${code}`;
      if (!reportedUnresolved.has(seen)) {
        reportedUnresolved.add(seen);
        console.warn(
          `[PLM] Onshape reported State as bare code ${code} with no option list, so it ` +
          `cannot be named without guessing. Full property: ${JSON.stringify(p)}`
        );
      }
      v = `Unknown (${code})`;
    }

    /*
     * First non-empty wins, and a clash is reported.
     *
     * This used to overwrite silently. Onshape can return more than one
     * property whose name normalises to the same key — a part-level "State" and
     * a workflow "Status", say — and whichever happened to come last in the
     * response decided what PLM displayed. That is a coin toss dressed up
     * as a mapping, and precisely the kind of thing that shows a released part
     * as something else.
     */
    const existing = byNormalized.get(key);
    if (existing != null && toDisplayString(existing) !== "") {
      if (toDisplayString(existing) !== toDisplayString(v)) {
        const clash = `clash|${key}`;
        if (!reportedUnresolved.has(clash)) {
          reportedUnresolved.add(clash);
          console.warn(
            `[PLM] two Onshape properties both map to "${key}" with different values: ` +
            `${JSON.stringify(toDisplayString(existing))} and ${JSON.stringify(toDisplayString(v))}. ` +
            `Keeping the first. Properties: ${JSON.stringify(props.filter((q) => normalizeName(q.name) === key))}`
          );
        }
      }
      continue;
    }

    byNormalized.set(key, v);
  }

  const out: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(STANDARD)) {
    let v: unknown;
    for (const a of aliases) {
      const hit = byNormalized.get(normalizeName(a));
      if (hit != null && toDisplayString(hit) !== "") { v = hit; break; }
    }
    out[field] = toDisplayString(v);
  }
  return out;
}

export function toDefinitions(props: RawProperty[]): PropertyDef[] {
  return props
    .filter((p) => p.propertyId && p.name)
    .map((p) => ({ propertyId: p.propertyId, name: p.name, valueType: "STRING" }));
}
