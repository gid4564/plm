import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { connectDb } from "@/lib/db";
import { ActivityLog, BomLink, Part } from "@/lib/models";
import { handler, ok, fail } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A date, or null to clear it.
 *
 * An empty string means "clear", not "invalid": clearing one end of an
 * effectivity window is the ordinary way to say "and it still is", so a form
 * that submits a blank date field must be able to express that.
 */
const DateOrNull = z
  .union([z.string(), z.null()])
  .transform((v, ctx) => {
    if (v === null || v.trim() === "") return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: `"${v}" is not a date.` });
      return z.NEVER;
    }
    return d;
  });

const PatchSchema = z.object({
  effectiveFrom: DateOrNull.optional(),
  effectiveTo: DateOrNull.optional(),
  quantity: z.number().int().positive().max(100000).optional(),
});

/**
 * Change one component position in an assembly.
 *
 * Effectivity here is the edge's, not the part's — "this assembly uses this
 * component between these dates". That is what makes a substitution
 * expressible: the superseded component stays a perfectly current part
 * everywhere else, which retiring the part itself could not say.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const parsed = PatchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Bad request", 400);

  await connectDb();
  const link: any = await BomLink.findOne({ _id: id, enterpriseId: s.enterpriseId });
  if (!link) return fail("That structure link does not exist.", 404);

  const from = "effectiveFrom" in parsed.data ? parsed.data.effectiveFrom : link.effectiveFrom;
  const to = "effectiveTo" in parsed.data ? parsed.data.effectiveTo : link.effectiveTo;

  /*
   * A window has to be a window.
   *
   * Checked on the merged result, because either end can be changed alone:
   * moving "from" past an existing "to" is how this goes wrong in practice,
   * and the submitted patch on its own cannot see it. An inverted window would
   * make the component appear on no date at all, silently.
   */
  if (from && to && to.getTime() < from.getTime()) {
    return fail(
      `Effective to (${to.toISOString().slice(0, 10)}) is before effective from ` +
      `(${from.toISOString().slice(0, 10)}). The component would appear on no date at all.`,
      400
    );
  }

  const before = {
    from: link.effectiveFrom ? new Date(link.effectiveFrom).toISOString().slice(0, 10) : null,
    to: link.effectiveTo ? new Date(link.effectiveTo).toISOString().slice(0, 10) : null,
    quantity: link.quantity,
  };

  if ("effectiveFrom" in parsed.data) link.effectiveFrom = parsed.data.effectiveFrom ?? null;
  if ("effectiveTo" in parsed.data) link.effectiveTo = parsed.data.effectiveTo ?? null;
  if (parsed.data.quantity != null) link.quantity = parsed.data.quantity;
  await link.save();

  const [parent, child]: any[] = await Promise.all([
    Part.findById(link.parentId).select("number name").lean(),
    Part.findById(link.childId).select("number name").lean(),
  ]);

  const day = (d: unknown) => (d ? new Date(d as Date).toISOString().slice(0, 10) : null);
  const window = `${day(link.effectiveFrom) ?? "always"} → ${day(link.effectiveTo) ?? "current"}`;

  await ActivityLog.create({
    enterpriseId: s.enterpriseId,
    partId: link.parentId,
    direction: "plm",
    action: "updated",
    trigger: "bom",
    ok: true,
    message:
      `${s.email} set ${child?.number ?? child?.name ?? "a component"} in ` +
      `${parent?.number ?? parent?.name ?? "an assembly"} to ${window}` +
      (parsed.data.quantity != null && parsed.data.quantity !== before.quantity
        ? `, quantity ${before.quantity} → ${parsed.data.quantity}`
        : "") +
      ".",
  });

  return ok({
    link: {
      id: String(link._id),
      quantity: link.quantity,
      effectiveFrom: link.effectiveFrom ? new Date(link.effectiveFrom).toISOString() : null,
      effectiveTo: link.effectiveTo ? new Date(link.effectiveTo).toISOString() : null,
    },
    message: `Saved: ${child?.number ?? "component"} in ${parent?.number ?? "assembly"}, ${window}.`,
  });
});
