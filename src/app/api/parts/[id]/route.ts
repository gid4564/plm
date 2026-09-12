import { z } from "zod";
import { connectDb } from "@/lib/db";
import {
  ActivityLog, BomLink, Drawing, Enterprise, Part, PartIteration, Release,
} from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { deletePart, plainAttributes, pushPartToOnshape, syncPartFromOnshape } from "@/lib/sync";
import {
  editabilityReason, isEditable, listDefinitions, missingForRelease, missingForReleaseKeys,
  validateAttributes,
} from "@/lib/attributes";
import { handler, ok, fail } from "@/lib/api";
import { onshapeElementUrl } from "@/lib/onshape/oauth";
import { tasksForPart } from "@/lib/tasks";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One part, with everything the detail page shows.
 *
 * Assembled server-side in one response rather than left to the page to fetch
 * piecemeal: the structure, the iterations and the drawings are all small, and
 * five round trips to render one page is worse than one slightly larger reply.
 */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  await connectDb();

  const part: any = await Part.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!part) return fail("Part not found", 404);

  const defs = await listDefinitions(s.enterpriseId, "PART");
  const attributes = plainAttributes(part.attributes);
  const state = String(part.lifecycleState);

  const [children, parents, iterations, drawings, logs, ent, release, tasks] = await Promise.all([
    /*
     * Self-referencing edges are excluded rather than shown.
     *
     * A part cannot contain itself, so such an edge is always data damage — and
     * it renders as "contains ×7 itself" in both directions at once, which
     * reads as a product bug rather than a bad row. The import path refuses to
     * create one; this makes sure one that arrived another way cannot mislead.
     */
    BomLink.find({ parentId: id, childId: { $ne: id } }).lean(),
    BomLink.find({ childId: id, parentId: { $ne: id } }).lean(),
    PartIteration.find({ partId: id }).sort({ iteration: -1 }).limit(25).lean(),
    Drawing.find({ partIds: id }).select("-attributes").lean(),
    ActivityLog.find({ partId: id }).sort({ createdAt: -1 }).limit(25).lean(),
    Enterprise.findById(s.enterpriseId).lean(),
    part.releaseId ? Release.findById(part.releaseId).lean() : null,
    /*
     * The tasks Onshape has open against this part.
     *
     * Read from PLM's own mirror, not from Onshape: the tasks were synced with
     * their part links already resolved, so answering this costs one indexed
     * query and a part page does not wait on a network call to render.
     */
    tasksForPart(s.enterpriseId, id),
  ]);

  // Resolve the other end of each structure edge in two queries, not one per row.
  const otherIds = [
    ...children.map((l: any) => l.childId),
    ...parents.map((l: any) => l.parentId),
  ];
  const others: any[] = otherIds.length
    ? await Part.find({ _id: { $in: otherIds } })
        .select("number name kind revision lifecycleState")
        .lean()
    : [];
  const byId = new Map(others.map((p: any) => [String(p._id), p]));

  const describe = (l: any, key: "childId" | "parentId") => {
    const other = byId.get(String(l[key]));
    return {
      linkId: String(l._id),
      partId: String(l[key]),
      number: other?.number ?? null,
      name: other?.name ?? "",
      kind: other?.kind ?? "part",
      revision: other?.revision ?? "",
      lifecycleState: other?.lifecycleState ?? "",
      quantity: l.quantity ?? 1,
      findNumber: l.findNumber ?? "",
      lastImportedAt: l.lastImportedAt,
    };
  };

  return ok({
    part: {
      id: String(part._id),
      number: part.number,
      productId: part.productId ? String(part.productId) : null,
      productName: part.productName || "",
      name: part.name,
      kind: part.kind,
      revision: part.revision || "",
      iteration: part.iteration ?? 1,
      lifecycleState: state,
      onshapeState: part.onshapeState || "",
      documentId: part.documentId,
      elementId: part.elementId,
      partIdInOnshape: part.partId || "",
      configuration: part.configuration,
      documentName: part.documentName,
      elementName: part.elementName,
      attributes,
      onshapeProperties: part.onshapeProperties ?? [],
      createdByEmail: part.createdByEmail ?? null,
      pushPending: part.pushPending,
      writeBackBlocked: part.writeBackBlocked ?? null,
      lastPushError: part.lastPushError,
      firstSyncedAt: part.firstSyncedAt,
      lastSyncedFromOnshapeAt: part.lastSyncedFromOnshapeAt,
      lastPushedToOnshapeAt: part.lastPushedToOnshapeAt,
      updatedAt: part.updatedAt,
    },
    /*
     * The schema travels with the data, annotated for this part's state.
     *
     * `editable` and `lockReason` are computed here rather than in the browser
     * because they are governance, not presentation: a client that worked out
     * editability for itself would be a second implementation of the rules, and
     * the two would drift.
     */
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
    /* Keys as well as labels, so a caller rendering the fields can match them. */
    missingForReleaseKeys: missingForReleaseKeys(defs, attributes),
    structure: {
      children: children.map((l: any) => describe(l, "childId")),
      usedIn: parents.map((l: any) => describe(l, "parentId")),
    },
    iterations: iterations.map((i: any) => ({
      iteration: i.iteration,
      revision: i.revision || "",
      lifecycleState: i.lifecycleState,
      cause: i.cause,
      changedKeys: i.changedKeys ?? [],
      createdByEmail: i.createdByEmail ?? null,
      createdAt: i.createdAt,
      /*
       * The release this iteration came from, when it came from one.
       *
       * Carried so the history can link to it: a released revision is the row
       * people most often want to follow up, and the snapshot already records
       * which release produced it.
       */
      releaseId: i.releaseId ? String(i.releaseId) : null,
    })),
    drawings: drawings.map((d: any) => ({
      id: String(d._id),
      number: d.number,
      name: d.name,
      revision: d.revision || "",
      lifecycleState: d.lifecycleState,
      currentFileId: d.currentFileId ? String(d.currentFileId) : null,
    })),
    release: release
      ? { id: String((release as any)._id), number: (release as any).number, state: (release as any).state }
      : null,
    tasks,
    openTaskCount: tasks.filter((t) => t.open).length,
    onshapeUrl: onshapeElementUrl(part, (ent as any)?.onshapeDomain),
    logs: logs.map((l: any) => ({
      id: String(l._id),
      direction: l.direction,
      action: l.action,
      trigger: l.trigger,
      message: l.message,
      changes: l.changes,
      ok: l.ok,
      createdAt: l.createdAt,
    })),
  });
});

