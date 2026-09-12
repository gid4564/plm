import { Types } from "mongoose";
import { connectDb } from "@/lib/db";
import { ActivityLog, Part, Product } from "@/lib/models";

/**
 * Products: what a part is part of.
 *
 * PLM's own grouping, not Onshape's. Onshape organises by document, which is a
 * container for CAD rather than a statement about what is being built, and a
 * part can move between products without its CAD moving anywhere.
 *
 * Every part belongs to exactly one product. Rather than allow "no product"
 * and special-case it at every filter, count and picker, "Unassigned" is an
 * ordinary product created on demand — so the invariant holds everywhere
 * without a null branch anywhere.
 */

/** Collapse incidental whitespace, so a stray double space cannot fork a product. */
const normalizeName = (s: string) => String(s ?? "").trim().replace(/\s+/g, " ");

/** The case- and whitespace-insensitive key products are matched by. */
export function productNameKey(name: string): string {
  return normalizeName(name).toLowerCase();
}

/**
 * The product a part lands in when nobody has said otherwise.
 *
 * Automatic paths — a release takeover, a webhook — have nobody to ask, and a
 * part quietly belonging to whichever product the integration account happened
 * to have selected would be worse than one visibly belonging to none.
 */
export const UNASSIGNED_PRODUCT = "Unassigned";

export type ResolvedProduct = { productId: string; productName: string };

/**
 * Find or create a product by name, ignoring case and incidental whitespace.
 *
 * Returns null only for a blank name — there is nothing to resolve.
 */
export async function resolveProduct(
  enterpriseId: string,
  rawName: string,
  opts: { createdByUserId?: string | null } = {}
): Promise<ResolvedProduct | null> {
  const name = normalizeName(rawName);
  if (!name) return null;

  await connectDb();
  const nameLower = productNameKey(name);

  const existing: any = await Product.findOne({ enterpriseId, nameLower }).lean();
  if (existing) return { productId: String(existing._id), productName: existing.name };

  try {
    const created: any = await Product.create({
      enterpriseId,
      name,
      nameLower,
      createdByUserId: opts.createdByUserId ?? null,
    });
    return { productId: String(created._id), productName: created.name };
  } catch (err: any) {
    /*
     * Two syncs racing to create the same product. The loser adopts the
     * winner's row rather than failing a sync over a duplicate key — the
     * result is the same either way, and one of them is somebody's page load.
     */
    if (err?.code === 11000) {
      const winner: any = await Product.findOne({ enterpriseId, nameLower }).lean();
      if (winner) return { productId: String(winner._id), productName: winner.name };
    }
    throw err;
  }
}

/**
 * A product by id, for a caller that already has one to hand.
 *
 * Returns null for an id that does not belong to this enterprise, which is the
 * point: a product id arriving from a request is not to be trusted, and the
 * caller falls back to Unassigned rather than filing a part into another
 * tenant's product.
 */
export async function resolveProductById(
  enterpriseId: string,
  productId: string
): Promise<ResolvedProduct | null> {
  await connectDb();
  const row: any = await Product.findOne({ _id: productId, enterpriseId }).lean().catch(() => null);
  return row ? { productId: String(row._id), productName: row.name } : null;
}

/** The always-available fallback. Never null — its name is never blank. */
export async function resolveUnassignedProduct(enterpriseId: string): Promise<ResolvedProduct> {
  return (await resolveProduct(enterpriseId, UNASSIGNED_PRODUCT))!;
}

/**
 * The product this person is working in, for filing a part they just brought in.
 *
 * Falls back to Unassigned rather than guessing: somebody who has never chosen
 * a product has not implicitly chosen the first one alphabetically. Returns the
 * product's name too, because the caller stores both.
 */
export async function currentProductFor(userId: string): Promise<ResolvedProduct | null> {
  await connectDb();
  const { User } = await import("@/lib/models");
  const user: any = await User.findById(userId).select("enterpriseId currentProductId").lean();
  if (!user?.currentProductId) return null;
  return resolveProductById(String(user.enterpriseId), String(user.currentProductId));
}

