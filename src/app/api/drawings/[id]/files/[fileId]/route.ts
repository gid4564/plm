import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { Drawing, DrawingFile } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { toBuffer } from "@/lib/binary";

type Ctx = { params: Promise<{ id: string; fileId: string }> };

/**
 * Serve one stored PDF of a drawing.
 *
 * Inline by default so it opens in the browser's viewer — a reviewer looking at
 * a release wants to see the sheet, not download it. `?download=1` forces the
 * save dialog for whoever actually wants the file.
 *
 * The filename carries the stage and the revision, which matters more than it
 * looks: two sheets of the same drawing are kept, and the whole point is that
 * they differ. A pair of files both called "DWG-00001.pdf" in someone's
 * downloads folder would defeat that entirely.
 */
export const GET = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id, fileId } = await ctx.params;
  await connectDb();

  // Scoped through the drawing, so a file id alone cannot reach another
  // enterprise's sheet.
  const drawing: any = await Drawing.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!drawing) return fail("Drawing not found", 404);

  const file: any = await DrawingFile.findOne({ _id: fileId, drawingId: id }).lean();
  if (!file) return fail("That version of this drawing does not exist", 404);

  /*
   * Normalised rather than used directly: this query is .lean(), so `data`
   * arrives as a BSON Binary and not a Buffer. See lib/binary.ts — passing one
   * to Uint8Array silently produces an empty body behind a correct
   * Content-Length.
   */
  const bytes = toBuffer(file.data);
  if (!bytes) {
    return fail(
      file.failureReason
        ? `This sheet was never captured: ${file.failureReason}`
        : "This sheet has no stored content.",
      404
    );
  }

  const download = new URL(req.url).searchParams.get("download") === "1";
  const safe = (v: string) => v.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  const name =
    `${safe(drawing.number || "drawing")}` +
    `${file.revision ? `_Rev${safe(file.revision)}` : ""}` +
    `_${file.stage}_v${file.version}.pdf`;

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": file.contentType || "application/pdf",
      // From the bytes actually being sent, never from the stored size field —
      // a Content-Length that disagrees with the body is what made the original
      // bug present as a truncated transfer rather than as an error.
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      /*
       * A stored sheet never changes — a new capture is a new version with its
       * own id — so this is safe to cache hard. `private` because it is a
       * controlled document and must not land in a shared proxy.
       */
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
});
