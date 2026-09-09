/**
 * Parsing and display for a part's mass properties.
 *
 * Mass and inertia need a material — Onshape computes them from volume times
 * density, and there is no density without one. Volume, surface area and
 * centroid come from geometry alone and are available on any solid. The two
 * are kept apart everywhere in this file: a part with no material assigned
 * should show its geometry cleanly rather than a confusing zero mass.
 *
 * The response shape is parsed defensively, the same reasoning as the BOM
 * parser: Onshape's documentation for this endpoint does not fully describe
 * every tenant's response, values can arrive as bare numbers or as
 * [value, accuracy] pairs, and a part id can come back keyed differently than
 * it was requested. Nothing here throws on an unrecognised shape — it reports
 * "unrecognised" and logs what actually arrived, which is what makes the real
 * shape knowable instead of guessed at.
 */

export type MassProperties = {
  /** Whether Onshape could compute mass. False with no material assigned. */
  hasMass: boolean;
  massKg: number | null;
  volumeM3: number | null;
  /** [x, y, z] in metres, or null when Onshape did not report one. */
  centroidM: [number, number, number] | null;
  surfaceAreaM2: number | null;
  /** Which payload layout was recognised, for diagnostics. */
  shape: string;
};

const EMPTY: MassProperties = {
  hasMass: false, massKg: null, volumeM3: null, centroidM: null, surfaceAreaM2: null,
  shape: "unrecognised",
};

/**
 * A value from Onshape may be a bare number, or an array whose first element
 * is the value and whose remaining elements are accuracy/error terms. Both
 * forms are documented in different places for what is nominally the same
 * endpoint, so both are accepted.
 */
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && typeof v[0] === "number" && Number.isFinite(v[0])) return v[0];
  return null;
}

function vec3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [x, y, z] = v;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  if (![x, y, z].every(Number.isFinite)) return null;
  return [x, y, z];
}

/**
 * Turn Onshape's response into normalised mass properties for one part.
 *
 * `bodies` is keyed by part id in every shape seen so far, but a body's own
 * key inside it has been observed loose (composite ids, a differing case) —
 * so the exact key is tried first and the sole remaining body second, on the
 * grounds that a Part Studio mass-properties call for one part id has exactly
 * one body to report regardless of what it is keyed as.
 */
export function parseMassProperties(payload: any, partId: string): MassProperties {
  const bodies = payload?.bodies;
  if (!bodies || typeof bodies !== "object") return EMPTY;

  const keys = Object.keys(bodies);

  const body =
    bodies[partId] ??
    (keys.length === 1 ? bodies[keys[0]] : undefined);

  if (!body || typeof body !== "object") return { ...EMPTY, shape: keys.length ? "unrecognised-key" : "no-bodies" };

  const massKg = num(body.mass);
  const hasMass = body.hasMass === true || (body.hasMass == null && massKg != null && massKg > 0);

  return {
    hasMass,
    massKg: hasMass ? massKg : null,
    volumeM3: num(body.volume),
    centroidM: vec3(body.centroid),
    surfaceAreaM2: num(body.periphery ?? body.surfaceArea),
    shape: "bodies",
  };
}

/* -------------------------------------------------------------------------- */
/* Display formatting                                                         */
/*                                                                            */
/* Onshape reports mass and geometry in SI base units (kilograms, metres)     */
/* regardless of the document's own units, and manufacturing parts are small   */
/* enough that kilograms and metres read as a string of zeroes. These pick     */
/* whichever unit reads like a real measurement.                              */
/* -------------------------------------------------------------------------- */

export function formatMass(kg: number): string {
  if (kg < 1) return `${(kg * 1000).toFixed(kg < 0.001 ? 3 : 1)} g`;
  return `${kg.toFixed(3)} kg`;
}

export function formatVolume(m3: number): string {
  const cm3 = m3 * 1_000_000;
  if (cm3 < 1000) return `${cm3.toFixed(2)} cm³`;
  return `${(m3 * 1000).toFixed(2)} L`;
}

export function formatLengthMm(m: number): string {
  return `${(m * 1000).toFixed(2)} mm`;
}

export function formatCentroidMm(c: [number, number, number]): string {
  return c.map((v) => formatLengthMm(v)).join(", ");
}

export function formatArea(m2: number): string {
  const mm2 = m2 * 1_000_000;
  if (mm2 < 1_000_000) return `${mm2.toFixed(1)} mm²`;
  return `${m2.toFixed(4)} m²`;
}
