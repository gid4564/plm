import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { ConfigurationError, listModels, registerModel } from "@/lib/configurator";

/** Every configurable model. Anyone signed in may configure (design §11). */
export const GET = handler(async () => {
  const s = await requireSession();
  return ok({ models: await listModels(s.enterpriseId) });
});

/** Make an assembly configurable. Admin only: it decides what everyone can configure. */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can add a configurable model.", 403);
  const b = (await req.json().catch(() => ({}))) as { url?: string; versionId?: string; name?: string };
  if (!b.url) return fail("Paste the assembly's Onshape link.", 422);
  try {
    return ok(await registerModel(s.enterpriseId, { userId: s.userId, email: s.email }, {
      url: b.url, versionId: b.versionId || null, name: b.name,
    }), 201);
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 422);
    throw err;
  }
});
