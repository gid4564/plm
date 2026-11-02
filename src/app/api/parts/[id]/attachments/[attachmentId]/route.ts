import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { readAttachment, removeAttachment } from "@/lib/onshape-create";

type Ctx = { params: Promise<{ id: string; attachmentId: string }> };

/** Download an attached file. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id, attachmentId } = await ctx.params;

  const file = await readAttachment(s.enterpriseId, id, attachmentId);
  if (!file) return fail("Attachment not found", 404);

  return new NextResponse(new Uint8Array(file.data), {
    status: 200,
    headers: {
      "Content-Type": file.contentType || "application/octet-stream",
      "Content-Length": String(file.data.length),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
});

/** Remove an attachment from PLM. Anything already sent to Onshape stays there. */
export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id, attachmentId } = await ctx.params;
  try {
    await removeAttachment(s.enterpriseId, id, { userId: s.userId, email: s.email }, attachmentId);
  } catch (err: any) {
    return fail(String(err?.message ?? err), 422);
  }
  return ok({ removed: true });
});
