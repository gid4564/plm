import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { ConfigurationError, getItem, nameItem } from "@/lib/configurator";

type Ctx = { params: Promise<{ id: string }> };

/** One configured item — polled while it generates. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const item = await getItem(s.enterpriseId, id);
  return item ? ok({ item }) : fail("Configuration not found", 404);
});

/** Name a configuration. Anyone signed in, like generating one (a demo). */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const { name } = (await req.json().catch(() => ({}))) as { name?: unknown };
  if (typeof name !== "string") return fail("Give the configuration a name, or an empty one to clear it.", 422);
  try {
    return ok({ item: await nameItem(s.enterpriseId, id, name) });
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 404);
    throw err;
  }
});
