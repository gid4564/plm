import { Types } from "mongoose";
import { connectDb } from "@/lib/db";
import { ActivityLog, Enterprise, Part, PartIteration } from "@/lib/models";
import { gridfsDelete, gridfsDownload, gridfsUpload } from "@/lib/gridfs";
import { allocatePartNumber, markSelfWrite, plainAttributes, pushPartToOnshape, syncPartFromOnshape } from "@/lib/sync";
import { listDefinitions, mapOutbound } from "@/lib/attributes";
import { currentProductFor, resolveProductById, resolveUnassignedProduct } from "@/lib/products";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { withApiProcess } from "@/lib/api-log";
import { IMPORT_TIMEOUT_MS } from "@/lib/onshape/live-client";
import { captureWorkspaceGeometry } from "@/lib/geometry";
import type { OnshapeClient, PartCoords } from "@/lib/onshape/types";
import { isStepFile, scanStep } from "@/lib/step-scan";

/**
 * Parts that start life in PLM, and the step that puts them into Onshape.
 *
 * The flow is: create a PLM-only part, attach a CAD file (and anything else
 * worth keeping with it), then "Create in Onshape" — which makes a company
 * document, imports the file into a Part Studio, links the PLM part to the body
 * it produced, and writes PLM's values onto it through the same mapping table
 * every other write uses. From then on it is an ordinary synced part.
 *
 * The import is the slow part (minutes, for a large casting), so it runs in
 * the background and records its progress on the part — see
 * `Part.onshapeCreate`. Every step that changes Onshape is recorded before
 * the next one starts, so a retry resumes rather than repeats.
 */

export const ATTACHMENT_BUCKET = "partfiles";

/**
 * Largest file accepted as an attachment.
 *
 * Bounded by the server rather than by Onshape: the file is held in memory to
 * store it and again to send it, and the production box is small. Raise it
 * with PLM_MAX_ATTACHMENT_MB if the server is.
 */
export const MAX_ATTACHMENT_BYTES = (Number(process.env.PLM_MAX_ATTACHMENT_MB) || 200) * 1024 * 1024;

/**
 * File extensions Onshape imports as geometry.
 *
 * Anything else attached to a part (a PDF, a photo, a spec sheet) goes to the
 * document as a plain file tab instead. Formats Onshape would import only as
 * a drawing or sketch (DXF, DWG) are deliberately absent: the job here is to
 * produce a part.
 */
const CAD_EXTENSIONS = new Set([
  "step", "stp", "iges", "igs", "x_t", "x_b", "xmt_txt", "xmt_bin", "sat", "sab",
  "sldprt", "sldasm", "ipt", "iam", "prt", "asm", "catpart", "catproduct",
  "par", "psm", "jt", "3dm", "stl", "obj", "3mf", "f3d", "neu",
]);

export function isImportableCad(filename: string): boolean {
  const ext = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase() ?? "";
  return CAD_EXTENSIONS.has(ext);
}

/**
 * A run that has said "running" for this long is assumed dead — the server
 * restarted under it — and may be started again. Comfortably past the import
 * timeout, so a slow but live import is never run twice.
 */
const STALE_RUN_MS = IMPORT_TIMEOUT_MS + 5 * 60_000;

type Actor = { userId: string; email: string };
type Attachment = {
  _id: Types.ObjectId; filename: string; contentType: string; size: number;
  fileId: Types.ObjectId; onshapeElementId: string | null;
};

/* -------------------------------------------------------------------------- */
/* Creating a PLM part                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A new part, in PLM only, with a fresh number.
 *
 * Same placeholder Onshape identity as a copy (see part-copy.ts): the schema
 * needs a documentId and elementId, and `plmOnly` is what every Onshape call
 * checks before trusting them. Filed into the product given, else the one the
 * person is working in, else Unassigned.
 */
