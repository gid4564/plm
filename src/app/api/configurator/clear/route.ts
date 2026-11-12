import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { ConfigurationError, clearConfigurator, clearPreview } from "@/lib/configurator";

/** What clearing the configurator would remove, for the confirmation. Admin only. */
export const GET = handler(async () => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can clear the configurator.", 403);
  return ok({ preview: await clearPreview(s.enterpriseId) });
});

/**
 * Clear the configurator before a demo: every model, its configurations and
 * the parts made for them go; CFG numbering starts again. Admin only.
 */
export const POST = handler(async () => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can clear the configurator.", 403);
  try {
    return ok({ result: await clearConfigurator(s.enterpriseId, s.email) });
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 409);
    throw err;
  }
});