const Patch = z.object({
  /** Attribute values, keyed by AttributeDefinition.key. */
  attributes: z.record(z.string(), z.unknown()).optional(),
  /** Push PLM-owned values to Onshape after saving. Defaults on. */
  push: z.boolean().optional().default(true),
});

/**
 * Update attribute values, then push what Onshape should carry.
 *
 * Every value goes through the metamodel: type coercion, permitted enum
 * values, and whether this attribute may be edited in this lifecycle state.
 * A refusal names the attribute and the reason, because "save failed" on a
 * governed field is useless to whoever is trying to work.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const b = parsed.data;

  await connectDb();
  const part: any = await Part.findOne({ _id: id, enterpriseId: s.enterpriseId });
  if (!part) return fail("Part not found", 404);

  const defs = await listDefinitions(s.enterpriseId, "PART");
  const current = plainAttributes(part.attributes);
  const state = String(part.lifecycleState);

  let changed = false;
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (b.attributes) {
    const result = validateAttributes(defs, b.attributes, current, state);
    if (!result.ok) {
      return ok({ ok: false, errors: result.errors }, 422);
    }

    for (const key of Object.keys(b.attributes)) {
      const from = current[key] ?? null;
      const to = result.values[key] ?? null;
      if (String(from) !== String(to)) {
        changes[key] = { from, to };
        changed = true;
      }
    }

    if (changed) {
      part.attributes = result.values;
      part.markModified("attributes");

      /*
       * A PLM-side edit earns an iteration too.
       *
       * The same rule the sync applies, for the same reason: the iteration
       * history has to answer "what did this look like when it was approved",
       * and an edit made here is exactly as much a change as one made in CAD.
       */
      part.iteration = (part.iteration ?? 1) + 1;
      await part.save();

      await PartIteration.create({
        enterpriseId: part.enterpriseId,
        partId: part._id,
        iteration: part.iteration,
        revision: part.revision ?? "",
        lifecycleState: part.lifecycleState,
        attributes: plainAttributes(part.attributes),
        onshapeVersionId: part.versionId ?? null,
        cause: "edit",
        changedKeys: Object.keys(changes),
        createdByEmail: s.email,
      }).catch(() => {});

      await ActivityLog.create({
        enterpriseId: s.enterpriseId, partId: part._id, direction: "plm",
        action: "updated", trigger: "user-edit", ok: true,
        message: `${s.email} updated ${Object.keys(changes).join(", ")} (iteration ${part.iteration})`,
        changes,
      });
    }
  }

  if (!changed && !b.push) {
    return ok({ ok: true, changed: false, push: null });
  }

  const push = b.push ? await pushPartToOnshape(id, { trigger: "user-edit" }) : null;
  const fresh: any = await Part.findById(id).lean();

  return ok({
    ok: true,
    changed,
    changes,
    push,
    part: {
      id: String(fresh._id),
      iteration: fresh.iteration,
      attributes: plainAttributes(fresh.attributes),
      pushPending: fresh.pushPending,
      lastPushError: fresh.lastPushError,
      writeBackBlocked: fresh.writeBackBlocked ?? null,
      updatedAt: fresh.updatedAt,
    },
    missingForRelease: missingForRelease(defs, plainAttributes(fresh.attributes)),
  });
});

