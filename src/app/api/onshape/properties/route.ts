import { connectDb } from "@/lib/db";
import { AttributeDefinition, Enterprise, Part } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForUser } from "@/lib/onshape/factory";
import { discoverProperties } from "@/lib/onshape/properties";
import type { PropertyDef } from "@/lib/onshape/types";
import { handler, ok, fail } from "@/lib/api";

/**
 * The current attribute-to-property mapping, without contacting Onshape.
 *
 * Reads off the attribute definitions themselves rather than a separate map:
 * in PLM the mapping *is* part of the metamodel, one entry per attribute, with
 * its own direction and authority. There is no second place for it to be
 * wrong.
 */
export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();

  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  const defs: any[] = await AttributeDefinition.find({ enterpriseId: s.enterpriseId })
    .sort({ objectType: 1, order: 1 })
    .lean();

  return ok({
    checkedAt: ent.onshapePropertyDefsCheckedAt ?? null,
    /** Every property this tenant is known to have, for the mapping dropdowns. */
    available: (ent.onshapePropertyDefs ?? []).map((d: any) => ({
      propertyId: d.propertyId,
      name: d.name,
      valueType: d.valueType,
      enumValues: d.enumValues ?? [],
    })),
    mappings: defs.map((d) => ({
      id: String(d._id),
      objectType: d.objectType,
      key: d.key,
      label: d.label,
      dataType: d.dataType,
      owner: d.owner,
      syncDirection: d.syncDirection,
      authority: d.authority,
      onshapePropertyName: d.onshapePropertyName ?? "",
      onshapePropertyId: d.onshapePropertyId ?? "",
      /**
       * Three states, not two.
       *
       * "plm-only" is a deliberate design choice, not a broken mapping — and
       * showing it as unmapped would send an admin looking for a problem that
       * is not there.
       */
      status: !d.onshapePropertyName
        ? "plm-only"
        : d.onshapePropertyId
          ? "bound"
          : "unmatched",
    })),
  });
});

/**
 * Parse the ids out of a pasted Onshape URL, e.g.
 * https://cad.onshape.com/documents/{did}/w/{wid}/e/{eid}
 */
function parseOnshapeUrl(url: string) {
  const m = url.match(
    /\/documents\/([0-9a-f]{24})\/(w|v|m)\/([0-9a-f]{24})\/e\/([0-9a-f]{24})/i
  );
  if (!m) return null;
  return { documentId: m[1], wvType: m[2], wvId: m[3], elementId: m[4] };
}

/**
 * Re-run discovery and rebind the metamodel.
 *
 * Onshape has no dependable company-level endpoint for custom property
 * definitions, but every part's metadata names its properties. So the caller
 * may pass a part URL, or PLM reuses an already-synced part, and reads the ids
 * straight off the real thing.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can run property discovery.", 403);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  const body = (await req.json().catch(() => ({}))) as { partUrl?: string; partId?: string };
  const client = await clientForUser(s.userId);

  let extraDefs: PropertyDef[] = [];
  let sampledFrom: string | null = null;

  // 1. An explicitly pasted part URL wins.
  if (body.partUrl?.trim()) {
    const parsed = parseOnshapeUrl(body.partUrl.trim());
    if (!parsed) {
      return fail(
        "Could not read that Onshape URL. Open the Part Studio in Onshape and copy the " +
        "address bar — it should look like " +
        "https://cad.onshape.com/documents/<id>/w/<id>/e/<id>",
        422
      );
    }
    if (!body.partId?.trim()) {
      return fail("Also enter the part ID (for example JHD) so a specific part can be read.", 422);
    }
    const meta = await client.getPartMetadata({
      documentId: parsed.documentId,
      elementId: parsed.elementId,
      partId: body.partId.trim(),
      configuration: "default",
      workspaceId: parsed.wvType === "w" ? parsed.wvId : null,
      versionId: parsed.wvType === "v" ? parsed.wvId : null,
    });
    extraDefs = meta.definitions;
    sampledFrom = `${meta.documentName || parsed.documentId} / ${meta.partName || body.partId}`;
  } else {
    // 2. Otherwise reuse any part PLM has already synced.
    const part: any = await Part.findOne({ enterpriseId: s.enterpriseId })
      .sort({ lastSyncedFromOnshapeAt: -1 })
      .lean();
    if (part) {
      try {
        const meta = await client.getPartMetadata({
          documentId: part.documentId, elementId: part.elementId, partId: part.partId,
          configuration: part.configuration, workspaceId: part.workspaceId, versionId: part.versionId,
        });
        extraDefs = meta.definitions;
        sampledFrom = `${meta.documentName || part.documentName} / ${meta.partName || part.partId}`;
      } catch {
        /* fall through to the schema endpoint alone */
      }
    }
  }

  const result = await discoverProperties(client, s.enterpriseId, ent.onshapeCompanyId, extraDefs);

  return ok({
    bound: result.bound,
    unmatched: result.unmatched,
    plmOnly: result.plmOnly,
    definitionCount: result.allDefinitions.length,
    sampledFrom,
    schemaError: result.schemaError,
    // Everything Onshape reported, so a name mismatch is visible rather than
    // just showing up as "unmatched".
    seenNames: result.allDefinitions.map((d) => d.name).sort(),
    // Actionable guidance for an attribute naming a property the tenant lacks.
    instructions: result.unmatched.map((u) =>
      `No Onshape property is named "${u.wanted}", which the ${u.objectType.toLowerCase()} ` +
      `attribute "${u.label}" maps to. Either add a custom property with that exact name ` +
      `in Onshape (Enterprise settings → Properties), or change the attribute to point at ` +
      `a property the tenant already has.`
    ),
  });
});
