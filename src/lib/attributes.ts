import { connectDb } from "@/lib/db";
import { AttributeDefinition, LIFECYCLE_STATES, type LifecycleState } from "@/lib/models";
import { toDisplayString } from "@/lib/onshape/standard-properties";

/**
 * The attribute metamodel.
 *
 * PLM attributes are not a bag of mirrored CAD properties. Each one declares
 * its type, whether it is needed to release, when it may be edited, whether it
 * freezes once released, and which system is allowed to author it. Everything
 * in this file is the enforcement of those declarations — the schema itself
 * lives in the AttributeDefinition collection, configured per enterprise.
 */

export type AttrDef = {
  _id?: unknown;
  objectType: "PART" | "DRAWING";
  key: string;
  label: string;
  description?: string;
  dataType: "STRING" | "TEXT" | "NUMBER" | "INTEGER" | "BOOLEAN" | "DATE" | "ENUM";
  enumValues?: string[];
  unit?: string;
  defaultValue?: unknown;
  required?: boolean;
  requiredForRelease?: boolean;
  editableInStates?: string[];
  frozenAtRelease?: boolean;
  owner?: "plm" | "onshape";
  onshapePropertyId?: string;
  onshapePropertyName?: string;
  syncDirection?: "none" | "from-onshape" | "to-onshape" | "both";
  authority?: "plm" | "onshape";
  order?: number;
  group?: string;
  system?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Coercion                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Force a value into the shape its definition promises, or reject it.
 *
 * Returns `{ ok: false, reason }` rather than throwing or silently defaulting.
 * A number attribute that quietly became 0 because someone typed "n/a" is the
 * kind of wrong data PLM exists to keep out, and it is indistinguishable from a
 * real 0 once stored.
 */
export function coerceValue(
  def: AttrDef,
  raw: unknown
): { ok: true; value: unknown } | { ok: false; reason: string } {
  // Empty is always allowed here; whether it is *permitted* is a required check,
  // which runs separately and knows the lifecycle state.
  if (raw == null || raw === "") return { ok: true, value: null };

  switch (def.dataType) {
    case "STRING":
    case "TEXT": {
      const s = typeof raw === "string" ? raw : toDisplayString(raw);
      return { ok: true, value: s.trim() };
    }

    case "NUMBER":
    case "INTEGER": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { ok: false, reason: `"${String(raw)}" is not a number` };
      if (def.dataType === "INTEGER" && !Number.isInteger(n)) {
        return { ok: false, reason: `${n} is not a whole number` };
      }
      return { ok: true, value: n };
    }

    case "BOOLEAN": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return { ok: true, value: true };
      if (["false", "no", "n", "0"].includes(s)) return { ok: true, value: false };
      return { ok: false, reason: `"${String(raw)}" is not a yes/no value` };
    }

    case "DATE": {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime())) return { ok: false, reason: `"${String(raw)}" is not a date` };
      return { ok: true, value: d };
    }

    case "ENUM": {
      const s = typeof raw === "string" ? raw.trim() : toDisplayString(raw).trim();
      const options = def.enumValues ?? [];
      // Case-insensitive match, but the stored value is the option as defined —
      // so a value that arrived from Onshape with different casing does not
      // fork into a second apparent choice.
      const hit = options.find((o) => o.toLowerCase() === s.toLowerCase());
      if (!hit) {
        return {
          ok: false,
          reason: options.length
            ? `"${s}" is not one of: ${options.join(", ")}`
            : `"${s}" was given but ${def.label} has no permitted values defined`,
        };
      }
      return { ok: true, value: hit };
    }

    default:
      return { ok: false, reason: `unknown data type "${def.dataType}"` };
  }
}

/* -------------------------------------------------------------------------- */
/* Editability                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether an attribute may be changed on an object in this state.
 *
 * Two independent rules, and both have to pass:
 *
 *   editableInStates — positive list; empty means every state
 *   frozenAtRelease  — once Released or Obsolete, never again
 *
 * They are separate because they answer different questions. The first is
 * process control ("material is fixed once it is under review"); the second is
 * a guarantee about the record ("what was released cannot be rewritten").
 */
export function isEditable(def: AttrDef, state: LifecycleState | string): boolean {
  if (def.frozenAtRelease && (state === "Released" || state === "Obsolete")) return false;
  const allowed = def.editableInStates ?? [];
  if (allowed.length === 0) return true;
  return allowed.includes(state);
}

/**
 * Why an attribute is read-only, in words a person can act on.
 *
 * Returned rather than a bare boolean because "you cannot edit this" with no
 * reason is the single most irritating thing a PLM system does.
 */
