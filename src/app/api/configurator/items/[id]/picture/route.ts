import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { itemPicture } from "@/lib/configurator";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A configured item's picture. Cached hard by the browser: an item's picture
 * never changes once generated — a different picture is a different item.
 */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const pic = await itemPicture(s.enterpriseId, id);
  if (!pic) return fail("No picture yet", 404);
  return new NextResponse(new Uint8Array(pic.data), {
    status: 200,
    headers: { "Content-Type": pic.contentType, "Cache-Control": "private, max-age=31536000, immutable" },
  });
});
