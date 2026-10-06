import { connectDb } from "@/lib/db";
import { ActivityLog, BomLink, Part, PartIteration, StarRelease } from "@/lib/models";

/**
 * "A*" — an off-cycle change to an already-released part or assembly that
 * does not warrant a new revision, and is never sent to Onshape.
 *
 * Two shapes, both registered the same way:
 *
 *   A component swap — a supplier part renumbered but still form-fit-function
 *   equivalent, so the assembly that uses it is substituted in PLM without
 *   "revving the BOM". Built on the structure edge's own effectivity dates
 *   (BomLink.effectiveFrom/effectiveTo) — see api/bom-links/[id]/route.ts,
 *   which already uses them for exactly this: "the superseded component
 *   stays a perfectly current part everywhere else". A star swap just closes
 *   one edge and opens another on the same day, rather than leaving both ends
 *   open for someone to set by hand.
 *
 *   A plain note — a metadata or cosmetic correction with no structure
 *   change at all, registered against the part directly.
 *
 * Either way: `revision` never moves, nothing is written back to Onshape,
 * and PLM's own `starCount` is what turns "A" into "A*", "A**", and so on.
 */

export type StarReleaseSwap = { bomLinkId: string; newPartId: string };

export type StarReleaseResult = {
  starReleaseId: string;
  starCount: number;
  revisionLabel: string;
  swap: { fromPartId: string; toPartId: string; oldBomLinkId: string; newBomLinkId: string } | null;
};

/** "A" + 2 stars -> "A**". A blank revision has nothing to star and is returned as-is. */
export function starLabel(revision: string, starCount: number): string {
  if (!revision) return revision;
  return `${revision}${"*".repeat(Math.max(0, starCount))}`;
}

export async function registerStarRelease(
  enterpriseId: string,
  actor: { email: string },
  partId: string,
  opts: { reason: string; swap?: StarReleaseSwap }
): Promise<StarReleaseResult> {
  await connectDb();

  const reason = String(opts.reason ?? "").trim();
  if (!reason) {
    throw new Error(
      "A star release needs a reason — what changed, and why it does not need a new revision."
    );
  }

  const part: any = await Part.findOne({ _id: partId, enterpriseId });
  if (!part) throw new Error("Part not found.");
  if (!part.revision) {
    throw new Error(
      `${part.number || part.name} has no revision in PLM, so there is nothing for a star to ` +
      `attach to. If it is genuinely already released — outside PLM, or before PLM tracked it — ` +
      `an admin can record that from its own part page first ("Set initial revision…"); otherwise ` +
      `it needs a real release.`
    );
  }

  let swapResult: StarReleaseResult["swap"] = null;

  if (opts.swap) {
    const oldLink: any = await BomLink.findOne({ _id: opts.swap.bomLinkId, enterpriseId });
    if (!oldLink) throw new Error("That structure link does not exist.");
    if (String(oldLink.parentId) !== String(part._id)) {
      throw new Error("That component is not part of this assembly.");
    }
    /*
     * Any existing end — past or a planned future one set through the
     * ordinary effectivity editor — means this edge already has a defined
     * lifespan a star swap has no business overwriting.
     */
    if (oldLink.effectiveTo) {
      throw new Error(
        `That component's effectivity already ends ` +
        `${new Date(oldLink.effectiveTo).toISOString().slice(0, 10)}. Clear that first if this ` +
        `swap should replace it.`
      );
    }
    if (String(oldLink.childId) === String(opts.swap.newPartId)) {
      throw new Error("That is already the component in use.");
    }
    const newPart: any = await Part.findOne({ _id: opts.swap.newPartId, enterpriseId });
    if (!newPart) throw new Error("The replacement part was not found in this enterprise.");

    /*
     * The (parent, child) pair is unique, so a part that was swapped out
     * earlier still has its ended edge on file. Swapping it back in reopens
     * that edge rather than inserting a second one.
     */
    const existing: any = await BomLink.findOne({
      enterpriseId, parentId: oldLink.parentId, childId: newPart._id,
    });
    if (existing && (!existing.effectiveTo || new Date(existing.effectiveTo) > new Date())) {
      throw new Error(
        `${newPart.number || newPart.name} is already a component of this assembly.`
      );
    }

    const now = new Date();
    oldLink.effectiveTo = now;
    await oldLink.save();

    let newLink: any;
    if (existing) {
      existing.quantity = oldLink.quantity;
      existing.findNumber = oldLink.findNumber;
      existing.effectiveFrom = now;
      existing.effectiveTo = null;
      await existing.save();
      newLink = existing;
    } else {
      newLink = await BomLink.create({
        enterpriseId, parentId: oldLink.parentId, childId: newPart._id,
        quantity: oldLink.quantity, findNumber: oldLink.findNumber,
        effectiveFrom: now, effectiveTo: null,
        /*
         * Blank, not copied from the old edge — this one was never read from
         * an Onshape assembly. Leaving the provenance fields empty is what
         * marks it, honestly, as PLM's own.
         */
        sourceDocumentId: "", sourceElementId: "",
      });
    }

    swapResult = {
      fromPartId: String(oldLink.childId), toPartId: String(newPart._id),
      oldBomLinkId: String(oldLink._id), newBomLinkId: String(newLink._id),
    };
  }

  part.starCount = (part.starCount ?? 0) + 1;
  await part.save();

  const label = starLabel(part.revision, part.starCount);

  const star = await StarRelease.create({
    enterpriseId, partId: part._id,
    baseRevision: part.revision, starIndex: part.starCount,
    reason,
    swap: swapResult,
    createdByEmail: actor.email,
  });

  await ActivityLog.create({
    enterpriseId, partId: part._id, direction: "plm", action: "starred", trigger: "manual", ok: true,
    message:
      `${actor.email} registered star release ${label} on ${part.number || part.name}` +
      (swapResult ? " (swapped a component)" : "") +
      `: ${reason}`,
  });

  return { starReleaseId: String(star._id), starCount: part.starCount, revisionLabel: label, swap: swapResult };
}

