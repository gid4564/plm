import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Enterprise, ManufacturingItem, SyncLog } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { deleteItem, pushItemToOnshape, syncPartFromOnshape } from "@/lib/sync";
import { resolveProduct } from "@/lib/products";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { readPropertyMap } from "@/lib/onshape/properties";
import type { PartCoords } from "@/lib/onshape/types";
import { handler, ok, fail } from "@/lib/api";
import { onshapeElementUrl } from "@/lib/onshape/oauth";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  await connectDb();

  const item: any = await ManufacturingItem.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!item) return fail("Manufacturing item not found", 404);

  const logs = await SyncLog.find({ itemId: id }).sort({ createdAt: -1 }).limit(25).lean();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();

  return ok({
    item: { ...item, id: String(item._id), _id: undefined },
    onshapeUrl: onshapeElementUrl(item, ent?.onshapeDomain),
    statuses: ent?.statuses ?? [],
    facilities: ent?.facilities ?? [],
    logs: logs.map((l: any) => ({
      id: String(l._id),
      direction: l.direction,
      action: l.action,
      trigger: l.trigger,
      message: l.message,
      changes: l.changes,
      ok: l.ok,
      createdAt: l.createdAt,
    })),
  });
});

const Patch = z.object({
  status: z.string().min(1).optional(),
  remarks: z.string().max(5000).optional(),
  quantity: z.number().int().min(0).optional(),
  dueDate: z.string().nullable().optional(),
  /** Who is responsible for making this — from the enterprise's list in Settings. "" means not yet decided. */
  manufacturedBy: z.string().max(80).optional(),
  /**
   * Move this item to a different product by name.
   *
   * A name rather than an id, so typing one that does not exist yet creates
   * it — the same rule the panel and BOM import follow. Every item must
   * belong to a product, so this has no "clear" form; picking "Unassigned" is
   * how you say none applies.
   */
  product: z.string().min(1).max(200).optional(),
  /** Push MOS-owned fields to Onshape after saving. Defaults on. */
  push: z.boolean().optional().default(true),
});

/** Update MOS-owned fields, then push to Onshape. */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const b = parsed.data;

  await connectDb();
  const item: any = await ManufacturingItem.findOne({ _id: id, enterpriseId: s.enterpriseId });
  if (!item) return fail("Manufacturing item not found", 404);

  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (b.status && !(ent?.statuses ?? []).includes(b.status)) {
    return fail(`"${b.status}" is not a valid status for this enterprise`, 422);
  }
  if (b.manufacturedBy && !(ent?.facilities ?? []).includes(b.manufacturedBy)) {
    return fail(`"${b.manufacturedBy}" is not one of this enterprise's manufacturing locations`, 422);
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const apply = (field: string, value: unknown) => {
    if (value === undefined) return;
    if (String(item[field] ?? "") !== String(value ?? "")) {
      changes[field] = { from: item[field], to: value };
      item[field] = value;
    }
  };

  apply("status", b.status);
  apply("remarks", b.remarks);
  apply("quantity", b.quantity);
  apply("dueDate", b.dueDate === null ? null : b.dueDate ? new Date(b.dueDate) : undefined);
  apply("manufacturedBy", b.manufacturedBy);

  if (b.product) {
    const resolved = await resolveProduct(s.enterpriseId, b.product);
    if (resolved && resolved.productId !== String(item.productId ?? "")) {
      changes.product = { from: item.productName, to: resolved.productName };
      item.productId = resolved.productId;
      item.productName = resolved.productName;
    }
  }

  if (Object.keys(changes).length === 0 && !b.push) {
    return ok({ item: { ...item.toObject(), id: String(item._id) }, changed: false, push: null });
  }

  await item.save();

  if (Object.keys(changes).length) {
    await SyncLog.create({
      enterpriseId: s.enterpriseId, itemId: item._id, direction: "mos->onshape",
      action: "updated", trigger: "user-edit", ok: true,
      message: `${s.email} updated ${Object.keys(changes).join(", ")}`,
      changes,
    });
  }

  const push = b.push ? await pushItemToOnshape(id, { trigger: "user-edit" }) : null;
  const fresh: any = await ManufacturingItem.findById(id).lean();

  return ok({
    item: { ...fresh, id: String(fresh._id), _id: undefined },
    changed: Object.keys(changes).length > 0,
    changes,
    push,
  });
});

/** Force a re-sync from Onshape, or retry a failed push. */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const { action } = (await req.json().catch(() => ({}))) as { action?: string };

  await connectDb();
  const item: any = await ManufacturingItem.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!item) return fail("Manufacturing item not found", 404);

  if (action === "push") {
    return ok({ push: await pushItemToOnshape(id, { trigger: "manual" }) });
  }

  if (action === "pull") {
    const result = await syncPartFromOnshape(
      s.enterpriseId,
      {
        documentId: item.documentId, elementId: item.elementId, partId: item.partId,
        configuration: item.configuration, workspaceId: item.workspaceId, versionId: item.versionId,
      },
      { trigger: "manual" }
    );
    return ok({ pull: result });
  }

  return fail(`Unknown action "${action}". Use "push" or "pull".`, 422);
});

/**
 * Delete a manufacturing item.
 *
 * The MOS-owned properties are blanked in Onshape first, so the part stops
 * advertising an MO number that no longer resolves. That write is treated as
 * part of the deletion: if it fails the item is kept, because deleting anyway
 * would strand a stale number in CAD with nothing to reconcile it against.
 * `?force=1` overrides this for parts that no longer exist in Onshape.
 *
 * This is a hard delete. If Onshape reports the part again it is treated as new
 * and receives a fresh MO number — the old one is not reused.
 */
export const DELETE = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const force = new URL(req.url).searchParams.get("force") === "1";

  await connectDb();
  const exists = await ManufacturingItem.exists({ _id: id, enterpriseId: s.enterpriseId });
  if (!exists) return fail("Manufacturing item not found", 404);

  const result = await deleteItem(s.enterpriseId, id, s.email, { force });

  if (!result.ok) {
    return fail(
      `Could not clear the MO properties in Onshape, so nothing was deleted: ${result.error}. ` +
      `Retry, or delete anyway if the part no longer exists in Onshape.`,
      502
    );
  }

  return ok({ deleted: true, moNumber: result.moNumber, cleared: result.cleared, clearError: result.error ?? null });
});
