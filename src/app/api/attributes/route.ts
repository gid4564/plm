import { z } from "zod";
import { connectDb } from "@/lib/db";
import { ActivityLog, AttributeDefinition, LIFECYCLE_STATES } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { seedAttributeDefinitions, shapeDefinition } from "@/lib/attributes";
import { handler, ok, fail } from "@/lib/api";

/** The whole attribute schema for this enterprise, both object types. */
export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();

  const defs: any[] = await AttributeDefinition.find({ enterpriseId: s.enterpriseId })
    .sort({ objectType: 1, order: 1, label: 1 })
    .lean();

  return ok({
    states: LIFECYCLE_STATES,
    dataTypes: ["STRING", "TEXT", "NUMBER", "INTEGER", "BOOLEAN", "DATE", "ENUM"],
    definitions: defs.map(shapeDefinition),
  });
});

const Definition = z.object({
  objectType: z.enum(["PART", "DRAWING"]),
  key: z
    .string()
    .min(1)
    .max(60)
    // The key is what values are stored against, so it has to be a stable
    // identifier rather than prose — and it is never renamed afterwards.
    .regex(/^[a-z][a-zA-Z0-9]*$/, "Use a lowerCamelCase key, e.g. \"unitOfMeasure\"."),
  label: z.string().min(1).max(120),
  description: z.string().max(1000).optional().default(""),
  dataType: z.enum(["STRING", "TEXT", "NUMBER", "INTEGER", "BOOLEAN", "DATE", "ENUM"]),
  enumValues: z.array(z.string().min(1).max(120)).max(100).optional().default([]),
  unit: z.string().max(20).optional().default(""),
  defaultValue: z.unknown().optional(),
  required: z.boolean().optional().default(false),
  requiredForRelease: z.boolean().optional().default(false),
  editableInStates: z.array(z.enum(LIFECYCLE_STATES)).optional().default([]),
  frozenAtRelease: z.boolean().optional().default(false),
  owner: z.enum(["plm", "onshape"]).optional().default("onshape"),
  onshapePropertyName: z.string().max(200).optional().default(""),
  onshapePropertyId: z.string().max(60).optional().default(""),
  syncDirection: z.enum(["none", "from-onshape", "to-onshape", "both"]).optional().default("from-onshape"),
  authority: z.enum(["plm", "onshape"]).optional().default("onshape"),
  order: z.number().int().min(0).max(10_000).optional().default(100),
  group: z.string().max(80).optional().default(""),
});

/**
 * Reject a definition that cannot mean what it says.
 *
 * These are the combinations that would silently do nothing rather than fail,
 * which is the worst outcome for a governance rule — an admin sets it, sees no
 * error, and believes it is in force.
 */
function contradictions(d: z.infer<typeof Definition>): string | null {
  if (d.dataType === "ENUM" && d.enumValues.length === 0) {
    return "An enum attribute needs at least one permitted value, or nothing can ever be stored in it.";
  }
  if (d.dataType !== "ENUM" && d.enumValues.length) {
    return `Permitted values only apply to an enum. Change the type to ENUM, or clear them.`;
  }
  if (d.syncDirection !== "none" && !d.onshapePropertyName && !d.onshapePropertyId) {
    return "This attribute is directed to or from Onshape but names no Onshape property, so nothing would move. Name a property, or set the direction to none.";
  }
  if (d.syncDirection === "none" && d.onshapePropertyName) {
    return "This attribute names an Onshape property but its direction is none, so the mapping would never be used.";
  }
  if (d.required && d.editableInStates.length && !d.editableInStates.includes("In Work")) {
    return "An attribute that is always required must be editable In Work, or a new object could never be saved.";
  }
  if (
    d.requiredForRelease &&
    d.editableInStates.length &&
    !d.editableInStates.includes("In Work") &&
    !d.editableInStates.includes("Under Review")
  ) {
    return (
      "This attribute is required to release but cannot be edited In Work or Under Review, " +
      "so there is no state in which anyone could fill it in. A part that arrives through a " +
      "release Onshape started is already Under Review."
    );
  }
  if (d.unit && !["NUMBER", "INTEGER"].includes(d.dataType)) {
    return "A unit of measure only makes sense on a number.";
  }
  return null;
}

/** Add an attribute to the schema. */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change the attribute schema.", 403);

  const parsed = Definition.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const d = parsed.data;

  const problem = contradictions(d);
  if (problem) return fail(problem, 422);

  await connectDb();

  const clash = await AttributeDefinition.exists({
    enterpriseId: s.enterpriseId, objectType: d.objectType, key: d.key,
  });
  if (clash) {
    return fail(`A ${d.objectType.toLowerCase()} attribute with the key "${d.key}" already exists.`, 409);
  }

  const created: any = await AttributeDefinition.create({ ...d, enterpriseId: s.enterpriseId });

  await ActivityLog.create({
    enterpriseId: s.enterpriseId, direction: "plm", action: "created", trigger: "user-edit", ok: true,
    message: `${s.email} added the ${d.objectType.toLowerCase()} attribute "${d.label}" (${d.key})`,
  });

  return ok({ definition: shapeDefinition(created.toObject()) }, 201);
});

/** Create the seed schema, for an enterprise that has none or is missing parts of it. */
export const PUT = handler(async () => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change the attribute schema.", 403);

  const created = await seedAttributeDefinitions(s.enterpriseId);

  if (created) {
    await ActivityLog.create({
      enterpriseId: s.enterpriseId, direction: "plm", action: "created",
      trigger: "user-edit", ok: true,
      message: `${s.email} seeded ${created} attribute definition(s)`,
    });
  }

  return ok({
    created,
    message: created
      ? `Added ${created} definition(s) from the starting schema.`
      : "The starting schema is already present; nothing was changed.",
  });
});

