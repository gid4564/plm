import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { Part, PartThumbnail } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { handler } from "@/lib/api";
import { toBuffer } from "@/lib/binary";
import type { PartCoords } from "@/lib/onshape/types";

type Ctx = { params: Promise<{ id: string }> };

/** Refresh a cached image after this long. Geometry changes rarely. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Do not retry a failed render more often than this. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * Neutral placeholder, drawn when no rendering is available.
 *
 * Served with a short cache lifetime and a 200 rather than a 404 so the browser
 * shows a tidy tile instead of a broken-image icon, and retries reasonably soon.
 */
function placeholder(): NextResponse {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="#eef1f5"/>` +
    `<path d="M30 62 L44 44 L54 56 L62 48 L74 62 Z" fill="#c3cad3"/>` +
    `<circle cx="40" cy="36" r="5" fill="#c3cad3"/></svg>`;
  return new NextResponse(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "private, max-age=300",
    },
  });
}

/**
 * Serve a rendering of the part behind a manufacturing part.
 *
 * Cached in MongoDB on first request rather than fetched during sync: rendering
 * is slow, and syncing a whole Part Studio should not wait on pictures nobody
 * has asked to see yet.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  const size = Math.min(600, Math.max(64, Number(new URL(req.url).searchParams.get("size")) || 300));

  await connectDb();

  const part: any = await Part.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!part) return placeholder();

  const cached: any = await PartThumbnail.findOne({ itemId: id });

  // Normalised for the reason given in lib/binary.ts: the shape Mongo returns
  // for a binary field depends on how it was queried, and the wrong one fails
  // silently rather than loudly.
  const cachedBytes = toBuffer(cached?.data);
  const fresh = cachedBytes && cached.fetchedAt && Date.now() - cached.fetchedAt.getTime() < MAX_AGE_MS;
  if (fresh && cached.size >= size) {
    return new NextResponse(new Uint8Array(cachedBytes), {
      status: 200,
      headers: {
        "Content-Type": cached.contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  }

  // Back off after a failure so a part Onshape cannot render does not cause a
  // fetch on every page view.
  if (cached?.failedAt && Date.now() - cached.failedAt.getTime() < RETRY_AFTER_MS) {
    return placeholder();
  }

  const coords: PartCoords = {
    documentId: part.documentId, elementId: part.elementId, partId: part.partId,
    configuration: part.configuration, workspaceId: part.workspaceId, versionId: part.versionId,
  };

  let thumb = null;
  let reason: string | null = null;
  try {
    const { client } = await clientForEnterprise(s.enterpriseId);
    thumb = await client.getPartThumbnail(coords, size);
    if (!thumb) reason = "Onshape returned no image for this part.";
  } catch (err: any) {
    reason = String(err?.message ?? err);
  }

  if (!thumb) {
    await PartThumbnail.updateOne(
      { itemId: id },
      { $set: { itemId: id, enterpriseId: s.enterpriseId, contentType: "image/svg+xml",
                data: Buffer.from(""), size, failedAt: new Date(), failureReason: reason } },
      { upsert: true }
    );
    return placeholder();
  }

  await PartThumbnail.updateOne(
    { itemId: id },
    { $set: { itemId: id, enterpriseId: s.enterpriseId, contentType: thumb.contentType,
              data: thumb.data, size, fetchedAt: new Date(), failedAt: null, failureReason: null } },
    { upsert: true }
  );

  return new NextResponse(new Uint8Array(thumb.data), {
    status: 200,
    headers: {
      "Content-Type": thumb.contentType,
      "Cache-Control": "private, max-age=86400",
    },
  });
});
