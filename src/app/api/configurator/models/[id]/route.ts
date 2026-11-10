import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { ConfigurationError, getModel, listItems, setModelEnabled } from "@/lib/configurator";

type Ctx = { params: Promise<{ id: string }> };

/** A model's inputs and its most recently asked-for configurations. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const model = await getModel(s.enterpriseId, id);
  if (!model) return fail("Model not found", 404);
  return ok({ model, items: await listItems(s.enterpriseId, id) });
});

/** Switch a model on or off for configuring. Admin only. */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change a configurable model.", 403);
  const { id } = await ctx.params;
  const { enabled } = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof enabled !== "boolean") return fail("Say whether the model is enabled.", 422);
  try {
    await setModelEnabled(s.enterpriseId, id, enabled);
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 404);
    throw err;
  }
  return ok({ enabled });
});
