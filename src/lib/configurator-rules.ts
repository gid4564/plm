/**
 * The configurator's rules — what the inputs are, which are visible, and what
 * a set of values means — derived from Onshape's configuration payload.
 *
 * Pure and dependency-free, so the browser (showing and hiding inputs as
 * someone types) and the server (deciding the cache key) run the very same
 * code. Two implementations of "is this input visible" would disagree the
 * first time a model used a rule one of them did not know, and the result
 * would be a key the form never showed.
 *
 * Shapes are as read from a live tenant (docs/CONFIGURATOR-DESIGN.md §1):
 * each parameter wrapped as {type, typeName, message}, visibility as a tree of
 * BTParameterVisibilityLogical (AND/OR) over BTParameterVisibilityOnEqual.
 */

export type ConfigOption = { value: string; label: string };

export type Rule =
  | { op: "AND" | "OR"; children: Rule[] }
  | { equals: { id: string; value: string } }
  /** A rule type not met before: treated as satisfied, so it never hides an input wrongly. */
  | { unknown: string };

export type ConfigInput = {
  id: string;
  name: string;
  kind: "list" | "boolean" | "quantity" | "string";
  options: ConfigOption[];
  default: string;
  /** Quantities only. */
  min?: number;
  max?: number;
  units?: string;
  integer?: boolean;
  visibility: Rule | null;
};

export type Values = Record<string, string>;

/** Onshape's typed envelope, unwrapped — payloads arrive either way. */
const un = (x: any): any => (x && typeof x === "object" && x.message && typeof x.message === "object" ? x.message : x);
const typeOf = (x: any): string => String(x?.typeName ?? x?.btType ?? un(x)?.btType ?? "");

function parseRule(raw: any): Rule | null {
  if (!raw) return null;
  const t = typeOf(raw);
  const m = un(raw) ?? {};
  if (/Logical/.test(t)) {
    const children = (m.children ?? []).map(parseRule).filter(Boolean) as Rule[];
    if (children.length === 0) return null;
    return { op: String(m.operation).toUpperCase() === "OR" ? "OR" : "AND", children };
  }
  if (/OnEqual/.test(t)) return { equals: { id: String(m.parameterId), value: String(m.value) } };
  // The empty base condition means "always shown".
  if (!t || t === "BTParameterVisibilityCondition") return null;
  return { unknown: t };
}

/** The inputs of a configuration payload, in Onshape's order. */
export function parseDefinition(payload: unknown): ConfigInput[] {
  const params: any[] = (payload as any)?.configurationParameters ?? [];
  return params.map((wrapped) => {
    const p = un(wrapped);
    const t = typeOf(wrapped);
    const kind: ConfigInput["kind"] = /Enum/.test(t) ? "list" : /Boolean/.test(t) ? "boolean"
      : /Quantity/.test(t) ? "quantity" : "string";
    const options = (p.options ?? []).map(un).map((o: any) => ({
      value: String(o.option), label: String(o.optionName ?? o.option),
    }));
    const r = un(p.rangeAndDefault);
    const input: ConfigInput = {
      id: String(p.parameterId),
      name: String(p.parameterName ?? p.parameterId),
      kind,
      options,
      default: String(
        kind === "quantity" ? r?.defaultValue ?? "" : p.defaultValue ?? (kind === "list" ? options[0]?.value ?? "" : "")
      ),
      visibility: parseRule(p.visibilityCondition),
    };
    if (kind === "boolean") input.default = String(String(p.defaultValue) === "true");
    if (kind === "quantity") {
      input.min = Number(r?.minValue);
      input.max = Number(r?.maxValue);
      input.units = String(r?.units ?? "");
      input.integer = String(p.quantityType ?? "").toUpperCase() === "INTEGER";
    }
    return input;
  });
}

