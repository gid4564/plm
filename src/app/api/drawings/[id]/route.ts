import { z } from "zod";
import { connectDb } from "@/lib/db";
import { ActivityLog, Drawing, DrawingFile, Part, Release } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import {
  editabilityReason, isEditable, listDefinitions, missingForRelease, validateAttributes,
} from "@/lib/attributes";
import { plainAttributes } from "@/lib/sync";
import { handler, ok, fail } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** One drawing, its attributes, its sheets, and the parts it documents. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  await connectDb();

  const drawing: any = await Drawing.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!drawing) return fail("Drawing not found", 404);

  const defs = await listDefinitions(s.enterpriseId, "DRAWING");
  const attributes = plainAttributes(drawing.attributes);
  const state = String(drawing.lifecycleState);

  const [files, parts, release, logs] = await Promise.all([
    // Bytes excluded: the page lists which sheets exist, and one of them can be
    // several megabytes.
    DrawingFile.find({ drawingId: id }).select("-data").sort({ version: -1 }).lean(),
    (drawing.partIds ?? []).length
      ? Part.find({ _id: { $in: drawing.partIds } })
          .select("number name kind revision iteration lifecycleState")
          .lean()
      : [],
    drawing.releaseId ? Release.findById(drawing.releaseId).select("number state").lean() : null,
    ActivityLog.find({ drawingId: id }).sort({ createdAt: -1 }).limit(25).lean(),
  ]);

  return ok({
    drawing: {
      id: String(drawing._id),
      number: drawing.number,
      name: drawing.name,
      revision: drawing.revision || "",
      iteration: drawing.iteration ?? 1,
      lifecycleState: state,
      documentId: drawing.documentId,
      elementId: drawing.elementId,
      documentName: drawing.documentName,
      elementName: drawing.elementName,
      attributes,
      currentFileId: drawing.currentFileId ? String(drawing.currentFileId) : null,
      updatedAt: drawing.updatedAt,
    },
    definitions: defs.map((d) => ({
      key: d.key,
      label: d.label,
      description: d.description ?? "",
      dataType: d.dataType,
      enumValues: d.enumValues ?? [],
      unit: d.unit ?? "",
      group: d.group ?? "",
      order: d.order ?? 100,
      required: Boolean(d.required),
      requiredForRelease: Boolean(d.requiredForRelease),
      owner: d.owner ?? "onshape",
      syncDirection: d.syncDirection ?? "from-onshape",
      authority: d.authority ?? "onshape",
      onshapePropertyName: d.onshapePropertyName ?? "",
      mapped: Boolean(d.onshapePropertyId),
      editable: isEditable(d, state),
      lockReason: editabilityReason(d, state),
    })),
    missingForRelease: missingForRelease(defs, attributes),
    /*
     * Both stages, newest first. This is the pair requirement 5 is about: the
     * as-submitted sheet is what the approvers reviewed, and the as-released
     * one carries the revision, the watermark and the title-block fields
     * Onshape only fills in once the release has completed.
     */
    files: files.map((f: any) => ({
      id: String(f._id),
      version: f.version,
      stage: f.stage,
      revision: f.revision || "",
      size: f.size ?? 0,
      onshapeVersionId: f.onshapeVersionId ?? null,
      releaseId: f.releaseId ? String(f.releaseId) : null,
      fetchedAt: f.fetchedAt,
      failedAt: f.failedAt,
      failureReason: f.failureReason ?? null,
      isCurrent: String(drawing.currentFileId ?? "") === String(f._id),
    })),
    parts: parts.map((p: any) => ({
      id: String(p._id),
      number: p.number,
      name: p.name,
      kind: p.kind,
      revision: p.revision || "",
      iteration: p.iteration ?? 1,
      lifecycleState: p.lifecycleState,
    })),
    release: release
      ? { id: String((release as any)._id), number: (release as any).number, state: (release as any).state }
      : null,
    logs: logs.map((l: any) => ({
      id: String(l._id),
      direction: l.direction,
      action: l.action,
      trigger: l.trigger,
      message: l.message,
      ok: l.ok,
      createdAt: l.createdAt,
    })),
  });
});

const Patch = z.object({
  attributes: z.record(z.string(), z.unknown()),
});

/**
 * Update a drawing's attributes.
 *
 * The same metamodel enforcement a part gets — type coercion, permitted enum
 * values, and state-dependent editability. This route exists because the
 * drawing schema has attributes required to release ("Checked by" among them),
 * and without it a release could report a gap nobody had any way to fill.
 *
 * No push to Onshape: the seeded drawing attributes are all PLM-owned, and a
 * drawing's metadata read is element-scoped rather than part-scoped, which the
 * client does not yet expose. An attribute directed outbound is accepted and
 * stored, and stays PLM-side until that read exists.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const drawing: any = await Drawing.findOne({ _id: id, enterpriseId: s.enterpriseId });
  if (!drawing) return fail("Drawing not found", 404);

  const defs = await listDefinitions(s.enterpriseId, "DRAWING");
  const current = plainAttributes(drawing.attributes);
  const state = String(drawing.lifecycleState);

  const result = validateAttributes(defs, parsed.data.attributes, current, state);
  if (!result.ok) return ok({ ok: false, errors: result.errors }, 422);

  const changed = Object.keys(parsed.data.attributes).filter(
    (k) => String(current[k] ?? "") !== String(result.values[k] ?? "")
  );

  if (changed.length) {
    drawing.attributes = result.values;
    drawing.markModified("attributes");
    drawing.iteration = (drawing.iteration ?? 1) + 1;
    await drawing.save();

    await ActivityLog.create({
      enterpriseId: s.enterpriseId, drawingId: drawing._id, direction: "plm",
      action: "updated", trigger: "user-edit", ok: true,
      message: `${s.email} updated ${changed.join(", ")} on ${drawing.number}`,
      changes: Object.fromEntries(changed.map((k) => [k, { from: current[k] ?? null, to: result.values[k] ?? null }])),
    });
  }

  return ok({
    ok: true,
    changed: changed.length > 0,
    drawing: {
      id: String(drawing._id),
      iteration: drawing.iteration,
      attributes: plainAttributes(drawing.attributes),
    },
    missingForRelease: missingForRelease(defs, plainAttributes(drawing.attributes)),
  });
});
