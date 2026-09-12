import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { connectDb } from "@/lib/db";
import { ActivityLog, User } from "@/lib/models";
import {
  countUnfiled, fileUnfiled, listProducts, resolveProduct,
} from "@/lib/products";
import { handler, ok, fail } from "@/lib/api";

/**
 * The products in this enterprise, with their counts.
 *
 * `unfiled` is reported separately from the "Unassigned" product because they
 * are different situations: an unassigned part was filed there, an unfiled one
 * predates the field and was never asked. The dashboard offers to file those
 * rather than folding them in silently.
 */
export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();

  const [products, unfiled, me] = await Promise.all([
    listProducts(s.enterpriseId),
    countUnfiled(s.enterpriseId),
    User.findById(s.userId).select("currentProductId").lean(),
  ]);

  return ok({
    products,
    unfiled,
    currentProductId: (me as any)?.currentProductId
      ? String((me as any).currentProductId)
      : null,
  });
});

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  code: z.string().max(32).optional(),
});

export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  const body = await req.json().catch(() => ({}));

  /* Filing the unfiled is a bulk action on this collection, so it lives here. */
  if (body?.action === "file-unfiled") {
    const result = await fileUnfiled(s.enterpriseId);
    return ok({
      ...result,
      message: result.filed
        ? `Filed ${result.filed} item(s) into Unassigned.`
        : "Nothing needed filing.",
    });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "A product needs a name.", 400);
  }

  const resolved = await resolveProduct(s.enterpriseId, parsed.data.name, {
    createdByUserId: s.userId,
  });
  if (!resolved) return fail("A product needs a name.", 400);

  /*
   * resolveProduct is find-or-create, so this reports which happened. Telling
   * somebody a product was created when they in fact re-typed an existing name
   * invites them to look for a duplicate that is not there.
   */
  const all = await listProducts(s.enterpriseId);
  const product = all.find((p) => p.id === resolved.productId)!;
  const isNew = product.total === 0 && !parsed.data.description && !parsed.data.code;

  if (parsed.data.description || parsed.data.code) {
    const { renameProduct } = await import("@/lib/products");
    await renameProduct(s.enterpriseId, resolved.productId, resolved.productName, {
      description: parsed.data.description,
      code: parsed.data.code,
    });
  }

  await connectDb();
  await ActivityLog.create({
    enterpriseId: s.enterpriseId,
    direction: "plm",
    action: "created",
    trigger: "product",
    ok: true,
    message: `${s.email} created product "${resolved.productName}".`,
  });

  return ok({
    product: (await listProducts(s.enterpriseId)).find((p) => p.id === resolved.productId),
    existed: !isNew,
    message: `Product "${resolved.productName}" is ready.`,
  });
});
