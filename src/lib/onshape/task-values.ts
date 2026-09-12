/**
 * Rendering an Onshape property value as text.
 *
 * Pure, and deliberately free of any server import so the task panel can use
 * it directly: the panel is a client component, and reaching into lib/tasks
 * for this would drag Mongoose into the browser bundle.
 *
 * It exists because a property's `value` is not always a scalar. Two of the
 * ones every task carries are arrays of objects, and `String()` on those
 * renders the string "[object Object]" — which is what a task panel showed for
 * Category and Assigned to:
 *
 *   Category     -> [{ name: "Task", memberCategories: [{ name: "Onshape Task" }], … }]
 *   Assigned to  -> [{ name: "Dan Designer", approvalDate: "…", approverName: "…", … }]
 *
 * Both carry a human `name`; the rest is Onshape's bookkeeping.
 */

/** The fields Onshape uses to name a thing, in the order worth trying. */
const NAME_KEYS = ["name", "label", "displayName", "approverName", "email", "id"];

/** One element of a structured value, as a person would read it. */
function nameOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);

  const o = v as Record<string, unknown>;
  for (const k of NAME_KEYS) {
    const candidate = o[k];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number") return String(candidate);
  }

  /*
   * Nothing nameable. An empty string rather than a JSON dump: the caller
   * turns that into "—", and a wall of braces in a form field tells a reader
   * less than an honest blank does.
   */
  return "";
}

export type FormatOptions = {
  valueType?: string;
  enumValues?: { value: string; label: string }[];
  /** What to show when there is nothing. */
  empty?: string;
};

/**
 * A property value as display text, never "[object Object]".
 *
 * An enum resolves through its own labels, because the stored value is a code
 * nobody recognises — Priority is "0", not "Low".
 */
export function formatPropertyValue(value: unknown, opts: FormatOptions = {}): string {
  const empty = opts.empty ?? "—";

  if (value == null || value === "") return empty;

  /* An enum's code means nothing without the label list that came with it. */
  const enumHit = (opts.enumValues ?? []).find((e) => String(e.value) === String(value));
  if (enumHit) return enumHit.label || String(value);

  if (Array.isArray(value)) {
    const names = value.map(nameOf).filter(Boolean);
    return names.length ? names.join(", ") : empty;
  }

  if (typeof value === "object") {
    return nameOf(value) || empty;
  }

  if (String(opts.valueType ?? "").toUpperCase() === "DATE") {
    const d = new Date(String(value));
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
  }

  if (typeof value === "boolean") return value ? "Yes" : "No";

  return String(value);
}

/**
 * Whether a value is structured enough that a text box over it would corrupt
 * it rather than change it.
 *
 * Used to decide between an input and a read-only line: PLM has no picker for
 * a user list or a category tree, and offering a text field for one is a way
 * to destroy it.
 */
export function isStructuredValue(value: unknown): boolean {
  return value != null && typeof value === "object";
}
