import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { ConfigurationError, itemPicture, restorePicture, setItemPicture } from "@/lib/configurator";
import { ok } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A configured item's picture. Cached hard by the browser: callers put the
 * item's pictureVersion in the URL (?v=), so a render that replaces the
 * picture is a new URL rather than a stale cache.
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

/**
 * Make a studio render (the body: a PNG or JPEG) this configuration's picture.
 * Anyone signed in, like generating one (a demo).
 */
export const PUT = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const type = (req.headers.get("content-type") || "").split(";")[0].trim();
  const data = Buffer.from(await req.arrayBuffer());
  try {
    return ok({ item: await setItemPicture(s.enterpriseId, id, data, type) });
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 422);
    throw err;
  }
});

/** Put Onshape's own picture back. */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  try {
    return ok({ item: await restorePicture(s.enterpriseId, id) });
  } catch (err: any) {
    if (err instanceof ConfigurationError) return fail(err.message, 404);
    throw err;
  }
});
