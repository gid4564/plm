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
 * Generate the next number for a type, from PLM's own UI.
 *
 * Onshape's own "Part number generator" app extension is what hands numbers to
 * a live part, assembly or drawing — see /api/numbering/onshape-extension.
 * This endpoint exists so a signed-in user can hand out a number without going
 * through Onshape at all: a purchased part that has no CAD model still needs
 * an identifier, and PLM is the number master for that too.
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
    source: "plm",
    issuedByEmail: s.email,
  });

  return ok({ number });
});
