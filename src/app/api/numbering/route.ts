import { z } from "zod";
import { connectDb } from "@/lib/db";
import { NumberingSequence, NumberIssuedLog } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { NUMBERING_TYPES, formatNumber, getOrCreateSequence, type NumberingType } from "@/lib/numbering";
import { handler, ok, fail } from "@/lib/api";

/**
 * A standalone number-generator tool, unrelated to the manufacturing-order
 * system — see lib/numbering.ts. This route reports the current scheme for
 * each element type and lets an admin change it.
 */
export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();

  const sequences = await Promise.all(NUMBERING_TYPES.map((t) => getOrCreateSequence(s.enterpriseId, t)));
  const log = await NumberIssuedLog.find({ enterpriseId: s.enterpriseId })
    .sort({ createdAt: -1 })
    .limit(25)
    .lean();

  return ok({
    sequences: sequences.map((sq: any) => ({
      type: sq.type,
      prefix: sq.prefix,
      suffix: sq.suffix,
      padding: sq.padding,
      counter: sq.counter,
      next: formatNumber(sq.prefix, sq.counter + 1, sq.padding, sq.suffix),
    })),
    log: log.map((l: any) => ({
      id: String(l._id),
      type: l.type,
      number: l.number,
      source: l.source,
      issuedByEmail: l.issuedByEmail,
      documentId: l.documentId,
      elementId: l.elementId,
      partId: l.partId,
      createdAt: l.createdAt,
    })),
  });
});

const Body = z.object({
  type: z.enum(NUMBERING_TYPES as [NumberingType, ...NumberingType[]]),
  prefix: z.string().max(20).optional(),
  suffix: z.string().max(20).optional(),
  padding: z.number().int().min(0).max(10).optional(),
  /** Set the counter back to zero. A separate, explicit flag — not implied by any other change. */
  resetCounter: z.boolean().optional(),
});

/**
 * Change one type's prefix, suffix, padding, or reset its counter.
 *
 * Admin only: this changes what everyone using the tool sees next, the same
 * reasoning as every other enterprise-wide setting.
 */
export const PATCH = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change a numbering scheme", 403);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const b = parsed.data;

  await connectDb();
  await getOrCreateSequence(s.enterpriseId, b.type);

  const update: Record<string, unknown> = {};
  if (b.prefix !== undefined) update.prefix = b.prefix;
  if (b.suffix !== undefined) update.suffix = b.suffix;
  if (b.padding !== undefined) update.padding = b.padding;
  if (b.resetCounter) update.counter = 0;

  const seq: any = await NumberingSequence.findOneAndUpdate(
    { enterpriseId: s.enterpriseId, type: b.type },
    update,
    { new: true }
  );

  return ok({
    sequence: {
      type: seq.type, prefix: seq.prefix, suffix: seq.suffix, padding: seq.padding, counter: seq.counter,
      next: formatNumber(seq.prefix, seq.counter + 1, seq.padding, seq.suffix),
    },
  });
});