export async function createPlmPart(
  enterpriseId: string,
  actor: Actor,
  input: { name: string; productId?: string | null }
): Promise<{ id: string; number: string }> {
  await connectDb();

  const name = input.name.trim();
  if (!name) throw new Error("A new part needs a name.");

  const product =
    (input.productId ? await resolveProductById(enterpriseId, input.productId) : null) ??
    (await currentProductFor(actor.userId)) ??
    (await resolveUnassignedProduct(enterpriseId));

  const number = await allocatePartNumber(enterpriseId, "part");
  const newId = new Types.ObjectId();

  // Defaults, number and name, as a first sync seeds them — so the part's
  // attributes read the same as one that arrived from Onshape.
  const defs = await listDefinitions(enterpriseId, "PART");
  const attributes: Record<string, unknown> = {};
  for (const d of defs) if (d.defaultValue != null) attributes[d.key] = d.defaultValue;
  attributes.number = number;
  attributes.name = name;

  await Part.create({
    _id: newId,
    enterpriseId,
    documentId: "plm-only",
    elementId: `plm-only:${newId.toString()}`,
    partId: "",
    configuration: "default",
    plmOnly: true,
    kind: "part",
    number,
    name,
    productId: product.productId,
    productName: product.productName,
    attributes,
    lifecycleState: "In Work",
    iteration: 1,
    createdByUserId: actor.userId,
    createdByEmail: actor.email,
    // What every write-back path already checks; cleared once the part is
    // linked, when its values are written to Onshape after all.
    writeBackBlocked:
      "This part has not been created in Onshape yet — its values are written there once it is.",
  });

  await PartIteration.create({
    enterpriseId, partId: newId, iteration: 1, revision: "", lifecycleState: "In Work",
    attributes, onshapeVersionId: null, cause: "edit", changedKeys: [],
    createdByEmail: actor.email, releaseId: null,
  }).catch(() => {});

  await ActivityLog.create({
    enterpriseId, partId: newId, direction: "plm", action: "created", trigger: "manual", ok: true,
    message: `${actor.email} created ${number} "${name}" in PLM.`,
  });

  return { id: String(newId), number };
}

/* -------------------------------------------------------------------------- */
/* Attachments                                                                 */
/* -------------------------------------------------------------------------- */

