import { connectDb } from "@/lib/db";
import { ManufacturingItem } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { syncPartFromOnshape } from "@/lib/sync";
import { handler, ok } from "@/lib/api";

/**
 * Batch size per call. Each item costs an Onshape round trip, so a whole
 * catalogue in one request would sit past most reverse-proxy timeouts. The
 * caller repeats until `remaining` reaches zero.
 */
const BATCH = 25;

/**
 * Re-pull a batch of items from Onshape.
 *
 * Exists because mirrored fields change meaning when the mapping improves — the
 * enum-label fix, for instance, leaves previously synced rows holding a raw
 * integer until something re-reads them. Waiting for a designer to touch every
 * part is not a plan.
 *
 * Oldest-synced first, so repeated calls sweep the whole set without repeating
 * work.
 */
export const POST = handler(async () => {
  const s = await requireSession();
  await connectDb();

  const total = await ManufacturingItem.countDocuments({ enterpriseId: s.enterpriseId });
  const items: any[] = await ManufacturingItem.find({ enterpriseId: s.enterpriseId })
    .sort({ lastSyncedFromOnshapeAt: 1 })
    .limit(BATCH)
    .lean();

  const { client } = await clientForEnterprise(s.enterpriseId);

  let updated = 0, unchanged = 0;
  const failures: { moNumber: string | null; error: string }[] = [];

  for (const item of items) {
    try {
      const r = await syncPartFromOnshape(
        s.enterpriseId,
        {
          documentId: item.documentId, elementId: item.elementId, partId: item.partId,
          configuration: item.configuration, workspaceId: item.workspaceId, versionId: item.versionId,
        },
        { trigger: "bulk-resync", client }
      );
      if (r.action === "unchanged") unchanged++;
      else updated++;
    } catch (err: any) {
      // One unreachable part must not abandon the rest of the batch.
      failures.push({ moNumber: item.moNumber, error: String(err?.message ?? err) });
    }
  }

  const processed = items.length;
  const stillStale = await ManufacturingItem.countDocuments({
    enterpriseId: s.enterpriseId,
    $or: [
      { lastSyncedFromOnshapeAt: null },
      { lastSyncedFromOnshapeAt: { $lt: new Date(Date.now() - 60_000) } },
    ],
  });

  return ok({ total, processed, updated, unchanged, failures, remaining: stillStale });
});
