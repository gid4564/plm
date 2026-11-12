import { Types } from "mongoose";
import { connectDb } from "@/lib/db";
import { ActivityLog, BomLink, ConfigurableModel, ConfiguredItem, Enterprise, NumberingSequence, Part, PartGeometry, PartIteration, PartThumbnail } from "@/lib/models";
import { configurationNormalizer, deletePart, syncPartFromOnshape } from "@/lib/sync";
import { listDefinitions } from "@/lib/attributes";
import { assignParts, resolveProductById, resolveUnassignedProduct, type ResolvedProduct } from "@/lib/products";
import { upsertBomLink } from "@/lib/bom-import";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { withApiProcess } from "@/lib/api-log";
import { nextNumber } from "@/lib/numbering";
import { parseDefinition, resolve, summarize, toEncoding, validate, type Values } from "@/lib/configurator-rules";
import type { OnshapeClient } from "@/lib/onshape/types";
import { toBuffer } from "@/lib/binary";
import type { BomLine } from "@/lib/onshape/bom";
import type { AssemblyDefinition, AssemblyInstance, FileExport } from "@/lib/onshape/types";
import { captureWorkspaceGeometry } from "@/lib/geometry";
import { composeGlb, type Placement } from "@/lib/gltf-compose";

/**
 * The configurator, phase 1: configure a model and see it.
 *
 * A model is a configured Onshape assembly read at a version. A request is
 * resolved against the model's own rules, keyed by Onshape's configuration
 * string, and either served from PLM or generated once in the background and
 * kept. See docs/CONFIGURATOR-DESIGN.md — phase 1 renders the picture, phase 2
 * reads the configuration's BOM and keeps it as a snapshot, phase 3 grows
 * PLM's BOM from it: the configuration becomes a PLM assembly numbered from
 * the CFG scheme, each BOM line a PLM part (reused when PLM has it), with this
 * configuration's quantities on its own edges. Numbers stay in PLM — nothing
 * is written back to Onshape (decided 10 Nov 2026). Phase 4 builds its 3D
 * model from the part exports (lib/gltf-compose.ts says why not Onshape's
 * assembly export) and keeps it as the configured assembly's geometry.
 */

/** Part exports running at once while building one model. */
const EXPORT_CONCURRENCY = 3;

/**
 * How 3D models are built. A model built by an older build is rebuilt the
 * next time its configuration is opened: 2 draws composite parts, which 1
 * left out (frames, weldments — the WorkStation's frame, legs and pegboard).
 */
const MODEL_BUILD = 2;

/** Bodies that are not drawn: construction geometry, not product. */
const UNDRAWN_BODIES = new Set(["wire", "point"]);

/**
 * Why a configurator-made part is never written to Onshape. Set as the part's
 * writeBackBlocked, which every write-back path already honours — including
 * deletion, so a reset touches nothing in Onshape either.
 */
export const NO_WRITE_BACK =
  "Made by the configurator — numbered in PLM only; nothing is written back to Onshape.";

/** One position in a configuration's BOM, as kept on the item. */
export type ConfiguredBomLine = {
  level: number;
  quantity: number;
  partNumber: string;
  name: string;
  description: string;
  kind: "part" | "assembly" | "other";
  documentId: string | null;
  elementId: string | null;
  partId: string | null;
  configuration: string | null;
  /** Where the row's part is read from. Absent on phase-2 snapshots. */
  workspaceId?: string | null;
  versionId?: string | null;
  /** Phase 3: the PLM part this line is, and whether this configuration added it. */
  plmPartId?: string | null;
  plmNumber?: string | null;
  added?: boolean;
};

export function toBomSnapshot(lines: BomLine[]): ConfiguredBomLine[] {
  return lines.map((l) => ({
    level: l.indentLevel, quantity: l.quantity, partNumber: l.partNumber, name: l.name,
    description: l.description,
    kind: !l.source ? "other" : l.isAssembly ? "assembly" : "part",
    documentId: l.source?.documentId ?? null, elementId: l.source?.elementId ?? null,
    partId: l.source?.partId ?? null, configuration: l.source?.configuration ?? null,
    workspaceId: l.source?.workspaceId ?? null, versionId: l.source?.versionId ?? null,
  }));
}

/** Rendered size. A configuration's picture is the main thing on its page. */
const PICTURE = { width: 800, height: 600 };

/** Generations running at once, per server process (§4.3 of the design). */
const CONCURRENCY = 2;

/**
 * A generation that has said "queued" or "generating" this long is assumed
 * lost — the server restarted under it — and is started again on the next
 * request. A cold Onshape render was measured at about a minute.
 */
const STALE_MS = 4 * 60_000;

type Actor = { userId: string; email: string };

export class ConfigurationError extends Error {
  constructor(message: string, public fields: Record<string, string> = {}) {
    super(message);
  }
}

/* ------------------------------- Models ---------------------------------- */

/** The document, version or workspace, and tab in an Onshape URL. */
export function parseOnshapeUrl(url: string) {
  const m = /\/documents\/([0-9a-f]{24})\/(w|v|m)\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i.exec(url);
  if (!m) return null;
  return { documentId: m[1], wvType: m[2] as "w" | "v" | "m", wvId: m[3], elementId: m[4] };
}

/**
 * What a URL names, before it is registered: the assembly, its versions, and
 * how many inputs it has — what an admin needs to choose a version.
 */
