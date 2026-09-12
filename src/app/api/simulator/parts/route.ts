import { connectDb } from "@/lib/db";
import {
  Drawing, Enterprise, MockOnshapeDrawing, MockOnshapePart, MockPropertyDef,
  MockReleasePackage, Part,
} from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { isMock } from "@/lib/onshape/oauth";
import { handler, ok, fail } from "@/lib/api";

/** Everything the simulator UI needs: the mock tenant, and what PLM holds of it. */
export const GET = handler(async () => {
  const s = await requireSession();
  if (!isMock()) return fail("The simulator is only available when ONSHAPE_MODE=mock", 400);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  const companyId = ent.onshapeCompanyId;
  const [defs, mockParts, mockDrawings, packages, plmParts, plmDrawings] = await Promise.all([
    MockPropertyDef.find({ companyId }).lean(),
    MockOnshapePart.find({ companyId }).sort({ documentName: 1, elementName: 1, partId: 1 }).lean(),
    MockOnshapeDrawing.find({ companyId }).sort({ documentName: 1, elementName: 1 }).lean(),
    MockReleasePackage.find({ companyId }).sort({ createdAt: -1 }).limit(20).lean(),
    Part.find({ enterpriseId: s.enterpriseId }).lean(),
    Drawing.find({ enterpriseId: s.enterpriseId }).lean(),
  ]);

  // Which of the tenant's parts PLM already holds, so the simulator can show
  // both sides at once — the whole point of having a simulator at all.
  const knownParts = new Map(
    plmParts.map((p: any) => [
      `${p.documentId}:${p.elementId}:${p.partId}:${p.configuration}`,
      {
        id: String(p._id),
        number: p.number,
        revision: p.revision || "",
        iteration: p.iteration ?? 1,
        lifecycleState: p.lifecycleState,
      },
    ])
  );
  const knownDrawings = new Map(
    plmDrawings.map((d: any) => [
      `${d.documentId}:${d.elementId}`,
      {
        id: String(d._id),
        number: d.number,
        revision: d.revision || "",
        lifecycleState: d.lifecycleState,
      },
    ])
  );

  return ok({
    companyId,
    definitions: defs.map((d: any) => ({
      propertyId: d.propertyId, name: d.name, valueType: d.valueType,
      enumValues: d.enumValues ?? [],
      // Code/label pairs, for an enum the simulator stores as a code — which is
      // State, and is how a real tenant reports it.
      enumOptions: (d.enumOptions ?? []).map((o: any) => ({ value: o.value, label: o.label })),
      builtIn: d.builtIn,
    })),
    parts: mockParts.map((p: any) => ({
      id: String(p._id),
      documentId: p.documentId, documentName: p.documentName,
      workspaceId: p.workspaceId,
      elementId: p.elementId, elementName: p.elementName,
      partId: p.partId, configuration: p.configuration,
      properties: p.properties || {},
      revisions: (p.revisions ?? []).map((r: any) => ({ revision: r.revision, versionId: r.versionId })),
      plm: knownParts.get(`${p.documentId}:${p.elementId}:${p.partId}:${p.configuration}`) ?? null,
    })),
    drawings: mockDrawings.map((d: any) => ({
      id: String(d._id),
      documentId: d.documentId, documentName: d.documentName,
      elementId: d.elementId, elementName: d.elementName,
      partIds: d.partIds ?? [],
      revisions: (d.revisions ?? []).map((r: any) => ({ revision: r.revision, versionId: r.versionId })),
      plm: knownDrawings.get(`${d.documentId}:${d.elementId}`) ?? null,
    })),
    releasePackages: packages.map((r: any) => ({
      rpid: r.rpid,
      state: r.state,
      changeOrderId: r.changeOrderId,
      itemCount: (r.items ?? []).length,
      items: (r.items ?? []).map((i: any) => ({
        elementType: i.elementType, name: i.name, revision: i.revision || "",
      })),
      createdAt: r.createdAt,
    })),
  });
});
