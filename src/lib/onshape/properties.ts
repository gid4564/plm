import { connectDb } from "@/lib/db";
import { AttributeDefinition, Enterprise } from "@/lib/models";
import { normalizeName } from "./standard-properties";
import type { OnshapeClient, PropertyDef } from "./types";

/**
 * Binding the metamodel to a tenant's Onshape properties.
 *
 * MOS matched a fixed set of three fields against property names. PLM cannot:
 * which attributes exist is configured per enterprise, so the mapping lives on
 * each AttributeDefinition as an id plus the name it was matched by.
 *
 * Matching is still by name rather than id, and for the same reason — Onshape
 * does not publish its built-in property ids as stable constants, and a
 * customer's custom properties have ids that are theirs alone. A definition
 * carries `onshapePropertyName` as its intent, and discovery resolves that to
 * whatever id this tenant actually uses.
 */

export type BindResult = {
  /** Definitions whose property id was filled in or corrected. */
  bound: { key: string; objectType: string; label: string; propertyId: string; matchedName: string }[];
  /** Definitions that name a property this tenant does not have. */
  unmatched: { key: string; objectType: string; label: string; wanted: string }[];
  /** Definitions that ask for no Onshape property at all. PLM-only, by design. */
  plmOnly: number;
};

/**
 * Resolve every attribute definition's named property to an id on this tenant.
 *
 * Runs on discovery and, cheaply, on each sync — so a mapping repairs itself
 * the first time any part is seen, rather than depending on the poorly
 * documented company-level schema endpoint having worked.
 *
 * An id that is already set is re-checked rather than trusted, because the
 * failure this is guarding against is silent: a property deleted and recreated
 * in Onshape keeps its name and gets a new id, and the stale mapping then reads
 * and writes nothing while looking perfectly configured.
 */
export async function bindAttributeProperties(
  enterpriseId: string,
  defs: PropertyDef[]
): Promise<BindResult> {
  await connectDb();

  const byName = new Map<string, PropertyDef>();
  for (const d of defs) byName.set(normalizeName(d.name), d);

  const attrs: any[] = await AttributeDefinition.find({ enterpriseId }).lean();

  const bound: BindResult["bound"] = [];
  const unmatched: BindResult["unmatched"] = [];
  let plmOnly = 0;

  for (const attr of attrs) {
    const wanted = String(attr.onshapePropertyName ?? "").trim();
    if (!wanted) {
      plmOnly++;
      continue;
    }

    const hit = byName.get(normalizeName(wanted));
    if (!hit) {
      unmatched.push({
        key: attr.key, objectType: attr.objectType, label: attr.label, wanted,
      });
      continue;
    }

    if (String(attr.onshapePropertyId ?? "") === hit.propertyId) continue;

    await AttributeDefinition.updateOne(
      { _id: attr._id },
      { $set: { onshapePropertyId: hit.propertyId, onshapePropertyName: hit.name } }
    );
    bound.push({
      key: attr.key, objectType: attr.objectType, label: attr.label,
      propertyId: hit.propertyId, matchedName: hit.name,
    });
  }

  return { bound, unmatched, plmOnly };
}

export type DiscoveryResult = BindResult & {
  allDefinitions: PropertyDef[];
  /** Populated when the company-level schema endpoint failed outright. */
  schemaError: string | null;
};

/**
 * Enumerate the tenant's custom-property definitions and bind the metamodel.
 *
 * Two sources, merged. The company-level schema endpoint is the complete list
 * when it works, but it is unreliable across tenants; a real part's metadata
 * response names every property on it, which is less complete but always
 * available. The part's definitions take precedence, since they are evidence
 * from the thing being synced rather than from a schema query.
 */
export async function discoverProperties(
  client: OnshapeClient,
  enterpriseId: string,
  companyId: string,
  extraDefs: PropertyDef[] = []
): Promise<DiscoveryResult> {
  let schemaDefs: PropertyDef[] = [];
  let schemaError: string | null = null;
  try {
    schemaDefs = await client.listPropertyDefinitions(companyId);
  } catch (err: any) {
    schemaError = String(err?.message ?? err);
  }

  const seen = new Set(extraDefs.map((d) => d.propertyId));
  const allDefinitions = [...extraDefs, ...schemaDefs.filter((d) => !seen.has(d.propertyId))];

  const result = await bindAttributeProperties(enterpriseId, allDefinitions);

  // Cached so the mapping screen can offer the full list without a live call.
  await Enterprise.findByIdAndUpdate(enterpriseId, {
    $set: {
      onshapePropertyDefs: allDefinitions.map((d) => ({
        propertyId: d.propertyId,
        name: d.name,
        valueType: d.valueType,
        enumValues: d.enumValues ?? [],
      })),
      onshapePropertyDefsCheckedAt: new Date(),
    },
  });

  return { ...result, allDefinitions, schemaError };
}