export async function previewModel(enterpriseId: string, url: string, given?: OnshapeClient) {
  const at = parseOnshapeUrl(url);
  if (!at) throw new ConfigurationError("That is not an Onshape assembly link (…/documents/<id>/w/<id>/e/<id>).");
  if (at.wvType === "m") throw new ConfigurationError("Open the assembly in its workspace or a version, not a microversion.");
  const client = given ?? (await clientForEnterprise(enterpriseId)).client;

  const coords = {
    documentId: at.documentId, elementId: at.elementId, partId: "", configuration: "default",
    workspaceId: at.wvType === "w" ? at.wvId : null, versionId: at.wvType === "v" ? at.wvId : null,
  };
  const [doc, el, versions, payload] = await Promise.all([
    client.getDocumentInfo(at.documentId),
    client.getElementInfo(coords).catch(() => null),
    client.listVersions(at.documentId).catch(() => []),
    client.getConfigurationPayload(coords),
  ]);
  if (client.mode === "live" && el && el.elementType !== "ASSEMBLY") {
    throw new ConfigurationError(`"${el.name}" is a ${el.elementType.toLowerCase()} tab, not an assembly.`);
  }
  const inputs = parseDefinition(payload);
  if (inputs.length === 0) throw new ConfigurationError("That assembly has no configuration to choose from.");

  // A model is read at a version, and a version made before the configuration
  // was added has none: the workspace shows inputs the model would not get.
  // Checked here for the newest version, which is what is offered first.
  let newestVersionInputs: number | null = null;
  if (at.wvType === "w" && versions[0]) {
    newestVersionInputs = parseDefinition(await client.getConfigurationPayload({
      documentId: at.documentId, elementId: at.elementId, versionId: versions[0].id, workspaceId: null,
    }).catch(() => null)).length;
  }

  return {
    ...at,
    newestVersionInputs,
    documentName: doc.name || (client.mode === "mock" ? "Flight Case (simulated)" : ""),
    elementName: el?.name || (client.mode === "mock" ? "Case Assembly" : ""),
    versions,
    inputs: inputs.map((i) => ({ name: i.name, kind: i.kind })),
  };
}

/**
 * Make a model configurable, read at the version given.
 *
 * A link already at a version uses it. A workspace link needs a version named;
 * without one, the newest is used. Refused when the document has no version,
 * or the version chosen has no configuration (it predates it) — a model read
 * from a workspace would go stale, and one with no inputs configures nothing.
 */
export async function registerModel(
  enterpriseId: string,
  actor: Actor,
  input: { url: string; versionId?: string | null; name?: string; productId?: string | null },
  given?: OnshapeClient
) {
  await connectDb();
  const client = given ?? (await clientForEnterprise(enterpriseId)).client;
  const p = await previewModel(enterpriseId, input.url, client);

  const versionId: string | null = p.wvType === "v" ? p.wvId : input.versionId || p.versions[0]?.id || null;
  const version = p.versions.find((v) => v.id === versionId);
  if (input.versionId && !version && p.wvType !== "v") {
    throw new ConfigurationError("That version is not one of this document's.");
  }
  // Only ever a version: a workspace changes under the cached configurations.
  if (!versionId) {
    throw new ConfigurationError(
      "This document has no versions yet. Create a version in Onshape (with the configuration in it), then add the model again."
    );
  }
  const workspaceId = null;

  const payload = await client.getConfigurationPayload({
    documentId: p.documentId, elementId: p.elementId, versionId, workspaceId,
  });
  // Read at the version, not the workspace the preview saw: a version made
  // before the configuration was added has no inputs, and a model of it
  // could configure nothing.
  if (parseDefinition(payload).length === 0) {
    throw new ConfigurationError(
      `At version ${version?.name ? `"${version.name}"` : versionId} this assembly has no configuration — it was ` +
      `probably added after that version. Create a new version in Onshape, then add the model again.`
    );
  }

  const model: any = await ConfigurableModel.create({
    enterpriseId,
    name: input.name?.trim() || p.elementName || p.documentName || "Configurable model",
    productId: input.productId || null,
    documentId: p.documentId,
    elementId: p.elementId,
    versionId,
    workspaceId,
    versionName: version?.name ?? (versionId ? "" : "workspace"),
    documentName: p.documentName,
    elementName: p.elementName,
    definition: payload,
    createdByEmail: actor.email,
  });

  await ActivityLog.create({
    enterpriseId, direction: "plm", action: "created", trigger: "manual", ok: true,
    message: `${actor.email} made "${model.name}" configurable (${p.documentName} · ${p.elementName}` +
      `${versionId ? `, version ${version?.name ?? versionId}` : ", workspace"}).`,
  });
  return { id: String(model._id) };
}

export async function listModels(enterpriseId: string) {
  await connectDb();
  const rows: any[] = await ConfigurableModel.find({ enterpriseId }).sort({ name: 1 }).select("-definition").lean();
  const counts = await ConfiguredItem.aggregate([
    { $match: { modelId: { $in: rows.map((r) => r._id) }, state: "ready" } },
    { $group: { _id: "$modelId", n: { $sum: 1 } } },
  ]);
  const by = new Map(counts.map((c: any) => [String(c._id), c.n]));
  return Promise.all(rows.map(async (m) => {
    const product = await productFor(enterpriseId, m);
    return {
      ...shapeModel(m), configurations: by.get(String(m._id)) ?? 0,
      productId: product.productId, productName: product.productName, productChosen: Boolean(m.productId),
    };
  }));
}

/**
 * The product a model's configurations and their new parts are filed into.
 *
 * The one an admin chose for the model; otherwise the one the model's own
 * parts are already in — the assembly itself as synced from Onshape, or else
 * the product most of the document's parts belong to — so a Flight Case whose
 * parts someone filed under "Flight Case" keeps growing there. Unassigned only
 * when PLM has nothing to go on.
 */
