import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { ConfigurationError, previewModel } from "@/lib/configurator";

/** What a pasted link names — the assembly, its versions, its inputs — before it is added. */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can add a configurable model.", 403);
  const { url } = (await req.json().catch(() => ({}))) as { url?: string };
  if (!url) return fail("Paste the assembly's Onshape link.", 422);
  try {
    return ok({ preview: await previewModel(s.enterpriseId, url) });
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 422);
    throw err;
  }
});
