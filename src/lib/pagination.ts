/**
 * Cursor for paging a list sorted newest-updated-first.
 *
 * Offset-based paging ("skip 50, take 50") drifts on a list that keeps
 * changing underneath it: an item edited between two page loads moves to the
 * top, and the next page either repeats it or skips whatever it displaced.
 * A cursor pins each page to the exact row it stopped at instead, so paging
 * stays correct while the list is being worked on — which a manufacturing
 * list always is.
 */
export type Cursor = { updatedAtMs: number; id: string };

const PATTERN = /^(\d+)_([0-9a-fA-F]{24})$/;

/** Opaque, URL-safe encoding of a page boundary. */
export function encodeCursor(c: Cursor): string {
  return `${c.updatedAtMs}_${c.id}`;
}

/**
 * Decode a cursor produced by encodeCursor.
 *
 * Anything malformed — tampered with, or left over from a build that encoded
 * it differently — decodes to null rather than throwing. A bad cursor should
 * just restart from page one, not break the list.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  const m = PATTERN.exec(raw);
  if (!m) return null;
  const updatedAtMs = Number(m[1]);
  if (!Number.isFinite(updatedAtMs)) return null;
  return { updatedAtMs, id: m[2] };
}