/** Whether a rule holds for these values. */
function holds(rule: Rule | null, values: Values): boolean {
  if (!rule) return true;
  if ("op" in rule) {
    return rule.op === "AND" ? rule.children.every((c) => holds(c, values)) : rule.children.some((c) => holds(c, values));
  }
  if ("equals" in rule) return String(values[rule.equals.id] ?? "") === rule.equals.value;
  return true;
}

/**
 * The values as they really are: anything given that is not an input is
 * dropped, anything missing takes its default, and every input hidden under
 * the result is reset to its default.
 *
 * Repeated until nothing moves, because resetting one hidden input can hide
 * another (switching foam off hides Add cutouts, whose reset hides Cutout
 * type). Bounded by the number of inputs — each pass can only settle more.
 */
export function resolve(inputs: ConfigInput[], given: Values): { values: Values; visible: Set<string> } {
  const values: Values = {};
  for (const i of inputs) values[i.id] = given[i.id] != null && given[i.id] !== "" ? String(given[i.id]) : i.default;

  let visible = new Set<string>();
  for (let pass = 0; pass <= inputs.length; pass++) {
    visible = new Set(inputs.filter((i) => holds(i.visibility, values)).map((i) => i.id));
    let moved = false;
    for (const i of inputs) {
      if (!visible.has(i.id) && values[i.id] !== i.default) {
        values[i.id] = i.default;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { values, visible };
}

/** What is wrong with the visible values, per input. Hidden inputs are never wrong. */
export function validate(inputs: ConfigInput[], values: Values, visible: Set<string>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const i of inputs) {
    if (!visible.has(i.id)) continue;
    const v = values[i.id];
    if (i.kind === "list" && !i.options.some((o) => o.value === v)) {
      errors[i.id] = `Choose one of: ${i.options.map((o) => o.label).join(", ")}.`;
    } else if (i.kind === "boolean" && v !== "true" && v !== "false") {
      errors[i.id] = "Must be on or off.";
    } else if (i.kind === "quantity") {
      const n = Number(v);
      const unit = i.units ? ` ${i.units}` : "";
      if (!Number.isFinite(n)) errors[i.id] = "Enter a number.";
      else if (i.integer && !Number.isInteger(n)) errors[i.id] = "Enter a whole number.";
      else if (n < (i.min ?? -Infinity) || n > (i.max ?? Infinity)) {
        errors[i.id] = `Between ${i.min} and ${i.max}${unit}.`;
      }
    }
  }
  return errors;
}

/** The parameters to send to Onshape's encoder: every input, a quantity with its unit. */
export function toEncoding(inputs: ConfigInput[], values: Values): { parameterId: string; parameterValue: string }[] {
  return inputs.map((i) => ({
    parameterId: i.id,
    parameterValue: i.kind === "quantity" && i.units ? `${values[i.id]} ${i.units}` : String(values[i.id]),
  }));
}

/** A one-line description of the visible choices: "700 x 400 x 300 · Add foam inserts · Slots 10". */
export function summarize(inputs: ConfigInput[], values: Values, visible: Set<string>): string {
  const abbrev = (u?: string) => (u === "millimeter" ? "mm" : u === "inch" ? "in" : u === "meter" ? "m" : u ?? "");
  const parts: string[] = [];
  for (const i of inputs) {
    if (!visible.has(i.id)) continue;
    const v = values[i.id];
    if (i.kind === "list") {
      const label = i.options.find((o) => o.value === v)?.label ?? v;
      // A choice that is also the name of another visible input ("Slots", then
      // "Slots 10") reads as a stutter, so it is named: "Cutout type: Slots".
      const clash = inputs.some((x) => x !== i && visible.has(x.id) && x.name.toLowerCase() === label.toLowerCase());
      parts.push(clash ? `${i.name}: ${label}` : label);
    }
    else if (i.kind === "boolean") { if (v === "true") parts.push(i.name); }
    else if (i.kind === "quantity") parts.push(`${i.name} ${v}${i.units ? ` ${abbrev(i.units)}` : ""}`);
    else if (v) parts.push(`${i.name}: ${v}`);
  }
  return parts.join(" · ");
}
