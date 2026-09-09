import { connectDb } from "@/lib/db";
import { Enterprise } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { seedMockOnshape } from "@/lib/mock-seed";
import { isMock } from "@/lib/onshape/oauth";
import { handler, ok, fail } from "@/lib/api";

export const POST = handler(async () => {
  const s = await requireSession();
  if (!isMock()) return fail("The simulator is only available when ONSHAPE_MODE=mock", 400);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  return ok(await seedMockOnshape(ent.onshapeCompanyId));
});
