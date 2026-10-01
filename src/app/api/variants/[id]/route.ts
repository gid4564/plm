import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { deleteVariant, updateVariant } from "@/lib/variants";
import { handler, ok, fail } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

const PatchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  order: z.number().int().optional(),
});

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Bad request", 422);

  try {
    const variant = await updateVariant(s.enterpriseId, id, parsed.data);
    return ok({ variant });
  } catch (err: any) {
    return fail(String(err?.message ?? err), 409);
  }
});

/**
 * Remove a variant. Every BomLink tagged with it is untagged, not deleted —
 * a component only stops being narrowed to this variant; it does not leave
 * the BOM.
 */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const removed = await deleteVariant(s.enterpriseId, id);
  if (!removed) return fail("Variant not found.", 404);
  return ok({ removed: true });
});
