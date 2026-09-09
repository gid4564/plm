import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Enterprise } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";

export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  return ok({
    name: ent.name,
    releaseSyncEnabled: Boolean(ent.releaseSyncEnabled),
    releasesIgnored: ent.releasesIgnored ?? 0,
    lastReleaseIgnoredAt: ent.lastReleaseIgnoredAt ?? null,
    facilities: ent.facilities ?? [],
  });
});

const Body = z.object({
  releaseSyncEnabled: z.boolean().optional(),
  /**
   * The whole list, replaced — not one entry appended. Simpler for a list
   * this short, and it is what lets removing an entry and renaming one be the
   * same operation as adding one, from the client's point of view.
   */
  facilities: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
});

/**
 * Change enterprise-wide behaviour.
 *
 * Admin only: this decides whether other people's releases create records for
 * everyone, which is not one user's call to make.
 */
export const PATCH = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change enterprise settings", 403);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId);
  if (!ent) return fail("Enterprise not found", 404);

  if (parsed.data.releaseSyncEnabled !== undefined) {
    ent.releaseSyncEnabled = parsed.data.releaseSyncEnabled;
    // Enabling starts a fresh count; the old one measured a different policy.
    if (parsed.data.releaseSyncEnabled) {
      ent.releasesIgnored = 0;
      ent.lastReleaseIgnoredAt = null;
    }
  }

  if (parsed.data.facilities !== undefined) {
    // De-duplicated case-insensitively — "In-house" and "in-house" typed a
    // year apart should not both show up as separate options on every item.
    const seen = new Set<string>();
    ent.facilities = parsed.data.facilities.filter((f) => {
      const key = f.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  await ent.save();

  return ok({ releaseSyncEnabled: ent.releaseSyncEnabled, facilities: ent.facilities });
});
