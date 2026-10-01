import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Part } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { createVariant, listVariants } from "@/lib/variants";
import { handler, ok, fail } from "@/lib/api";

/**
 * Named variants of one assembly's BOM — "Model A", "Model B" — against which
 * a BomLink can be tagged. See Variant's own comment in lib/models/index.ts.
 */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  const parentPartId = new URL(req.url).searchParams.get("parentPartId") || "";
  if (!parentPartId) return fail("A parentPartId is required.", 422);

  await connectDb();
  const parent: any = await Part.findOne({ _id: parentPartId, enterpriseId: s.enterpriseId })
    .select("_id").lean();
  if (!parent) return fail("That part does not exist.", 404);

  const variants = await listVariants(s.enterpriseId, parentPartId);
  return ok({ variants });
});

const CreateBody = z.object({
  parentPartId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
});

export const POST = handler(async (req: Request) => {
  const s = await requireSession();

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Bad request", 422);
  const b = parsed.data;

  await connectDb();
  const parent: any = await Part.findOne({ _id: b.parentPartId, enterpriseId: s.enterpriseId })
    .select("_id kind").lean();
  if (!parent) return fail("That part does not exist.", 404);
  if (parent.kind !== "assembly") {
    return fail("Variants are defined against an assembly's BOM, and this part is not one.", 422);
  }

  try {
    const variant = await createVariant(s.enterpriseId, b.parentPartId, b.name, b.description ?? "");
    return ok({ variant });
  } catch (err: any) {
    return fail(String(err?.message ?? err), 409);
  }
});