export async function addAttachment(
  enterpriseId: string,
  partId: string,
  actor: Actor,
  file: { filename: string; contentType: string; data: Buffer }
): Promise<{ id: string }> {
  await connectDb();
  const part: any = await Part.findOne({ _id: partId, enterpriseId });
  if (!part) throw new Error("Part not found.");
  if (part.lifecycleState === "Released" || part.lifecycleState === "Obsolete") {
    throw new Error(`${part.number} is ${part.lifecycleState.toLowerCase()} — its files are fixed.`);
  }
  if (file.data.length === 0) throw new Error(`${file.filename} is empty.`);
  if (file.data.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${file.filename} is ${Math.round(file.data.length / 1048576)} MB; ` +
      `the limit is ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)} MB.`
    );
  }

  const fileId = await gridfsUpload(ATTACHMENT_BUCKET, file.filename, file.data, {
    enterpriseId, partId, contentType: file.contentType,
  });

  part.attachments.push({
    filename: file.filename,
    contentType: file.contentType || "application/octet-stream",
    size: file.data.length,
    fileId,
    uploadedByEmail: actor.email,
  });
  await part.save();
  const added = part.attachments[part.attachments.length - 1];

  await ActivityLog.create({
    enterpriseId, partId: part._id, direction: "plm", action: "updated", trigger: "manual", ok: true,
    message: `${actor.email} attached ${file.filename} to ${part.number}.`,
  });

  return { id: String(added._id) };
}

export async function readAttachment(
  enterpriseId: string,
  partId: string,
  attachmentId: string
): Promise<{ filename: string; contentType: string; data: Buffer } | null> {
  await connectDb();
  const part: any = await Part.findOne({ _id: partId, enterpriseId }).select("attachments").lean();
  const a = part?.attachments?.find((x: any) => String(x._id) === attachmentId);
  if (!a) return null;
  return { filename: a.filename, contentType: a.contentType, data: await gridfsDownload(ATTACHMENT_BUCKET, a.fileId) };
}

/**
 * Remove an attachment from PLM.
 *
 * Only PLM's copy: a file already sent to Onshape stays in the document,
 * because removing a tab from somebody's CAD document is not what taking a
 * file off a PLM record means.
 */
export async function removeAttachment(
  enterpriseId: string,
  partId: string,
  actor: Actor,
  attachmentId: string
): Promise<void> {
  await connectDb();
  const part: any = await Part.findOne({ _id: partId, enterpriseId });
  if (!part) throw new Error("Part not found.");
  const a = part.attachments.id(attachmentId);
  if (!a) throw new Error("That attachment is not on this part.");
  if (part.onshapeCreate?.state === "running" && part.onshapeCreate.attachmentId === attachmentId) {
    throw new Error(`${a.filename} is being imported into Onshape right now.`);
  }

  const { fileId, filename } = a;
  a.deleteOne();
  await part.save();
  await gridfsDelete(ATTACHMENT_BUCKET, fileId);

  await ActivityLog.create({
    enterpriseId, partId: part._id, direction: "plm", action: "updated", trigger: "manual", ok: true,
    message: `${actor.email} removed ${filename} from ${part.number}.`,
  });
}


/* -------------------------------------------------------------------------- */
/* Create in Onshape                                                           */
/* -------------------------------------------------------------------------- */

type Body = { elementId: string; elementName: string; partId: string; name: string };
type PlanEntry = {
  key: string; fileName: string; name: string;
  instances: number; bodiesPerInstance: number;
  include: boolean; primary: boolean;
  plmPartId: string | null; bodies: Body[];
};

/** A person's changes to a plan on the review screen. */
export type PlanEdit = { key: string; name?: string; include?: boolean; primary?: boolean };

/**
 * A body's name, compared loosely.
 *
 * Case and surrounding space are ignored, and so is a trailing "(2)" or "<2>"
 * — the suffix CAD systems add to tell repeated uses of one part apart. Only
 * those: "Bracket_2" may genuinely be a different part from "Bracket_1".
 */
export const bodyNameKey = (s: string) =>
  s.trim().toLowerCase().replace(/\s*(\(\d+\)|<\d+>)$/, "");

/**
 * Which of the file's parts is most likely this PLM part.
 *
 * An exact name first; then one whose name appears as a whole word in this
 * part's name, or the other way round ("Plastic Bottle" → "bottle"), the
 * longest such match winning; else the first. Only a default — the review
 * shows it and anyone can change it — but a wrong default was easy to miss:
 * this part then took the wrong body, and the wrong body took its name.
 */
export function primaryIndex(names: string[], partName: string): number {
  const target = bodyNameKey(partName);
  const exact = names.findIndex((n) => bodyNameKey(n) === target);
  if (exact >= 0) return exact;

  const words = (s: string) => ` ${s.replace(/[^a-z0-9]+/g, " ").trim()} `;
  const t = words(target);
  let best = -1, bestLen = 0;
  names.forEach((n, i) => {
    const w = words(bodyNameKey(n));
    if (w.trim() && (t.includes(w) || w.includes(t)) && w.length > bestLen) { best = i; bestLen = w.length; }
  });
  return best >= 0 ? best : 0;
}

/**
 * Start creating this part in Onshape from one of its CAD attachments.
 *
 * A STEP file is read first (see step-scan.ts). One part in it: the import
 * starts at once. Several: nothing is created yet — the part waits in state
 * "review" for someone to confirm which parts become PLM parts, and under
 * what names. Other formats cannot be read here, so they are imported first
 * and reviewed afterwards if the import produced more than one part.
 *
 * Returns whether a review is now waiting. The import itself runs in the
 * background; the caller follows it on the part.
 */
export async function startCreateInOnshape(
  enterpriseId: string,
  partId: string,
  actor: Actor,
  attachmentId: string,
  opts: { client?: OnshapeClient; wait?: boolean } = {}
): Promise<{ review: boolean }> {
  await connectDb();
  const part: any = await Part.findOne({ _id: partId, enterpriseId });
  if (!part) throw new Error("Part not found.");
  if (!part.plmOnly) {
    throw new Error(`${part.number} is already linked to Onshape.`);
  }
  if (part.kind !== "part") {
    throw new Error("Only a part can be created from a file — an assembly is built in Onshape.");
  }

  const run = part.onshapeCreate;
  if (run?.state === "running" && run.startedAt && Date.now() - run.startedAt.getTime() < STALE_RUN_MS) {
    throw new Error(`${part.number} is already being created in Onshape.`);
  }
  if (run?.state === "map") {
    throw new Error(`${part.number} is waiting for someone to place the imported bodies.`);
  }
  if (run?.state === "review" && run.planFrom === "import") {
    throw new Error(`${part.number} has been imported and is waiting for its parts to be confirmed.`);
  }

  const a: Attachment | undefined = part.attachments.id(attachmentId);
  if (!a) throw new Error("That attachment is not on this part.");
  if (!isImportableCad(a.filename)) {
    throw new Error(`${a.filename} is not a CAD format Onshape can import as a part.`);
  }

  /*
   * A retry of a confirmed plan keeps it: the PLM parts it made already exist,
   * and planning again would make them twice. A different file starts over,
   * keeping only the document — its bodies must not land beside the first
   * file's.
   */
  const sameFile = run?.attachmentId === attachmentId;
  const confirmed =
    sameFile && run?.state !== "review" && (run?.plan?.length ?? 0) > 0 &&
    run.plan.every((x: any) => x.include === false || x.plmPartId);

  let plan: PlanEntry[] | null = confirmed ? run.plan.map(plainEntry) : null;
  let planFrom: "file" | "import" | null = confirmed ? run.planFrom : null;

  if (!confirmed && isStepFile(a.filename)) {
    const scan = scanStep(await gridfsDownload(ATTACHMENT_BUCKET, a.fileId));
    if (!scan.ok) throw new Error(`${a.filename} could not be read: ${scan.error}`);
    const p = primaryIndex(scan.parts.map((x) => x.name), part.name);
    plan = scan.parts.map((x, i) => ({
      key: x.key, fileName: x.name, name: i === p ? part.name : x.name,
      instances: x.instances, bodiesPerInstance: x.bodiesPerInstance,
      include: true, primary: i === p, plmPartId: i === p ? partId : null, bodies: [],
    }));
    planFrom = "file";
  }

  const review = !confirmed && (plan?.length ?? 0) > 1;
  part.onshapeCreate = {
    state: review ? "review" : "running",
    step: review ? `${a.filename} holds ${plan!.length} parts — confirm what to create` : "Starting",
    error: null,
    warnings: [],
    attachmentId,
    documentId: run?.documentId ?? null,
    workspaceId: run?.workspaceId ?? null,
    initialElementIds: run?.initialElementIds ?? [],
    importedElementIds: sameFile ? run?.importedElementIds ?? [] : [],
    plan: plan ?? undefined,
    planFrom,
    unassignedBodies: [],
    startedAt: new Date(),
    finishedAt: null,
    startedByEmail: actor.email,
  };
  await part.save();
  if (review) return { review: true };

  await launch(enterpriseId, part, () => runCreate(enterpriseId, partId, opts.client), opts.wait);
  return { review: false };
}

/**
 * Confirm a plan waiting in "review": make the PLM parts it calls for, then
 * carry on — importing, for a plan read from the file, or linking straight
 * away, for one built from an import already done.
 */
export async function confirmPlan(
  enterpriseId: string,
  partId: string,
  actor: Actor,
  edits: PlanEdit[],
  opts: { client?: OnshapeClient; wait?: boolean } = {}
): Promise<{ created: { id: string; number: string; name: string }[] }> {
  await connectDb();
  const part: any = await Part.findOne({ _id: partId, enterpriseId });
  if (!part) throw new Error("Part not found.");
  const run = part.onshapeCreate;
  if (run?.state !== "review") throw new Error(`${part.number} has no plan waiting to be confirmed.`);

  const plan: PlanEntry[] = run.plan.map(plainEntry);
  for (const e of edits) {
    const entry = plan.find((x) => x.key === e.key);
    if (!entry) throw new Error("That plan has changed — reload the page.");
    if (e.include !== undefined) entry.include = e.include;
    if (e.name !== undefined) entry.name = e.name.trim();
    if (e.primary !== undefined) entry.primary = e.primary;
  }

  const primaries = plan.filter((x) => x.primary);
  if (primaries.length !== 1) throw new Error(`Choose exactly one part to be ${part.number}.`);
  if (!primaries[0].include) throw new Error(`The part chosen as ${part.number} has to be included.`);

  // The entry this part no longer takes goes back to the file's name.
  // The name follows the PLM part, not the row: a row that becomes this part
  // takes its name unless given another, and the row it left gets the file's.
  const named = (key: string) => edits.some((e) => e.key === key && e.name !== undefined);
  for (const x of plan) {
    if (x.primary && x.plmPartId !== partId) {
      x.plmPartId = partId;
      if (!named(x.key)) x.name = part.name;
    } else if (!x.primary && x.plmPartId === partId) {
      x.plmPartId = null;
      if (!named(x.key)) x.name = x.fileName;
    }
  }
  const blank = plan.find((x) => x.include && !x.name);
  if (blank) throw new Error(`Give "${blank.fileName}" a name, or leave it out.`);

  /*
   * A name given to this part's own row renames it, here, before Onshape is
   * written to — the review is the last moment the name can be settled
   * without a rename in two systems.
   */
  const primary = primaries[0];
  if (primary.name !== part.name) {
    const from = part.name;
    part.name = primary.name;
    part.attributes = { ...plainAttributes(part.attributes), name: primary.name };
    part.markModified("attributes");
    await ActivityLog.create({
      enterpriseId, partId, direction: "plm", action: "updated", trigger: "manual", ok: true,
      message: `${actor.email} renamed ${part.number} from "${from}" to "${primary.name}" at review.`,
      changes: { name: { from, to: primary.name } },
    });
  }

  const a = part.attachments.id(run.attachmentId);
  const created: { id: string; number: string; name: string }[] = [];
  for (const x of plan) {
    if (!x.include || x.plmPartId) continue;
    const made = await createPlmPart(enterpriseId, actor, { name: x.name, productId: part.productId ? String(part.productId) : null });
    x.plmPartId = made.id;
    created.push({ ...made, name: x.name });
    await ActivityLog.create({
      enterpriseId, partId: made.id, direction: "plm", action: "created", trigger: "manual", ok: true,
      message: `Made from ${a?.filename ?? "an imported file"}, alongside ${part.number}.`,
    });
  }

  part.onshapeCreate.plan = plan;
  part.onshapeCreate.state = "running";
  part.onshapeCreate.step = "Starting";
  part.onshapeCreate.startedAt = new Date();
  part.markModified("onshapeCreate");
  await part.save();

  await ActivityLog.create({
    enterpriseId, partId, direction: "plm", action: "updated", trigger: "manual", ok: true,
    message:
      `${actor.email} confirmed ${plan.filter((x) => x.include).length} part(s) from ` +
      `${a?.filename ?? "the file"}` + (created.length ? `: created ${created.map((c) => c.number).join(", ")}.` : "."),
  });

  const next = run.planFrom === "import"
    ? () => linkPlan(enterpriseId, partId, opts.client)
    : () => runCreate(enterpriseId, partId, opts.client);
  await launch(enterpriseId, part, next, opts.wait);
  return { created };
}

/**
 * Place the bodies the import produced but no plan entry claimed by name —
 * one body per entry still without one — then link.
 */
export async function assignBodies(
  enterpriseId: string,
  partId: string,
  actor: Actor,
  assignments: { key: string; elementId: string; partId: string }[],
  opts: { client?: OnshapeClient; wait?: boolean } = {}
): Promise<void> {
  await connectDb();
  const part: any = await Part.findOne({ _id: partId, enterpriseId });
  if (!part) throw new Error("Part not found.");
  const run = part.onshapeCreate;
  if (run?.state !== "map") throw new Error(`${part.number} has no bodies waiting to be placed.`);

  const plan: PlanEntry[] = run.plan.map(plainEntry);
  let pool: Body[] = (run.unassignedBodies ?? []).map(plainBody);
  for (const asg of assignments) {
    const entry = plan.find((x) => x.key === asg.key && x.include);
    const body = pool.find((b) => b.elementId === asg.elementId && b.partId === asg.partId);
    if (!entry || !body) throw new Error("That body or part is no longer waiting — reload the page.");
    entry.bodies.push(body);
    pool = pool.filter((b) => b !== body);
  }
  const missing = plan.filter((x) => x.include && x.bodies.length === 0);
  if (missing.length) throw new Error(`Still no body for: ${missing.map((x) => x.name).join(", ")}.`);

  part.onshapeCreate.plan = plan;
  part.onshapeCreate.unassignedBodies = pool;
  part.onshapeCreate.state = "running";
  part.onshapeCreate.step = "Linking";
  part.markModified("onshapeCreate");
  await part.save();

  await ActivityLog.create({
    enterpriseId, partId, direction: "plm", action: "updated", trigger: "manual", ok: true,
    message: `${actor.email} placed ${assignments.length} imported body/bodies by hand.`,
  });

  await launch(enterpriseId, part, () => linkPlan(enterpriseId, partId, opts.client), opts.wait);
}

/** Abandon a plan waiting for review. Nothing has been created yet for a STEP plan. */
export async function cancelPlan(enterpriseId: string, partId: string): Promise<void> {
  await connectDb();
  const part: any = await Part.findOne({ _id: partId, enterpriseId });
  if (!part) throw new Error("Part not found.");
  if (part.onshapeCreate?.state !== "review") throw new Error("There is no plan waiting to cancel.");
  await Part.updateOne(
    { _id: partId },
    // The plan goes too: it was never confirmed, so the next attempt plans afresh.
    { $set: {
      "onshapeCreate.plan": [],
      "onshapeCreate.planFrom": null,
      "onshapeCreate.state": "failed",
      "onshapeCreate.error": "Cancelled at review." +
        (part.onshapeCreate.documentId ? " The Onshape document already made is kept for the next attempt." : ""),
      "onshapeCreate.finishedAt": new Date(),
    } }
  );
}

/* ------------------------------ The background job ------------------------ */

async function launch(enterpriseId: string, part: any, fn: () => Promise<void>, wait?: boolean) {
  const job = withApiProcess("Create in Onshape", fn, { subject: part.number, newRun: true });
  if (wait) await job;
  else void job;
}

const plainBody = (b: any): Body => ({
  elementId: String(b.elementId), elementName: String(b.elementName ?? ""),
  partId: String(b.partId), name: String(b.name ?? ""),
});
const plainEntry = (x: any): PlanEntry => ({
  key: String(x.key), fileName: String(x.fileName ?? ""), name: String(x.name ?? ""),
  instances: x.instances ?? 1, bodiesPerInstance: x.bodiesPerInstance ?? 1,
  include: x.include !== false, primary: Boolean(x.primary),
  plmPartId: x.plmPartId ? String(x.plmPartId) : null,
  bodies: (x.bodies ?? []).map(plainBody),
});

/** Record a step's name, so the page can say what is happening. */
async function step(partId: string, name: string, extra: Record<string, unknown> = {}) {
  const set: Record<string, unknown> = { "onshapeCreate.step": name };
  for (const [k, v] of Object.entries(extra)) set[`onshapeCreate.${k}`] = v;
  await Part.updateOne({ _id: partId }, { $set: set });
}

async function fail(partId: string, error: string) {
  console.warn(`[PLM] create in Onshape failed for part ${partId}: ${error}`);
  await Part.updateOne(
    { _id: partId },
    { $set: { "onshapeCreate.state": "failed", "onshapeCreate.error": error, "onshapeCreate.finishedAt": new Date() } }
  );
}

async function runCreate(enterpriseId: string, partId: string, given?: OnshapeClient): Promise<void> {
  try {
    const client = given ?? (await clientForEnterprise(enterpriseId)).client;
    const ent: any = await Enterprise.findById(enterpriseId).lean();
    const part: any = await Part.findById(partId).lean();
    const run = part.onshapeCreate;
    const a = part.attachments.find((x: any) => String(x._id) === run.attachmentId);
    if (!a) throw new Error("The attachment was removed before the import could start.");

    // 1. The document, unless an earlier attempt already made it.
    let { documentId, workspaceId } = run;
    let initial: string[] = run.initialElementIds ?? [];
    if (!documentId) {
      await step(partId, "Creating the Onshape document");
      const doc = await client.createDocument({
        name: `${part.number} ${part.name}`.trim(),
        companyId: ent?.onshapeCompanyId,
        folderId: ent?.onshapeNewDocFolderId || undefined,
      });
      documentId = doc.documentId;
      workspaceId = doc.workspaceId;
      // Read before anything is imported: whatever is here now is Onshape's
      // blank starter tab, and is what gets tidied away later.
      initial = (await client.listElements({ documentId, workspaceId }).catch(() => [])).map((e) => e.id);
      await step(partId, "Document created", { documentId, workspaceId, initialElementIds: initial });
    }

    // 2. The import, unless an earlier attempt already finished it.
    let elementIds: string[] = run.importedElementIds ?? [];
    if (elementIds.length === 0) {
      await step(partId, `Importing ${a.filename}`);
      const data = await gridfsDownload(ATTACHMENT_BUCKET, a.fileId);
      if (data.length === 0) throw new Error(`${a.filename} could not be read back from storage.`);
      const result = await client.importFile(
        { documentId, workspaceId },
        { filename: a.filename, data, contentType: a.contentType }
      );
      elementIds = result.elementIds;
      if (elementIds.length === 0) {
        throw new Error(`Onshape finished importing ${a.filename} but reported no new tabs.`);
      }
      await step(partId, "Imported", { importedElementIds: elementIds });
    }

    // 3. Tidy the blank starter Part Studio, now the import has its own tab.
    //    Once only: forgotten after, so a retry does not try again and warn.
    const warnings: string[] = [...(run.warnings ?? [])];
    for (const id of initial) {
      if (elementIds.includes(id)) continue;
      await client.deleteElement({ documentId, workspaceId, elementId: id }).catch((err: any) => {
        warnings.push(`The empty starter tab could not be removed: ${String(err?.message ?? err)}`);
      });
    }
    await step(partId, "Finding the imported parts", { warnings, initialElementIds: [] });

    // 4. Every body the import made.
    const bodies: Body[] = [];
    const elements = await client.listElements({ documentId, workspaceId });
    for (const id of elementIds) {
      const el = elements.find((e) => e.id === id);
      if (el && el.elementType !== "PARTSTUDIO") continue;
      const parts = await client.listElementParts({
        documentId, workspaceId, elementId: id, partId: "", configuration: "default",
      });
      for (const p of parts) {
        bodies.push({ elementId: id, elementName: el?.name ?? "", partId: p.partId, name: p.name });
      }
    }
    if (bodies.length === 0) {
      throw new Error(`Onshape imported ${a.filename} but it produced no solid parts.`);
    }

    // 5. Which body is which part.
    const plan: PlanEntry[] | null = run.plan?.length ? run.plan.map(plainEntry) : null;

    if (!plan) {
      // Not read beforehand: plan from what the import produced, one entry per
      // distinct name. One distinct part needs no review.
      const groups = new Map<string, Body[]>();
      for (const b of bodies) {
        const k = bodyNameKey(b.name || b.partId);
        groups.set(k, [...(groups.get(k) ?? []), b]);
      }
      const list = [...groups.values()];
      const p = primaryIndex(list.map((g) => g[0].name), part.name);
      const built: PlanEntry[] = list.map((g, i) => ({
        key: `${g[0].elementId}:${g[0].partId}`, fileName: g[0].name || g[0].partId,
        name: i === p ? part.name : g[0].name || g[0].partId,
        instances: g.length, bodiesPerInstance: 1, include: true, primary: i === p,
        plmPartId: i === p ? partId : null, bodies: g,
      }));
      if (built.length > 1) {
        await Part.updateOne({ _id: partId }, { $set: {
          "onshapeCreate.state": "review",
          "onshapeCreate.planFrom": "import",
          "onshapeCreate.plan": built,
          "onshapeCreate.step": `${a.filename} imported as ${built.length} parts — confirm what to create`,
        } });
        return;
      }
      await Part.updateOne({ _id: partId }, { $set: { "onshapeCreate.plan": built, "onshapeCreate.planFrom": "import" } });
      return await linkPlan(enterpriseId, partId, client);
    }

    // A plan read from the file: match by name, unless an earlier attempt
    // already placed every body (possibly by hand).
    if (plan.some((x) => x.include && x.bodies.length === 0)) {
      for (const x of plan) x.bodies = [];
      let pool = bodies;
      if (plan.length === 1) {
        plan[0].bodies = pool; // nothing to tell apart
        pool = [];
      } else {
        for (const x of plan) {
          const k = bodyNameKey(x.fileName);
          x.bodies = pool.filter((b) => bodyNameKey(b.name) === k);
          pool = pool.filter((b) => bodyNameKey(b.name) !== k);
        }
      }
      for (const x of plan) {
        const expected = x.instances * x.bodiesPerInstance;
        if (x.include && x.bodies.length > 0 && x.bodies.length !== expected) {
          warnings.push(`"${x.fileName}": the file has ${expected} bod${expected === 1 ? "y" : "ies"}, Onshape made ${x.bodies.length}.`);
        }
      }
      const stuck = plan.some((x) => x.include && x.bodies.length === 0);
      await Part.updateOne({ _id: partId }, { $set: {
        "onshapeCreate.plan": plan,
        "onshapeCreate.unassignedBodies": pool,
        "onshapeCreate.warnings": warnings,
        ...(stuck ? {
          "onshapeCreate.state": "map",
          "onshapeCreate.step": "Some parts could not be matched to an imported body by name — place them",
        } : {}),
      } });
      if (stuck) return;
    }

    await linkPlan(enterpriseId, partId, client);
  } catch (err: any) {
    await fail(partId, String(err?.message ?? err));
  }
}

/**
 * Link every included plan entry's PLM part to its bodies, then finish.
 *
 * Safe to run again after a failure part-way: a PLM part already linked is
 * passed over, so a retry carries on from the first one that was not.
 */
async function linkPlan(enterpriseId: string, partId: string, given?: OnshapeClient): Promise<void> {
  try {
    const client = given ?? (await clientForEnterprise(enterpriseId)).client;
    const part: any = await Part.findById(partId).lean();
    const run = part.onshapeCreate;
    const { documentId, workspaceId } = run;
    const plan: PlanEntry[] = run.plan.map(plainEntry);
    const warnings: string[] = [...(run.warnings ?? [])];
    const docInfo = await client.getDocumentInfo(documentId).catch(() => null);
    const documentName = docInfo?.name || `${part.number} ${part.name}`.trim();

    for (const x of plan) {
      if (!x.include || !x.plmPartId || x.bodies.length === 0) continue;
      const target: any = await Part.findById(x.plmPartId).lean();
      if (!target) { warnings.push(`The PLM part for "${x.name}" no longer exists.`); continue; }
      if (!target.plmOnly) continue; // linked by an earlier attempt
      await step(partId, `Linking ${target.number} ${target.name}`);
      await linkOne(enterpriseId, target, x.bodies, { documentId, workspaceId, documentName, runPartId: partId }, client, warnings);
    }

    // The source file is the imported tab; other files go in as file tabs.
    const primary = plan.find((x) => x.primary);
    if (primary?.bodies[0]) {
      await Part.updateOne(
        { _id: partId, "attachments._id": run.attachmentId },
        { $set: { "attachments.$.onshapeElementId": primary.bodies[0].elementId } }
      );
    }
    const fresh: any = await Part.findById(partId).lean();
    for (const a of fresh.attachments ?? []) {
      if (a.onshapeElementId || String(a._id) === run.attachmentId) continue;
      await step(partId, `Adding ${a.filename} to the document`);
      try {
        const data = await gridfsDownload(ATTACHMENT_BUCKET, a.fileId);
        const { elementId } = await client.uploadBlob(
          { documentId, workspaceId },
          { filename: a.filename, data, contentType: a.contentType }
        );
        await Part.updateOne(
          { _id: partId, "attachments._id": a._id },
          { $set: { "attachments.$.onshapeElementId": elementId, "attachments.$.onshapeError": null } }
        );
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        warnings.push(`${a.filename} was not added to the document: ${msg}`);
        await Part.updateOne(
          { _id: partId, "attachments._id": a._id },
          { $set: { "attachments.$.onshapeError": msg } }
        );
      }
    }

    const leftOut = plan.filter((x) => !x.include).reduce((n, x) => n + x.bodies.length, 0)
      + (run.unassignedBodies?.length ?? 0);
    if (leftOut > 0) {
      warnings.push(`${leftOut} imported bod${leftOut === 1 ? "y was" : "ies were"} left in the document without a PLM part.`);
    }

    const linked = plan.filter((x) => x.include && x.plmPartId);
    await Part.updateOne(
      { _id: partId },
      { $set: {
        "onshapeCreate.state": "done",
        "onshapeCreate.step": "Done",
        "onshapeCreate.error": null,
        "onshapeCreate.warnings": warnings,
        "onshapeCreate.finishedAt": new Date(),
      } }
    );

    await ActivityLog.create({
      enterpriseId, partId, direction: "plm->onshape", action: "created", trigger: "create-in-onshape", ok: true,
      message:
        `Created in Onshape — document "${documentName}", ${linked.length} part(s) linked` +
        (warnings.length ? ` (${warnings.length} warning(s))` : "") + ".",
    });
  } catch (err: any) {
    await fail(partId, String(err?.message ?? err));
  }
}

/**
 * Point one PLM part at its Onshape body, then make Onshape agree with PLM.
 *
 * Name and number are written outright: the import named the body after the
 * file, and a sync would otherwise carry that name back over the one in PLM
 * (Name is Onshape-owned — see sync.ts). Mapped attributes follow the mapping
 * table, as an edit would. Further bodies of the same part — repeated uses of
 * it in the file — get the same values, so every copy in Onshape reads as the
 * part it is; PLM tracks the first.
 */
async function linkOne(
  enterpriseId: string,
  target: any,
  bodies: Body[],
  /** Where the job reports progress: the part "Create in Onshape" was pressed on. */
  doc: { documentId: string; workspaceId: string; documentName: string; runPartId: string },
  client: OnshapeClient,
  warnings: string[]
): Promise<void> {
  const [first, ...copies] = bodies;
  const id = String(target._id);
  await Part.updateOne(
    { _id: id },
    { $set: {
      documentId: doc.documentId,
      elementId: first.elementId,
      partId: first.partId,
      configuration: "default",
      workspaceId: doc.workspaceId,
      versionId: null,
      documentName: doc.documentName,
      elementName: first.elementName,
      plmOnly: false,
      writeBackBlocked: null,
      firstSyncedAt: new Date(),
    } }
  );

  const coordsOf = (b: Body): PartCoords => ({
    documentId: doc.documentId, workspaceId: doc.workspaceId, versionId: null,
    elementId: b.elementId, partId: b.partId, configuration: "default",
  });

  const meta = await client.getPartMetadata(coordsOf(first));
  const idOf = (n: string) => meta.properties.find((p) => p.name.toLowerCase() === n)?.propertyId;
  const identity: Record<string, unknown> = {};
  const nameId = idOf("name");
  const numberId = idOf("part number");
  if (nameId && target.name) identity[nameId] = target.name;
  if (numberId && target.number) identity[numberId] = target.number;

  const defs = await listDefinitions(enterpriseId, "PART");
  const outbound = mapOutbound(defs, { ...plainAttributes(target.attributes), number: target.number });

  if (Object.keys(identity).length > 0) {
    await markSelfWrite(enterpriseId, coordsOf(first));
    await client.updatePartProperties(coordsOf(first), identity);
  }
  if (Object.keys(outbound).length > 0) {
    const push = await pushPartToOnshape(id, { trigger: "create-in-onshape", client });
    if (!push.ok) warnings.push(`${target.number}: mapped properties were not written: ${push.error}`);
  }
  for (const b of copies) {
    await markSelfWrite(enterpriseId, coordsOf(b));
    await client.updatePartProperties(coordsOf(b), { ...outbound, ...identity }).catch((err: any) => {
      warnings.push(`${target.number}: a further copy (${b.name || b.partId}) was not updated: ${String(err?.message ?? err)}`);
    });
  }

  await syncPartFromOnshape(enterpriseId, coordsOf(first), { trigger: "create-in-onshape", client, kind: "part" })
    .catch((err: any) => warnings.push(`${target.number}: the first sync did not complete: ${String(err?.message ?? err)}`));

  /*
   * The 3D model, for PLM's own viewer — taken whether or not the enterprise
   * captures on every sync. A part made from a file has nothing else to look
   * at in PLM until it does, and this is one export per part, asked for by
   * the person creating it. A first sync would capture it for a new part;
   * this one was linked, not created, so the sync does not.
   */
  await step(doc.runPartId, `Capturing the 3D model of ${target.number}`);
  const cap = await captureWorkspaceGeometry(client, enterpriseId, id, coordsOf(first))
    .catch((err: any) => ({ ok: false, bytes: 0, reason: String(err?.message ?? err) }));
  if (!cap.ok) warnings.push(`${target.number}: the 3D model was not captured: ${cap.reason}`);
}
