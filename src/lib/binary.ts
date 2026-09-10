/**
 * Normalise whatever Mongo hands back for a binary field into a Buffer.
 *
 * This exists because of a failure that is almost invisible. A `.lean()` query
 * returns a BSON `Binary` rather than a Node `Buffer`, and `new Uint8Array(binary)`
 * does not throw on it — it quietly produces a zero-length array. A route that
 * did that served HTTP 200 with the correct Content-Type and Content-Length and
 * an empty body, so the only symptom was the client reporting a truncated
 * transfer. Nothing in the logs, nothing in the response headers, and no error
 * anywhere.
 *
 * Returns null rather than an empty Buffer when there is genuinely nothing, so
 * a caller can tell "no content stored" from "content of length zero" and
 * answer 404 rather than serving a valid, empty file.
 */
export function toBuffer(v: unknown): Buffer | null {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.length ? v : null;

  // BSON Binary: the bytes live on `.buffer`. Its own `length` is a method,
  // which is the detail that makes the Uint8Array conversion fail silently.
  const binary = v as { buffer?: unknown; sub_type?: number };
  if (binary.buffer != null) {
    const inner = binary.buffer;
    if (Buffer.isBuffer(inner)) return inner.length ? inner : null;
    if (inner instanceof Uint8Array) return inner.length ? Buffer.from(inner) : null;
  }

  if (v instanceof Uint8Array) return v.length ? Buffer.from(v) : null;
  if (v instanceof ArrayBuffer) return v.byteLength ? Buffer.from(v) : null;

  return null;
}
