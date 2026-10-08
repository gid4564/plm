import { requireSession } from "@/lib/auth/session";
import { queryApiUsage } from "@/lib/api-usage";
import { handler, ok, fail } from "@/lib/api";

/**
 * The data behind the API-usage page. All the work is in lib/api-usage.ts,
 * where it can be tested without a session; this is only the door.
 *
 * Admin only: it reveals what the integration is doing and which documents
 * are being touched.
 */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can see API usage.", 403);
  return ok(await queryApiUsage(s.enterpriseId, new URL(req.url).searchParams));
});
