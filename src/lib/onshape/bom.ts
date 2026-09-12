import type { PartCoords } from "./types";
import { normalizeName, toDisplayString } from "./standard-properties";

/* -------------------------------------------------------------------------- */
/* Bill of materials                                                           */
/*                                                                            */
/* Onshape's BOM response has changed shape more than once, and the public     */
/* documentation does not describe every variant a tenant can return. Rather   */
/* than bind to one layout, everything here is written to accept whichever of  */
/* the known shapes turns up and to say which one it recognised, so a payload   */
/* this parser has never seen is reported instead of silently yielding an      */
/* empty table.                                                                */
/* -------------------------------------------------------------------------- */

/** One row of an exploded assembly. */
export type BomLine = {
  /** Stable identity for selection; derived from the source part when there is one. */
  key: string;
  quantity: number;
  partNumber: string;
  name: string;
  description: string;
  material: string;
  revision: string;
  state: string;
  vendor: string;
  project: string;
  /** 0 for a top-level row; deeper values only appear in an indented BOM. */
  indentLevel: number;
  /**
   * A subassembly row rather than a part row.
   *
   * Not currently brought into PLM by an import — see the note on
   * `assessLine` in lib/bom-import.ts. PLM does track assemblies, so this is a
   * limitation of the importer rather than of the model.
   */
  isAssembly: boolean;
  /**
   * Where the item is *defined*, not where it is used.
   *
   * This is the reason a BOM is a better enrolment route than the assembly
   * panel: Onshape resolves each row back to the Part Studio that owns the
   * part, so items land under the same identity a panel sync would produce
   * instead of creating a second record against the assembly element.
   */
  source: PartCoords | null;
  /** How the source was addressed: "w" workspace, "v" version, "m" microversion. */
  sourceWvmType: "w" | "v" | "m" | null;
  /** Set when the row cannot be enrolled, with the reason to show the user. */
  unresolvable: string | null;
};

export type BomTable = {
  lines: BomLine[];
  /** Column names Onshape returned, so an unmapped column is visible in the UI. */
  headers: string[];
  /** Which payload layout was recognised. Surfaced for diagnostics. */
  shape: string;
  /**
   * Whether the rows carry structure.
   *
   * Reported rather than left to the caller to remember: an indented table's
   * rows are positions, a flat table's rows are parts, and every consumer of
   * `lines` needs to know which it is holding.
   */
  indented: boolean;
};

/**
 * Column aliases.
 *
 * Deliberately narrow. An indented BOM also carries an "Item" column holding
 * outline numbers like "1.2.1"; accepting that as a part number would fill the
 * table with plausible-looking nonsense, so near-misses are left unmapped and
 * shown as blank rather than guessed at.
 */
const COLUMNS: Record<string, string[]> = {
  quantity: ["quantity", "qty"],
  partNumber: ["part number", "partnumber", "part no", "part no.", "part #"],
  name: ["name", "part name", "title"],
  description: ["description", "desc"],
  material: ["material", "material name"],
  revision: ["revision", "rev"],
  state: ["state", "lifecycle state", "workflow state", "status"],
  vendor: ["vendor", "supplier", "manufacturer"],
  project: ["project", "programme", "program"],
};

type HeaderMap = { byField: Record<string, string[]>; names: string[] };

/** Build field -> candidate header ids from whatever header list was supplied. */
function mapHeaders(rawHeaders: any[]): HeaderMap {
  const byField: Record<string, string[]> = {};
  const names: string[] = [];

  for (const h of rawHeaders) {
    if (!h || typeof h !== "object") continue;
    const id = String(h.id ?? h.headerId ?? h.propertyName ?? "");
    const name = String(h.name ?? h.displayName ?? h.propertyName ?? "");
    if (!id) continue;
    if (name) names.push(name);

    // Match on the visible column name first, then on the raw property name —
    // a tenant that has renamed a column still reports the original underneath.
    const candidates = [name, String(h.propertyName ?? "")].filter(Boolean).map(normalizeName);

    for (const [field, aliases] of Object.entries(COLUMNS)) {
      const norm = aliases.map(normalizeName);
      if (candidates.some((c) => norm.includes(c))) {
        (byField[field] ??= []).push(id);
      }
    }
  }

  return { byField, names };
}

