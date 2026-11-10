import { requireSession } from "@/lib/auth/session";
import { handler, ok } from "@/lib/api";
import { ConfigurationError, requestConfiguration } from "@/lib/configurator";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Ask for a configuration. Returns at once: ready from the cache, or queued /
 * generating, in which case the page follows the item until it is done.
 * Anyone signed in may ask (design §11 — this is a demo).
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const { values, retry } = (await req.json().catch(() => ({}))) as { values?: Record<string, string>; retry?: boolean };
  try {
    const result = await requestConfiguration(s.enterpriseId, { userId: s.userId, email: s.email }, id, values ?? {}, {
      retry: Boolean(retry),
    });
    return ok(result, result.item?.state === "ready" ? 200 : 202);
  } catch (err: any) {
    if (err instanceof ConfigurationError) return ok({ error: err.message, fields: err.fields }, 422);
    throw err;
  }
});