export type ProductSummary = {
  id: string;
  name: string;
  code: string;
  description: string;
  /** Parts and assemblies in this product. */
  parts: number;
  assemblies: number;
  total: number;
  /** How many are released, so a product's maturity reads at a glance. */
  released: number;
  inWork: number;
  underReview: number;
  isUnassigned: boolean;
};

/**
 * Every product, with its counts.
 *
 * One aggregation over parts rather than a query per product: a sidebar
 * listing twenty products would otherwise be twenty round trips on every
 * dashboard load. Products with nothing in them still appear — a product
 * someone just created is exactly when they need to see it.
 */
export async function listProducts(enterpriseId: string): Promise<ProductSummary[]> {
  await connectDb();

  const [rows, counts] = await Promise.all([
    Product.find({ enterpriseId }).sort({ name: 1 }).lean(),
    Part.aggregate([
      /*
       * An aggregation `$match` gets no schema casting, unlike a `find()` — a
       * plain string here matches nothing at all and every count comes back
       * zero, silently.
       */
      { $match: { enterpriseId: new Types.ObjectId(enterpriseId) } },
      {
        $group: {
          _id: "$productId",
          parts: { $sum: { $cond: [{ $eq: ["$kind", "assembly"] }, 0, 1] } },
          assemblies: { $sum: { $cond: [{ $eq: ["$kind", "assembly"] }, 1, 0] } },
          released: { $sum: { $cond: [{ $eq: ["$lifecycleState", "Released"] }, 1, 0] } },
          inWork: { $sum: { $cond: [{ $eq: ["$lifecycleState", "In Work"] }, 1, 0] } },
          underReview: { $sum: { $cond: [{ $eq: ["$lifecycleState", "Under Review"] }, 1, 0] } },
          total: { $sum: 1 },
        },
      },
    ]),
  ]);

  const byId = new Map(counts.map((c: any) => [String(c._id), c]));

  return rows.map((p: any) => {
    const c = byId.get(String(p._id));
    return {
      id: String(p._id),
      name: p.name,
      code: p.code ?? "",
      description: p.description ?? "",
      parts: c?.parts ?? 0,
      assemblies: c?.assemblies ?? 0,
      total: c?.total ?? 0,
      released: c?.released ?? 0,
      inWork: c?.inWork ?? 0,
      underReview: c?.underReview ?? 0,
      isUnassigned: productNameKey(p.name) === productNameKey(UNASSIGNED_PRODUCT),
    };
  });
}

/**
 * Parts that predate the product field, or that arrived before one existed.
 *
 * Counted separately from the "Unassigned" product because they are a different
 * thing: an unassigned part was filed there, a null one was never asked. The
 * dashboard can then offer to file them rather than silently folding them in.
 */
export async function countUnfiled(enterpriseId: string): Promise<number> {
  await connectDb();
  return Part.countDocuments({ enterpriseId, $or: [{ productId: null }, { productId: { $exists: false } }] });
}

/** File every part with no product into "Unassigned". */
export async function fileUnfiled(enterpriseId: string): Promise<{ filed: number; productId: string }> {
  await connectDb();
  const unassigned = await resolveUnassignedProduct(enterpriseId);
  const res = await Part.updateMany(
    { enterpriseId, $or: [{ productId: null }, { productId: { $exists: false } }] },
    { $set: { productId: unassigned.productId, productName: unassigned.productName } }
  );
  return { filed: res.modifiedCount ?? 0, productId: unassigned.productId };
}

/**
 * Move parts into a product.
 *
 * Writes the denormalised name alongside the id, because every list and count
 * reads that rather than joining. Returns how many moved, which is not always
 * how many were asked for — a part already in the product is not modified.
 */
