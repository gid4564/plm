import { connectDb } from "@/lib/db";
import { ActivityLog, Drawing, DrawingFile, Part, Release } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { refreshReleasedDrawings, validateRelease } from "@/lib/release";
import { handler, ok, fail } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** One release, with its items, their drawings, and the audit trail. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  await connectDb();

  const release: any = await Release.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!release) return fail("Release not found", 404);

  const partIds = (release.items ?? []).filter((i: any) => i.kind === "part").map((i: any) => i.partId);
  const drawingIds = (release.items ?? []).filter((i: any) => i.kind === "drawing").map((i: any) => i.drawingId);

  const [parts, drawings, files, logs] = await Promise.all([
    partIds.length
      ? Part.find({ _id: { $in: partIds } })
          .select("number name kind revision iteration lifecycleState documentName elementName")
          .lean()
      : [],
    drawingIds.length
      ? Drawing.find({ _id: { $in: drawingIds } })
          .select("number name revision lifecycleState currentFileId documentName elementName")
          .lean()
      : [],
    /*
     * This release's sheets only — scoped by releaseId, not just by drawing.
     *
     * A drawing outlives any one release, so an unscoped query returned every
     * sheet ever captured of it: a reviewer opening this release saw an earlier
     * release's as-submitted sheet listed as though it were what they were
     * being asked to approve. Two "as submitted" rows with no way to tell them
     * apart is worse than showing none.
     *
     * The drawing's own page is where the full history belongs, and it labels
     * each sheet with the release it came from.
     *
     * Bytes excluded: a release with a dozen drawings would otherwise be
     * megabytes of JSON.
     */
    drawingIds.length
      ? DrawingFile.find({ drawingId: { $in: drawingIds }, releaseId: id })
          .select("-data")
          .sort({ version: 1 })
          .lean()
      : [],
    ActivityLog.find({ releaseId: id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  const partById = new Map(parts.map((p: any) => [String(p._id), p]));
  const drawingById = new Map(drawings.map((d: any) => [String(d._id), d]));

  const filesByDrawing = new Map<string, any[]>();
  for (const f of files) {
    const key = String(f.drawingId);
    filesByDrawing.set(key, [...(filesByDrawing.get(key) ?? []), f]);
  }

  return ok({
    release: {
      id: String(release._id),
      number: release.number,
      title: release.title,
      description: release.description ?? "",
      origin: release.origin,
      state: release.state,
      onshapeState: release.onshapeState || "",
      onshapeReleasePackageId: release.onshapeReleasePackageId ?? null,
      onshapeWorkflowId: release.onshapeWorkflowId ?? null,
      onshapeChangeOrderId: release.onshapeChangeOrderId ?? null,
      onshapeTransitionAction: release.onshapeTransitionAction ?? null,
      transitionedOnshapeAt: release.transitionedOnshapeAt,
      transitionError: release.transitionError ?? null,
      submittedByEmail: release.submittedByEmail ?? null,
      submittedAt: release.submittedAt,
      decidedByEmail: release.decidedByEmail ?? null,
      decidedAt: release.decidedAt,
      decisionNote: release.decisionNote ?? "",
      validationFailures: release.validationFailures ?? [],
      drawingRefreshPending: Boolean(release.drawingRefreshPending),
      drawingRefreshedAt: release.drawingRefreshedAt,
      createdAt: release.createdAt,
      updatedAt: release.updatedAt,
    },
    /** Recomputed rather than read off the release: attributes may have been filled in since. */
    validationFailures: await validateRelease(id),
    parts: (release.items ?? [])
      .filter((i: any) => i.kind === "part")
      .map((i: any) => {
        const p = partById.get(String(i.partId));
        return {
          partId: String(i.partId),
          number: p?.number ?? null,
          name: p?.name ?? "",
          kind: p?.kind ?? "part",
          revision: i.revision || p?.revision || "",
          iteration: p?.iteration ?? null,
          lifecycleState: p?.lifecycleState ?? "",
          documentName: p?.documentName ?? "",
          elementName: p?.elementName ?? "",
        };
      }),
    drawings: (release.items ?? [])
      .filter((i: any) => i.kind === "drawing")
      .map((i: any) => {
        const d = drawingById.get(String(i.drawingId));
        const sheets = filesByDrawing.get(String(i.drawingId)) ?? [];
        return {
          drawingId: String(i.drawingId),
          number: d?.number ?? null,
          name: d?.name ?? "",
          revision: i.revision || d?.revision || "",
          lifecycleState: d?.lifecycleState ?? "",
          currentFileId: d?.currentFileId ? String(d.currentFileId) : null,
          /*
           * Both stages, in order. This is requirement 5 made visible: the
           * as-submitted sheet is what the approvers reviewed, and the
           * as-released one carries the revision, the watermark and the
           * title-block fields Onshape only fills in afterwards.
           */
          files: sheets.map((f: any) => ({
            id: String(f._id),
            version: f.version,
            stage: f.stage,
            revision: f.revision || "",
            size: f.size ?? 0,
            onshapeVersionId: f.onshapeVersionId ?? null,
            fetchedAt: f.fetchedAt,
            failedAt: f.failedAt,
            failureReason: f.failureReason ?? null,
          })),
        };
      }),
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

/**
 * Retry collecting the released drawing sheets.
 *
 * Exists because the sheets depend on Onshape having finished creating
 * versions, which happens after the decision and is announced by a separate
 * event. If that event is missed — a webhook not registered, a delivery lost —
 * the release would otherwise sit with its controlled documents never
 * collected and no way to ask again.
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };

  await connectDb();
  const release: any = await Release.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!release) return fail("Release not found", 404);

  if (action === "refresh-drawings") {
    if (!release.drawingRefreshPending) {
      return ok({ refresh: null, message: "No drawing sheets are outstanding for this release." });
    }
    return ok({ refresh: await refreshReleasedDrawings(id, { trigger: "manual" }) });
  }

  return fail(`Unknown action "${action}". Use "refresh-drawings".`, 422);
});
