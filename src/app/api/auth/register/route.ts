import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Enterprise, User } from "@/lib/models";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().optional().default(""),
  // The Onshape enterprise this login is bound to.
  onshapeCompanyId: z.string().min(1, "Onshape Enterprise ID is required"),
  enterpriseName: z.string().optional().default(""),
  onshapeDomain: z.string().optional().default(""),
});

export const POST = handler(async (req: Request) => {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const b = parsed.data;

  await connectDb();

  if (await User.findOne({ email: b.email.toLowerCase() })) {
    return fail("An account with that email already exists", 409);
  }

  // First user for an enterprise creates it and becomes its admin.
  let enterprise: any = await Enterprise.findOne({ onshapeCompanyId: b.onshapeCompanyId });
  let isFirstForEnterprise = false;
  if (!enterprise) {
    enterprise = await Enterprise.create({
      onshapeCompanyId: b.onshapeCompanyId,
      name: b.enterpriseName || `Enterprise ${b.onshapeCompanyId}`,
      onshapeDomain: b.onshapeDomain,
    });
    isFirstForEnterprise = true;
  }

  const user: any = await User.create({
    email: b.email.toLowerCase(),
    passwordHash: await hashPassword(b.password),
    name: b.name,
    role: isFirstForEnterprise ? "admin" : "user",
    enterpriseId: enterprise._id,
  });

  await createSession({
    userId: String(user._id),
    email: user.email,
    enterpriseId: String(enterprise._id),
    role: user.role,
  });

  return ok({ id: String(user._id), email: user.email, role: user.role, enterprise: enterprise.name }, 201);
});
