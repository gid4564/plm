import { Types } from "mongoose";
import { connectDb } from "@/lib/db";
import { BomLink, Part } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { decodeCursor, encodeCursor } from "@/lib/pagination";
import { plainAttributes } from "@/lib/sync";

/**
 * Page size for the parts list.
 *
 * A large assembly import can bring in a hundred parts at once, so the list is
 * exactly the thing that grows without anyone deciding it should. Loaded a page
 * at a time, capped so a caller cannot ask for the whole enterprise in one go.
 */
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** List parts and assemblies for the caller's enterprise, one page at a time. */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  await connectDb();

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const state = url.searchParams.get("state")?.trim();
  const kind = url.searchParams.get("kind")?.trim();
  const owner = url.searchParams.get("owner")?.trim();
  const releaseId = url.searchParams.get("release")?.trim();
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("limit")) || PAGE_SIZE));
  const cursor = decodeCursor(url.searchParams.get("cursor"));

  if (url.searchParams.get("cursor") && !cursor) {
    return fail("That page marker is not valid — start again from the first page.", 422);
  }

  const filter: Record<string, unknown> = { enterpriseId: s.enterpriseId };
  if (state && state !== "all") filter.lifecycleState = state;
  if (kind && kind !== "all") filter.kind = kind;
  if (releaseId && releaseId !== "all") filter.releaseId = releaseId;

  // "mine" is who brought the part in, not who last edited it.
  if (owner === "mine") filter.createdByUserId = s.userId;
  else if (owner === "auto") filter.createdByUserId = null;

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { number: rx }, { name: rx }, { revision: rx },
      { documentName: rx }, { elementName: rx },
    ];
  }

  // Total against the filter, not the page — this is what lets the header say
  // "50 of 340" rather than just how many happen to be on screen.
  const total = await Part.countDocuments(filter);

  // The cursor names the exact row the previous page ended on, so that row and
  // everything before it in sort order is excluded. A Mongo $or over the
  // filter's own $or requires wrapping both in $and, or one silently replaces
  // the other.
  const pageFilter = cursor
    ? {
        $and: [
          filter,
          {
            $or: [
              { updatedAt: { $lt: new Date(cursor.updatedAtMs) } },
              { updatedAt: new Date(cursor.updatedAtMs), _id: { $lt: new Types.ObjectId(cursor.id) } },
            ],
          },
        ],
      }
    : filter;

  const parts = await Part.find(pageFilter)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit)
    .lean();

  const last = parts[parts.length - 1];
  const nextCursor =
    parts.length === limit && last
      ? encodeCursor({ updatedAtMs: new Date(last.updatedAt).getTime(), id: String(last._id) })
      : null;

  /*
   * Structure counts for this page only.
   *
   * Two grouped queries over the page's ids, rather than a lookup per row: a
   * fifty-row page would otherwise cost a hundred queries. Counted rather than
   * fetched because the list only shows whether a part has children or parents,
   * not what they are.
   */
  const ids = parts.map((p: any) => p._id);
  const [childCounts, parentCounts] = await Promise.all([
    BomLink.aggregate([
      { $match: { parentId: { $in: ids } } },
      { $group: { _id: "$parentId", n: { $sum: 1 } } },
    ]),
    BomLink.aggregate([
      { $match: { childId: { $in: ids } } },
      { $group: { _id: "$childId", n: { $sum: 1 } } },
    ]),
  ]);
  const childrenBy = new Map(childCounts.map((r: any) => [String(r._id), r.n]));
  const parentsBy = new Map(parentCounts.map((r: any) => [String(r._id), r.n]));

  // Lifecycle facet, computed over the whole enterprise rather than the current
  // filter, so choosing a state does not immediately remove every other option.
  const states = await Part.aggregate([
    { $match: { enterpriseId: new Types.ObjectId(s.enterpriseId) } },
    { $group: { _id: "$lifecycleState", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  return ok({
    total,
    nextCursor,
    states: states.map((r: any) => ({ state: String(r._id ?? ""), count: r.count })),
    parts: parts.map((p: any) => {
      const attrs = plainAttributes(p.attributes);
      return {
        id: String(p._id),
        number: p.number,
        name: p.name,
        kind: p.kind,
        revision: p.revision || "",
        iteration: p.iteration ?? 1,
        lifecycleState: p.lifecycleState,
        onshapeState: p.onshapeState || "",
        // The two attributes a list is worth showing without opening a part.
        material: attrs.material ?? "",
        classification: attrs.classification ?? "",
        documentName: p.documentName,
        elementName: p.elementName,
        createdByEmail: p.createdByEmail ?? null,
        releaseId: p.releaseId ? String(p.releaseId) : null,
        childCount: childrenBy.get(String(p._id)) ?? 0,
        usedInCount: parentsBy.get(String(p._id)) ?? 0,
        pushPending: p.pushPending,
        writeBackBlocked: p.writeBackBlocked ?? null,
        lastPushError: p.lastPushError,
        lastSyncedFromOnshapeAt: p.lastSyncedFromOnshapeAt,
        lastPushedToOnshapeAt: p.lastPushedToOnshapeAt,
        updatedAt: p.updatedAt,
      };
    }),
  });
});
