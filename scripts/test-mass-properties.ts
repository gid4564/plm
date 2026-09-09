/**
 * Checks for mass-properties parsing and display formatting.
 *
 * Run with:  npm run test:mass
 *
 * A part with no material assigned genuinely has no mass to report — Onshape
 * has geometry but no density. That has to read as "no material assigned",
 * never as a confident "0 kg", or someone building to it could reasonably
 * conclude the part really does weigh nothing. These cases pin that down,
 * along with the defensive parsing this endpoint needs for the same reason
 * the BOM parser does: several value shapes are documented in different
 * places for what is nominally the same response.
 */
import {
  parseMassProperties, formatMass, formatVolume, formatArea, formatCentroidMm, formatLengthMm,
} from "../src/lib/onshape/mass-properties";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra !== undefined ? JSON.stringify(extra) : ""); }
};

console.log("A part with a material — mass, volume and centroid all present");
{
  const payload = {
    bodies: {
      JHD: { hasMass: true, mass: [0.45], volume: [0.0001667], centroid: [0.01, -0.02, 0.03], periphery: [0.021] },
    },
  };
  const r = parseMassProperties(payload, "JHD");
  check("recognised", r.shape === "bodies", r.shape);
  check("hasMass is true", r.hasMass === true);
  check("mass value unwrapped from its array", r.massKg === 0.45, r.massKg);
  check("volume unwrapped", r.volumeM3 === 0.0001667, r.volumeM3);
  check("centroid read as a 3-vector", JSON.stringify(r.centroidM) === JSON.stringify([0.01, -0.02, 0.03]));
  check("surface area from periphery", r.surfaceAreaM2 === 0.021, r.surfaceAreaM2);
}

console.log("\nBare numbers instead of [value] arrays — the other documented shape");
{
  const payload = { bodies: { JHD: { hasMass: true, mass: 0.45, volume: 0.0001667, centroid: [0.01, 0.02, 0.03] } } };
  const r = parseMassProperties(payload, "JHD");
  check("a bare number is read the same as a wrapped one", r.massKg === 0.45, r.massKg);
}

console.log("\nNo material assigned — the case this feature exists to get right");
{
  const payload = { bodies: { JHD: { hasMass: false, mass: [0], volume: [0.0001667], centroid: [0, 0, 0.01] } } };
  const r = parseMassProperties(payload, "JHD");
  check("hasMass is false, not a confident zero", r.hasMass === false);
  check("mass is null, never 0 — 0 kg would read as a real measurement", r.massKg === null, r.massKg);
  check("volume is still reported — geometry does not need a material", r.volumeM3 === 0.0001667, r.volumeM3);
}

console.log("\nWhen Onshape omits hasMass entirely, infer it from whether mass is positive");
{
  const zero = parseMassProperties({ bodies: { JHD: { mass: [0], volume: [0.001] } } }, "JHD");
  check("zero mass with no hasMass flag is treated as no material", zero.hasMass === false, zero);

  const real = parseMassProperties({ bodies: { JHD: { mass: [1.2], volume: [0.001] } } }, "JHD");
  check("positive mass with no hasMass flag is treated as present", real.hasMass === true, real);
}

console.log("\nA body keyed differently than the part id it was requested for");
{
  // Seen in practice: the requested part id and the body's own key do not
  // always match exactly. With exactly one body in the response, using it is
  // the only reasonable reading rather than reporting nothing.
  const payload = { bodies: { "JHD-1": { hasMass: true, mass: [0.2], volume: [0.0001] } } };
  const r = parseMassProperties(payload, "JHD");
  check("the sole body is used even though its key does not match", r.massKg === 0.2, r);
}

console.log("\nJunk in, diagnosable out — never throws");
for (const [label, payload] of [
  ["null", null], ["no bodies key", {}], ["bodies not an object", { bodies: "nope" }],
  ["empty bodies", { bodies: {} }], ["two bodies, wrong part id", { bodies: { A: {}, B: {} } }],
] as const) {
  const r = parseMassProperties(payload, "JHD");
  check(`${label} → no throw, hasMass false`, r.hasMass === false, r.shape);
}

console.log("\nDisplay formatting");
check("sub-gram mass in grams with extra precision", formatMass(0.0004) === "0.400 g", formatMass(0.0004));
check("a light part in grams", formatMass(0.45) === "450.0 g", formatMass(0.45));
check("a part over 1kg in kilograms", formatMass(2.5) === "2.500 kg", formatMass(2.5));
check("small volume in cm³", formatVolume(0.0001667) === "166.70 cm³", formatVolume(0.0001667));
check("large volume in litres", formatVolume(0.005) === "5.00 L", formatVolume(0.005));
check("length in millimetres", formatLengthMm(0.01) === "10.00 mm", formatLengthMm(0.01));
check("centroid as three millimetre values",
  formatCentroidMm([0.01, -0.02, 0.03]) === "10.00 mm, -20.00 mm, 30.00 mm", formatCentroidMm([0.01, -0.02, 0.03]));
check("small area in mm²", formatArea(0.00002) === "20.0 mm²", formatArea(0.00002));
check("large area in m²", formatArea(2) === "2.0000 m²", formatArea(2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
