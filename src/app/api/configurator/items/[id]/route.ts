import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { getItem } from "@/lib/configurator";

type Ctx = { params: Promise<{ id: string }> };

/** One configured item — polled while it generates. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const item = await getItem(s.enterpriseId, id);
  return item ? ok({ item }) : fail("Configuration not found", 404);
});
