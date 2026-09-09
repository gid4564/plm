import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Enterprise, ManufacturingItem, SyncLog } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { deleteItem } from "@/lib/sync";
import { handler, ok, fail } from "@/lib/api";

/**
 * Triggers that represent a person deciding this part belongs in the MOS.
 * Anything created by another route arrived automatically.
 */
const DELIBERATE = ["panel:sync", "user-edit", "manual", "onshape.revision.created", "onshape.workflow.transition"];

/**
 * List items that look automatically created and never used.
 *
 * Written for the cleanup after enrolment became deliberate: before that, any
 * property save enrolled a part, so a lot of records exist that nobody asked
 * for. Judging that is a matter of evidence rather than a single flag, so every
 * signal is reported per item and the caller decides.
 */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  await connectDb();

  const url = new URL(req.url);
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (beforeRaw && Number.isNaN(before!.getTime())) return fail("Invalid 'before' date", 422);

  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  const defaultStatus = (ent?.statuses ?? [])[0] ?? "Under Construction";

  const filter: Record<string, unknown> = { enterpriseId: s.enterpriseId };
  if (before) filter.createdAt = { $lt: before };

  const items: any[] = await ManufacturingItem.find(filter).sort({ createdAt: 1 }).lean();

  // One query rather than one per item: a few hundred items would otherwise be
  // a few hundred round trips.
  const touched = new Set(
    (
      await SyncLog.find({
        enterpriseId: s.enterpriseId,
        itemId: { $in: items.map((i) => i._id) },
        trigger: { $in: DELIBERATE },
      }).distinct("itemId")
    ).map(String)
  );

  const rows = items.map((i) => {
    const signals = {
      defaultStatus: i.status === defaultStatus,
      noRemarks: !i.remarks,
      defaultQuantity: (i.quantity ?? 1) === 1,
      noDueDate: !i.dueDate,
      neverTouchedByAPerson: !touched.has(String(i._id)),
    };
    const unused = Object.values(signals).every(Boolean);
    return {
      id: String(i._id),
      moNumber: i.moNumber,
      partName: i.partName,
      partNumber: i.partNumber,
      status: i.status,
      remarks: i.remarks || "",
      documentName: i.documentName,
      createdAt: i.createdAt,
      signals,
      unused,
    };
  });

  return ok({
    total: items.length,
    unused: rows.filter((r) => r.unused).length,
    inUse: rows.filter((r) => !r.unused).length,
    items: rows,
    defaultStatus,
  });
});

const Body = z.object({
  /** Explicit ids only — never a filter. What was previewed is what is removed. */
  ids: z.array(z.string()).min(1).max(500),
  force: z.boolean().optional().default(false),
});

/**
 * Delete the listed items.
 *
 * Takes explicit ids rather than repeating the filter, so a record that changed
 * between preview and confirmation cannot be swept up by a query the user never
 * saw the results of.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();

  // One client for the whole batch rather than one per item.
  const { client } = await clientForEnterprise(s.enterpriseId);

  let deleted = 0;
  const failures: { id: string; moNumber: string | null; error: string }[] = [];

  for (const id of parsed.data.ids) {
    try {
      const r = await deleteItem(s.enterpriseId, id, s.email, { force: parsed.data.force, client });
      if (r.ok) deleted++;
      else failures.push({ id, moNumber: r.moNumber, error: r.error ?? "unknown" });
    } catch (err: any) {
      failures.push({ id, moNumber: null, error: String(err?.message ?? err) });
    }
  }

  return ok({ requested: parsed.data.ids.length, deleted, failures });
});
