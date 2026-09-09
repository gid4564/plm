import { connectDb } from "@/lib/db";
import { ManufacturingItem } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { normalizeConfiguration, syncPartFromOnshape } from "@/lib/sync";
import { clientForUser } from "@/lib/onshape/factory";
import { handler, ok, fail } from "@/lib/api";

/**
 * Resolve an Onshape part to its MOS item — the panel's entry point.
 *
 * ?sync=1 creates the item on the spot if the MOS has never seen the part,
 * which is what makes the panel useful before any webhook has fired.
 */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  await connectDb();

  const p = new URL(req.url).searchParams;

  // Second line of defence against unsubstituted Onshape {$token} placeholders
  // arriving from the panel. See the note in app/panel/page.tsx.
  const clean = (v: string | null) => (v && /^\{\$.*\}$/.test(v) ? null : v);

  const documentId = clean(p.get("documentId")) || "";
  const elementId = clean(p.get("elementId")) || "";
  const partId = clean(p.get("partId")) || "";
  const rawConfiguration = clean(p.get("configuration")) || "default";
  const workspaceId = clean(p.get("workspaceId"));
  const versionId = clean(p.get("versionId"));
  const product = clean(p.get("product"));

  if (!documentId || !elementId || !partId) {
    return fail("documentId, elementId and partId are all required", 422);
  }

  // Must match exactly how the sync engine keys the record, or the panel will
  // miss an existing item and create a second one.
  const configuration = await normalizeConfiguration(s.enterpriseId, rawConfiguration);
  const identity = { enterpriseId: s.enterpriseId, documentId, elementId, partId, configuration };
  let item: any = await ManufacturingItem.findOne(identity).lean();

  if (!item && p.get("sync") === "1") {
    // Guard against an Assembly-context panel.
    //
    // Onshape resolves {$documentId} and {$elementId} to the *assembly's* tab
    // while {$partId} names the selected instance. Syncing that would file the
    // part under the assembly element — a second record, with a second MO
    // number, for a part already tracked against its Part Studio. Refuse rather
    // than corrupt the identity.
    const client = await clientForUser(s.userId);
    const el = await client.getElementInfo({ documentId, elementId, partId, configuration, workspaceId, versionId });

    if (el && el.elementType && el.elementType !== "PARTSTUDIO") {
      return fail(
        `This panel syncs Part Studio parts. The selected item is in "${el.name}", ` +
        `which is ${el.elementType === "ASSEMBLY" ? "an Assembly" : `a ${el.elementType}`}. ` +
        `Open the part in its Part Studio, or ask for assembly support to be added.`,
        409
      );
    }

    // sync=1 is only ever set by a deliberate action — the panel's Sync to MOS
    // button — so this is one of the two paths allowed to allocate an MO number.
    const result = await syncPartFromOnshape(
      s.enterpriseId,
      { documentId, elementId, partId, configuration, workspaceId, versionId },
      {
        trigger: "panel:sync", create: true, createdBy: { userId: s.userId, email: s.email },
        product: product ? { name: product } : undefined,
      }
    );
    if (result.action === "skipped-no-part-number") {
      return fail(
        "This part has no Part Number in Onshape. A manufacturing order cannot be raised " +
        "without one — a supplier quotes against it and goods-in receives against it. " +
        "Set the part number on the part, then sync again.",
        409
      );
    }

    item = await ManufacturingItem.findById(result.itemId).lean();
  }

  if (!item) return ok({ item: null, known: false });

  return ok({
    known: true,
    item: {
      id: String(item._id),
      moNumber: item.moNumber,
      partName: item.partName,
      partNumber: item.partNumber,
      revision: item.revision,
      description: item.description,
      material: item.material,
      onshapeState: item.onshapeState,
      project: item.project,
      vendor: item.vendor,
      productId: item.productId ? String(item.productId) : null,
      productName: item.productName ?? "",
      status: item.status,
      remarks: item.remarks,
      quantity: item.quantity,
      dueDate: item.dueDate,
      documentName: item.documentName,
      elementName: item.elementName,
      pushPending: item.pushPending,
      writeBackBlocked: item.writeBackBlocked ?? null,
      lastPushError: item.lastPushError,
      lastSyncedFromOnshapeAt: item.lastSyncedFromOnshapeAt,
      lastPushedToOnshapeAt: item.lastPushedToOnshapeAt,
    },
  });
});