export function editabilityReason(def: AttrDef, state: LifecycleState | string): string | null {
  if (isEditable(def, state)) return null;
  if (def.frozenAtRelease && (state === "Released" || state === "Obsolete")) {
    return `${def.label} is frozen once released — raise a new revision to change it.`;
  }
  const allowed = def.editableInStates ?? [];
  return `${def.label} can only be edited in: ${allowed.join(", ")}. This is ${state}.`;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export type ValidationResult = {
  ok: boolean;
  /** Coerced values, safe to store. Only present when ok. */
  values: Record<string, unknown>;
  /** key -> why it was refused. */
  errors: Record<string, string>;
};

/**
 * Validate a set of proposed attribute values against the metamodel.
 *
 * `state` is needed because editability is state-dependent — an attribute the
 * caller is not allowed to change in this state is an error, not a silent
 * no-op. Attributes absent from `proposed` are left alone rather than cleared,
 * so a partial form submission cannot wipe fields it never showed.
 */
export function validateAttributes(
  defs: AttrDef[],
  proposed: Record<string, unknown>,
  current: Record<string, unknown>,
  state: LifecycleState | string
): ValidationResult {
  const values: Record<string, unknown> = { ...current };
  const errors: Record<string, string> = {};
  const byKey = new Map(defs.map((d) => [d.key, d]));

  for (const [key, raw] of Object.entries(proposed)) {
    const def = byKey.get(key);
    if (!def) {
      errors[key] = `There is no attribute "${key}" defined for this object type.`;
      continue;
    }

    const coerced = coerceValue(def, raw);
    if (!coerced.ok) {
      errors[key] = coerced.reason;
      continue;
    }

    // Only complain about editability if the value is actually different. A form
    // that round-trips a locked field unchanged is not an attempt to change it.
    const unchanged = sameValue(current[key], coerced.value);
    if (!unchanged && !isEditable(def, state)) {
      errors[key] = editabilityReason(def, state) ?? `${def.label} cannot be edited now.`;
      continue;
    }

    values[key] = coerced.value;
  }

  // Always-required attributes, checked against the merged result.
  for (const def of defs) {
    if (!def.required) continue;
    if (isEmpty(values[def.key])) errors[def.key] ??= `${def.label} is required.`;
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
}

/**
 * Attributes that must hold a value before this object can go for release.
 *
 * Separate from `required` deliberately: a designer has to be able to save a
 * half-finished part, but a released part with no material is precisely the
 * defect PLM exists to prevent. Returns labels, not keys — the caller is
 * showing these to a person.
 */
export function missingForRelease(defs: AttrDef[], values: Record<string, unknown>): string[] {
  return defs
    .filter((d) => d.requiredForRelease && isEmpty(values[d.key]))
    .map((d) => d.label);
}

const isEmpty = (v: unknown) =>
  v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** Value equality that survives a round trip through a form and through Mongo. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
    return ta === tb;
  }
  if (isEmpty(a) && isEmpty(b)) return true;
  return a === b;
}

/* -------------------------------------------------------------------------- */
/* Mapping to and from Onshape                                                 */
/* -------------------------------------------------------------------------- */

/** One Onshape property as the sync layer hands it over. */
export type IncomingProperty = {
  propertyId: string;
  name: string;
  value: unknown;
};

export type MappedInbound = {
  values: Record<string, unknown>;
  /** key -> [from, to], for the iteration diff and the activity log. */
  changed: Record<string, [unknown, unknown]>;
  /** Values Onshape sent that the metamodel refused, so they are not lost silently. */
  rejected: Record<string, string>;
  /** Keys PLM held on to because it has authority over them. */
  heldByPlm: string[];
};

/**
 * Fold Onshape's properties into PLM attribute values, obeying each
 * attribute's direction and authority.
 *
 * The authority rule is the part that matters. An attribute mapped "both" has
 * no defined behaviour on conflict without it, which in practice means
 * whichever sync ran last wins and quietly overwrites the other system. Here,
 * a PLM-authoritative attribute keeps its value and is reported in `heldByPlm`
 * so the push back out can carry it.
 */
export function mapInbound(
  defs: AttrDef[],
  incoming: IncomingProperty[],
  current: Record<string, unknown>,
  state: LifecycleState | string
): MappedInbound {
  const byId = new Map(incoming.map((p) => [p.propertyId, p]));
  const values: Record<string, unknown> = { ...current };
  const changed: Record<string, [unknown, unknown]> = {};
  const rejected: Record<string, string> = {};
  const heldByPlm: string[] = [];

  for (const def of defs) {
    const dir = def.syncDirection ?? "from-onshape";
    if (dir === "none" || dir === "to-onshape") continue;
    if (!def.onshapePropertyId) continue;

    const prop = byId.get(def.onshapePropertyId);
    if (!prop) continue;

    // A frozen attribute on a released object is not updated from CAD either.
    // Onshape is the author of the value, but the released record is a
    // statement about what was approved, and it does not move.
    if (!isEditable(def, state)) continue;

    if (dir === "both" && (def.authority ?? "onshape") === "plm") {
      heldByPlm.push(def.key);
      continue;
    }

    const coerced = coerceValue(def, prop.value);
    if (!coerced.ok) {
      rejected[def.key] = `Onshape sent ${JSON.stringify(prop.value)} for ${def.label}: ${coerced.reason}`;
      continue;
    }

    if (!sameValue(current[def.key], coerced.value)) {
      changed[def.key] = [current[def.key] ?? null, coerced.value];
      values[def.key] = coerced.value;
    }
  }

  return { values, changed, rejected, heldByPlm };
}