export async function productFor(enterpriseId: string, model: any): Promise<ResolvedProduct> {
  if (model.productId) {
    const chosen = await resolveProductById(enterpriseId, String(model.productId));
    if (chosen) return chosen;
  }
  const unassigned = await resolveUnassignedProduct(enterpriseId);
  const filed = { enterpriseId, documentId: model.documentId, configuredFrom: null, productId: { $nin: [null, unassigned.productId] } };
  const own: any = await Part.findOne({ ...filed, elementId: model.elementId, partId: "" }).select("productId").lean();
  if (own?.productId) return (await resolveProductById(enterpriseId, String(own.productId))) ?? unassigned;
  const [most]: any[] = await Part.aggregate([
    { $match: { ...filed, enterpriseId: new Types.ObjectId(enterpriseId), productId: { $nin: [null, new Types.ObjectId(unassigned.productId)] } } },
    { $group: { _id: "$productId", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 1 },
  ]);
  if (most?._id) return (await resolveProductById(enterpriseId, String(most._id))) ?? unassigned;
  return unassigned;
}

/**
 * Choose the product a model files into, and move what the configurator has
 * already made for it — the configured assemblies and the parts created for
 * their BOMs — there too. Parts PLM had before stay where they are. Admin.
 */
export async function setModelProduct(enterpriseId: string, modelId: string, productId: string, actor: Actor) {
  await connectDb();
  const product = await resolveProductById(enterpriseId, productId);
  if (!product) throw new ConfigurationError("That product does not exist.");
  const r = await ConfigurableModel.updateOne({ _id: modelId, enterpriseId }, { $set: { productId: product.productId } });
  if (r.matchedCount === 0) throw new ConfigurationError("Model not found.");
  const made = await Part.find({ enterpriseId, "configuredFrom.modelId": modelId }).select("_id").lean();
  const { moved } = await assignParts(enterpriseId, made.map((p: any) => String(p._id)), product.productId, actor);
  return { productId: product.productId, productName: product.productName, moved };
}

function shapeModel(m: any) {
  return {
    id: String(m._id), name: m.name, enabled: m.enabled !== false,
    documentName: m.documentName, elementName: m.elementName,
    versionName: m.versionName, onVersion: Boolean(m.versionId), revision: m.revision,
    documentId: m.documentId, elementId: m.elementId, versionId: m.versionId, workspaceId: m.workspaceId,
    createdAt: m.createdAt,
  };
}

export async function getModel(enterpriseId: string, modelId: string) {
  await connectDb();
  const m: any = await ConfigurableModel.findOne({ _id: modelId, enterpriseId }).lean();
  if (!m) return null;
  return { ...shapeModel(m), inputs: parseDefinition(m.definition) };
}

export async function setModelEnabled(enterpriseId: string, modelId: string, enabled: boolean) {
  await connectDb();
  const r = await ConfigurableModel.updateOne({ _id: modelId, enterpriseId }, { $set: { enabled } });
  if (r.matchedCount === 0) throw new ConfigurationError("Model not found.");
}

/* -------------------------------- Items ---------------------------------- */

function shapeItem(i: any) {
  return {
    id: String(i._id), modelId: String(i.modelId), number: i.number, key: i.key,
    values: i.values ?? {}, summary: i.summary, state: i.state, step: i.step, error: i.error,
    hasPicture: Boolean(i.hasPicture),
    pictureVersion: i.pictureVersion ?? 0, rendered: Boolean(i.renderedAt),
    bom: (i.bom ?? null) as ConfiguredBomLine[] | null, bomError: i.bomError ?? null, bomFetchedAt: i.bomFetchedAt ?? null,
    partId: i.partId ? String(i.partId) : null, plmError: i.plmError ?? null,
    addedParts: (i.addedPartIds ?? []).length,
    name: i.name ?? "", hasModel: Boolean(i.modelAt), modelError: i.modelError ?? null, modelMs: i.modelMs ?? null,
    requestCount: i.requestCount ?? 1, requestedByEmail: i.requestedByEmail,
    lastRequestedAt: i.lastRequestedAt, generatedAt: i.generatedAt, elapsedMs: i.elapsedMs,
  };
}

export async function getItem(enterpriseId: string, itemId: string) {
  await connectDb();
  const i: any = await ConfiguredItem.findOne({ _id: itemId, enterpriseId }).select("-picture -onshapePicture").lean();
  if (!i) return null;
  const hasPicture = Boolean(await ConfiguredItem.exists({ _id: itemId, picture: { $ne: null } }));
  return shapeItem({ ...i, hasPicture });
}

export async function itemPicture(enterpriseId: string, itemId: string) {
  await connectDb();
  const i: any = await ConfiguredItem.findOne({ _id: itemId, enterpriseId }).select("picture pictureType").lean();
  const data = toBuffer(i?.picture);
  return data && data.length ? { data, contentType: i.pictureType || "image/png" } : null;
}

/** The model's configurations, most recently asked for first. */
export async function listItems(enterpriseId: string, modelId: string, limit = 24) {
  await connectDb();
  const rows: any[] = await ConfiguredItem.find({ enterpriseId, modelId })
    .sort({ lastRequestedAt: -1 }).limit(limit).select("-picture -onshapePicture").lean();
  const withPic = new Set(
    (await ConfiguredItem.find({ _id: { $in: rows.map((r) => r._id) }, picture: { $ne: null } }).select("_id").lean())
      .map((r: any) => String(r._id))
  );
  return rows.map((r) => shapeItem({ ...r, hasPicture: withPic.has(String(r._id)) }));
}

/**
 * Ask for a configuration.
 *
 * Resolved against the model's rules first (hidden inputs reset, values
 * checked), then keyed by Onshape's own encoding. Seen before: returned as it
 * is — ready, still generating (this request joins it), or failed (remembered,
 * so a combination Onshape rejects is not retried on every request; `retry`
 * asks again). New: queued for generation.
 */
export async function requestConfiguration(
  enterpriseId: string,
  actor: Actor,
  modelId: string,
  given: Values,
  opts: { client?: OnshapeClient; retry?: boolean; wait?: boolean } = {}
) {
  await connectDb();
  const model: any = await ConfigurableModel.findOne({ _id: modelId, enterpriseId }).lean();
  if (!model) throw new ConfigurationError("Model not found.");
  if (model.enabled === false) throw new ConfigurationError(`"${model.name}" is not available for configuring.`);

  const inputs = parseDefinition(model.definition);
  const { values, visible } = resolve(inputs, given);
  const errors = validate(inputs, values, visible);
  if (Object.keys(errors).length) throw new ConfigurationError("Some choices are not valid.", errors);

  const client = opts.client ?? (await clientForEnterprise(enterpriseId)).client;
  const { configuration: key } = await withApiProcess(
    "Configurator",
    () => client.encodeConfiguration(model.documentId, model.elementId, toEncoding(inputs, values)),
    { subject: model.name }
  );

  const identity = { enterpriseId, modelId, modelRevision: model.revision ?? 1, key };
  // Two first requests for one configuration at the same instant both try to
  // insert; the loser's upsert hits the unique index, and asking again finds
  // the winner's row.
  const upsert = () => ConfiguredItem.findOneAndUpdate(
    identity,
    {
      $setOnInsert: {
        ...identity, values, summary: summarize(inputs, values, visible),
        state: "queued", step: "Waiting to generate", requestedByEmail: actor.email,
      },
      $inc: { requestCount: 1 },
      $set: { lastRequestedAt: new Date() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).select("-picture -onshapePicture").lean();
  const item: any = await upsert().catch((err: any) => {
    if (err?.code === 11000) return upsert();
    throw err;
  });
  const fresh = item.requestCount === 1;

  const since = item.startedAt ?? item.createdAt;
  const lost = (item.state === "queued" || item.state === "generating") && since &&
    Date.now() - new Date(since).getTime() > STALE_MS && !running.has(String(item._id));
  const again = opts.retry && item.state === "failed";
  // Ready but without its BOM: generated before phase 2, or the BOM read
  // failed after the picture worked. The picture is kept; only the BOM is
  // asked for. A failed BOM read is retried only on request, like a failure.
  const bomMissing = item.state === "ready" && !item.bom && (!item.bomError || opts.retry);
  // Ready with a BOM but not yet in PLM: generated before phase 3, or adding
  // it failed. Only that step runs.
  const plmMissing = item.state === "ready" && item.bom && !item.partId && (!item.plmError || opts.retry);
  // In PLM but without its 3D model: generated before phase 4, or building
  // it failed. Only that step runs.
  const modelMissing = item.state === "ready" && item.partId &&
    (!item.modelAt || !item.partModelsAt || (item.modelBuild ?? 1) < MODEL_BUILD) && (!item.modelError || opts.retry);
  const bomOnly = bomMissing || plmMissing || modelMissing;

  if (fresh || lost || again || bomOnly) {
    if (!fresh) {
      await ConfiguredItem.updateOne(
        { _id: item._id },
        { $set: {
          state: "queued",
          step: bomMissing ? "Waiting to read the BOM" : plmMissing ? "Waiting to add it to PLM"
            : modelMissing ? "Waiting to build the 3D model" : "Waiting to generate",
          error: null, bomError: null, plmError: null, modelError: null, startedAt: null,
        } }
      );
    }
    const job = enqueue(String(item._id), () => generate(enterpriseId, String(item._id), model, client, actor));
    if (opts.wait) await job;
  }

  return { item: await getItem(enterpriseId, String(item._id)), cached: !fresh && item.state === "ready" && !bomOnly };
}

/* ------------------------------ Generation ------------------------------- */

const running = new Set<string>();
const waiting: { id: string; run: () => Promise<void>; done: () => void }[] = [];

/** Run now if a slot is free, otherwise wait for one. One entry per item, ever. */
function enqueue(id: string, run: () => Promise<void>): Promise<void> {
  const existing = waiting.find((w) => w.id === id);
  if (running.has(id) || existing) return Promise.resolve();
  return new Promise((done) => {
    waiting.push({ id, run, done });
    pump();
  });
}

function pump() {
  while (running.size < CONCURRENCY && waiting.length) {
    const next = waiting.shift()!;
    running.add(next.id);
    void next.run().finally(() => {
      running.delete(next.id);
      next.done();
      pump();
    });
  }
}

async function generate(enterpriseId: string, itemId: string, model: any, client: OnshapeClient, actor: Actor) {
  const started = Date.now();
  const coords = (configuration: string) => ({
    documentId: model.documentId, elementId: model.elementId,
    versionId: model.versionId, workspaceId: model.workspaceId, configuration,
  });
  await withApiProcess("Configurator", async () => {
    const item: any = await ConfiguredItem.findById(itemId).select("key number bom").lean();
    const hasPicture = Boolean(await ConfiguredItem.exists({ _id: itemId, picture: { $ne: null } }));

    // Picture first: it is what the person is waiting for (§4.3).
    if (!hasPicture) {
      try {
        await ConfiguredItem.updateOne(
          { _id: itemId },
          { $set: { state: "generating", step: "Rendering in Onshape", startedAt: new Date() } }
        );
        const picture = await client.renderConfiguration(coords(item.key), PICTURE);
        // Numbered once, on the first success — a configuration that never
        // generated is not something anyone can quote.
        const number = item.number ?? (await nextNumber(enterpriseId, "CONFIGURATION")).number;
        await ConfiguredItem.updateOne(
          { _id: itemId },
          { $set: {
            number, picture: picture.data, pictureType: picture.contentType,
            generatedAt: new Date(), elapsedMs: Date.now() - started,
          } }
        );
      } catch (err: any) {
        const message = String(err?.message ?? err);
        console.warn(`[PLM] configurator: generating ${itemId} failed: ${message}`);
        await ConfiguredItem.updateOne(
          { _id: itemId },
          { $set: { state: "failed", step: "", error: message, elapsedMs: Date.now() - started } }
        );
        return;
      }
    }

    // Then the BOM. Its failure does not undo a good picture: the item is
    // ready, says why its BOM is missing, and can be asked again.
    let bom: ConfiguredBomLine[] | null = item.bom ?? null;
    const bomWasRead = !bom;
    if (!bom) {
      await ConfiguredItem.updateOne(
        { _id: itemId },
        { $set: { state: "generating", step: "Reading the BOM", ...(hasPicture ? { startedAt: new Date() } : {}) } }
      );
      let set: Record<string, unknown>;
      try {
        const table = await client.getAssemblyBom(coords(item.key), { multiLevel: true });
        bom = toBomSnapshot(table.lines);
        set = { bom, bomError: null, bomFetchedAt: new Date() };
      } catch (err: any) {
        const message = String(err?.message ?? err);
        console.warn(`[PLM] configurator: reading the BOM of ${itemId} failed: ${message}`);
        set = { bomError: message };
      }
      await ConfiguredItem.updateOne({ _id: itemId }, { $set: set });
    }

    // Then PLM's BOM (phase 3). Like the BOM read, a failure here leaves the
    // picture and the snapshot standing, says why, and is retried on request.
    const inPlm = Boolean(await ConfiguredItem.exists({ _id: itemId, partId: { $ne: null } }));
    // Also after a fresh read of an item already in PLM: the new snapshot has
    // to learn its PLM parts again. Every step is find-or-create, so nothing
    // is made twice.
    if (bom && (!inPlm || bomWasRead)) {
      await ConfiguredItem.updateOne({ _id: itemId }, { $set: { state: "generating", step: "Adding to PLM" } });
      try {
        await addToPlm(enterpriseId, itemId, model, client, actor, bom);
      } catch (err: any) {
        const message = String(err?.message ?? err);
        console.warn(`[PLM] configurator: adding ${itemId} to PLM failed: ${message}`);
        await ConfiguredItem.updateOne({ _id: itemId }, { $set: { plmError: message } });
      }
    }

    // Last, the 3D model (phase 4) — the slowest step, and the least waited
    // for: the picture and the BOM are already on screen. Kept as the
    // configured assembly's geometry, so it needs that assembly first.
    // The parts' own models come from the same exports, so an item whose
    // assembly model predates them (or whose parts lost theirs) runs it again.
    const done: any = await ConfiguredItem.findById(itemId).select("partId modelAt partModelsAt modelBuild key").lean();
    if (done?.partId && (!done.modelAt || !done.partModelsAt || (done.modelBuild ?? 1) < MODEL_BUILD)) {
      await ConfiguredItem.updateOne({ _id: itemId }, { $set: { state: "generating", step: "Building the 3D model" } });
      const t0 = Date.now();
      let parts: PartExports | null = null;
      const r = await captureWorkspaceGeometry(client, enterpriseId, String(done.partId), {
        documentId: model.documentId, elementId: model.elementId, partId: "", configuration: done.key,
        versionId: model.versionId ?? null, workspaceId: model.workspaceId ?? null,
      }, {
        isAssembly: true,
        produce: async () => { const b = await buildModel(client, model, done.key); parts = b.parts; return b.file; },
      });
      if (r.ok && parts) {
        await ConfiguredItem.updateOne({ _id: itemId }, { $set: { step: "Keeping each part's 3D model" } });
        await storePartModels(enterpriseId, client, model, parts);
      }
      await ConfiguredItem.updateOne(
        { _id: itemId },
        { $set: r.ok
          ? { modelAt: new Date(), partModelsAt: new Date(), modelBuild: MODEL_BUILD, modelError: null, modelMs: Date.now() - t0 }
          : { modelError: r.reason } }
      );
      if (!r.ok) console.warn(`[PLM] configurator: the 3D model of ${itemId} failed: ${r.reason}`);
    }

    await ConfiguredItem.updateOne(
      { _id: itemId },
      { $set: { state: "ready", step: "", error: null, ...(hasPicture ? {} : { elapsedMs: Date.now() - started }) } }
    );
  }, { subject: model.name, newRun: true });
}

/* ------------------------------- 3D model -------------------------------- */

/**
 * The configuration's 3D model: the assembly definition says which part sits
 * where, for this configuration; each distinct part (one tab, part and
 * configuration) is exported once; gltf-compose places them. A part that
 * cannot be exported is left out and named — a model missing one pin is more
 * use than no model.
 */
export type PartExports = Map<string, { inst: AssemblyInstance; data: Buffer; configuration: string }>;

export async function buildModel(
  client: OnshapeClient, model: any, key: string
): Promise<{ file: FileExport; parts: PartExports }> {
  const started = Date.now();
  const def: AssemblyDefinition = await client.getAssemblyDefinition({
    documentId: model.documentId, elementId: model.elementId,
    versionId: model.versionId, workspaceId: model.workspaceId, configuration: key,
  });

  const cfgOf = (x: { fullConfiguration?: string; configuration?: string }) => x.fullConfiguration || x.configuration || "default";
  const subFor = (inst: AssemblyInstance) => {
    const same = def.subAssemblies.filter((s) => s.documentId === inst.documentId && s.elementId === inst.elementId);
    return same.find((s) => cfgOf(s) === cfgOf(inst)) ?? same[0];
  };
  /** The instance an occurrence path ends at, or null if anything on the way is suppressed. */
  const resolvePath = (path: string[]): AssemblyInstance | null => {
    let list = def.rootAssembly.instances;
    for (let i = 0; i < path.length; i++) {
      const inst = list.find((x) => x.id === path[i]);
      if (!inst || inst.suppressed) return null;
      if (i === path.length - 1) return inst;
      const sub = subFor(inst);
      if (!sub) return null;
      list = sub.instances;
    }
    return null;
  };

  const bodyType = new Map((def.parts ?? []).map((p) => [`${p.documentId}|${p.elementId}|${p.partId}`, String(p.bodyType ?? "").toLowerCase()]));
  const unique = new Map<string, AssemblyInstance>();
  const placements: Placement[] = [];
  for (const o of def.rootAssembly.occurrences) {
    if (o.hidden) continue;
    const inst = resolvePath(o.path);
    if (!inst || String(inst.type).toLowerCase() !== "part" || !inst.partId) continue;
    if (UNDRAWN_BODIES.has(bodyType.get(`${inst.documentId}|${inst.elementId}|${inst.partId}`) ?? "")) continue;
    const k = `${inst.documentId}|${inst.elementId}|${inst.partId}|${cfgOf(inst)}`;
    if (!unique.has(k)) unique.set(k, inst);
    placements.push({ key: k, name: inst.name, transform: o.transform });
  }
  if (!placements.length) throw new Error("The assembly definition has no visible parts to draw.");

  const exported = new Map<string, Buffer>();
  const parts: PartExports = new Map();
  const missing: string[] = [];
  const queue = [...unique];
  await Promise.all(Array.from({ length: EXPORT_CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [k, inst] = next;
      const sameDoc = inst.documentId === model.documentId;
      if (!sameDoc && !inst.documentVersion) { missing.push(`${inst.name} (in another document)`); continue; }
      try {
        const out = await client.exportGltf({
          documentId: inst.documentId, elementId: inst.elementId, partId: inst.partId!, configuration: cfgOf(inst),
          workspaceId: sameDoc ? model.workspaceId ?? null : null,
          versionId: sameDoc ? model.versionId ?? null : inst.documentVersion ?? null,
        }, { coarse: true });
        exported.set(k, out.data);
        parts.set(k, { inst, data: out.data, configuration: cfgOf(inst) });
      } catch (err: any) {
        missing.push(`${inst.name} (${String(err?.message ?? err).slice(0, 120)})`);
      }
    }
  }));
  if (!exported.size) throw new Error(`No part of the assembly could be exported: ${missing.join("; ")}`);
  if (missing.length) console.warn(`[PLM] configurator: 3D model left out ${missing.length} part(s): ${missing.join("; ")}`);

  const data = composeGlb(exported, placements, model.name);
  return { file: { data, contentType: "model/gltf-binary", via: "direct", elapsedMs: Date.now() - started }, parts };
}

/**
 * Give each PLM part of the configuration its own 3D model, from the exports
 * the assembly model was just built from — no further Onshape call. Only for
 * a part that has none yet: a part shared by many configurations keeps the
 * first, and one PLM had before keeps whatever it had.
 */
async function storePartModels(enterpriseId: string, client: OnshapeClient, model: any, parts: PartExports) {
  const normalize = await configurationNormalizer(enterpriseId);
  let stored = 0;
  for (const { inst, data, configuration } of parts.values()) {
    const part: any = await Part.findOne({
      enterpriseId, documentId: inst.documentId, elementId: inst.elementId, partId: inst.partId,
      configuration: normalize(configuration, inst.documentId),
    }).select("_id").lean();
    if (!part) continue;
    const has = await PartGeometry.exists({ partId: part._id, size: { $gt: 0 }, failureReason: null });
    if (has) continue;
    const r = await captureWorkspaceGeometry(client, enterpriseId, String(part._id), {
      documentId: inst.documentId, elementId: inst.elementId, partId: inst.partId!, configuration,
      versionId: model.versionId ?? null, workspaceId: model.workspaceId ?? null,
    }, { produce: async () => ({ data, contentType: "model/gltf-binary", via: "direct", elapsedMs: 0 }) });
    if (r.ok) stored++;
  }
  return stored;
}

/* -------------------------------- Pictures ------------------------------- */

/** Largest picture accepted from a render: a 2400 px JPEG is well under this. */
const MAX_PICTURE_BYTES = 12 * 1024 * 1024;

/**
 * Make a studio render the configuration's picture — the gallery's, and the
 * configured assembly's thumbnail in PLM. Onshape's picture is kept the first
 * time, so `restorePicture` can put it back.
 */
export async function setItemPicture(enterpriseId: string, itemId: string, data: Buffer, contentType: string) {
  await connectDb();
  if (!/^image\/(png|jpeg|webp)$/.test(contentType)) throw new ConfigurationError("A picture must be a PNG, JPEG or WebP image.");
  if (!data.length || data.length > MAX_PICTURE_BYTES) throw new ConfigurationError("That picture is empty or too large.");
  const item: any = await ConfiguredItem.findOne({ _id: itemId, enterpriseId }).select("picture pictureType renderedAt partId").lean();
  if (!item) throw new ConfigurationError("Configuration not found.");
  await ConfiguredItem.updateOne({ _id: itemId }, {
    $set: {
      picture: data, pictureType: contentType, renderedAt: new Date(),
      ...(item.renderedAt ? {} : { onshapePicture: item.picture ?? null, onshapePictureType: item.pictureType ?? null }),
    },
    $inc: { pictureVersion: 1 },
  });
  if (item.partId) await setThumbnail(enterpriseId, item.partId, data, contentType);
  return getItem(enterpriseId, itemId);
}

/** Put Onshape's own picture back after a render replaced it. */
export async function restorePicture(enterpriseId: string, itemId: string) {
  await connectDb();
  const item: any = await ConfiguredItem.findOne({ _id: itemId, enterpriseId }).select("onshapePicture onshapePictureType renderedAt partId").lean();
  if (!item) throw new ConfigurationError("Configuration not found.");
  const original = toBuffer(item.onshapePicture);
  if (!item.renderedAt || !original?.length) return getItem(enterpriseId, itemId);
  const type = item.onshapePictureType || "image/png";
  await ConfiguredItem.updateOne({ _id: itemId }, {
    $set: { picture: original, pictureType: type, renderedAt: null, onshapePicture: null, onshapePictureType: null },
    $inc: { pictureVersion: 1 },
  });
  if (item.partId) await setThumbnail(enterpriseId, item.partId, original, type);
  return getItem(enterpriseId, itemId);
}

async function setThumbnail(enterpriseId: string, partId: unknown, data: Buffer, contentType: string) {
  await PartThumbnail.updateOne(
    { partId },
    { $set: { enterpriseId, contentType, data, fetchedAt: new Date(), failedAt: null, failureReason: null } },
    { upsert: true }
  );
}

/* --------------------------------- Names --------------------------------- */

/**
 * Name a configuration ("Touring case, 10 slots"). The configured assembly in
 * PLM takes the name too — it is PLM's own part, never written to Onshape.
 * An empty name goes back to the model's.
 */
export async function nameItem(enterpriseId: string, itemId: string, name: string) {
  await connectDb();
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 120);
  const item: any = await ConfiguredItem.findOneAndUpdate(
    { _id: itemId, enterpriseId }, { $set: { name: clean } }, { new: true }
  ).select("modelId partId").lean();
  if (!item) throw new ConfigurationError("Configuration not found.");
  if (item.partId) {
    const model: any = await ConfigurableModel.findById(item.modelId).select("name").lean();
    const partName = clean || model?.name || "";
    await Part.updateOne({ _id: item.partId, enterpriseId }, { $set: { name: partName, "attributes.name": partName } });
  }
  return getItem(enterpriseId, itemId);
}

/* ----------------------------- Growing the BOM ---------------------------- */

/**
 * Turn one configuration's BOM into PLM's: §4.4 of the design.
 *
 * - Every document the BOM reaches is marked distinct first, so the parts are
 *   keyed by their own configuration — the 700 mm Base is not the 1000 mm one.
 * - Each line is looked up by (document, tab, part, configuration) and reused;
 *   the latch is one PLM part however many cases use it. A part PLM held under
 *   "default" before its document was distinct, with the same number Onshape
 *   reports for this configuration, is re-keyed rather than duplicated (§8).
 * - A line PLM does not have is created as a sync creates one — adopting
 *   Onshape's number, or issuing the next — but never written back.
 * - The configuration itself is a PLM assembly with the CFG number, its own
 *   parent, so its quantities are its own edges (Hinge Pin × 4 here, × 2 in
 *   a smaller case) — which one edge per parent and child could not hold.
 */
async function addToPlm(
  enterpriseId: string, itemId: string, model: any, client: OnshapeClient, actor: Actor, snapshot: ConfiguredBomLine[]
) {
  const item: any = await ConfiguredItem.findById(itemId).select("key number summary name picture pictureType").lean();
  let bom = snapshot;
  // A phase-2 snapshot does not say where each row is read from; read it again.
  if (bom.some((l) => l.kind !== "other" && l.workspaceId === undefined && l.versionId === undefined)) {
    const table = await client.getAssemblyBom(
      { documentId: model.documentId, elementId: model.elementId, versionId: model.versionId, workspaceId: model.workspaceId, configuration: item.key },
      { multiLevel: true }
    );
    bom = toBomSnapshot(table.lines);
  }

  const documents = new Set<string>([model.documentId]);
  for (const l of bom) if (l.documentId) documents.add(l.documentId);
  await Enterprise.updateOne({ _id: enterpriseId }, { $addToSet: { distinctConfigurationDocuments: { $each: [...documents] } } });
  const normalize = await configurationNormalizer(enterpriseId);

  // The configured assembly.
  const topIdentity = {
    enterpriseId, documentId: model.documentId, elementId: model.elementId, partId: "",
    configuration: normalize(item.key, model.documentId),
  };
  let top: any = await Part.findOne(topIdentity);
  const product = await productFor(enterpriseId, model);
  if (!top) {
    const defs = await listDefinitions(enterpriseId, "PART");
    const attributes: Record<string, unknown> = {};
    for (const d of defs) if (d.defaultValue != null) attributes[d.key] = d.defaultValue;
    const topName = item.name || model.name;
    Object.assign(attributes, { number: item.number, name: topName, description: item.summary });
    top = await Part.create({
      ...topIdentity,
      kind: "assembly", number: item.number, name: topName, attributes,
      lifecycleState: "In Work", iteration: 1,
      versionId: model.versionId ?? null, workspaceId: model.workspaceId ?? null,
      documentName: model.documentName, elementName: model.elementName,
      productId: product.productId, productName: product.productName,
      createdByUserId: actor.userId, createdByEmail: actor.email,
      writeBackBlocked: NO_WRITE_BACK,
      configuredFrom: { modelId: model._id, configuredItemId: itemId },
      firstSyncedAt: new Date(),
    });
    await PartIteration.create({
      enterpriseId, partId: top._id, iteration: 1, revision: "", lifecycleState: "In Work",
      attributes, onshapeVersionId: model.versionId ?? null, cause: "sync", changedKeys: [],
      createdByEmail: actor.email, releaseId: null,
    }).catch(() => {});
    if (item.picture) {
      await PartThumbnail.updateOne(
        { partId: top._id },
        { $set: { enterpriseId, contentType: item.pictureType || "image/png", data: item.picture, fetchedAt: new Date(), failedAt: null, failureReason: null } },
        { upsert: true }
      );
    }
  }

  // Each line, parents before children (BOM order already is).
  const added: string[] = [];
  const parentAt: (string | null)[] = [];
  const edges = new Map<string, { parent: string; child: string; quantity: number }>();
  for (const l of bom) {
    if (l.kind === "other" || !l.documentId || !l.elementId) {
      parentAt[l.level] = null;
      continue;
    }
    const configuration = normalize(l.configuration, l.documentId);
    const identity = { enterpriseId, documentId: l.documentId, elementId: l.elementId, partId: l.partId || "", configuration };
    let part: any = await Part.findOne(identity).select("_id number").lean();
    if (!part && configuration !== "default" && l.partNumber) {
      const legacy: any = await Part.findOne({ ...identity, configuration: "default" }).select("_id number").lean();
      if (legacy && legacy.number === l.partNumber) {
        await Part.updateOne({ _id: legacy._id }, { $set: { configuration } });
        part = legacy;
      }
    }
    if (!part) {
      const coords = {
        documentId: l.documentId, elementId: l.elementId, partId: l.partId || "", configuration: l.configuration ?? "default",
        workspaceId: l.workspaceId ?? null, versionId: l.versionId ?? null,
      };
      const r = await syncPartFromOnshape(enterpriseId, coords, {
        trigger: "configurator", client, create: true, kind: l.kind === "assembly" ? "assembly" : "part",
        productId: product.productId,
        createdBy: actor, writeBackBlocked: NO_WRITE_BACK,
        metadataFallback: {
          coords, documentName: model.documentName, elementName: `${model.elementName} (configurator BOM)`,
          partName: l.name, partNumber: l.partNumber, revision: "", description: l.description,
          material: "", state: "", vendor: "", project: "", raw: {}, definitions: [], properties: [],
        },
      });
      if (!r.partId) throw new Error(`Could not add "${l.name}" to PLM (${r.action}).`);
      part = await Part.findById(r.partId).select("_id number").lean();
      if (r.action === "created") {
        await Part.updateOne({ _id: r.partId }, { $set: { configuredFrom: { modelId: model._id, configuredItemId: null } } });
        added.push(String(r.partId));
      }
    }
    l.plmPartId = String(part._id);
    l.plmNumber = part.number ?? null;
    l.added = added.includes(String(part._id));

    const parent = l.level === 0 ? String(top._id) : parentAt[l.level - 1];
    parentAt[l.level] = String(part._id);
    parentAt.length = l.level + 1;
    if (parent && parent !== String(part._id)) {
      const key = `${parent}:${part._id}`;
      const e = edges.get(key);
      if (e) e.quantity += l.quantity;
      else edges.set(key, { parent, child: String(part._id), quantity: l.quantity });
    }
  }
  for (const e of edges.values()) {
    await upsertBomLink(enterpriseId, e.parent, e.child, e.quantity, { documentId: model.documentId, elementId: model.elementId });
  }

  await ConfiguredItem.updateOne(
    { _id: itemId },
    { $set: { bom, partId: top._id, plmError: null, plmAt: new Date() }, $addToSet: { addedPartIds: { $each: added } } }
  );
  await ActivityLog.create({
    enterpriseId, partId: top._id, direction: "plm", action: "created", trigger: "configurator", ok: true,
    message: `Configurator: ${item.number} (${item.summary}) is in PLM with ${edges.size} BOM lines; ` +
      `${added.length} new part${added.length === 1 ? "" : "s"}.`,
  });
}

/* --------------------------------- Reset --------------------------------- */

/** What resetting a model would remove: its configurations and the PLM parts made for them. */
export async function resetPreview(enterpriseId: string, modelId: string) {
  await connectDb();
  const model: any = await ConfigurableModel.findOne({ _id: modelId, enterpriseId }).select("_id name").lean();
  if (!model) return null;
  const [configurations, parts] = await Promise.all([
    ConfiguredItem.countDocuments({ enterpriseId, modelId: model._id }),
    Part.countDocuments({ enterpriseId, "configuredFrom.modelId": model._id }),
  ]);
  return { name: model.name as string, configurations, parts };
}

export type ResetResult = {
  configurations: number;
  partsRemoved: number;
  /** Parts the configurator made that stay: released, or used by something else. */
  partsKept: { number: string; reason: string }[];
  cfgCounterReset: boolean;
};

/**
 * Start a model again from nothing, for demos: its configurations, their
 * pictures and BOMs, the PLM assemblies and parts the configurator made for
 * them, and — when no configuration of any model is left — the CFG counter.
 *
 * Never removed: a part PLM had before the configurator used it (the latch
 * that was already there), a released part, or one something else now uses.
 * Nothing in Onshape is touched; configurator parts are never written there.
 */
export async function resetModel(enterpriseId: string, modelId: string, actorEmail: string): Promise<ResetResult> {
  await connectDb();
  const model: any = await ConfigurableModel.findOne({ _id: modelId, enterpriseId }).lean();
  if (!model) throw new ConfigurationError("Model not found.");
  for (const id of [...running, ...waiting.map((w) => w.id)]) {
    if (await ConfiguredItem.exists({ _id: id, modelId })) {
      throw new ConfigurationError("A configuration of this model is generating. Try again when it has finished.");
    }
  }

  const made: any[] = await Part.find({ enterpriseId, "configuredFrom.modelId": model._id })
    .select("_id number revision").lean();
  const kept = new Map<string, string>();
  for (const p of made) if (p.revision) kept.set(String(p._id), `released at revision ${p.revision}`);

  // A made part still used by a parent outside what is being removed stays —
  // and so, in turn, may its own parents' removal change nothing below it.
  for (;;) {
    const going = new Set(made.map((p) => String(p._id)).filter((id) => !kept.has(id)));
    const outside: any[] = await BomLink.find({ enterpriseId, childId: { $in: [...going] } }).select("parentId childId").lean();
    let moved = false;
    for (const e of outside) {
      if (!going.has(String(e.parentId)) && !kept.has(String(e.childId))) {
        const parentKept = made.find((p) => String(p._id) === String(e.parentId));
        kept.set(String(e.childId), parentKept ? `inside ${parentKept.number}, which stays` : "used by another assembly");
        moved = true;
      }
    }
    if (!moved) break;
  }
  const going = made.filter((p) => !kept.has(String(p._id)));
  const goingIds = going.map((p) => p._id);

  await BomLink.deleteMany({ enterpriseId, parentId: { $in: goingIds } });
  await BomLink.deleteMany({ enterpriseId, childId: { $in: goingIds } });
  let partsRemoved = 0;
  for (const p of going) {
    const r = await deletePart(String(p._id), { trigger: "configurator-reset" });
    if (r.ok) partsRemoved++;
  }

  const configurations = (await ConfiguredItem.deleteMany({ enterpriseId, modelId: model._id })).deletedCount ?? 0;
  const cfgCounterReset = !(await ConfiguredItem.exists({ enterpriseId }));
  if (cfgCounterReset) await NumberingSequence.updateOne({ enterpriseId, type: "CONFIGURATION" }, { $set: { counter: 0 } });

  await ActivityLog.create({
    enterpriseId, direction: "plm", action: "deleted", trigger: "configurator-reset", ok: true,
    message: `${actorEmail} reset "${model.name}": ${configurations} configuration${configurations === 1 ? "" : "s"} ` +
      `and ${partsRemoved} part${partsRemoved === 1 ? "" : "s"} removed` +
      (kept.size ? `, ${kept.size} kept` : "") + (cfgCounterReset ? "; CFG numbering starts again at 1." : "."),
  });

  const numberOf = new Map(made.map((p) => [String(p._id), p.number]));
  return {
    configurations, partsRemoved, cfgCounterReset,
    partsKept: [...kept].map(([id, reason]) => ({ number: numberOf.get(id) ?? id, reason })),
  };
}

/* -------------------------------- Removing ------------------------------- */

/**
 * Remove a model from the configurator: a Reset (its configurations and the
 * PLM parts made for them, under the same rules — parts PLM had before,
 * released parts and parts used elsewhere stay), then the model itself. A part
 * that stays is no longer marked as the configurator's, since the model it
 * pointed at is gone.
 */
export async function removeModel(enterpriseId: string, modelId: string, actorEmail: string) {
  const reset = await resetModel(enterpriseId, modelId, actorEmail);
  await Part.updateMany({ enterpriseId, "configuredFrom.modelId": new Types.ObjectId(modelId) }, { $set: { configuredFrom: null } });
  await ConfigurableModel.deleteOne({ _id: modelId, enterpriseId });
  return reset;
}

/** What clearing the whole configurator would remove, for the confirmation. */
export async function clearPreview(enterpriseId: string) {
  await connectDb();
  const models: any[] = await ConfigurableModel.find({ enterpriseId }).select("_id").lean();
  const ids = models.map((m) => m._id);
  const [configurations, parts] = await Promise.all([
    ConfiguredItem.countDocuments({ enterpriseId, modelId: { $in: ids } }),
    Part.countDocuments({ enterpriseId, "configuredFrom.modelId": { $in: ids } }),
  ]);
  return { models: models.length, configurations, parts };
}

/**
 * Clear the configurator for a demo from scratch: every model removed, with
 * its configurations and the parts made for them; CFG numbering starts again.
 */
export async function clearConfigurator(enterpriseId: string, actorEmail: string) {
  await connectDb();
  const models: any[] = await ConfigurableModel.find({ enterpriseId }).select("_id").lean();
  const total = { models: 0, configurations: 0, partsRemoved: 0, partsKept: [] as ResetResult["partsKept"], cfgCounterReset: false };
  for (const m of models) {
    const r = await removeModel(enterpriseId, String(m._id), actorEmail);
    total.models++;
    total.configurations += r.configurations;
    total.partsRemoved += r.partsRemoved;
    total.partsKept.push(...r.partsKept);
    total.cfgCounterReset = r.cfgCounterReset;
  }
  return total;
}
