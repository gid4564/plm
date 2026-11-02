import { requireSession } from "@/lib/auth/session";
import { handler, ok, fail } from "@/lib/api";
import { addAttachment, MAX_ATTACHMENT_BYTES } from "@/lib/onshape-create";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Attach one or more files to a part, as multipart form data (field `file`).
 *
 * The size is checked from the declared length before the body is read, so an
 * oversized upload is refused without first being held in memory.
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const declared = Number(req.headers.get("content-length")) || 0;
  if (declared > MAX_ATTACHMENT_BYTES + 1024 * 1024) {
    return fail(`That upload is larger than the ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)} MB limit.`, 413);
  }

  const form = await req.formData().catch(() => null);
  const files = (form?.getAll("file") ?? []).filter((f): f is File => f instanceof File);
  if (files.length === 0) return fail("No file was sent.", 422);

  const added: { id: string; filename: string }[] = [];
  try {
    for (const f of files) {
      const { id: attachmentId } = await addAttachment(
        s.enterpriseId, id, { userId: s.userId, email: s.email },
        { filename: f.name, contentType: f.type, data: Buffer.from(await f.arrayBuffer()) }
      );
      added.push({ id: attachmentId, filename: f.name });
    }
  } catch (err: any) {
    return fail(String(err?.message ?? err), 422);
  }
  return ok({ added }, 201);
});