export type StarReleaseHistoryRow = {
  id: string;
  baseRevision: string;
  starIndex: number;
  reason: string;
  createdByEmail: string;
  createdAt: string;
  swap: { fromNumber: string; fromName: string; toNumber: string; toName: string } | null;
};

/** A part's star history, newest first — for the "Star releases" card on its detail page. */
export async function starHistory(enterpriseId: string, partId: string): Promise<StarReleaseHistoryRow[]> {
  await connectDb();
  const rows: any[] = await StarRelease.find({ enterpriseId, partId }).sort({ createdAt: -1 }).lean();
  if (!rows.length) return [];

  const swapPartIds = rows.flatMap((r) => (r.swap ? [r.swap.fromPartId, r.swap.toPartId] : []));
  const parts: any[] = swapPartIds.length
    ? await Part.find({ _id: { $in: swapPartIds } }).select("number name").lean()
    : [];
  const byId = new Map(parts.map((p) => [String(p._id), p]));

  return rows.map((r) => ({
    id: String(r._id),
    baseRevision: r.baseRevision,
    starIndex: r.starIndex,
    reason: r.reason,
    createdByEmail: r.createdByEmail ?? "",
    createdAt: r.createdAt,
    swap: r.swap
      ? {
          fromNumber: byId.get(String(r.swap.fromPartId))?.number ?? "",
          fromName: byId.get(String(r.swap.fromPartId))?.name ?? "",
          toNumber: byId.get(String(r.swap.toPartId))?.number ?? "",
          toName: byId.get(String(r.swap.toPartId))?.name ?? "",
        }
      : null,
  }));
}

/**
 * Star reasons for many parts at once, newest first — for a list or a tree
 * where fetching each part's history separately would be a query per row.
 * Bounded by the caller's own `partIds` (a page, a BOM), never the whole
 * enterprise, so this stays one query regardless of list size.
 */
export async function starReasonsForParts(
  enterpriseId: string, partIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!partIds.length) return out;

  await connectDb();
  const rows: any[] = await StarRelease.find({ enterpriseId, partId: { $in: partIds } })
    .sort({ createdAt: -1 })
    .select("partId baseRevision starIndex reason")
    .lean();

  for (const r of rows) {
    const key = String(r.partId);
    const line = `${r.baseRevision}${"*".repeat(r.starIndex)}: ${r.reason}`;
    const list = out.get(key);
    if (list) list.push(line);
    else out.set(key, [line]);
  }
  return out;
}

/**
 * Catching PLM's own record up to reality, for an object released outside
 * PLM's tracking entirely — before PLM existed, or through Onshape directly
 * with no PLM release ever taken over.
 *
 * Not a release and not a star release: neither applies here, because both
 * assume PLM already holds a revision to move from or star. This just
 * records the one it was told, admin-only, since it is the one write in this
 * whole system that takes somebody's word for a revision rather than reading
 * it off Onshape or assigning it through governance. Nothing is sent to
 * Onshape, and it refuses outright once a real revision is on record — this
 * is a one-time catch-up, not a way to override one.
 */
export async function setInitialRevision(
  enterpriseId: string,
  actor: { email: string },
  partId: string,
  opts: { revision: string; reason: string }
): Promise<{ revision: string }> {
  await connectDb();

  const revision = String(opts.revision ?? "").trim();
  const reason = String(opts.reason ?? "").trim();
  if (!revision) throw new Error("A revision is required.");
  if (!reason) {
    throw new Error(
      "A reason is required — why this is already released outside PLM's own workflow."
    );
  }

  const part: any = await Part.findOne({ _id: partId, enterpriseId });
  if (!part) throw new Error("Part not found.");
  if (part.revision) {
    throw new Error(
      `${part.number || part.name} already has a revision on record (${part.revision}) — this is ` +
      `only for catching up an object PLM has never tracked a release for. A star release is what ` +
      `an already-tracked revision needs.`
    );
  }

  part.revision = revision;
  part.lifecycleState = "Released";
  part.iteration = (part.iteration ?? 1) + 1;
  await part.save();

  await PartIteration.create({
    enterpriseId, partId: part._id, iteration: part.iteration, revision,
    lifecycleState: "Released", attributes: part.attributes ?? {}, onshapeVersionId: part.versionId ?? null,
    cause: "backfill", changedKeys: [], createdByEmail: actor.email, releaseId: null,
  }).catch(() => {});

  await ActivityLog.create({
    enterpriseId, partId: part._id, direction: "plm", action: "updated", trigger: "manual", ok: true,
    message:
      `${actor.email} recorded ${part.number || part.name} as already at revision ${revision}, ` +
      `released outside PLM's own workflow: ${reason}`,
  });

  return { revision };
}
