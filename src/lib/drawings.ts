import { withApiProcess } from "@/lib/api-log";
import { connectDb } from "@/lib/db";
import { ActivityLog, Drawing, DrawingFile } from "@/lib/models";
import { listDefinitions } from "@/lib/attributes";
import { nextNumber } from "@/lib/numbering";
import type { DrawingCoords, OnshapeClient, ReleasePackageItem } from "@/lib/onshape/types";

/**
 * Drawing documents and their PDFs.
 *
 * A drawing is a PLM object in its own right, and its controlled deliverable is
 * a PDF that has to be captured twice per release. That is not an
 * implementation quirk — it is the actual behaviour of the system being
 * integrated: Onshape only applies the revision, the watermark and the
 * title-block release fields once the release has completed, so the sheet the
 * approvers reviewed and the sheet that becomes the controlled document are
 * different files.
 *
 * A note on attributes. Onshape's metadata read used here is part-scoped, and a
 * drawing is an element with no part inside it, so a drawing's name arrives
 * from the release package rather than from a metadata call. Every other
 * seeded drawing attribute is PLM-owned by design (sheet size, drawn by,
 * checked by), so nothing is currently lost by that — but adding an
 * element-level metadata read is what would be needed to mirror custom
 * properties held on a drawing tab.
 */

/** Mongo's per-document ceiling. A drawing PDF is normally far inside it. */
const MAX_PDF_BYTES = 15 * 1024 * 1024;

/**
 * Create or update the PLM drawing for one release-package item.
 *
 * Idempotent on the Onshape document+element pair, so a drawing that appears in
 * several releases is one PLM object throughout its life rather than one per
 * release.
 */
export async function upsertDrawingFromPackageItem(
  enterpriseId: string,
  item: ReleasePackageItem,
  opts: { partIds?: string[]; releaseId?: string } = {}
): Promise<any> {
  await connectDb();

  const identity = {
    enterpriseId,
    documentId: item.documentId,
    elementId: item.elementId,
  };

  let drawing: any = await Drawing.findOne(identity);

  if (!drawing) {
    const { number } = await nextNumber(enterpriseId, "DRAWING");
    const defs = await listDefinitions(enterpriseId, "DRAWING");

    const attributes: Record<string, unknown> = {};
    for (const d of defs) if (d.defaultValue != null) attributes[d.key] = d.defaultValue;
    attributes.number = number;
    attributes.name = item.name || "";

    drawing = new Drawing({
      ...identity,
      number,
      name: item.name || "",
      lifecycleState: "Under Review",
      attributes,
      partIds: opts.partIds ?? [],
      releaseId: opts.releaseId ?? null,
      versionId: item.versionId || null,
    });

    try {
      await drawing.save();
    } catch (err: any) {
      // Two items in one package naming the same drawing, or two releases
      // racing. The loser adopts the winner rather than minting a second
      // drawing number for one sheet.
      if (err?.code === 11000) {
        drawing = await Drawing.findOne(identity);
        if (!drawing) throw err;
      } else {
        throw err;
      }
    }
  } else {
    if (item.name) drawing.name = item.name;
    if (opts.releaseId) drawing.releaseId = opts.releaseId;
    // Union rather than replace: a sheet can document more parts over time, and
    // a package that happens to mention only one of them is not evidence that
    // the others are no longer on it.
    for (const pid of opts.partIds ?? []) {
      if (!drawing.partIds.some((p: any) => String(p) === String(pid))) drawing.partIds.push(pid);
    }
    await drawing.save();
  }

  return drawing;
}

export type CaptureResult = {
  ok: boolean;
  fileId: string | null;
  version: number | null;
  error: string | null;
};

/**
 * Export a drawing's PDF from Onshape and store it as the next file version.
 *
 * `stage` decides both what is recorded and, through `coords`, what Onshape
 * actually produces:
 *
 *   as-submitted — exported from the workspace: no revision, no watermark
 *   as-released  — exported from the version the release produced: all three
 *
 * A failure is recorded as a file row with a reason rather than thrown away.
 * A release whose drawing could not be captured has to be visible as exactly
 * that — not as a release with no drawings, which looks the same as a release
 * that never had any.
 */
