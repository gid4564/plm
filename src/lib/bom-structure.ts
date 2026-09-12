import type { BomLine, BomTable } from "@/lib/onshape/bom";

/**
 * Rebuild an assembly's hierarchy from an indented BOM.
 *
 * Onshape returns a multi-level BOM as a flat list of rows whose ORDER carries
 * the tree: a row's parent is the nearest row above it exactly one level
 * shallower. There is no parent pointer on the row — `indentLevel` and position
 * are the whole of it, which is why the rows must never be reordered or
 * collapsed before this runs.
 *
 * Rows at level 0 have no parent in the list; they hang off the assembly the
 * BOM was read from.
 */

export type StructuredRow = {
  line: BomLine;
  /** Index in the original row list, which is this position's identity. */
  index: number;
  /** Index of the parent row, or null for a top-level row. */
  parentIndex: number | null;
  level: number;
  /** Indexes of the immediate children. */
  childIndexes: number[];
};

export type Structure = {
  rows: StructuredRow[];
  /** Indexes of the rows directly under the assembly the BOM came from. */
  topLevel: number[];
  /**
   * Rows whose indent jumped by more than one from the row above.
   *
   * Reported rather than guessed at. A gap means the list is not the
   * well-formed indented BOM this reconstruction assumes — a row was filtered
   * out upstream, or the payload interleaves something unexpected — and
   * silently attaching such a row to a grandparent would invent a structure
   * Onshape never described.
   */
  gaps: { index: number; from: number; to: number }[];
};

export function structureFromIndent(table: BomTable): Structure {
  const rows: StructuredRow[] = [];
  const gaps: Structure["gaps"] = [];
  const topLevel: number[] = [];

  /*
   * The current ancestor at each depth.
   *
   * `stack[n]` is the index of the row most recently seen at level n, which is
   * by definition the parent of the next row at level n+1.
   */
  const stack: number[] = [];
  let previousLevel = 0;

  table.lines.forEach((line, index) => {
    const level = Math.max(0, Number(line.indentLevel) || 0);

    if (index > 0 && level > previousLevel + 1) {
      gaps.push({ index, from: previousLevel, to: level });
    }

    const parentIndex = level === 0 ? null : (stack[level - 1] ?? null);

    rows.push({ line, index, parentIndex, level, childIndexes: [] });
    if (parentIndex === null) topLevel.push(index);
    else rows[parentIndex].childIndexes.push(index);

    stack[level] = index;
    // Anything deeper than this row is no longer an ancestor of what follows.
    stack.length = level + 1;
    previousLevel = level;
  });

  return { rows, topLevel, gaps };
}

/**
 * Every (parent, child) pair the structure describes, in import order.
 *
 * Parents come before their children, because a child's edge cannot be written
 * until its parent exists in PLM.
 */
export function inImportOrder(structure: Structure): StructuredRow[] {
  const out: StructuredRow[] = [];
  const walk = (indexes: number[]) => {
    for (const i of indexes) {
      out.push(structure.rows[i]);
      walk(structure.rows[i].childIndexes);
    }
  };
  walk(structure.topLevel);
  return out;
}