/** Re-sync from Onshape, retry a failed push, or obsolete a released part. */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };

  await connectDb();
  const part: any = await Part.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!part) return fail("Part not found", 404);

  if (action === "push") {
    return ok({ push: await pushPartToOnshape(id, { trigger: "manual" }) });
  }

  if (action === "pull") {
    const result = await syncPartFromOnshape(
      s.enterpriseId,
      {
        documentId: part.documentId, elementId: part.elementId, partId: part.partId,
        configuration: part.configuration, workspaceId: part.workspaceId, versionId: part.versionId,
      },
      { trigger: "manual", kind: part.kind }
    );
    return ok({ pull: result });
  }

  /*
   * Obsoleting is how a released part leaves service.
   *
   * Deliberately not a delete: the record and its iterations stay, because a
   * released part may be in products already built. Restricted to admins for
   * the same reason — it is a records decision.
   */
  if (action === "obsolete") {
    if (s.role !== "admin") return fail("Only an admin can obsolete a part.", 403);
    if (part.lifecycleState !== "Released") {
      return fail(
        `${part.number} is ${part.lifecycleState}. Only a released part can be obsoleted.`,
        422
      );
    }
    await Part.updateOne({ _id: id }, { $set: { lifecycleState: "Obsolete" } });
    await ActivityLog.create({
      enterpriseId: s.enterpriseId, partId: id, direction: "plm",
      action: "updated", trigger: "user-edit", ok: true,
      message: `${s.email} obsoleted ${part.number} at revision ${part.revision || "-"}`,
    });
    return ok({ obsoleted: true });
  }

  return fail(`Unknown action "${action}". Use "push", "pull" or "obsolete".`, 422);
});

/**
 * Remove a part from PLM.
 *
 * Refused for anything that has been released — that is a records decision,
 * not a cleanup one, and obsoleting is the route for a part that is no longer
 * wanted. `?force=1` overrides it for an admin dealing with a part that never
 * should have been released, or one that no longer exists in Onshape.
 *
 * PLM's own values are cleared off the CAD part first, so it stops advertising
 * a part number that no longer resolves. Unlike MOS, a failed clear does not
 * block the delete: a part in a document PLM can no longer write to would
 * otherwise be impossible to remove.
 */
export const DELETE = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const force = new URL(req.url).searchParams.get("force") === "1";

  if (force && s.role !== "admin") {
    return fail("Only an admin can force-delete a released part.", 403);
  }

  await connectDb();
  const part: any = await Part.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!part) return fail("Part not found", 404);

  const openRelease = part.releaseId
    ? await Release.findOne({ _id: part.releaseId, state: "Under Review" }).lean()
    : null;
  if (openRelease) {
    return fail(
      `${part.number} is in release ${(openRelease as any).number}, which is still under ` +
      `review. Decide the release first.`,
      409
    );
  }

  const result = await deletePart(id, { trigger: "user-delete", force });
  if (!result.ok) return fail(result.clearError ?? "Could not delete this part.", 409);

  // Structure edges on both sides go with it: an edge to a part that no longer
  // exists renders as a blank row and is worse than no edge.
  await BomLink.deleteMany({ $or: [{ parentId: id }, { childId: id }] });

  return ok({
    deleted: true,
    number: part.number,
    cleared: result.cleared,
    clearError: result.clearError,
  });
});