/** Read one logical field off a row, trying mapped headers then direct fields. */
function readField(row: Record<string, any>, field: string, headers: HeaderMap): unknown {
  const bag = row.headerIdToValue ?? row.values ?? null;

  for (const id of headers.byField[field] ?? []) {
    if (bag && bag[id] != null) return bag[id];
    if (row[id] != null) return row[id];
  }

  // Some shapes put the well-known columns straight on the row.
  if (row[field] != null) return row[field];
  return null;
}

function toQuantity(v: unknown): number {
  const n = Number(toDisplayString(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
}

/**
 * Resolve a row's item source into part coordinates.
 *
 * Returns a reason string instead of coordinates when the row describes
 * something PLM cannot track — most often a subassembly, which has no part
 * to track in PLM.
 */
function resolveSource(row: Record<string, any>): {
  source: PartCoords | null;
  wvm: "w" | "v" | "m" | null;
  isAssembly: boolean;
  reason: string | null;
} {
  const src = row.itemSource ?? row.item ?? row.itemSourceLocation ?? null;

  if (!src || typeof src !== "object") {
    return { source: null, wvm: null, isAssembly: false, reason: "Onshape did not report where this row comes from." };
  }

  const elementType = String(src.elementType ?? src.type ?? "").toUpperCase();
  const documentId = String(src.documentId ?? "");
  const elementId = String(src.elementId ?? "");
  const partId = String(src.partId ?? src.partIdentity ?? "");

  const isAssembly = elementType === "ASSEMBLY" || (!partId && elementType !== "PARTSTUDIO");

  if (!documentId || !elementId) {
    return { source: null, wvm: null, isAssembly, reason: "Row has no document or tab reference." };
  }

  /*
   * A subassembly is addressable — as an element, not as a part within one.
   *
   * It used to be returned with no source and a reason, which made it
   * unimportable: in MOS only parts could become manufacturing items. PLM
   * tracks assemblies (`kind: "assembly"`, partId empty) and every part-scoped
   * Onshape URL now has an element-scoped form, so there is nothing left
   * standing in the way of treating the row as what it is.
   */
  if (!partId && !isAssembly) {
    return { source: null, wvm: null, isAssembly, reason: "Row has no part id." };
  }

  const wvmTypeRaw = String(src.wvmType ?? src.wvm ?? "").toLowerCase();
  const wvm: "w" | "v" | "m" | null =
    wvmTypeRaw === "w" || wvmTypeRaw === "v" || wvmTypeRaw === "m"
      ? wvmTypeRaw
      : src.workspaceId ? "w" : src.versionId ? "v" : null;

  const wvmId = String(src.wvmId ?? src.workspaceId ?? src.versionId ?? src.microversionId ?? "");

  const configuration = String(src.fullConfiguration ?? src.configuration ?? "") || "default";

  return {
    source: {
      documentId,
      elementId,
      partId,
      configuration,
      workspaceId: wvm === "w" ? wvmId || null : null,
      versionId: wvm === "v" ? wvmId || null : null,
    },
    wvm,
    /*
     * The computed value, not a constant.
     *
     * This said `false` because an assembly row could never reach this point —
     * it was always refused above. Now that a subassembly resolves to a real
     * source, hardcoding false would lose the one flag that decides whether it
     * is brought in as an assembly or as a part, and a subassembly would be
     * created as a part with no partId.
     */
    isAssembly,
    reason: null,
  };
}

/**
 * Turn whatever Onshape returned into a BOM table.
 *
 * Never throws on an unexpected payload — an empty `lines` with a `shape` of
 * "unrecognised" is a diagnosable result, whereas an exception halfway through
 * parsing tells the user nothing about what arrived.
 */
export function parseBom(
  payload: any,
  opts: { indented?: boolean } = {}
): BomTable {
  const indented = Boolean(opts.indented);

  let rawHeaders: any[] = [];
  let rawRows: any[] = [];
  let shape = "unrecognised";

  const table = payload?.bomTable ?? payload;

  if (table && typeof table === "object") {
    if (Array.isArray(table.headers)) rawHeaders = table.headers;

    if (Array.isArray(table.items)) {
      rawRows = table.items;
      shape = payload?.bomTable ? "bomTable.items" : "items";
    } else if (Array.isArray(table.rows)) {
      rawRows = table.rows;
      shape = "rows";
    } else if (Array.isArray(table.bomTableRows)) {
      rawRows = table.bomTableRows;
      shape = "bomTableRows";
    }
  }

  if (!rawRows.length && Array.isArray(payload)) {
    rawRows = payload;
    shape = "array";
  }

  const headers = mapHeaders(rawHeaders);
  const seen = new Map<string, BomLine>();
  const lines: BomLine[] = [];

  rawRows.forEach((row: any, index: number) => {
    if (!row || typeof row !== "object") return;

    const { source, wvm, isAssembly, reason } = resolveSource(row);

    const line: BomLine = {
      key: !source
        ? `row-${index}`
        : indented
          // Unique per position: the same part in two subassemblies is two
          // rows, and the UI keys its checkboxes and its selection on this.
          ? `${index}:${source.documentId}:${source.elementId}:${source.partId}:${source.configuration}`
          : `${source.documentId}:${source.elementId}:${source.partId}:${source.configuration}`,
      quantity: toQuantity(readField(row, "quantity", headers)),
      partNumber: toDisplayString(readField(row, "partNumber", headers)),
      name: toDisplayString(readField(row, "name", headers)),
      description: toDisplayString(readField(row, "description", headers)),
      material: toDisplayString(readField(row, "material", headers)),
      revision: toDisplayString(readField(row, "revision", headers)),
      state: toDisplayString(readField(row, "state", headers)),
      vendor: toDisplayString(readField(row, "vendor", headers)),
      project: toDisplayString(readField(row, "project", headers)),
      indentLevel: Number(row.indentLevel ?? row.itemIndentLevel ?? 0) || 0,
      isAssembly,
      source,
      sourceWvmType: wvm,
      unresolvable: reason,
    };

    /*
     * Collapsing depends on what the caller asked Onshape for.
     *
     * A FLAT BOM answers "how many does the product need in total", so a part
     * appearing in three subassemblies is one row with the quantities added.
     *
     * An INDENTED BOM answers "what contains what", and there each appearance
     * is a distinct position: the same bolt under two different subassemblies
     * is two edges with their own quantities. Collapsing those would merge two
     * positions into one and lose the structure the indent was requested for —
     * which is why the key carries the row index as well when indented.
     */
    if (indented) {
      lines.push(line);
      return;
    }

    const existing = source ? seen.get(line.key) : undefined;
    if (existing) {
      existing.quantity += line.quantity;
      return;
    }

    if (source) seen.set(line.key, line);
    lines.push(line);
  });

  return { lines, headers: headers.names, shape, indented };
}

/* -------------------------------------------------------------------------- */
/* Onshape URL parsing                                                         */
/* -------------------------------------------------------------------------- */

export type ParsedOnshapeUrl = {
  documentId: string;
  elementId: string;
  workspaceId: string | null;
  versionId: string | null;
  configuration: string | null;
};

/**
 * Pull document/workspace/element ids out of a pasted Onshape URL.
 *
 * Pasting the link from the browser bar is the only entry point that needs no
 * explanation, so it is worth accepting the URL in whatever form it is copied —
 * with or without a protocol, on any enterprise host, and with any trailing
 * query string.
 */
export function parseOnshapeUrl(input: string): ParsedOnshapeUrl | null {
  const raw = (input || "").trim();
  if (!raw) return null;

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return null;
  }

  // /documents/{did}/{w|v|m}/{wvmId}/e/{eid}
  const m = url.pathname.match(
    /\/documents\/([0-9a-f]{16,32})\/(w|v|m)\/([0-9a-f]{16,32})\/e\/([0-9a-f]{16,32})/i
  );
  if (!m) return null;

  const [, documentId, wvm, wvmId, elementId] = m;

  return {
    documentId,
    elementId,
    workspaceId: wvm === "w" ? wvmId : null,
    versionId: wvm === "v" ? wvmId : null,
    configuration: url.searchParams.get("configuration"),
  };
}
