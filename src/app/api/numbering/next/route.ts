import { z } from "zod";
import { connectDb } from "@/lib/db";
import { NumberIssuedLog } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { nextNumber, NUMBERING_TYPES, type NumberingType } from "@/lib/numbering";
import { handler, ok, fail } from "@/lib/api";

const Body = z.object({
  type: z.enum(NUMBERING_TYPES as [NumberingType, ...NumberingType[]]),
});

/**
 * Generate the next number for a type, from the MOS's own UI.
 *
 * Onshape's own "Part number generator" app extension is what actually hands
 * numbers to a live part, assembly or drawing — see /api/numbering/onshape-
 * extension. This endpoint exists only so a signed-in user can preview or
 * hand out a number without going through Onshape at all.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const { type } = parsed.data;

  await connectDb();
  const { number } = await nextNumber(s.enterpriseId, type);

  await NumberIssuedLog.create({
    enterpriseId: s.enterpriseId,
    type,
    number,
    source: "manual",
    issuedByEmail: s.email,
  });

  return ok({ number });
});
