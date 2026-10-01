import { z } from "zod";
import { connectDb } from "@/lib/db";
import { CategoryNumberingSequence, NumberIssuedLog } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { NUMBERING_TYPES, formatNumber, type NumberingType } from "@/lib/numbering";
import { handler, ok, fail } from "@/lib/api";

/**
 * Numbering schemes scoped to a specific Onshape category, on top of the
 * plain per-type schemes at /api/numbering.
 *
 * A category is typed in rather than picked from a live list — see
 * CategoryNumberingSequence's own comment for why — so this also reports
 * recently seen categories: real `{id, name}` pairs Onshape has actually sent
 * on a numbering request, whether or not a scheme existed for them yet. An
 * admin copies one in rather than guessing at what Onshape calls it.
 */
export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();

  const schemes = await CategoryNumberingSequence.find({ enterpriseId: s.enterpriseId })
    .sort({ type: 1, onshapeCategoryName: 1 })
    .lean();

  const configured = new Set(schemes.map((sq: any) => `${sq.type}:${sq.onshapeCategoryId}`));

  /*
   * The most recent category Onshape sent per (type, category id) pair, from
   * up to the last 500 numbering events — recent enough to be useful, bounded
   * so a busy tenant's full history is never scanned for this.
   */
  const recent: any[] = await NumberIssuedLog.find({
    enterpriseId: s.enterpriseId,
    onshapeCategoryId: { $ne: "" },
  })
    .sort({ createdAt: -1 })
    .limit(500)
    .select("type onshapeCategoryId onshapeCategoryName createdAt")
    .lean();

  const seenByKey = new Map<string, { type: string; onshapeCategoryId: string; onshapeCategoryName: string; lastSeenAt: string }>();
  for (const r of recent) {
    const key = `${r.type}:${r.onshapeCategoryId}`;
    if (!seenByKey.has(key)) {
      seenByKey.set(key, {
        type: r.type,
        onshapeCategoryId: r.onshapeCategoryId,
        onshapeCategoryName: r.onshapeCategoryName,
        lastSeenAt: r.createdAt,
      });
    }
  }

  return ok({
    schemes: schemes.map((sq: any) => ({
      id: String(sq._id),
      type: sq.type,
      onshapeCategoryId: sq.onshapeCategoryId,
      onshapeCategoryName: sq.onshapeCategoryName,
      prefix: sq.prefix,
      suffix: sq.suffix,
      padding: sq.padding,
      counter: sq.counter,
      next: formatNumber(sq.prefix, sq.counter + 1, sq.padding, sq.suffix),
    })),
    // Only the ones with no scheme yet — already-configured categories have
    // nothing new to offer here.
    seen: [...seenByKey.values()]
      .filter((r) => !configured.has(`${r.type}:${r.onshapeCategoryId}`))
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1)),
  });
});

const TYPE = NUMBERING_TYPES as [NumberingType, ...NumberingType[]];

const CreateBody = z.object({
  type: z.enum(TYPE),
  onshapeCategoryId: z.string().trim().min(1).max(200),
  onshapeCategoryName: z.string().trim().max(200).optional(),
  prefix: z.string().max(20).optional(),
  suffix: z.string().max(20).optional(),
  padding: z.number().int().min(0).max(10).optional(),
});

/** Add a category-specific scheme. Admin only, same reasoning as the type-level ones. */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can add a category numbering scheme", 403);

  const parsed = CreateBody.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const b = parsed.data;

  await connectDb();
  try {
    const created = await CategoryNumberingSequence.create({
      enterpriseId: s.enterpriseId,
      type: b.type,
      onshapeCategoryId: b.onshapeCategoryId,
      onshapeCategoryName: b.onshapeCategoryName ?? "",
      ...(b.prefix !== undefined ? { prefix: b.prefix } : {}),
      ...(b.suffix !== undefined ? { suffix: b.suffix } : {}),
      ...(b.padding !== undefined ? { padding: b.padding } : {}),
    });
    return ok({
      scheme: {
        id: String(created._id), type: created.type,
        onshapeCategoryId: created.onshapeCategoryId, onshapeCategoryName: created.onshapeCategoryName,
        prefix: created.prefix, suffix: created.suffix, padding: created.padding, counter: created.counter,
        next: formatNumber(created.prefix, created.counter + 1, created.padding, created.suffix),
      },
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      return fail(
        `A ${b.type} scheme already exists for category "${b.onshapeCategoryId}". Edit that one ` +
        `instead of creating a second.`,
        409
      );
    }
    throw err;
  }
});

const PatchBody = z.object({
  id: z.string().min(1),
  onshapeCategoryName: z.string().trim().max(200).optional(),
  prefix: z.string().max(20).optional(),
  suffix: z.string().max(20).optional(),
  padding: z.number().int().min(0).max(10).optional(),
  resetCounter: z.boolean().optional(),
});

/** Change an existing category scheme's prefix, suffix, padding, name, or reset its counter. */
export const PATCH = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change a numbering scheme", 403);

  const parsed = PatchBody.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const b = parsed.data;

  await connectDb();

  const update: Record<string, unknown> = {};
  if (b.onshapeCategoryName !== undefined) update.onshapeCategoryName = b.onshapeCategoryName;
  if (b.prefix !== undefined) update.prefix = b.prefix;
  if (b.suffix !== undefined) update.suffix = b.suffix;
  if (b.padding !== undefined) update.padding = b.padding;
  if (b.resetCounter) update.counter = 0;

  const seq: any = await CategoryNumberingSequence.findOneAndUpdate(
    { _id: b.id, enterpriseId: s.enterpriseId },
    update,
    { new: true }
  );
  if (!seq) return fail("Category scheme not found", 404);

  return ok({
    scheme: {
      id: String(seq._id), type: seq.type,
      onshapeCategoryId: seq.onshapeCategoryId, onshapeCategoryName: seq.onshapeCategoryName,
      prefix: seq.prefix, suffix: seq.suffix, padding: seq.padding, counter: seq.counter,
      next: formatNumber(seq.prefix, seq.counter + 1, seq.padding, seq.suffix),
    },
  });
});

const DeleteBody = z.object({ id: z.string().min(1) });

/**
 * Remove a category scheme. Numbers already issued under it are untouched;
 * PLM parts already numbered keep their number, and the category simply
 * falls back to the type's plain scheme from here on.
 */
export const DELETE = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can remove a category numbering scheme", 403);

  const parsed = DeleteBody.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const removed = await CategoryNumberingSequence.findOneAndDelete({
    _id: parsed.data.id, enterpriseId: s.enterpriseId,
  });
  if (!removed) return fail("Category scheme not found", 404);

  return ok({ removed: true });
});