/**
 * Build the propertyId -> value bag for a write back to Onshape.
 *
 * Only attributes whose direction actually permits an outbound write are
 * included. An attribute with no mapped property is skipped rather than
 * guessed at: inventing a property to hold PLM data is a decision for the
 * mapping screen, not for the sync.
 */
export function mapOutbound(
  defs: AttrDef[],
  values: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const def of defs) {
    const dir = def.syncDirection ?? "from-onshape";
    if (dir !== "to-onshape" && dir !== "both") continue;
    if (!def.onshapePropertyId) continue;

    const v = values[def.key];
    if (v === undefined) continue;

    // Onshape's metadata API takes scalars; a Date has to be sent as text or it
    // arrives as an ISO string wrapped in an object.
    out[def.onshapePropertyId] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Reading and seeding the schema                                              */
/* -------------------------------------------------------------------------- */

export async function listDefinitions(
  enterpriseId: string,
  objectType: "PART" | "DRAWING"
): Promise<AttrDef[]> {
  await connectDb();
  return (await AttributeDefinition.find({ enterpriseId, objectType })
    .sort({ order: 1, label: 1 })
    .lean()) as unknown as AttrDef[];
}

/**
 * The schema a new enterprise starts with.
 *
 * A configurable metamodel that opens empty can demonstrate nothing, and the
 * sync layer assumes a handful of these exist by key. They are marked `system`
 * rather than hard-coded so they stay visible and editable in the same table as
 * everything an admin adds — the point is that they are ordinary definitions
 * that happen to be present from the start, not a privileged hidden set.
 *
 * onshapePropertyId is deliberately left empty. The ids are per-tenant and are
 * filled in by property discovery, which matches on name — the same approach
 * MOS uses, and for the same reason: Onshape does not publish its built-in
 * property ids as stable constants.
 */
const SEED: AttrDef[] = [
  /* ------------------------------- PART ---------------------------------- */
  {
    objectType: "PART", key: "number", label: "Part number", group: "Identification", order: 10,
    dataType: "STRING", required: true, system: true,
    owner: "plm", syncDirection: "to-onshape", onshapePropertyName: "Part number",
    frozenAtRelease: true,
    description: "Issued by PLM and written to Onshape. PLM is the number master.",
  },
  {
    objectType: "PART", key: "name", label: "Name", group: "Identification", order: 20,
    dataType: "STRING", required: true, system: true,
    owner: "onshape", syncDirection: "from-onshape", onshapePropertyName: "Name",
    frozenAtRelease: true,
  },
  {
    objectType: "PART", key: "description", label: "Description", group: "Identification", order: 30,
    dataType: "TEXT", requiredForRelease: true, system: true,
    owner: "onshape", syncDirection: "both", authority: "onshape", onshapePropertyName: "Description",
    frozenAtRelease: true,
  },
  {
    objectType: "PART", key: "material", label: "Material", group: "Physical", order: 40,
    dataType: "STRING", requiredForRelease: true, system: true,
    owner: "onshape", syncDirection: "from-onshape", onshapePropertyName: "Material",
    frozenAtRelease: true,
  },
  {
    objectType: "PART", key: "mass", label: "Mass", unit: "kg", group: "Physical", order: 50,
    dataType: "NUMBER", owner: "plm", syncDirection: "none",
    description: "Read from Onshape's mass properties on demand, not mirrored.",
  },
  {
    objectType: "PART", key: "classification", label: "Make or buy", group: "Sourcing", order: 60,
    dataType: "ENUM", enumValues: ["Make", "Buy", "Standard part"],
    requiredForRelease: true, owner: "plm", syncDirection: "none",
    editableInStates: ["In Work", "Under Review"],
  },
  {
    objectType: "PART", key: "unitOfMeasure", label: "Unit of measure", group: "Sourcing", order: 70,
    dataType: "ENUM", enumValues: ["Each", "kg", "m", "m²", "litre"],
    defaultValue: "Each", requiredForRelease: true, owner: "plm", syncDirection: "none",
  },
  {
    objectType: "PART", key: "supplier", label: "Supplier", group: "Sourcing", order: 80,
    dataType: "STRING", owner: "onshape", syncDirection: "both", authority: "plm",
    onshapePropertyName: "Vendor",
    description: "Mapped both ways with PLM authoritative: sourcing is decided here.",
  },
  {
    objectType: "PART", key: "responsibleEngineer", label: "Responsible engineer", group: "Governance", order: 90,
    dataType: "STRING", requiredForRelease: true, owner: "plm", syncDirection: "none",
    /*
     * Under Review is included deliberately, and it is not slack.
     *
     * A part that reaches PLM through a release Onshape started arrives already
     * Under Review — PLM finds out about the release only once the package
     * exists. An attribute that is required to release but editable only In
     * Work could therefore never be filled in on that path: the reviewer is
     * told what is missing and given no way to supply it.
     */
    editableInStates: ["In Work", "Under Review"],
  },
  {
    objectType: "PART", key: "effectiveFrom", label: "Effective from", group: "Governance", order: 100,
    dataType: "DATE", owner: "plm", syncDirection: "none",
  },
  {
    objectType: "PART", key: "exportControlled", label: "Export controlled", group: "Governance", order: 110,
    dataType: "BOOLEAN", defaultValue: false, owner: "plm", syncDirection: "none",
    frozenAtRelease: true,
  },

  /* ------------------------------ DRAWING -------------------------------- */
  {
    objectType: "DRAWING", key: "number", label: "Drawing number", group: "Identification", order: 10,
    dataType: "STRING", required: true, system: true,
    owner: "plm", syncDirection: "to-onshape", onshapePropertyName: "Part number",
    frozenAtRelease: true,
  },
  {
    objectType: "DRAWING", key: "name", label: "Title", group: "Identification", order: 20,
    dataType: "STRING", required: true, system: true,
    owner: "onshape", syncDirection: "from-onshape", onshapePropertyName: "Name",
    frozenAtRelease: true,
  },
  {
    objectType: "DRAWING", key: "sheetSize", label: "Sheet size", group: "Sheet", order: 30,
    dataType: "ENUM", enumValues: ["A0", "A1", "A2", "A3", "A4"],
    owner: "plm", syncDirection: "none",
  },
  {
    objectType: "DRAWING", key: "drawnBy", label: "Drawn by", group: "Approval", order: 40,
    dataType: "STRING", owner: "plm", syncDirection: "none", editableInStates: ["In Work"],
  },
  {
    objectType: "DRAWING", key: "checkedBy", label: "Checked by", group: "Approval", order: 50,
    dataType: "STRING", requiredForRelease: true, owner: "plm", syncDirection: "none",
    editableInStates: ["In Work", "Under Review"], frozenAtRelease: true,
  },
];

/**
 * Create the seed schema for an enterprise that has none.
 *
 * Idempotent by key, so it can be re-run to pick up definitions added to the
 * seed later without disturbing anything an admin has since changed — an
 * upsert on a key that already exists touches nothing.
 */
export async function seedAttributeDefinitions(enterpriseId: string): Promise<number> {
  await connectDb();
  let created = 0;

  for (const def of SEED) {
    const res = await AttributeDefinition.updateOne(
      { enterpriseId, objectType: def.objectType, key: def.key },
      { $setOnInsert: { ...def, enterpriseId } },
      { upsert: true }
    );
    if (res.upsertedCount) created++;
  }

  return created;
}

/** The lifecycle states, for building editability pickers in the admin UI. */
export const ALL_STATES = LIFECYCLE_STATES;

/**
 * Serialise a definition for the API.
 *
 * Lives here rather than in the route because Next allows a route module to
 * export only its HTTP handlers — and because the shape of a definition is a
 * property of the metamodel, not of one endpoint.
 */
export function shapeDefinition(d: any) {
  return {
    id: String(d._id),
    objectType: d.objectType,
    key: d.key,
    label: d.label,
    description: d.description ?? "",
    dataType: d.dataType,
    enumValues: d.enumValues ?? [],
    unit: d.unit ?? "",
    defaultValue: d.defaultValue ?? null,
    required: Boolean(d.required),
    requiredForRelease: Boolean(d.requiredForRelease),
    editableInStates: d.editableInStates ?? [],
    frozenAtRelease: Boolean(d.frozenAtRelease),
    owner: d.owner ?? "onshape",
    onshapePropertyName: d.onshapePropertyName ?? "",
    onshapePropertyId: d.onshapePropertyId ?? "",
    syncDirection: d.syncDirection ?? "from-onshape",
    authority: d.authority ?? "onshape",
    order: d.order ?? 100,
    group: d.group ?? "",
    system: Boolean(d.system),
  };
}
