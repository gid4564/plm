import { connectDb } from "@/lib/db";
import { ActivityLog, ConfigurableModel, ConfiguredItem } from "@/lib/models";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { withApiProcess } from "@/lib/api-log";
import { nextNumber } from "@/lib/numbering";
import { parseDefinition, resolve, summarize, toEncoding, validate, type Values } from "@/lib/configurator-rules";
import type { OnshapeClient } from "@/lib/onshape/types";
import { toBuffer } from "@/lib/binary";
import type { BomLine } from "@/lib/onshape/bom";

/**
 * The configurator, phase 1: configure a model and see it.
 *
 * A model is a configured Onshape assembly read at a version. A request is
 * resolved against the model's own rules, keyed by Onshape's configuration
 * string, and either served from PLM or generated once in the background and
 * kept. See docs/CONFIGURATOR-DESIGN.md — phase 1 renders the picture, phase 2
 * reads the configuration's BOM and keeps it as a snapshot; PLM parts and the
 * 3D model come in later phases.
 */

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
};

export function toBomSnapshot(lines: BomLine[]): ConfiguredBomLine[] {
  return lines.map((l) => ({
    level: l.indentLevel, quantity: l.quantity, partNumber: l.partNumber, name: l.name,
    description: l.description,
    kind: !l.source ? "other" : l.isAssembly ? "assembly" : "part",
    documentId: l.source?.documentId ?? null, elementId: l.source?.elementId ?? null,
    partId: l.source?.partId ?? null, configuration: l.source?.configuration ?? null,
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

  return {
    ...at,
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
 * without one, the newest is used — a workspace is accepted only when the
 * document has no versions at all, and the model says so, because its cached
 * configurations can then go stale.
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

  let versionId: string | null = p.wvType === "v" ? p.wvId : input.versionId || p.versions[0]?.id || null;
  const version = p.versions.find((v) => v.id === versionId);
  if (input.versionId && !version && p.wvType !== "v") {
    throw new ConfigurationError("That version is not one of this document's.");
  }
  const workspaceId = versionId ? null : p.wvType === "w" ? p.wvId : null;

  const payload = await client.getConfigurationPayload({
    documentId: p.documentId, elementId: p.elementId, versionId, workspaceId,
  });

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
  return rows.map((m) => ({ ...shapeModel(m), configurations: by.get(String(m._id)) ?? 0 }));
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
    bom: (i.bom ?? null) as ConfiguredBomLine[] | null, bomError: i.bomError ?? null, bomFetchedAt: i.bomFetchedAt ?? null,
    requestCount: i.requestCount ?? 1, requestedByEmail: i.requestedByEmail,
    lastRequestedAt: i.lastRequestedAt, generatedAt: i.generatedAt, elapsedMs: i.elapsedMs,
  };
}

export async function getItem(enterpriseId: string, itemId: string) {
  await connectDb();
  const i: any = await ConfiguredItem.findOne({ _id: itemId, enterpriseId }).select("-picture").lean();
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
    .sort({ lastRequestedAt: -1 }).limit(limit).select("-picture").lean();
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
  ).select("-picture").lean();
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
  const bomOnly = item.state === "ready" && !item.bom && (!item.bomError || opts.retry);

  if (fresh || lost || again || bomOnly) {
    if (!fresh) {
      await ConfiguredItem.updateOne(
        { _id: item._id },
        { $set: {
          state: "queued", step: bomOnly ? "Waiting to read the BOM" : "Waiting to generate",
          error: null, bomError: null, startedAt: null,
        } }
      );
    }
    const job = enqueue(String(item._id), () => generate(enterpriseId, String(item._id), model, client));
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

async function generate(enterpriseId: string, itemId: string, model: any, client: OnshapeClient) {
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
    if (!item.bom) {
      await ConfiguredItem.updateOne(
        { _id: itemId },
        { $set: { state: "generating", step: "Reading the BOM", ...(hasPicture ? { startedAt: new Date() } : {}) } }
      );
      let set: Record<string, unknown>;
      try {
        const table = await client.getAssemblyBom(coords(item.key), { multiLevel: true });
        set = { bom: toBomSnapshot(table.lines), bomError: null, bomFetchedAt: new Date() };
      } catch (err: any) {
        const message = String(err?.message ?? err);
        console.warn(`[PLM] configurator: reading the BOM of ${itemId} failed: ${message}`);
        set = { bomError: message };
      }
      if (!hasPicture) set.elapsedMs = Date.now() - started;
      await ConfiguredItem.updateOne({ _id: itemId }, { $set: { ...set, state: "ready", step: "", error: null } });
    } else {
      await ConfiguredItem.updateOne({ _id: itemId }, { $set: { state: "ready", step: "", error: null } });
    }
  }, { subject: model.name, newRun: true });
}
