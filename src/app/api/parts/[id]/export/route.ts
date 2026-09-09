import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db";
import { ManufacturingItem, SyncLog } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForEnterprise } from "@/lib/onshape/factory";
import { EXPORT_FORMATS, exportFilename, findFormat } from "@/lib/onshape/export-formats";
import { preferKnownWorkspace, readCoords } from "@/lib/sync";
import { handler, ok, fail } from "@/lib/api";
import type { PartCoords } from "@/lib/onshape/types";

type Ctx = { params: Promise<{ id: string }> };

/** The formats on offer, for the item page to render. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  await requireSession();
  await ctx.params;
  return ok({
    formats: EXPORT_FORMATS.map((f) => ({
      id: f.id,
      label: f.label,
      purpose: f.purpose,
      extension: f.extension,
      // Worth showing: a translation is a job Onshape has to run, so it takes
      // noticeably longer than a direct download and the UI should say so.
      async: f.strategy === "translation",
    })),
  });
});

/**
 * Export the part behind a manufacturing item.
 *
 * Returns the file itself rather than a link. Onshape's download URLs are
 * short-lived and need the integration account's credentials, so handing one to
 * the browser would produce a link that works for nobody.
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const body = await req.json().catch(() => ({}));
  const format = findFormat(String((body as Record<string, unknown>).format ?? ""));
  if (!format) {
    return fail(
      `Unknown export format. Available: ${EXPORT_FORMATS.map((f) => f.id).join(", ")}.`,
      422
    );
  }

  await connectDb();
  const item: any = await ManufacturingItem.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!item) return fail("Manufacturing item not found", 404);

  // Same source the rest of the MOS reads from: the workspace where there is
  // one, the pinned version only for a part that has no other home.
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
    const result = await client.exportPart(coords, format);
    const filename = exportFilename(item, format);

    await SyncLog.create({
      enterpriseId: s.enterpriseId,
      itemId: item._id,
      direction: "onshape->mos",
      action: "exported",
      trigger: `export:${format.id}`,
      ok: true,
      message:
        `${s.email} exported ${format.label} (${Math.round(result.data.length / 1024)} KB) ` +
        `in ${(result.elapsedMs / 1000).toFixed(1)}s` +
        (result.via === "translation"
          ? ` via Onshape translation job ${result.translationId}`
          : " straight from the part") +
        `.`,
    });

    return new NextResponse(new Uint8Array(result.data), {
      status: 200,
      headers: {
        "Content-Type": result.contentType || format.contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(result.data.length),
        "Cache-Control": "no-store",
        // Read by the browser so it can name the download and report the wait.
        "X-MOS-Filename": filename,
        "X-MOS-Elapsed-Ms": String(result.elapsedMs),
        "X-MOS-Via": result.via,
      },
    });
  } catch (err: any) {
    const message = String(err?.message ?? err);
    await SyncLog.create({
      enterpriseId: s.enterpriseId,
      itemId: item._id,
      direction: "onshape->mos",
      action: "error",
      trigger: `export:${format.id}`,
      ok: false,
      message: `Export to ${format.label} failed: ${message}`,
    });
    // A failed export is Onshape refusing or struggling, not a fault here.
    return fail(message, 502);
  }
});
