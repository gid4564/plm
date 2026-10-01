import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { importBomLines, MAX_IMPORT } from "@/lib/bom-import";
import { handler, ok, fail } from "@/lib/api";

const Body = z.object({
  documentId: z.string().min(1),
  elementId: z.string().min(1),
  workspaceId: z.string().nullable().optional(),
  versionId: z.string().nullable().optional(),
  multiLevel: z.boolean().optional().default(true),
  /** Assembly configuration to read the BOM for; default configuration when absent. */
  configuration: z.string().nullable().optional(),
  /**
   * Row keys only.
   *
   * Quantities and coordinates are re-read from Onshape server-side: the claim
   * this feature makes is that the numbers come from the model rather than from
   * a person, so they must not be accepted from the browser.
   */
  keys: z.array(z.string().min(1)).min(1).max(MAX_IMPORT),
  /** Overwrite quantities already recorded on the structure edges. Off by default. */
  updateQuantities: z.boolean().optional().default(false),
});

/**
 * Bring the selected BOM rows into PLM, under the assembly they came from.
 *
 * The assembly itself is synced as a PLM object first, so the rows below it
 * become real structure rather than a flat list of parts that happen to have
 * arrived together.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const b = parsed.data;

  if (!b.workspaceId && !b.versionId) {
    return fail("A workspace or version is required to read the BOM.", 422);
  }

  const { assembly, result } = await importBomLines(
    { userId: s.userId, email: s.email, enterpriseId: s.enterpriseId },
    {
      documentId: b.documentId,
      elementId: b.elementId,
      workspaceId: b.workspaceId ?? null,
      versionId: b.versionId ?? null,
      configuration: b.configuration || null,
    },
    b.keys,
    { multiLevel: b.multiLevel, updateQuantities: b.updateQuantities }
  );

  return ok({ assembly, ...result });
});
