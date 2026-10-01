import { connectDb } from "@/lib/db";
import { deleteGeometryFiles } from "@/lib/geometry";
import {
  ActivityLog, BomLink, Drawing, DrawingFile, Enterprise, Part, PartGeometry,
  PartIteration, PartThumbnail, Product, Release, Task,
} from "@/lib/models";

/**
 * Everything "the work" means for one enterprise — what a clean slate clears.
 *
 * One array rather than two, so the dry-run count and the actual delete can
 * never disagree about what counts as work: parts and assemblies, the history
 * kept alongside them, and the groupings built on top of them. Deliberately
 * excludes anything somebody had to configure by hand — see
 * clearEnterpriseWorkData for the list of what survives.
 */
const WORK_MODELS = [
  { label: "parts and assemblies", model: Part },
  { label: "part iterations", model: PartIteration },
  { label: "BOM links", model: BomLink },
  { label: "drawings", model: Drawing },
  { label: "drawing files", model: DrawingFile },
  { label: "captured 3D models", model: PartGeometry },
  { label: "releases", model: Release },
  { label: "thumbnails", model: PartThumbnail },
  { label: "products", model: Product },
  { label: "tasks", model: Task },
  { label: "activity log entries", model: ActivityLog },
  /*
   * Deliberately NOT included: SelfWrite. Its documents are keyed by a
   * composite string, not an enterpriseId field, so a scoped delete would
   * silently match nothing — and they are self-cleaning anyway (a 90-second
   * TTL), so there is no clutter here to warn about in the first place.
   */
] as const;

export type WorkCounts = { label: string; count: number }[];

/** How much a clean slate would remove, without removing anything. */
export async function countEnterpriseWorkData(enterpriseId: string): Promise<WorkCounts> {
  await connectDb();
  return Promise.all(
    WORK_MODELS.map(async ({ label, model }) => ({
      label,
      count: await (model as any).countDocuments({ enterpriseId }),
    }))
  );
}

export type ClearResult = { counts: WorkCounts; total: number };

/**
 * Remove one enterprise's parts, assemblies, releases, drawings, tasks and
 * everything kept alongside them, so a demo or a test tenant can start over.
 *
 * What survives, deliberately: the attribute schema and its Onshape property
 * mapping, the registered OAuth clients Onshape's extensions authenticate
 * against and any tokens already issued, numbering sequences (resetting those
 * would have PLM reissue numbers Onshape may still be carrying on parts that
 * no longer exist here), users, and the enterprise record itself. Those are
 * what somebody had to set up by hand — losing any of them mid-reset would
 * cost more than starting over is meant to save.
 *
 * Never touches Onshape. A part already released there keeps its revision and
 * its released state, and syncing it back in brings that straight back — this
 * is not an undo for a release, only a fresh start on PLM's side of it. What
 * does NOT come back: PLM's own release decisions, the drawing PDFs and 3D
 * models captured here, and the activity log — none of that lives in Onshape.
 */
export async function clearEnterpriseWorkData(enterpriseId: string): Promise<ClearResult> {
  await connectDb();

  // Models over the inline limit live in GridFS, which deleting their rows
  // does not touch — remove those files while the rows still point at them.
  await deleteGeometryFiles({ enterpriseId });

  const counts: WorkCounts = [];
  let total = 0;
  for (const { label, model } of WORK_MODELS) {
    const res = await (model as any).deleteMany({ enterpriseId });
    const count = res.deletedCount ?? 0;
    counts.push({ label, count });
    total += count;
  }

  // Tied to releases that no longer exist otherwise, which would keep warning
  // about a backlog that is gone.
  await Enterprise.updateOne(
    { _id: enterpriseId },
    { $set: { releasesIgnored: 0, lastReleaseIgnoredAt: null } }
  );

  return { counts, total };
}
