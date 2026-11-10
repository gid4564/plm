/**
 * The configurator, phase 1 — against the real Flight Case definition.
 *
 * The definition is Onshape's own payload, read from a live tenant with
 * scripts/probe-configuration.mjs, so the rules here are tested against what
 * Onshape actually sends rather than a hand-made shape.
 *
 * Pinned down: inputs parse with their types, ranges and units; visibility
 * follows the model's rules, including chains (foam off hides cutouts, which
 * hides cutout type); hidden inputs reset to their defaults so two requests
 * that differ only in a hidden value are one configuration; invalid values are
 * refused per input; a configuration is generated once, numbered once, and
 * served from PLM afterwards; simultaneous requests share one generation; and
 * a combination Onshape rejects is remembered, not retried, unless asked.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";
process.env.MOCK_FAST = "1";

import { connectDb } from "../src/lib/db";
import { ActivityLog, ConfigurableModel, ConfiguredItem, Enterprise, NumberingSequence } from "../src/lib/models";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { parseDefinition, resolve, summarize, toEncoding, validate } from "../src/lib/configurator-rules";
import {
  ConfigurationError, getItem, itemPicture, listItems, registerModel, requestConfiguration,
} from "../src/lib/configurator";
import FLIGHT_CASE from "../src/lib/onshape/mock-configuration.json";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const COMPANY = "mock-company-configurator";
const actor = { userId: "aaaaaaaaaaaaaaaaaaaaaaaa", email: "eng@test" };

/** A client that counts what it is asked to render. */
class CountingClient extends MockOnshapeClient {
  renders = 0;
  async renderConfiguration(...args: Parameters<MockOnshapeClient["renderConfiguration"]>) {
    this.renders++;
    return super.renderConfiguration(...args);
  }
}

