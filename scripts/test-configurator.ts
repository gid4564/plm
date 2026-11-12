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
 *
 * Phase 4: the 3D model is composed from part exports — each distinct part
 * exported once and drawn wherever the assembly places it, in this
 * configuration's sizes; a part that will not export is left out rather than
 * losing the model. And a configuration can be named, and its PLM assembly
 * takes the name.
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
import { boxGlb, composeGlb, parseGltf, toColumnMajor } from "../src/lib/gltf-compose";
import type { AssemblyCoords } from "../src/lib/onshape/types";
import { PartGeometry } from "../src/lib/models";
import { readGeometryBytes } from "../src/lib/geometry";
import { clearConfigurator, clearPreview, listModels, nameItem, previewModel, removeModel, setModelProduct } from "../src/lib/configurator";
import { resolveProduct } from "../src/lib/products";

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
  exports = 0;
  failExport: string | null = null;
  async exportGltf(...args: Parameters<MockOnshapeClient["exportGltf"]>) {
    this.exports++;
    if (this.failExport && args[0].partId === this.failExport) throw new Error("Onshape glTF: 500");
    return super.exportGltf(...args);
  }
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
    await PartGeometry.deleteMany({ partId: { $in: old } });
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
  // …filed, by someone, under a "Flight Case" product.
  const flightCaseProduct = (await resolveProduct(eid, "Flight Case"))!;
  const before: any = await Part.create({
    enterpriseId: eid, documentId: DOC, elementId: handleEl, partId: "JLD", configuration: "default",
    kind: "part", number: "PRT012183", name: "Handle",
    productId: flightCaseProduct.productId, productName: flightCaseProduct.productName,
  });

  console.log("\nRegistering a model");
  let refused = "";
  await registerModel(eid, actor, { url: "https://cad.onshape.com/documents/nope" }, client).catch((e) => { refused = e.message; });
  check("a link that is not an assembly link is refused", /not an Onshape assembly link/.test(refused), refused);
  const url = "https://cad.onshape.com/documents/1c13dd44517cceffafef6ccd/w/a1534686b2a18cccbb2e4ffd/e/c77656776ef68e2ab240e460";

  // The live mistake (12 Nov 2026): the workspace has the configuration, the
  // newest version predates it — the model was registered with no inputs.
  class OldVersionClient extends MockOnshapeClient {
    async getConfigurationPayload(c?: AssemblyCoords): Promise<Record<string, unknown>> {
      return c?.versionId ? { configurationParameters: [] } : super.getConfigurationPayload();
    }
  }
  class NoVersionClient extends MockOnshapeClient {
    async listVersions() { return []; }
  }
  refused = "";
  await registerModel(eid, actor, { url }, new OldVersionClient(COMPANY)).catch((e) => { refused = e.message; });
  check("a version made before the configuration is refused, saying why", /no configuration.*new version/i.test(refused), refused);
  check("and the preview warns before anyone presses Add",
    (await previewModel(eid, url, new OldVersionClient(COMPANY))).newestVersionInputs === 0);
  refused = "";
  await registerModel(eid, actor, { url }, new NoVersionClient(COMPANY)).catch((e) => { refused = e.message; });
  check("a document with no version is refused, not read from the workspace", /no versions yet/i.test(refused), refused);
  check("neither left a model behind", (await ConfigurableModel.countDocuments({ enterpriseId: eid })) === 0);
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
  check("the configuration and its new parts are filed where the model's own parts are",
    String(top?.productId) === flightCaseProduct.productId &&
    (await Part.countDocuments({ enterpriseId: eid, "configuredFrom.modelId": modelId, productId: { $ne: flightCaseProduct.productId } })) === 0,
    String(top?.productName));
  check("which the models list says, as followed rather than chosen",
    (await listModels(eid)).some((m) => m.productName === "Flight Case" && !m.productChosen));
  check("configurator parts are blocked from write-back",
    (await Part.countDocuments({ enterpriseId: eid, "configuredFrom.modelId": modelId, writeBackBlocked: null })) === 0);

  /* -------------------------------------------------------------------- */
  console.log("\nComposing a GLB");
  {
    const a = boxGlb([1, 1, 1]), b = boxGlb([2, 2, 2]);
    const glb = composeGlb(new Map([["a", a], ["b", b]]), [
      { key: "a", name: "A1", transform: [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1] },
      { key: "a", name: "A2", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { key: "b", name: "B1", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { key: "gone", name: "X", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ]);
    const { json, bin } = parseGltf(glb);
    check("one mesh per part, drawn once per placement", json.meshes.length === 2 && json.nodes[0].children.length === 3);
    check("under one root that stands Onshape's Z-up scene upright", json.scenes[0].nodes.length === 1 && Math.abs(json.nodes[0].rotation[0] + Math.SQRT1_2) < 1e-9);
    check("placements reuse the part's mesh", json.nodes.filter((n: any) => n.mesh === 0).length === 2);
    check("Onshape's row-major transform becomes glTF's column-major", JSON.stringify(json.nodes[json.nodes[0].children[0]].matrix.slice(12, 15)) === "[5,6,7]");
    check("the second part's data is offset past the first's",
      json.bufferViews[3].byteOffset >= parseGltf(a).bin.length && bin.length === json.buffers[0].byteLength);
    check("and its accessors point at its own views", json.accessors[3].bufferView === 3 && json.meshes[1].primitives[0].indices === 5);
    check("column-major of identity is identity", JSON.stringify(toColumnMajor([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) === "[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]");
  }

  console.log("\nIts 3D model");
  const geo: any = await PartGeometry.findOne({ partId: big?.partId, revision: "" }).lean();
  check("built and kept as the configured assembly's geometry", big?.hasModel === true && !!geo && !geo.failureReason && geo.size > 1000,
    `${big?.modelError ?? ""} ${geo?.failureReason ?? ""}`);
  const model3d = parseGltf((await readGeometryBytes(geo))!);
  check("every visible part placed: 3 shell, 4 hinges, 5 latches of 4, 3 handles of 3, 2 foam",
    model3d.json.nodes[0].children.length === 3 + 4 + 20 + 9 + 2, String(model3d.json.nodes[0].children.length));
  check("each distinct part exported once", model3d.json.meshes.length === 12, String(model3d.json.meshes.length));
  const baseNode = model3d.json.nodes.find((n: any) => n.name === "Base");
  const baseMesh = model3d.json.nodes[baseNode.children[0]].mesh;
  const baseMax = model3d.json.accessors[model3d.json.meshes[baseMesh].primitives[0].attributes.POSITION].max;
  check("in this configuration's size (the 700 mm base)", Math.abs(baseMax[0] - 0.35) < 1e-6, JSON.stringify(baseMax));
  check("the 400 mm case has its own model", (await getItem(eid, p1.item!.id))?.hasModel === true);

  await ConfigurableModel.updateOne({ _id: modelId }, { $set: { enabled: true } });
  // A model built before composite parts were drawn is rebuilt when next opened.
  const exportsThen = client.exports;
  await ConfiguredItem.updateOne({ _id: first.item!.id }, { $set: { modelBuild: 1 } });
  await requestConfiguration(eid, actor, modelId, choice, { client, wait: true });
  check("a model from an older build is rebuilt when next opened",
    (await ConfiguredItem.findById(first.item!.id).lean() as any)?.modelBuild === 2 && client.exports > exportsThen);
  check("composite parts are drawn like any other (the simulated handle is one)",
    model3d.json.nodes.filter((n: any) => /^Handle Assembly/.test(n.name ?? "")).length === 0 &&
    model3d.json.nodes.some((n: any) => n.name === "Handle"));

  client.failExport = "RABD";
  const pinless = { [by("Size").id]: by("Size").options[4].value };
  const pl = await requestConfiguration(eid, actor, modelId, pinless, { client, wait: true });
  const plItem = await getItem(eid, pl.item!.id);
  const plGeo: any = await PartGeometry.findOne({ partId: plItem?.partId, revision: "" }).lean();
  const plJson = parseGltf((await readGeometryBytes(plGeo))!).json;
  check("a part that will not export is left out, not the model", plItem?.hasModel === true && !plJson.nodes.some((n: any) => /Hinge/.test(n.name ?? "")),
    plItem?.modelError ?? "");
  client.failExport = null;

  const partGeo = await PartGeometry.findOne({ partId: bline(big, "Base")?.plmPartId, revision: "" }).lean() as any;
  check("each part keeps its own 3D model, from the same exports", !!partGeo && partGeo.size > 100 && !partGeo.failureReason);
  check("the shared latch too", Boolean(await PartGeometry.exists({ partId: bline(big, "Latch")?.plmPartId, size: { $gt: 0 } })));
  const exportsBefore = client.exports;
  await ConfiguredItem.updateOne({ _id: first.item!.id }, { $set: { partModelsAt: null } });
  await requestConfiguration(eid, actor, modelId, choice, { client, wait: true });
  check("a configuration made before parts kept theirs catches up when next opened",
    Boolean((await ConfiguredItem.findById(first.item!.id).lean() as any)?.partModelsAt) && client.exports > exportsBefore);

  console.log("\nChoosing the model's product");
  const other = (await resolveProduct(eid, "Cases 2027"))!;
  const movedTo = await setModelProduct(eid, modelId, other.productId, actor);
  check("moves what the configurator made", movedTo.moved > 10 &&
    (await Part.countDocuments({ enterpriseId: eid, "configuredFrom.modelId": modelId, productId: { $ne: other.productId } })) === 0,
    String(movedTo.moved));
  check("but not the part PLM had before", String((await Part.findById(before._id).lean() as any)?.productId) === flightCaseProduct.productId);
  check("and new configurations follow the choice",
    (await listModels(eid)).some((m) => m.productName === "Cases 2027" && m.productChosen));

  console.log("\nNaming a configuration");
  const named = await nameItem(eid, first.item!.id, "  Touring   case ");
  check("kept, tidied", named?.name === "Touring case");
  check("and the PLM assembly takes it", (await Part.findById(big?.partId).lean() as any)?.name === "Touring case");
  await nameItem(eid, first.item!.id, "");
  check("an empty name goes back to the model's", (await Part.findById(big?.partId).lean() as any)?.name === "Flight Case");

  /* -------------------------------------------------------------------- */
  console.log("\nStarting again");
  // A part the configurator made, now also used by an assembly someone else built.
  const elsewhere: any = await Part.create({ enterpriseId: eid, documentId: "d".repeat(24), elementId: "e".repeat(24), kind: "assembly", number: "AS-99999", name: "Other" });
  await BomLink.create({ enterpriseId: eid, parentId: elsewhere._id, childId: bline(big, "Latch Assembly")?.plmPartId, quantity: 1 });
  const preview = await resetPreview(eid, modelId);
  check("the confirmation knows what it will remove", preview?.configurations === 5 && (preview?.parts ?? 0) > 10,
    JSON.stringify(preview));
  const reset = await resetModel(eid, modelId, actor.email);
  check("every configuration is gone", (await ConfiguredItem.countDocuments({ modelId })) === 0 && reset.configurations === 5);
  check("and their 3D models", (await PartGeometry.countDocuments({ enterpriseId: eid, partId: { $in: [big?.partId, plItem?.partId] } })) === 0);
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

  /* -------------------------------------------------------------------- */
  console.log("\nRemoving a model, and clearing the configurator");
  const second = await registerModel(eid, actor, { url, name: "Second" }, client);
  await requestConfiguration(eid, actor, second.id, {}, { client, wait: true });
  const doomed = await requestConfiguration(eid, actor, modelId, { [by("Size").id]: by("Size").options[1].value }, { client, wait: true });
  void doomed;
  const removed = await removeModel(eid, second.id, actor.email);
  check("removing a model deletes it and its configurations",
    !(await ConfigurableModel.exists({ _id: second.id })) && removed.configurations === 1 &&
    (await ConfiguredItem.countDocuments({ modelId: second.id })) === 0);
  check("and the parts it made, leaving the other model's", (await Part.countDocuments({ enterpriseId: eid, "configuredFrom.modelId": second.id })) === 0 &&
    (await Part.countDocuments({ enterpriseId: eid, "configuredFrom.modelId": modelId })) > 0);
  const cp = await clearPreview(eid);
  check("clearing says what it will remove", cp.models === 1 && cp.configurations >= 1 && cp.parts > 0, JSON.stringify(cp));
  const cleared = await clearConfigurator(eid, actor.email);
  check("clearing removes every model", cleared.models === 1 && (await ConfigurableModel.countDocuments({ enterpriseId: eid })) === 0);
  check("every configuration", (await ConfiguredItem.countDocuments({ enterpriseId: eid })) === 0);
  check("and every part the configurator made, except ones used elsewhere — now unmarked",
    (await Part.countDocuments({ enterpriseId: eid, configuredFrom: { $ne: null } })) === 0, JSON.stringify(cleared.partsKept));
  check("the part PLM had before stays", Boolean(await Part.exists({ _id: before._id })));
  check("and CFG numbering starts again", cleared.cfgCounterReset &&
    (await NumberingSequence.findOne({ enterpriseId: eid, type: "CONFIGURATION" }).lean() as any)?.counter === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
