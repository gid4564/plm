import { Types } from "mongoose";
import { connectDb } from "@/lib/db";
import { ManufacturingItem } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { decodeCursor, encodeCursor } from "@/lib/pagination";

/**
 * Page size for the dashboard list.
 *
 * A large assembly import can bring in a hundred items at once, and this is a
 * demo system many people share, so the list is exactly the thing that grows
 * without anyone deciding it should. Loaded a page at a time rather than all
 * at once, capped so a caller cannot ask for the whole enterprise in one go.
 */
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** List manufacturing items for the caller's enterprise, one page at a time. */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  await connectDb();

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const status = url.searchParams.get("status")?.trim();
  const owner = url.searchParams.get("owner")?.trim();
  const assembly = url.searchParams.get("assembly")?.trim();
  const product = url.searchParams.get("product")?.trim();
  const manufacturedBy = url.searchParams.get("manufacturedBy")?.trim();
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(url.searchParams.get("limit")) || PAGE_SIZE));
  const cursor = decodeCursor(url.searchParams.get("cursor"));

  if (url.searchParams.get("cursor") && !cursor) {
    return fail("That page marker is not valid — start again from the first page.", 422);
  }

  const filter: Record<string, unknown> = { enterpriseId: s.enterpriseId };
  if (status && status !== "all") filter.status = status;

  // "mine" is who enrolled the part, not who last edited it.
  if (owner === "mine") {
    filter.createdByUserId = s.userId;
  } else if (owner === "auto") {
    // Enrolled without a person: a release, or an item predating attribution.
    filter.createdByUserId = null;
  }
  // Everything exploded out of one assembly: the work package for that build.
  if (assembly && assembly !== "all") filter["sourceAssembly.elementId"] = assembly;

  // Mongoose casts this against productId's ObjectId type for a plain find(),
  // unlike the aggregate below which needs it cast by hand.
  if (product && product !== "all") filter.productId = product;
  if (manufacturedBy && manufacturedBy !== "all") filter.manufacturedBy = manufacturedBy;

  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { moNumber: rx }, { partName: rx }, { partNumber: rx },
      { documentName: rx }, { project: rx }, { remarks: rx },
    ];
  }

  // Total against the filter, not the page — this is what lets the header say
  // "50 of 340" rather than just how many happen to be on screen.
  const total = await ManufacturingItem.countDocuments(filter);

  // The cursor names the exact row the previous page ended on, so this row and
  // everything before it in sort order is excluded — a Mongo $or over the
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

  const items = await ManufacturingItem.find(pageFilter)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit)
    .lean();

  const last = items[items.length - 1];
  const nextCursor =
    items.length === limit && last
      ? encodeCursor({ updatedAtMs: new Date(last.updatedAt).getTime(), id: String(last._id) })
      : null;

  // Assemblies people have actually imported, for the filter. Computed over the
  // whole enterprise rather than the current filter, so choosing one does not
  // immediately remove every other option from the list.
  //
  // aggregate() bypasses Mongoose's casting, so the id has to be a real
  // ObjectId — a string here matches nothing and the filter silently empties.
  const assemblies = await ManufacturingItem.aggregate([
    {
      $match: {
        enterpriseId: new Types.ObjectId(s.enterpriseId),
        "sourceAssembly.elementId": { $nin: [null, ""] },
      },
    },
    {
      $group: {
        _id: "$sourceAssembly.elementId",
        name: { $first: "$sourceAssembly.elementName" },
        documentName: { $first: "$sourceAssembly.documentName" },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ]);

  // Products people have actually used, for the filter. Same reasoning as the
  // assembly facet above: computed over the whole enterprise, not the current
  // filter, so picking one does not remove every other option from the list.
  const products = await ManufacturingItem.aggregate([
    {
      $match: {
        enterpriseId: new Types.ObjectId(s.enterpriseId),
        productId: { $ne: null },
      },
    },
    {
      $group: {
        _id: "$productId",
        name: { $first: "$productName" },
        count: { $sum: 1 },
      },
    },
    { $sort: { name: 1 } },
    { $limit: 100 },
  ]);

  return ok({
    total,
    nextCursor,
    assemblies: assemblies.map((a: any) => ({
      elementId: String(a._id),
      name: a.name || "Assembly",
      documentName: a.documentName || "",
      count: a.count,
    })),
    products: products.map((p: any) => ({
      id: String(p._id),
      name: p.name || "Product",
      count: p.count,
    })),
    items: items.map((i: any) => ({
      id: String(i._id),
      moNumber: i.moNumber,
      partName: i.partName,
      partNumber: i.partNumber,
      revision: i.revision,
      status: i.status,
      remarks: i.remarks,
      quantity: i.quantity,
      material: i.material,
      project: i.project,
      documentName: i.documentName,
      elementName: i.elementName,
      createdByEmail: i.createdByEmail ?? null,
      productId: i.productId ? String(i.productId) : null,
      productName: i.productName || "",
      manufacturedBy: i.manufacturedBy || "",
      sourceAssembly: i.sourceAssembly
        ? {
            elementId: i.sourceAssembly.elementId,
            name: i.sourceAssembly.elementName || "",
            documentName: i.sourceAssembly.documentName || "",
            quantityInAssembly: i.sourceAssembly.quantityInAssembly ?? null,
          }
        : null,
      usedInCount: (i.usedIn ?? []).length,
      pushPending: i.pushPending,
      writeBackBlocked: i.writeBackBlocked ?? null,
      lastPushError: i.lastPushError,
      lastSyncedFromOnshapeAt: i.lastSyncedFromOnshapeAt,
      lastPushedToOnshapeAt: i.lastPushedToOnshapeAt,
      updatedAt: i.updatedAt,
    })),
  });
});
