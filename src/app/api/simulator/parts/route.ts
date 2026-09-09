import { connectDb } from "@/lib/db";
import { Enterprise, ManufacturingItem, MockOnshapePart, MockPropertyDef } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { isMock } from "@/lib/onshape/oauth";
import { handler, ok, fail } from "@/lib/api";

/** Everything the simulator UI needs: property definitions plus every mock part. */
export const GET = handler(async () => {
  const s = await requireSession();
  if (!isMock()) return fail("The simulator is only available when ONSHAPE_MODE=mock", 400);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  const companyId = ent.onshapeCompanyId;
  const [defs, parts, items] = await Promise.all([
    MockPropertyDef.find({ companyId }).lean(),
    MockOnshapePart.find({ companyId }).sort({ documentName: 1, elementName: 1, partId: 1 }).lean(),
    ManufacturingItem.find({ enterpriseId: s.enterpriseId }).lean(),
  ]);

  // Which parts the MOS already tracks, so the simulator can show sync state.
  const known = new Map(
    items.map((i: any) => [
      `${i.documentId}:${i.elementId}:${i.partId}:${i.configuration}`,
      { id: String(i._id), moNumber: i.moNumber, status: i.status },
    ])
  );

  return ok({
    companyId,
    definitions: defs.map((d: any) => ({
      propertyId: d.propertyId, name: d.name, valueType: d.valueType,
      enumValues: d.enumValues, builtIn: d.builtIn,
    })),
    parts: parts.map((p: any) => ({
      id: String(p._id),
      documentId: p.documentId, documentName: p.documentName,
      workspaceId: p.workspaceId,
      elementId: p.elementId, elementName: p.elementName,
      partId: p.partId, configuration: p.configuration,
      properties: p.properties || {},
      mos: known.get(`${p.documentId}:${p.elementId}:${p.partId}:${p.configuration}`) ?? null,
    })),
  });
});
