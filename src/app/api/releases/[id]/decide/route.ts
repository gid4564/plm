import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Release } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { decideRelease } from "@/lib/release";
import { handler, ok, fail } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  intent: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
});

/**
 * Approve or reject a release.
 *
 * Restricted to an approver or an admin — PLM's own permission, separate from
 * Onshape's. The Onshape transition itself is performed by the enterprise's
 * service account, because Onshape restricts an approve transition to
 * designated approvers; the person recorded here is who actually decided.
 *
 * A rejection may carry a note and usually should: the designer reads it to
 * know what to change, and it is the only place that reason is recorded.
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  if (s.role !== "approver" && s.role !== "admin") {
    return fail(
      "Only an approver or an admin can decide a release. Ask an admin to give you the " +
      "approver role.",
      403
    );
  }

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const release: any = await Release.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!release) return fail("Release not found", 404);

  const result = await decideRelease(id, {
    intent: parsed.data.intent,
    userId: s.userId,
    email: s.email,
    note: parsed.data.note,
  });

  /*
   * A failed Onshape transition is reported as a success with a warning, not as
   * an error — because PLM's own decision *did* land, and telling the caller
   * their approval failed would be false. The retryable part is named
   * separately so the UI can offer exactly that.
   */
  return ok(result, result.ok ? 200 : 502);
});
