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
  /** Subassembly rows cannot become manufacturing items — only parts can. */
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
 * something the MOS cannot track — most often a subassembly, which has no part
 * to attach a manufacturing order to.
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
  if (!partId) {
    return {
      source: null, wvm: null, isAssembly,
      reason: isAssembly
        ? "Subassembly — manufacturing orders are created for its parts, not for the subassembly itself."
        : "Row has no part id.",
    };
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
    isAssembly: false,
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
export function parseBom(payload: any): BomTable {
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
      key: source
        ? `${source.documentId}:${source.elementId}:${source.partId}:${source.configuration}`
        : `row-${index}`,
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

    // A part used in several subassemblies comes back as several rows. The
    // manufacturing question is how many to make in total, so identical parts
    // are collapsed and their quantities added.
    const existing = source ? seen.get(line.key) : undefined;
    if (existing) {
      existing.quantity += line.quantity;
      return;
    }

    if (source) seen.set(line.key, line);
    lines.push(line);
  });

  return { lines, headers: headers.names, shape };
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