async function captureDrawingPdfImpl(
  client: OnshapeClient,
  drawingId: string,
  stage: "as-submitted" | "as-released",
  coords: DrawingCoords,
  opts: { releaseId?: string; revision?: string } = {}
): Promise<CaptureResult> {
  await connectDb();

  const drawing: any = await Drawing.findById(drawingId);
  if (!drawing) return { ok: false, fileId: null, version: null, error: "Drawing not found" };

  // Version numbers are per drawing and monotonic, so the file list reads as a
  // history rather than needing a sort by date.
  const last: any = await DrawingFile.findOne({ drawingId: drawing._id })
    .sort({ version: -1 })
    .lean();
  const version = (last?.version ?? 0) + 1;

  const base = {
    enterpriseId: drawing.enterpriseId,
    drawingId: drawing._id,
    version,
    stage,
    onshapeVersionId: coords.versionId ?? null,
    revision: opts.revision ?? "",
    releaseId: opts.releaseId ?? null,
  };

  try {
    const out = await client.exportDrawingPdf(coords);

    if (out.data.length > MAX_PDF_BYTES) {
      // Recorded, not truncated. A silently shortened PDF is a corrupt
      // controlled document, which is worse than a missing one.
      const failed = await DrawingFile.create({
        ...base,
        translationId: out.translationId ?? null,
        failedAt: new Date(),
        failureReason:
          `The PDF is ${(out.data.length / 1024 / 1024).toFixed(1)}MB, over the ` +
          `${MAX_PDF_BYTES / 1024 / 1024}MB this store holds. Nothing was saved.`,
      });
      return {
        ok: false, fileId: String(failed._id), version,
        error: failed.failureReason,
      };
    }

    const file = await DrawingFile.create({
      ...base,
      contentType: out.contentType || "application/pdf",
      data: out.data,
      size: out.data.length,
      translationId: out.translationId ?? null,
      fetchedAt: new Date(),
    });

    // The released sheet supersedes the submitted one as what a person should
    // be looking at. Both remain; only which is current changes.
    drawing.currentFileId = file._id;
    if (opts.revision) drawing.revision = opts.revision;
    await drawing.save();

    await ActivityLog.create({
      enterpriseId: drawing.enterpriseId,
      drawingId: drawing._id,
      releaseId: opts.releaseId ?? null,
      direction: "onshape->plm",
      action: "updated",
      trigger: "release",
      ok: true,
      message:
        `Captured ${stage} PDF of ${drawing.number} as version ${version} ` +
        `(${(out.data.length / 1024).toFixed(0)}kB` +
        `${opts.revision ? `, revision ${opts.revision}` : ", no revision yet"}).`,
    });

    return { ok: true, fileId: String(file._id), version, error: null };
  } catch (err: any) {
    const error = String(err?.message ?? err);
    const failed = await DrawingFile.create({
      ...base,
      failedAt: new Date(),
      failureReason: error.slice(0, 1000),
    });

    await ActivityLog.create({
      enterpriseId: drawing.enterpriseId,
      drawingId: drawing._id,
      releaseId: opts.releaseId ?? null,
      direction: "onshape->plm",
      action: "error",
      trigger: "release",
      ok: false,
      message: `Could not capture the ${stage} PDF of ${drawing.number}: ${error.slice(0, 400)}`,
    });

    return { ok: false, fileId: String(failed._id), version, error };
  }
}

/**
 * Which coordinates a stage should be exported from.
 *
 * The whole two-pass behaviour reduces to this choice, so it is one function
 * rather than a decision repeated at each call site — a released sheet
 * accidentally exported from the workspace would look right and carry no
 * revision, which is the failure hardest to notice.
 */
export function coordsForStage(
  drawing: { documentId: string; elementId: string; workspaceId?: string | null },
  stage: "as-submitted" | "as-released",
  releasedVersionId?: string | null
): DrawingCoords {
  if (stage === "as-released") {
    if (!releasedVersionId) {
      throw new Error(
        "Cannot export an as-released drawing without the version the release produced. " +
        "Onshape only applies the revision and watermark at that version."
      );
    }
    return {
      documentId: drawing.documentId,
      elementId: drawing.elementId,
      workspaceId: null,
      versionId: releasedVersionId,
    };
  }

  return {
    documentId: drawing.documentId,
    elementId: drawing.elementId,
    workspaceId: drawing.workspaceId ?? null,
    versionId: null,
  };
}

/** Every stored PDF of a drawing, newest first. Bytes excluded. */
export async function listDrawingFiles(drawingId: string): Promise<any[]> {
  await connectDb();
  return DrawingFile.find({ drawingId })
    .select("-data")
    .sort({ version: -1 })
    .lean();
}

/* Named for the API-usage log — see lib/api-log.ts. */
export function captureDrawingPdf(...args: Parameters<typeof captureDrawingPdfImpl>): ReturnType<typeof captureDrawingPdfImpl> {
  return withApiProcess("Drawing PDF", () => captureDrawingPdfImpl(...args));
}
