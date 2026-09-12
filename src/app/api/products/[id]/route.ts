import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { connectDb } from "@/lib/db";
import { ActivityLog, User } from "@/lib/models";
import { assignParts, deleteProduct, renameProduct } from "@/lib/products";
import { handler, ok, fail } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  code: z.string().max(32).optional(),
});

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  /* Selecting a product is a write on the user, not the product — but this is
   * where the product is already addressed, so it is the natural place. */
  if (body?.action === "select") {
    await connectDb();
    await User.updateOne({ _id: s.userId }, { $set: { currentProductId: id } });
    return ok({ currentProductId: id });
  }

  /* Moving items in is likewise addressed by the destination product. */
  if (body?.action === "assign") {
    const ids: string[] = Array.isArray(body.partIds) ? body.partIds.map(String) : [];
    if (!ids.length) return fail("No items were selected.", 400);
    const result = await assignParts(s.enterpriseId, ids, id, {
      userId: s.userId,
      email: s.email,
    });
    return ok({
      ...result,
      message: result.moved
        ? `Moved ${result.moved} item(s) into "${result.productName}".`
        : `Those item(s) were already in "${result.productName}".`,
    });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success || !parsed.data.name) {
    return fail(parsed.success ? "A product needs a name." : parsed.error.issues[0].message, 400);
  }

  try {
    const product = await renameProduct(s.enterpriseId, id, parsed.data.name, {
      description: parsed.data.description,
      code: parsed.data.code,
    });
    if (!product) return fail("Product not found", 404);
    return ok({ product, message: `Saved "${product.name}".` });
  } catch (err: any) {
    return fail(String(err?.message ?? err), 400);
  }
});

/**
 * Delete a product. Its contents move to Unassigned rather than being deleted:
 * a product is a grouping, and removing a grouping says nothing about the parts
 * that were in it.
 */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can delete a product.", 403);
  const { id } = await ctx.params;

  const result = await deleteProduct(s.enterpriseId, id);
  if (!result.deleted) return fail(result.reason ?? "That product could not be deleted.", 400);

  await connectDb();
  await ActivityLog.create({
    enterpriseId: s.enterpriseId,
    direction: "plm",
    action: "deleted",
    trigger: "product",
    ok: true,
    message:
      `${s.email} deleted a product` +
      (result.moved ? `; ${result.moved} item(s) moved to "${result.movedTo}".` : "."),
  });

  return ok({
    ...result,
    message: result.moved
      ? `Product deleted. ${result.moved} item(s) moved to "${result.movedTo}".`
      : "Product deleted.",
  });
});
