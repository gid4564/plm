/**
 * Describe the shape of a JSON payload, for when a parse finds nothing.
 *
 * Written because a release package came back and PLM reported state `""` with
 * no available actions — which told nobody anything, while the response that
 * would have explained it sat in memory and was discarded. The same gap once
 * hid Onshape's numeric `elementType`: the fix there was to log the shape and
 * read the answer off a real payload rather than reason about the docs.
 *
 * Keys and types, not values. A release package carries part names, numbers and
 * an approver's identity, and a log line is the wrong place for those. The
 * exceptions are short strings on keys that look like a state or an action,
 * which are the values actually being hunted for and are not sensitive.
 */

const VALUE_WORTH_SHOWING = /state|status|action|transition|type|workflow|id$/i;
const MAX_STRING = 40;

function tag(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  return typeof v;
}

/**
 * One level of shape, recursing into objects and the first element of arrays.
 *
 * Depth-limited: nesting past a few levels is more noise than help in a log
 * line, and the interesting containers in Onshape's payloads sit near the top.
 */
export function describeShape(value: unknown, depth = 2): string {
  if (value === null || value === undefined) return tag(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]";
    if (depth <= 0) return `array[${value.length}]`;
    return `array[${value.length}] of ${describeShape(value[0], depth - 1)}`;
  }

  if (typeof value === "object") {
    if (depth <= 0) return "object";
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      // Show the value itself only where it is both short and likely to be the
      // thing being looked for.
      if (
        typeof v === "string" && v.length <= MAX_STRING && VALUE_WORTH_SHOWING.test(k)
      ) {
        return `${k}=${JSON.stringify(v)}`;
      }
      if (typeof v === "number" || typeof v === "boolean") return `${k}=${v}`;
      if (v && typeof v === "object") return `${k}:${describeShape(v, depth - 1)}`;
      return `${k}:${tag(v)}`;
    });
    return `{${entries.join(" ")}}`;
  }

  if (typeof value === "string") {
    return value.length <= MAX_STRING ? JSON.stringify(value) : `string(${value.length})`;
  }

  return tag(value);
}
