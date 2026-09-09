import { connectDb } from "@/lib/db";
import { Enterprise, User } from "@/lib/models";
import { getSession } from "@/lib/auth/session";
import { handler, ok } from "@/lib/api";

export const GET = handler(async () => {
  const s = await getSession();
  if (!s) return ok({ user: null });

  await connectDb();
  const user: any = await User.findById(s.userId).lean();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!user) return ok({ user: null });

  return ok({
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      role: user.role,
      onshapeConnected: Boolean(user.onshapeAccessToken) || Boolean(user.onshapeConnectedAt),
    },
    enterprise: ent && {
      id: String(ent._id),
      name: ent.name,
      onshapeCompanyId: ent.onshapeCompanyId,
      statuses: ent.statuses,
    },
  });
});
