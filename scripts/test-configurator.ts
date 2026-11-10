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
 *
 * Phase 2: each configuration's BOM is read once and kept — indented, with
 * the counts and sized parts of that configuration; an item made before its
 * BOM existed gets one without being rendered again; and a BOM that cannot be
 * read leaves a good picture alone, says why, and is retried only on request.
 *
 * Phase 3: the configuration becomes a PLM assembly with its CFG number and
 * its own quantities; lines become PLM parts, reused across configurations
 * and re-keyed from a "default" record PLM held before; nothing is written to
 * Onshape. And a reset removes what the configurator made, keeps what PLM had
 * before, and starts CFG numbering again.
 */
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017";
process.env.MONGODB_DB ??= "plm_test";
process.env.ONSHAPE_MODE = "mock";
process.env.MOCK_FAST = "1";

import { connectDb } from "../src/lib/db";
import { ActivityLog, BomLink, ConfigurableModel, ConfiguredItem, Enterprise, NumberingSequence, Part, PartIteration, PartThumbnail, Product } from "../src/lib/models";
import { MockOnshapeClient } from "../src/lib/onshape/mock-client";
import { parseDefinition, resolve, summarize, toEncoding, validate } from "../src/lib/configurator-rules";
import {
  ConfigurationError, getItem, itemPicture, listItems, registerModel, requestConfiguration, resetModel, resetPreview,
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
  boms = 0;
  failBom = false;
  writes = 0;
  async updatePartProperties(...args: Parameters<MockOnshapeClient["updatePartProperties"]>) {
    this.writes++;
    return super.updatePartProperties(...args);
  }
  async renderConfiguration(...args: Parameters<MockOnshapeClient["renderConfiguration"]>) {
    this.renders++;
    return super.renderConfiguration(...args);
  }
  async getAssemblyBom(...args: Parameters<MockOnshapeClient["getAssemblyBom"]>) {
    this.boms++;
    if (this.failBom) throw new Error("Onshape BOM: 503 Service Unavailable");
    return super.getAssemblyBom(...args);
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
    const old = (await Part.find({ enterpriseId: stale._id }).select("_id").lean()).map((p: any) => p._id);
    await PartThumbnail.deleteMany({ partId: { $in: old } });
    await PartIteration.deleteMany({ partId: { $in: old } });
    for (const M of [ConfigurableModel, ConfiguredItem, ActivityLog, NumberingSequence, Part, BomLink, Product]) {
      await (M as any).deleteMany({ enterpriseId: stale._id });
    }
    await Enterprise.deleteOne({ _id: stale._id });
  }
  const ent: any = await Enterprise.create({ onshapeCompanyId: COMPANY, name: "Configurator Co" });
  const eid = String(ent._id);
  const client = new CountingClient(COMPANY);

  // A part PLM already had before the configurator, keyed "default" as a
  // panel sync would have: the Handle, with the number Onshape reports.
  const DOC = "1c13dd44517cceffafef6ccd";
  const handleEl = (6).toString(16).padStart(24, "c");
  const before: any = await Part.create({
    enterpriseId: eid, documentId: DOC, elementId: handleEl, partId: "JLD", configuration: "default",
    kind: "part", number: "PRT012183", name: "Handle",
  });

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
  console.log("\nIts BOM");
  const bom = item?.bom ?? [];
  const line = (name: string) => bom.find((l) => l.name === name);
  check("read once, with the item", client.boms === 1 && bom.length > 0, `${client.boms} / ${bom.length}`);
  check("indented: the latch's parts sit under the Latch Assembly",
    line("Latch Assembly")?.level === 0 && line("Latch Assembly")?.kind === "assembly" &&
    ["Button", "Button Pin", "Latch", "Latch Pin"].every((n) => line(n)?.level === 1),
    bom.map((l) => `${l.level}:${l.name}`).join(", "));
  check("a non-geometric line is kept, as neither part nor assembly",
    line("N/A")?.kind === "other" && line("N/A")?.quantity === 1000 && !line("N/A")?.documentId);
  check("a 700 mm case has 4 hinge pins and 5 latches",
    line("Hinge Pin")?.quantity === 4 && line("Latch Assembly")?.quantity === 5);
  check("sized parts carry the case's size in their own configuration",
    /Length=0\.7\+meter/.test(line("Base")?.configuration ?? ""), line("Base")?.configuration ?? "");
  check("and the foam its slots", /Slots=10/.test(line("Foam Base")?.configuration ?? ""), line("Foam Base")?.configuration ?? "");
  check("Onshape's number is kept where there is one", line("Latch")?.partNumber === "PRT012181");
  check("served from PLM, the BOM is not read again", client.boms === 1);

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
  const small = (await getItem(eid, p1.item!.id))?.bom ?? [];
  const at = (b: typeof small, n: string) => b.find((l) => l.name === n);
  check("a 400 mm case has 2 hinge pins", at(small, "Hinge Pin")?.quantity === 2);
  check("the latch is one and the same part in both",
    at(small, "Latch")?.elementId === line("Latch")?.elementId && at(small, "Latch")?.configuration === line("Latch")?.configuration);
  check("the base is not", at(small, "Base")?.configuration !== line("Base")?.configuration);

  /* -------------------------------------------------------------------- */
  console.log("\nA configuration made before its BOM");
  await ConfiguredItem.updateOne({ _id: first.item!.id }, { $set: { bom: null, bomFetchedAt: null } });
  const rendersThen = client.renders;
  const backfill = await requestConfiguration(eid, actor, modelId, choice, { client, wait: true });
  item = await getItem(eid, first.item!.id);
  check("gets its BOM when next asked for", (item?.bom?.length ?? 0) > 0 && item?.state === "ready");
  check("without being rendered again", client.renders === rendersThen, String(client.renders));
  check("and keeps its number", item?.number === first.item?.number);
  check("not reported as served from PLM while it was being read", backfill.cached === false);

  console.log("\nA BOM that cannot be read");
  client.failBom = true;
  const odd = { [by("Size").id]: by("Size").options[2].value };
  const oddFirst = await requestConfiguration(eid, actor, modelId, odd, { client, wait: true });
  item = await getItem(eid, oddFirst.item!.id);
  check("the picture stands and the item is ready", item?.state === "ready" && item?.hasPicture === true && /^CFG-/.test(item?.number ?? ""));
  check("with the reason the BOM is missing", !item?.bom && /503/.test(item?.bomError ?? ""), item?.bomError ?? "");
  client.failBom = false;
  const bomsThen = client.boms;
  await requestConfiguration(eid, actor, modelId, odd, { client, wait: true });
  check("asking again does not hammer Onshape", client.boms === bomsThen);
  await requestConfiguration(eid, actor, modelId, odd, { client, wait: true, retry: true });
  item = await getItem(eid, oddFirst.item!.id);
  check("a retry reads it", client.boms === bomsThen + 1 && (item?.bom?.length ?? 0) > 0 && !item?.bomError);

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
  check("the model lists its configurations, newest request first", recent.length === 4 && recent[0].id === bad.item?.id,
    recent.map((x) => x.state).join(","));

  /* -------------------------------------------------------------------- */
  console.log("\nGrowing PLM's BOM");
  const big = await getItem(eid, first.item!.id);
  const top: any = await Part.findById(big?.partId).lean();
  check("the configuration is a PLM assembly with its CFG number",
    top?.kind === "assembly" && top?.number === big?.number && String(top?.configuredFrom?.configuredItemId) === big?.id,
    `${top?.kind} ${top?.number} / ${big?.number}`);
  check("with its picture as the thumbnail", Boolean(await PartThumbnail.exists({ partId: top?._id })));
  const kids = async (parentId: unknown) => {
    const links: any[] = await BomLink.find({ parentId }).lean();
    const parts: any[] = await Part.find({ _id: { $in: links.map((l) => l.childId) } }).select("name number").lean();
    return new Map(links.map((l) => [parts.find((p) => String(p._id) === String(l.childId))?.name, { qty: l.quantity, id: String(l.childId) }]));
  };
  const under = await kids(top?._id);
  check("its own quantities on its own edges", under.get("Hinge Pin")?.qty === 4 && under.get("Latch Assembly")?.qty === 5,
    JSON.stringify([...under]));
  const latchKids = await kids(under.get("Latch Assembly")?.id);
  check("subassemblies keep their parts", ["Button", "Button Pin", "Latch", "Latch Pin"].every((n) => latchKids.has(n)),
    [...latchKids.keys()].join(", "));
  check("a non-geometric line is not a part", !latchKids.has("N/A") && !(await Part.exists({ enterpriseId: eid, name: "N/A" })));
  const bline = (it: any, n: string) => it?.bom?.find((l: any) => l.name === n);
  check("Onshape's number is adopted", bline(big, "Latch")?.plmNumber === "PRT012181");
  check("a part with none gets a PLM number", /^PN-\d+/.test(bline(big, "Base")?.plmNumber ?? ""), bline(big, "Base")?.plmNumber);
  check("the Handle PLM already had is used, re-keyed to this configuration — not duplicated",
    bline(big, "Handle")?.plmPartId === String(before._id) && bline(big, "Handle")?.added === false &&
    (await Part.countDocuments({ enterpriseId: eid, number: "PRT012183" })) === 1,
    JSON.stringify({ line: bline(big, "Handle"), before: String(before._id) }));
  check("and is not marked as the configurator's", !(await Part.findById(before._id).lean() as any)?.configuredFrom);
  const smallItem = await getItem(eid, p1.item!.id);
  check("the latch is one PLM part in both configurations", bline(smallItem, "Latch")?.plmPartId === bline(big, "Latch")?.plmPartId);
  check("the base is two", bline(smallItem, "Base")?.plmPartId !== bline(big, "Base")?.plmPartId);
  check("the hinge pin is shared too, with each case's own quantity",
    bline(smallItem, "Hinge Pin")?.plmPartId === bline(big, "Hinge Pin")?.plmPartId &&
    (await kids(smallItem?.partId)).get("Hinge Pin")?.qty === 2 && (await kids(big?.partId)).get("Hinge Pin")?.qty === 4);
  check("float noise does not make a second part",
    (await Part.findById(bline(big, "Handle")?.plmPartId).lean() as any)?.configuration === "H=0.35 meter");
  check("the model's document is now keyed by configuration",
    ((await Enterprise.findById(eid).lean() as any)?.distinctConfigurationDocuments ?? []).includes(DOC));
  check("nothing was written to Onshape", client.writes === 0, String(client.writes));
  check("configurator parts are blocked from write-back",
    (await Part.countDocuments({ enterpriseId: eid, "configuredFrom.modelId": modelId, writeBackBlocked: null })) === 0);

  /* -------------------------------------------------------------------- */
  console.log("\nStarting again");
  // A part the configurator made, now also used by an assembly someone else built.
  const elsewhere: any = await Part.create({ enterpriseId: eid, documentId: "d".repeat(24), elementId: "e".repeat(24), kind: "assembly", number: "AS-99999", name: "Other" });
  await BomLink.create({ enterpriseId: eid, parentId: elsewhere._id, childId: bline(big, "Latch Assembly")?.plmPartId, quantity: 1 });
  const preview = await resetPreview(eid, modelId);
  check("the confirmation knows what it will remove", preview?.configurations === 4 && (preview?.parts ?? 0) > 10,
    JSON.stringify(preview));
  const reset = await resetModel(eid, modelId, actor.email);
  check("every configuration is gone", (await ConfiguredItem.countDocuments({ modelId })) === 0 && reset.configurations === 4);
  check("and the parts the configurator made, except an assembly something else uses — and what is inside it",
    (await Part.countDocuments({ enterpriseId: eid, "configuredFrom.modelId": modelId })) === 5 &&
    reset.partsKept.filter((k) => /another assembly/.test(k.reason)).length === 1 &&
    reset.partsKept.filter((k) => /which stays/.test(k.reason)).length === 4,
    JSON.stringify(reset.partsKept));
  check("the part PLM had before stays", Boolean(await Part.exists({ _id: before._id })));
  check("no edges are left pointing at removed parts",
    (await BomLink.countDocuments({ enterpriseId: eid })) === 1 + (await BomLink.countDocuments({ parentId: bline(big, "Latch Assembly")?.plmPartId })));
  check("CFG numbering starts again", reset.cfgCounterReset);
  check("still nothing written to Onshape", client.writes === 0);
  await ConfigurableModel.updateOne({ _id: modelId }, { $set: { enabled: true } });
  const anew = await requestConfiguration(eid, actor, modelId, choice, { client, wait: true });
  check("the next configuration is CFG-00001 again", (await getItem(eid, anew.item!.id))?.number === "CFG-00001");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
