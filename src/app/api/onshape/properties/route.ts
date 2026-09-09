import { connectDb } from "@/lib/db";
import { Enterprise } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForUser } from "@/lib/onshape/factory";
import { discoverProperties, readPropertyMap, MOS_FIELDS } from "@/lib/onshape/properties";
import { ManufacturingItem } from "@/lib/models";
import type { PropertyDef } from "@/lib/onshape/types";
import { handler, ok, fail } from "@/lib/api";

/** Current mapping, without contacting Onshape. */
export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  const map = readPropertyMap(ent);
  return ok({
    map,
    checkedAt: ent.propertyMapCheckedAt,
    fields: MOS_FIELDS.map((f) => ({
      key: f.key, label: f.label, valueType: f.valueType,
      description: f.description, propertyId: map[f.key] ?? null,
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
 * Re-run discovery.
 *
 * Onshape has no dependable company-level endpoint for custom property
 * definitions, but every part's metadata names its properties. So the caller may
 * pass a part URL (or we reuse an already-synced part) and read the ids straight
 * off the real thing.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
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
        "Could not read that Onshape URL. Open the Part Studio in Onshape and copy the address bar — it should look like https://cad.onshape.com/documents/<id>/w/<id>/e/<id>",
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
    // 2. Otherwise reuse any part the MOS has already synced.
    const item: any = await ManufacturingItem.findOne({ enterpriseId: s.enterpriseId })
      .sort({ lastSyncedFromOnshapeAt: -1 })
      .lean();
    if (item) {
      try {
        const meta = await client.getPartMetadata({
          documentId: item.documentId, elementId: item.elementId, partId: item.partId,
          configuration: item.configuration, workspaceId: item.workspaceId, versionId: item.versionId,
        });
        extraDefs = meta.definitions;
        sampledFrom = `${meta.documentName || item.documentName} / ${meta.partName || item.partId}`;
      } catch {
        /* fall through to the schema endpoint alone */
      }
    }
  }

  const result = await discoverProperties(client, s.enterpriseId, ent.onshapeCompanyId, extraDefs);

  return ok({
    map: result.map,
    found: result.found,
    missing: result.missing,
    definitionCount: result.allDefinitions.length,
    sampledFrom,
    schemaError: result.schemaError,
    // Everything Onshape reported, so a name mismatch is visible rather than
    // just showing up as "missing".
    seenNames: result.allDefinitions.map((d) => d.name).sort(),
    // Actionable setup guidance when something is not defined in the tenant.
    instructions: result.missing.length
      ? result.missing.map((m) =>
          `In Onshape, go to Enterprise settings → Properties → Custom properties and add a ${m.valueType} property named exactly "${m.label}". ${m.description}` +
          (m.valueType === "ENUM"
            ? ` Use these enum values: ${(ent.statuses || []).join(", ")}.`
            : "")
        )
      : [],
  });
});
