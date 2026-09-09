import { connectDb } from "@/lib/db";
import { ManufacturingItem } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { preferKnownWorkspace, readCoords } from "@/lib/sync";
import { handler, ok, fail } from "@/lib/api";
import type { PartCoords } from "@/lib/onshape/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Mass, volume, surface area and centroid for the part behind an item.
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
  const item: any = await ManufacturingItem.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!item) return fail("Manufacturing item not found", 404);

  const coords: PartCoords = readCoords(
    preferKnownWorkspace(
      {
        documentId: item.documentId,
        elementId: item.elementId,
        partId: item.partId,
        configuration: item.configuration,
        workspaceId: item.workspaceId,
        versionId: item.versionId,
      },
      item.workspaceId ?? null
    )
  );

  const { client } = await clientForEnterprise(s.enterpriseId);

  try {
    const result = await client.getMassProperties(coords);
    return ok(result);
  } catch (err: any) {
    return fail(String(err?.message ?? err), 502);
  }
});