async function main() {
  /* -------------------------------------------------------------------- */
  console.log("\nThe Flight Case's inputs");
  const inputs = parseDefinition(FLIGHT_CASE);
  const by = (name: string) => inputs.find((i) => i.name === name)!;
  check("ten inputs", inputs.length === 10, inputs.map((i) => i.name).join(", "));
  check("Size is a list of eight", by("Size").kind === "list" && by("Size").options.length === 8);
  check("Length is a length in mm with its range",
    by("Length").kind === "quantity" && by("Length").units === "millimeter" && by("Length").min === 300 && by("Length").max === 1350,
    JSON.stringify(by("Length")));
  check("Slots is a whole number with no unit", by("Slots").integer === true && by("Slots").units === "");
  check("foam defaults on, cutouts off", by("Add foam inserts").default === "true" && by("Add cutouts").default === "false");

  /* -------------------------------------------------------------------- */
  console.log("\nVisibility follows the model's rules");
  const custom = by("Size").options.find((o) => o.label === "Custom")!.value;
  const sevenHundred = by("Size").options.find((o) => o.label === "700 x 400 x 300")!.value;
  const slotsOpt = by("Cutout type").options.find((o) => o.label === "Slots")!.value;
  const ids = (names: string[]) => names.map((n) => by(n).id);

  let r = resolve(inputs, {});
  check("by default, the custom sizes are hidden", ids(["Length", "Depth", "Height"]).every((id) => !r.visible.has(id)));
  check("and so is everything about cutouts", ids(["Cutout type", "Compartments", "Slots"]).every((id) => !r.visible.has(id)));
  check("Add cutouts shows, because foam is on", r.visible.has(by("Add cutouts").id));

  r = resolve(inputs, { [by("Size").id]: custom });
  check("choosing Custom shows Length, Depth and Height", ids(["Length", "Depth", "Height"]).every((id) => r.visible.has(id)));

  r = resolve(inputs, { [by("Add cutouts").id]: "true", [by("Cutout type").id]: slotsOpt });
  check("cutouts as slots show Slots", r.visible.has(by("Slots").id) && !r.visible.has(by("Compartments").id));

  r = resolve(inputs, {
    [by("Add foam inserts").id]: "false", [by("Add cutouts").id]: "true", [by("Cutout type").id]: slotsOpt,
  });
  check("foam off hides Add cutouts and resets it", !r.visible.has(by("Add cutouts").id) && r.values[by("Add cutouts").id] === "false");
  check("which in turn hides Cutout type and Slots", !r.visible.has(by("Cutout type").id) && !r.visible.has(by("Slots").id));
  check("and resets Cutout type to its default", r.values[by("Cutout type").id] === by("Cutout type").default);

  /* -------------------------------------------------------------------- */
  console.log("\nHidden values do not change what a configuration is");
  const a = resolve(inputs, { [by("Size").id]: sevenHundred, [by("Length").id]: "500" });
  const b = resolve(inputs, { [by("Size").id]: sevenHundred, [by("Length").id]: "1200" });
  check("a hidden Length is reset", a.values[by("Length").id] === "500" && b.values[by("Length").id] === "500");
  check("so both encode the same", JSON.stringify(toEncoding(inputs, a.values)) === JSON.stringify(toEncoding(inputs, b.values)));
  check("a length is sent with its unit", toEncoding(inputs, a.values).find((p) => p.parameterId === "L")?.parameterValue === "500 millimeter");
  check("the summary names only what is visible",
    summarize(inputs, a.values, a.visible) === "700 x 400 x 300 · Add foam inserts", summarize(inputs, a.values, a.visible));

  /* -------------------------------------------------------------------- */
  console.log("\nInvalid values are refused per input");
  let v = resolve(inputs, { [by("Size").id]: custom, [by("Length").id]: "2000" });
  check("a Length past its range", /Between 300 and 1350 millimeter/.test(validate(inputs, v.values, v.visible)[by("Length").id] ?? ""));
  v = resolve(inputs, { [by("Add cutouts").id]: "true", [by("Cutout type").id]: slotsOpt, [by("Slots").id]: "4.5" });
  check("a fractional Slots", /whole number/.test(validate(inputs, v.values, v.visible)[by("Slots").id] ?? ""));
  v = resolve(inputs, { [by("Size").id]: "nonsense" });
  check("an option that does not exist", /Choose one of/.test(validate(inputs, v.values, v.visible)[by("Size").id] ?? ""));
  v = resolve(inputs, { [by("Size").id]: sevenHundred, [by("Length").id]: "99999" });
  check("but a hidden out-of-range value is not an error (it is reset)", Object.keys(validate(inputs, v.values, v.visible)).length === 0);

  /* -------------------------------------------------------------------- */
  await connectDb();
  const stale: any = await Enterprise.findOne({ onshapeCompanyId: COMPANY }).lean();
  if (stale) {
    for (const M of [ConfigurableModel, ConfiguredItem, ActivityLog, NumberingSequence]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }
  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Configurator Co" });
  const eid = String(ent._id);
  const client = new CountingClient(COMPANY);

  console.log("\nRegistering a model");
  let refused = "";
  await registerModel(eid, actor, { url: "https://cad.onshape.com/documents/nope" }, client).catch((e) => { refused = e.message; });
  check("a link that is not an assembly link is refused", /not an Onshape assembly link/.test(refused), refused);
  const url = "https://cad.onshape.com/documents/1c13dd44517cceffafef6ccd/w/a1534686b2a18cccbb2e4ffd/e/c77656776ef68e2ab240e460";
  const { id: modelId } = await registerModel(eid, actor, { url, name: "Flight Case" }, client);
  const model: any = await ConfigurableModel.findById(modelId).lean();
  check("registered at the newest version, not the workspace", model.versionId === "a0000000000000000000000a" && !model.workspaceId,
    `${model.versionId} / ${model.workspaceId}`);
  check("with the definition stored", parseDefinition(model.definition).length === 10);

  /* -------------------------------------------------------------------- */
  console.log("\nGenerating, then serving from PLM");
  const choice = { [by("Size").id]: sevenHundred, [by("Add cutouts").id]: "true", [by("Cutout type").id]: slotsOpt };
  const first = await requestConfiguration(eid, actor, modelId, choice, { client, wait: true });
  let item = await getItem(eid, first.item!.id);
  check("generated", item?.state === "ready", `${item?.state}: ${item?.error}`);
  check("with a CFG number", /^CFG-\d{5}$/.test(item?.number ?? ""), item?.number ?? "");
  check("and a picture", item?.hasPicture === true && ((await itemPicture(eid, item!.id))?.data.length ?? 0) > 100);
  check("summarised", item?.summary === "700 x 400 x 300 · Add foam inserts · Add cutouts · Cutout type: Slots · Slots 10 · Slot width 20 mm",
    item?.summary);
  check("Onshape was asked once", client.renders === 1, String(client.renders));

  const again = await requestConfiguration(eid, actor, modelId, { ...choice, [by("Length").id]: "1300" }, { client, wait: true });
  check("the same choices (bar a hidden one) are the same item", again.item?.id === first.item?.id);
  check("served from PLM", again.cached === true && client.renders === 1, String(client.renders));
  check("and counted", (await getItem(eid, first.item!.id))?.requestCount === 2);
  check("keeping its number", (await getItem(eid, first.item!.id))?.number === item?.number);

  /* -------------------------------------------------------------------- */
  console.log("\nTwo people, one new configuration");
  const pair = { [by("Size").id]: by("Size").options[1].value };
  const [p1, p2] = await Promise.all([
    requestConfiguration(eid, actor, modelId, pair, { client, wait: true }),
    requestConfiguration(eid, { ...actor, email: "other@test" }, modelId, pair, { client, wait: true }),
  ]);
  check("one item", p1.item?.id === p2.item?.id);
  check("one generation", client.renders === 2, String(client.renders));
  check("ready", (await getItem(eid, p1.item!.id))?.state === "ready");

  /* -------------------------------------------------------------------- */
  console.log("\nA combination Onshape rejects");
  const tooMany = {
    [by("Size").id]: by("Size").options[0].value, [by("Add cutouts").id]: "true", [by("Cutout type").id]: slotsOpt,
    [by("Slots").id]: "20", [by("Slot width").id]: "100",
  };
  const bad = await requestConfiguration(eid, actor, modelId, tooMany, { client, wait: true });
  item = await getItem(eid, bad.item!.id);
  check("fails, with Onshape's reason", item?.state === "failed" && /do not fit/.test(item?.error ?? ""), item?.error ?? "");
  check("and has no number", !item?.number);
  const rendersBefore = client.renders;
  await requestConfiguration(eid, actor, modelId, tooMany, { client, wait: true });
  check("asking again is answered from memory", client.renders === rendersBefore);
  await requestConfiguration(eid, actor, modelId, tooMany, { client, wait: true, retry: true });
  check("unless a retry is asked for", client.renders === rendersBefore + 1);

  /* -------------------------------------------------------------------- */
  console.log("\nRefusals");
  refused = "";
  let fields: Record<string, string> = {};
  await requestConfiguration(eid, actor, modelId, { [by("Size").id]: custom, [by("Length").id]: "5" }, { client })
    .catch((e: ConfigurationError) => { refused = e.message; fields = e.fields; });
  check("an out-of-range value is refused before Onshape is asked", /not valid/.test(refused) && !!fields[by("Length").id],
    JSON.stringify(fields));
  await ConfigurableModel.updateOne({ _id: modelId }, { $set: { enabled: false } });
  refused = "";
  await requestConfiguration(eid, actor, modelId, {}, { client }).catch((e) => { refused = e.message; });
  check("a disabled model cannot be configured", /not available/.test(refused), refused);

  const recent = await listItems(eid, modelId);
  check("the model lists its configurations, newest request first", recent.length === 3 && recent[0].id === bad.item?.id,
    recent.map((x) => x.state).join(","));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
