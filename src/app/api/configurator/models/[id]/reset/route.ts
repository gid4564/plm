import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { ConfigurationError, resetPreview, resetModel } from "@/lib/configurator";

type Ctx = { params: Promise<{ id: string }> };

/** What a reset would remove, for the confirmation. Admin only. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can reset a configurable model.", 403);
  const { id } = await ctx.params;
  const preview = await resetPreview(s.enterpriseId, id);
  if (!preview) return fail("Model not found", 404);
  return ok({ preview });
});

/**
 * Remove every configuration of a model and what the configurator made for
 * them — for starting a demo again. Admin only.
 */
export const POST = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can reset a configurable model.", 403);
  const { id } = await ctx.params;
  try {
    return ok({ result: await resetModel(s.enterpriseId, id, s.email) });
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 409);
    throw err;
  }
});