export async function assignParts(
  enterpriseId: string,
  partIds: string[],
  productId: string,
  actor: { userId?: string; email?: string } = {}
): Promise<{ moved: number; productName: string }> {
  await connectDb();

  const product: any = await Product.findOne({ _id: productId, enterpriseId }).lean();
  if (!product) throw new Error("That product does not exist.");

  /*
   * Only the parts that are actually somewhere else.
   *
   * `modifiedCount` cannot answer "how many moved" here: the schema has
   * timestamps, so Mongoose adds `updatedAt` to every `$set` and every matched
   * row counts as modified whether or not its product changed. That made the
   * reported count wrong — and worse, it bumped `updatedAt` on parts that did
   * not move, which reorders the dashboard, since the list is sorted by it.
   *
   * Selecting first costs one extra query and makes both problems go away.
   */
  const needMoving = await Part.find({
    enterpriseId,
    _id: { $in: partIds },
    $or: [
      { productId: { $ne: product._id } },
      { productName: { $ne: product.name } },
    ],
  })
    .select("_id")
    .lean();

  if (!needMoving.length) return { moved: 0, productName: product.name };

  await Part.updateMany(
    { enterpriseId, _id: { $in: needMoving.map((x: any) => x._id) } },
    { $set: { productId: product._id, productName: product.name } }
  );

  const moved = needMoving.length;
  if (moved) {
    await ActivityLog.create({
      enterpriseId,
      direction: "plm",
      action: "updated",
      trigger: "product",
      ok: true,
      message:
        `${actor.email || "Someone"} moved ${moved} item(s) into product "${product.name}".`,
    });
  }

  return { moved, productName: product.name };
}

/**
 * Rename a product, carrying the denormalised copies with it.
 *
 * The rewrite is the price of denormalising the name onto every part. Done
 * here rather than left to a background job because a rename that leaves the
 * old name showing on a thousand rows looks like data loss.
 */
export async function renameProduct(
  enterpriseId: string,
  productId: string,
  rawName: string,
  patch: { description?: string; code?: string } = {}
): Promise<ProductSummary | null> {
  await connectDb();

  const name = normalizeName(rawName);
  if (!name) throw new Error("A product needs a name.");

  const product: any = await Product.findOne({ _id: productId, enterpriseId });
  if (!product) return null;

  const nameLower = productNameKey(name);
  if (nameLower !== product.nameLower) {
    const clash: any = await Product.findOne({ enterpriseId, nameLower }).lean();
    if (clash && String(clash._id) !== String(product._id)) {
      throw new Error(`Another product is already called "${clash.name}".`);
    }
  }

  product.name = name;
  product.nameLower = nameLower;
  if (patch.description !== undefined) product.description = patch.description;
  if (patch.code !== undefined) product.code = patch.code;
  await product.save();

  await Part.updateMany({ enterpriseId, productId: product._id }, { $set: { productName: name } });

  const all = await listProducts(enterpriseId);
  return all.find((p) => p.id === String(product._id)) ?? null;
}

/**
 * Delete a product, moving anything in it to "Unassigned".
 *
 * Its contents are never deleted with it. A product is a grouping, and
 * removing a grouping is not a statement about the parts that were in it —
 * quietly destroying released parts because somebody tidied up a product list
 * would be unrecoverable.
 */
export async function deleteProduct(
  enterpriseId: string,
  productId: string
): Promise<{ deleted: boolean; moved: number; movedTo: string | null; reason?: string }> {
  await connectDb();

  const product: any = await Product.findOne({ _id: productId, enterpriseId }).lean();
  if (!product) return { deleted: false, moved: 0, movedTo: null, reason: "No such product." };

  if (productNameKey(product.name) === productNameKey(UNASSIGNED_PRODUCT)) {
    return {
      deleted: false,
      moved: 0,
      movedTo: null,
      reason:
        `"${UNASSIGNED_PRODUCT}" cannot be deleted — it is where parts go when nothing else ` +
        `has claimed them, and something has to be.`,
    };
  }

  const held = await Part.countDocuments({ enterpriseId, productId: product._id });
  let moved = 0;
  let movedTo: string | null = null;

  if (held) {
    const unassigned = await resolveUnassignedProduct(enterpriseId);
    const res = await Part.updateMany(
      { enterpriseId, productId: product._id },
      { $set: { productId: unassigned.productId, productName: unassigned.productName } }
    );
    moved = res.modifiedCount ?? 0;
    movedTo = unassigned.productName;
  }

  await Product.deleteOne({ _id: product._id, enterpriseId });
  return { deleted: true, moved, movedTo };
}

