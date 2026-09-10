import { z } from "zod";
import { connectDb } from "@/lib/db";
import { ActivityLog, AttributeDefinition, Drawing, LIFECYCLE_STATES, Part } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { shapeDefinition } from "@/lib/attributes";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Everything about a definition except its identity.
 *
 * `key` and `objectType` are deliberately absent. Values are stored against
 * the key, so renaming it would orphan every value already recorded — and
 * moving a definition between object types would orphan them all. Delete and
 * re-add is the honest route for either, and it makes the data loss visible.
 */
const Patch = z.object({
  label: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).optional(),
  dataType: z.enum(["STRING", "TEXT", "NUMBER", "INTEGER", "BOOLEAN", "DATE", "ENUM"]).optional(),
  enumValues: z.array(z.string().min(1).max(120)).max(100).optional(),
  unit: z.string().max(20).optional(),
  defaultValue: z.unknown().optional(),
  required: z.boolean().optional(),
  requiredForRelease: z.boolean().optional(),
  editableInStates: z.array(z.enum(LIFECYCLE_STATES)).optional(),
  frozenAtRelease: z.boolean().optional(),
  owner: z.enum(["plm", "onshape"]).optional(),
  onshapePropertyName: z.string().max(200).optional(),
  onshapePropertyId: z.string().max(60).optional(),
  syncDirection: z.enum(["none", "from-onshape", "to-onshape", "both"]).optional(),
  authority: z.enum(["plm", "onshape"]).optional(),
  order: z.number().int().min(0).max(10_000).optional(),
  group: z.string().max(80).optional(),
});

export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change the attribute schema.", 403);

  const { id } = await ctx.params;
  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const def: any = await AttributeDefinition.findOne({ _id: id, enterpriseId: s.enterpriseId });
  if (!def) return fail("Attribute not found", 404);

  const before = { ...def.toObject() };
  Object.assign(def, parsed.data);

  /*
   * Re-check the same contradictions the create path checks, against the
   * merged result rather than the patch. A patch that is individually
   * harmless can still leave the definition meaning nothing — switching a type
   * away from ENUM while leaving its values behind, say.
   */
  if (def.dataType === "ENUM" && (def.enumValues ?? []).length === 0) {
    return fail("An enum attribute needs at least one permitted value.", 422);
  }
  if (def.dataType !== "ENUM" && (def.enumValues ?? []).length) {
    return fail("Permitted values only apply to an enum. Clear them, or keep the type as ENUM.", 422);
  }
  if (def.syncDirection !== "none" && !def.onshapePropertyName && !def.onshapePropertyId) {
    return fail(
      "This attribute is directed to or from Onshape but names no Onshape property, so " +
      "nothing would move.",
      422
    );
  }

  const editable: string[] = def.editableInStates ?? [];
  if (
    def.requiredForRelease && editable.length &&
    !editable.includes("In Work") && !editable.includes("Under Review")
  ) {
    return fail(
      "This attribute is required to release but cannot be edited In Work or Under Review, " +
      "so there is no state in which anyone could fill it in. A part that arrives through a " +
      "release Onshape started is already Under Review.",
      422
    );
  }

  /*
   * Narrowing an enum is the change that can invalidate stored data.
   *
   * Counted rather than blocked: an admin removing a value usually knows they
   * are retiring it, and refusing outright would leave them unable to. But the
   * count has to be reported, because those objects now hold a value the schema
   * no longer permits and the next save of each will refuse it.
   */
  let strandedValues = 0;
  const removed = (before.enumValues ?? []).filter(
    (v: string) => !(def.enumValues ?? []).includes(v)
  );
  if (removed.length) {
    const Model: any = def.objectType === "DRAWING" ? Drawing : Part;
    strandedValues = await Model.countDocuments({
      enterpriseId: s.enterpriseId,
      [`attributes.${def.key}`]: { $in: removed },
    });
  }

  await def.save();

  await ActivityLog.create({
    enterpriseId: s.enterpriseId, direction: "plm", action: "updated", trigger: "user-edit", ok: true,
    message:
      `${s.email} changed the ${def.objectType.toLowerCase()} attribute "${def.label}"` +
      (strandedValues
        ? `. ${strandedValues} object(s) still hold a value that is no longer permitted.`
        : ""),
    changes: { keys: Object.keys(parsed.data) },
  });

  return ok({
    definition: shapeDefinition(def.toObject()),
    strandedValues,
    warning: strandedValues
      ? `${strandedValues} object(s) hold "${removed.join('", "')}", which this attribute no ` +
        `longer permits. They will keep the value until someone changes it, but the next ` +
        `save of each will refuse it.`
      : null,
  });
});

/**
 * Remove an attribute from the schema.
 *
 * The stored values are left alone rather than swept from every object. That
 * is deliberate: a definition deleted by mistake can be re-added with the same
 * key and its data is intact, whereas a cascade delete of every value across
 * the enterprise cannot be undone. Values with no definition simply stop being
 * shown.
 *
 * A `system` definition is refused — the sync code reads a handful of these by
 * key, and removing one would break syncing rather than merely hiding a field.
 */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change the attribute schema.", 403);

  const { id } = await ctx.params;
  await connectDb();

  const def: any = await AttributeDefinition.findOne({ _id: id, enterpriseId: s.enterpriseId });
  if (!def) return fail("Attribute not found", 404);

  if (def.system) {
    return fail(
      `"${def.label}" is part of the base schema and the sync engine reads it by key. ` +
      `You can change how it behaves, but not remove it.`,
      409
    );
  }

  const Model: any = def.objectType === "DRAWING" ? Drawing : Part;
  const holding = await Model.countDocuments({
    enterpriseId: s.enterpriseId,
    [`attributes.${def.key}`]: { $exists: true, $ne: null },
  });

  await AttributeDefinition.deleteOne({ _id: def._id });

  await ActivityLog.create({
    enterpriseId: s.enterpriseId, direction: "plm", action: "deleted", trigger: "user-edit", ok: true,
    message:
      `${s.email} removed the ${def.objectType.toLowerCase()} attribute "${def.label}" (${def.key})` +
      (holding ? `. ${holding} object(s) still hold a value for it.` : ""),
  });

  return ok({
    deleted: true,
    valuesRetained: holding,
    message: holding
      ? `Removed. ${holding} object(s) still hold a value for "${def.key}" — re-adding an ` +
        `attribute with the same key would show them again.`
      : "Removed.",
  });
});
