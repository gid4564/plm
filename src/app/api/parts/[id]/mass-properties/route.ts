import { connectDb } from "@/lib/db";
import { ActivityLog, Part } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { plainAttributes, preferKnownWorkspace, readCoords } from "@/lib/sync";
import { listDefinitions } from "@/lib/attributes";
import { handler, ok, fail } from "@/lib/api";
import type { PartCoords } from "@/lib/onshape/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Mass, volume, surface area and centroid for the part behind an part.
 *
 * Read on request rather than mirrored on every sync — unlike the fields that
 * change as a designer edits a part, mass properties are only interesting when
 * someone actually opens this section, and fetching them on every webhook or
 * page view would spend calls from a shared rate limit on something most
 * views never look at.
 */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  await connectDb();
  /*
   * A document, not a lean object: the mass read below is written back, and a
   * lean result has no save(). (A `.lean()` here also silently produces BSON
   * Binary rather than Buffer for binary fields, which has bitten this app
   * before — see lib/binary.ts.)
   */
  const part: any = await Part.findOne({ _id: id, enterpriseId: s.enterpriseId });
  if (!part) return fail("Part not found", 404);

  const coords: PartCoords = readCoords(
    preferKnownWorkspace(
      {
        documentId: part.documentId,
        elementId: part.elementId,
        partId: part.partId,
        configuration: part.configuration,
        workspaceId: part.workspaceId,
        versionId: part.versionId,
      },
      part.workspaceId ?? null
    )
  );

  const { client } = await clientForEnterprise(s.enterpriseId);

  try {
    const result = await client.getMassProperties(coords);

    /*
     * Record the mass on the part, not just report it.
     *
     * The value was previously read and thrown away with the response, so the
     * Mass attribute in the metamodel stayed permanently empty — a field that
     * exists, is documented in kilograms, and never holds anything. Onshape is
     * the authority on geometry, so PLM mirrors what it says rather than asking
     * anyone to type it.
     *
     * Only a real number is written. `hasMass: false` means Onshape could not
     * compute one — usually no material assigned — and that is not the same as
     * a mass of zero. Writing 0 there would be a confidently wrong number in a
     * field somebody might quote.
     */
    const stored = await storeMass(part, result.hasMass ? result.massKg : null, s.email);

    return ok({ ...result, stored });
  } catch (err: any) {
    return fail(String(err?.message ?? err), 502);
  }
});

/**
 * Persist a mass reading into the part's Mass attribute.
 *
 * Returns what happened, so the caller can say so rather than leaving the user
 * to guess whether the number they are looking at was kept.
 */
async function storeMass(
  part: any,
  massKg: number | null,
  actorEmail: string
): Promise<{ written: boolean; key: string; unit: string; was: unknown; now: unknown; why?: string }> {
  const key = "mass";
  const attrs = plainAttributes(part.attributes);
  const was = attrs[key] ?? null;

  if (massKg == null) {
    return { written: false, key, unit: "kg", was, now: was, why: "Onshape reported no mass." };
  }

  /*
   * Rounded to milligrams. Onshape returns a float with far more digits than
   * the geometry justifies, and an unrounded value makes every read look like
   * a change — which would fill the activity log with noise saying nothing.
   */
  const now = Math.round(massKg * 1e6) / 1e6;
  if (typeof was === "number" && Math.abs(was - now) < 1e-9) {
    return { written: false, key, unit: "kg", was, now, why: "Unchanged." };
  }

  const defs = await listDefinitions(String(part.enterpriseId), "PART");
  const def = defs.find((d) => d.key === key);
  if (!def) {
    return { written: false, key, unit: "kg", was, now, why: "This enterprise has no Mass attribute." };
  }

  /*
   * A frozen attribute is not written after release, even by Onshape.
   *
   * Mass is not frozen in the seeded metamodel, so this normally does nothing.
   * It is checked anyway because the metamodel is configurable: an enterprise
   * that decides the released mass is part of the record means it, and a
   * mirror that overwrites it would quietly undo that decision.
   */
  if (def.frozenAtRelease && part.lifecycleState === "Released") {
    return {
      written: false, key, unit: def.unit || "kg", was, now,
      why: `Mass is frozen at release, and ${part.number} is Released.`,
    };
  }

  part.attributes = { ...attrs, [key]: now };
  part.markModified("attributes");
  await part.save();

  await ActivityLog.create({
    enterpriseId: part.enterpriseId,
    partId: part._id,
    direction: "onshape->plm",
    action: "updated",
    trigger: "mass-properties",
    ok: true,
    message:
      `${actorEmail} read mass properties for ${part.number}: Mass ` +
      `${was == null ? "set to" : `changed from ${was} to`} ${now} ${def.unit || "kg"}.`,
  });

  return { written: true, key, unit: def.unit || "kg", was, now };
}
