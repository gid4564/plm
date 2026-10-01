import { z } from "zod";
import { connectDb } from "@/lib/db";
import {
  ActivityLog, BomLink, Drawing, Enterprise, Part, PartGeometry, PartIteration, Release,
} from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import {
  deletePart, plainAttributes, pushPartToOnshape, readCoords, syncPartFromOnshape,
} from "@/lib/sync";
import {
  editabilityReason, isEditable, listDefinitions, missingForRelease, missingForReleaseKeys,
  validateAttributes,
} from "@/lib/attributes";
import { handler, ok, fail } from "@/lib/api";
import { onshapeElementUrl } from "@/lib/onshape/oauth";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { tasksForPart } from "@/lib/tasks";
import { captureReleasedGeometry, geometryForPart } from "@/lib/geometry";
import { isFavorited } from "@/lib/favorites";
import { registerStarRelease, setInitialRevision, starHistory, starLabel } from "@/lib/star-release";
import { copyPart } from "@/lib/part-copy";
import { listVariants } from "@/lib/variants";

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

  /*
   * "Currently in the structure" excludes an edge a star release has since
   * closed out — see lib/star-release.ts. Without this, a swapped assembly
   * would show both the old and the new component here forever; the old one
   * still belongs in the part's history, which the star releases list below
   * is what carries it in.
   */
  const now = new Date();
  const currentlyEffective = {
    $and: [
      { $or: [{ effectiveFrom: null }, { effectiveFrom: { $lte: now } }] },
      { $or: [{ effectiveTo: null }, { effectiveTo: { $gte: now } }] },
    ],
  };

  const [children, parents, iterations, drawings, logs, ent, release, tasks, geometry, isFavorite, stars] =
    await Promise.all([
    /*
     * Self-referencing edges are excluded rather than shown.
     *
     * A part cannot contain itself, so such an edge is always data damage — and
     * it renders as "contains ×7 itself" in both directions at once, which
     * reads as a product bug rather than a bad row. The import path refuses to
     * create one; this makes sure one that arrived another way cannot mislead.
     */
    BomLink.find({ parentId: id, childId: { $ne: id }, ...currentlyEffective }).lean(),
    BomLink.find({ childId: id, parentId: { $ne: id }, ...currentlyEffective }).lean(),
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
    /*
     * What 3D has been captured, metadata only — never the mesh itself.
     *
     * Never asked for a part `writeBackBlocked` marks read-only — standard
     * content and library parts, which have no 3D representation to capture
     * and no revision to attach one to. Without this, a row from before the
     * capture side stopped even trying still shows Onshape's raw 403 for the
     * gltf export, forever, on a part where "no picture" is not a failure at
     * all but the honest answer.
     */
    part.writeBackBlocked ? [] : geometryForPart(s.enterpriseId, id),
    isFavorited(s.userId, "part", id),
    starHistory(s.enterpriseId, id),
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
      variantIds: (l.variantIds ?? []).map((v: unknown) => String(v)),
    };
  };

  /*
   * This part's own variants, when it is an assembly — the set a "Contains"
   * row's tag editor picks from. Empty for a plain part: nothing here is
   * ever tagged, since variants are defined against the BOM they branch, not
   * against a leaf that has none.
   */
  const variants = part.kind === "assembly" ? await listVariants(s.enterpriseId, id) : [];

  return ok({
    part: {
      id: String(part._id),
      number: part.number,
      productId: part.productId ? String(part.productId) : null,
      productName: part.productName || "",
      name: part.name,
      kind: part.kind,
      plmOnly: Boolean(part.plmOnly),
      revision: part.revision || "",
      starCount: part.starCount ?? 0,
      revisionLabel: starLabel(part.revision || "", part.starCount ?? 0),
      iteration: part.iteration ?? 1,
      lifecycleState: state,
      isFavorite,
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
    variants,
    starReleases: stars,
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
    geometry,
    // A plmOnly part's documentId/elementId are synthetic — real-looking
    // enough to satisfy the schema, not real enough to link to.
    onshapeUrl: part.plmOnly ? null : onshapeElementUrl(part, (ent as any)?.onshapeDomain),
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
  const { action, revision, reason, swap } = (await req.json().catch(() => ({}))) as {
    action?: string; revision?: string;
    reason?: string; swap?: { bomLinkId?: string; newPartId?: string };
  };

  await connectDb();
  const part: any = await Part.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!part) return fail("Part not found", 404);

  if ((action === "push" || action === "pull") && part.plmOnly) {
    return fail(
      `${part.number || part.name} is PLM-only — it has no Onshape original to sync with.`,
      422
    );
  }

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
   * Re-export the 3D model by hand — the retry button for a capture that
   * failed (too large before GridFS, a translation that timed out, Onshape
   * briefly unreachable) without waiting for the next sync or release to
   * try again on its own.
   *
   * Targets one existing row, named by its revision: a part can hold several
   * (one per released revision, plus the unreleased "" row — see
   * PartGeometry), and only the caller knows which one they are looking at.
   * Nothing is invented for a revision PLM has no row for at all.
   */
  if (action === "recapture-geometry") {
    // The same population the write-back and the thumbnail already refuse —
    // standard content and library parts, read-only to this account. Onshape
    // 403s the gltf export for these every time, so a retry can only ever
    // reproduce the same failure.
    if (part.writeBackBlocked) {
      return fail(
        `This part has no 3D capture to recreate: ${part.writeBackBlocked}`,
        409
      );
    }

    const row: any = await PartGeometry.findOne({
      enterpriseId: s.enterpriseId, partId: id, revision: revision ?? "",
    }).lean();
    if (!row) {
      return fail(
        `No 3D capture at revision "${revision || "(none)"}" to recreate. ` +
        `It has to have been attempted at least once first.`,
        404
      );
    }

    /*
     * A released row is pinned to the version the release produced — read
     * from there, never the live workspace, or "revision A" would start
     * showing whatever the model looks like today. The unreleased row has no
     * version to pin to, so it reads the part's current workspace, the same
     * as the sync that first captured it.
     */
    const coords = row.revision
      ? {
          documentId: part.documentId, elementId: part.elementId, partId: part.partId,
          configuration: part.configuration, workspaceId: null, versionId: row.onshapeVersionId,
        }
      : readCoords({
          documentId: part.documentId, elementId: part.elementId, partId: part.partId,
          configuration: part.configuration, workspaceId: part.workspaceId, versionId: part.versionId,
        });

    const { client } = await clientForEnterprise(s.enterpriseId);
    const result = await captureReleasedGeometry(client, s.enterpriseId, id, coords, {
      revision: row.revision || "",
      releaseId: row.releaseId ? String(row.releaseId) : null,
      isAssembly: part.kind === "assembly",
    });
    return ok({ recapture: result });
  }

  /*
   * A new PLM number, the same metadata, no link back to Onshape at all.
   * See lib/part-copy.ts.
   */
  if (action === "copy") {
    try {
      const result = await copyPart(s.enterpriseId, { userId: s.userId, email: s.email }, id);
      return ok({ copy: result });
    } catch (err: any) {
      return fail(String(err?.message ?? err), 422);
    }
  }

  /*
   * "A*" — an off-cycle change to an already-released part, never sent to
   * Onshape. See lib/star-release.ts for what this actually does; here it is
   * just parsing the two request shapes (a component swap, or a plain note)
   * into what that function wants.
   */
  if (action === "star-release") {
    try {
      const result = await registerStarRelease(
        s.enterpriseId, { email: s.email }, id,
        {
          reason: String(reason ?? ""),
          swap: swap?.bomLinkId && swap?.newPartId
            ? { bomLinkId: swap.bomLinkId, newPartId: swap.newPartId }
            : undefined,
        }
      );
      return ok({ star: result });
    } catch (err: any) {
      return fail(String(err?.message ?? err), 422);
    }
  }

  /*
   * Catching PLM's own record up to reality — an object released before PLM
   * tracked it, or directly in Onshape with no PLM release ever taken over.
   * See lib/star-release.ts. Admin-only: this is the one write in the system
   * that takes somebody's word for a revision rather than reading it off
   * Onshape or assigning it through the release workflow.
   */
  if (action === "set-initial-revision") {
    if (s.role !== "admin") {
      return fail("Only an admin can record an object as already released outside PLM.", 403);
    }
    try {
      const result = await setInitialRevision(
        s.enterpriseId, { email: s.email }, id,
        { revision: String(revision ?? ""), reason: String(reason ?? "") }
      );
      return ok({ initialRevision: result });
    } catch (err: any) {
      return fail(String(err?.message ?? err), 422);
    }
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

  return fail(
    `Unknown action "${action}". Use "push", "pull", "copy", "star-release", "set-initial-revision" or ` +
    `"obsolete".`,
    422
  );
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
