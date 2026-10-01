import { connectDb } from "@/lib/db";
import { BomLink, Variant } from "@/lib/models";

/**
 * Named variants of one assembly's BOM, and tagging BomLink edges against
 * them.
 *
 * See Variant's own comment in lib/models/index.ts for why this is scoped to
 * the assembly rather than the product, and why it is PLM's own concept with
 * nothing in Onshape to mirror it from.
 */

export type VariantDoc = {
  id: string;
  parentPartId: string;
  name: string;
  description: string;
  order: number;
};

function toDoc(v: any): VariantDoc {
  return {
    id: String(v._id),
    parentPartId: String(v.parentPartId),
    name: v.name,
    description: v.description ?? "",
    order: v.order ?? 0,
  };
}

/** Every variant defined for one assembly, in display order. */
export async function listVariants(enterpriseId: string, parentPartId: string): Promise<VariantDoc[]> {
  await connectDb();
  const rows = await Variant.find({ enterpriseId, parentPartId }).sort({ order: 1, name: 1 }).lean();
  return rows.map(toDoc);
}

/**
 * Every variant defined for any of the given assemblies, in one query.
 *
 * Used to answer "what variants exist anywhere in this product's BOM" — a
 * product can have more than one top-level assembly, and each is free to
 * define its own variants.
 */
export async function listVariantsFor(enterpriseId: string, parentPartIds: string[]): Promise<VariantDoc[]> {
  if (!parentPartIds.length) return [];
  await connectDb();
  const rows = await Variant.find({ enterpriseId, parentPartId: { $in: parentPartIds } })
    .sort({ order: 1, name: 1 })
    .lean();
  return rows.map(toDoc);
}

/**
 * Define a new variant of one assembly.
 *
 * Names are unique per assembly (the schema's own index enforces it) — two
 * variants called "Model A" under the same BOM would be indistinguishable in
 * every picker and tag editor that names them.
 */
export async function createVariant(
  enterpriseId: string, parentPartId: string, name: string, description = ""
): Promise<VariantDoc> {
  await connectDb();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A variant needs a name.");

  const count = await Variant.countDocuments({ enterpriseId, parentPartId });
  try {
    const created = await Variant.create({
      enterpriseId, parentPartId, name: trimmed, description: description.trim(), order: count,
    });
    return toDoc(created);
  } catch (err: any) {
    if (err?.code === 11000) {
      throw new Error(`This assembly already has a variant named "${trimmed}".`);
    }
    throw err;
  }
}

export async function updateVariant(
  enterpriseId: string, variantId: string, patch: { name?: string; description?: string; order?: number }
): Promise<VariantDoc> {
  await connectDb();
  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error("A variant needs a name.");
    update.name = trimmed;
  }
  if (patch.description !== undefined) update.description = patch.description.trim();
  if (patch.order !== undefined) update.order = patch.order;

  try {
    const updated = await Variant.findOneAndUpdate(
      { _id: variantId, enterpriseId }, update, { new: true }
    );
    if (!updated) throw new Error("Variant not found.");
    return toDoc(updated);
  } catch (err: any) {
    if (err?.code === 11000) {
      throw new Error(`This assembly already has a variant named "${patch.name}".`);
    }
    throw err;
  }
}

/**
 * Remove a variant, and untag every BomLink that named it.
 *
 * A BomLink left pointing at a deleted variant's id would be permanently
 * excluded from every view — nothing left to ever select that id again — so
 * this always cleans up, not only when a caller remembers to ask.
 */
export async function deleteVariant(enterpriseId: string, variantId: string): Promise<boolean> {
  await connectDb();
  const removed = await Variant.findOneAndDelete({ _id: variantId, enterpriseId });
  if (!removed) return false;
  await BomLink.updateMany({ enterpriseId, variantIds: variantId }, { $pull: { variantIds: variantId } });
  return true;
}

/**
 * Set which variants a specific BomLink belongs to.
 *
 * Every id must actually be a variant of THIS link's own parent — an id typed
 * or pasted wrong should not silently create a tag nothing can ever filter
 * by, and a variant of a different assembly entirely would be exactly that.
 */
export async function setLinkVariants(
  enterpriseId: string, linkId: string, variantIds: string[]
): Promise<{ parentPartId: string; variantIds: string[] }> {
  await connectDb();
  const link: any = await BomLink.findOne({ _id: linkId, enterpriseId });
  if (!link) throw new Error("That structure link does not exist.");

  const unique = [...new Set(variantIds)];
  if (unique.length) {
    const valid = await Variant.find({
      _id: { $in: unique }, enterpriseId, parentPartId: link.parentId,
    }).select("_id").lean();
    if (valid.length !== unique.length) {
      const validIds = new Set(valid.map((v: any) => String(v._id)));
      const bad = unique.filter((id) => !validIds.has(id));
      throw new Error(
        `${bad.length} of the given id(s) are not variants of this link's own assembly: ${bad.join(", ")}.`
      );
    }
  }

  link.variantIds = unique;
  link.markModified("variantIds");
  await link.save();
  return { parentPartId: String(link.parentId), variantIds: unique };
}
