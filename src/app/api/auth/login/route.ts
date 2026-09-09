import { z } from "zod";
import { connectDb } from "@/lib/db";
import { User } from "@/lib/models";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export const POST = handler(async (req: Request) => {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail("Email and password are required", 422);

  await connectDb();
  const user: any = await User.findOne({ email: parsed.data.email.toLowerCase() });

  // Same message either way — don't leak which emails exist.
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return fail("Invalid email or password", 401);
  }

  await createSession({
    userId: String(user._id),
    email: user.email,
    enterpriseId: String(user.enterpriseId),
    role: user.role,
  });

  return ok({ id: String(user._id), email: user.email, role: user.role });
});
