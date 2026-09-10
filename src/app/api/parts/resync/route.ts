import { connectDb } from "@/lib/db";
import { Part } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { syncPartFromOnshape } from "@/lib/sync";
import { handler, ok } from "@/lib/api";

/**
 * Batch size per call. Each part costs an Onshape round trip, so a whole
 * catalogue in one request would sit past most reverse-proxy timeouts. The
 * caller repeats until `remaining` reaches zero.
 */
const BATCH = 25;

/**
 * Re-pull a batch of parts from Onshape.
 *
 * Exists because mirrored values change meaning when the mapping improves — a
 * newly mapped attribute, or a corrected enum label, leaves previously synced
 * rows holding the old reading until something re-reads them. Waiting for a
 * designer to touch every part is not a plan.
 *
 * Oldest-synced first, so repeated calls sweep the whole set without repeating
 * work.
 */
export const POST = handler(async () => {
  const s = await requireSession();
  await connectDb();

  const total = await Part.countDocuments({ enterpriseId: s.enterpriseId });
  const batch: any[] = await Part.find({ enterpriseId: s.enterpriseId })
    .sort({ lastSyncedFromOnshapeAt: 1 })
    .limit(BATCH)
    .lean();

  const { client } = await clientForEnterprise(s.enterpriseId);

  let updated = 0;
  let unchanged = 0;
  const failures: { number: string | null; error: string }[] = [];

  for (const part of batch) {
    try {
      const r = await syncPartFromOnshape(
        s.enterpriseId,
        {
          documentId: part.documentId, elementId: part.elementId, partId: part.partId,
          configuration: part.configuration, workspaceId: part.workspaceId, versionId: part.versionId,
        },
        { trigger: "bulk-resync", client, kind: part.kind }
      );
      if (r.action === "unchanged") unchanged++;
      else updated++;
    } catch (err: any) {
      // One unreachable part must not abandon the rest of the batch.
      failures.push({ number: part.number ?? null, error: String(err?.message ?? err) });
    }
  }

  const stillStale = await Part.countDocuments({
    enterpriseId: s.enterpriseId,
    $or: [
      { lastSyncedFromOnshapeAt: null },
      { lastSyncedFromOnshapeAt: { $lt: new Date(Date.now() - 60_000) } },
    ],
  });

  return ok({ total, processed: batch.length, updated, unchanged, failures, remaining: stillStale });
});
