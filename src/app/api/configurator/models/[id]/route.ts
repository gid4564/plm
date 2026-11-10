import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { ConfigurationError, getModel, listItems, setModelEnabled, setModelProduct } from "@/lib/configurator";

type Ctx = { params: Promise<{ id: string }> };

/** A model's inputs and its most recently asked-for configurations. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const model = await getModel(s.enterpriseId, id);
  if (!model) return fail("Model not found", 404);
  return ok({ model, items: await listItems(s.enterpriseId, id) });
});

/** Switch a model on or off for configuring, or choose its product. Admin only. */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change a configurable model.", 403);
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean; productId?: string };
  try {
    // The product its configurations file into; what the configurator already
    // made for the model moves with it.
    if (typeof body.productId === "string" && body.productId) {
      return ok(await setModelProduct(s.enterpriseId, id, body.productId, { userId: s.userId, email: s.email }));
    }
    if (typeof body.enabled !== "boolean") return fail("Say whether the model is enabled, or which product it files into.", 422);
    await setModelEnabled(s.enterpriseId, id, body.enabled);
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 404);
    throw err;
  }
  return ok({ enabled: body.enabled });
});
