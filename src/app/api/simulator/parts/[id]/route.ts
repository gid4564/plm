import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Enterprise, MockOnshapePart } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { isMock, webhookCallbackUrl } from "@/lib/onshape/oauth";
import { handler, ok, fail } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({
  properties: z.record(z.string(), z.string()),
  /** Fire the webhook after saving — i.e. behave like a real Onshape save. */
  fireWebhook: z.boolean().optional().default(true),
});

/**
 * The designer's "Save" in the simulated Onshape.
 *
 * Writes the properties into the mock store, then POSTs a genuine
 * onshape.model.lifecycle.metadata payload at the PLM webhook receiver over
 * HTTP — the receiver is exercised exactly as Onshape would exercise it.
 */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  if (!isMock()) return fail("The simulator is only available when ONSHAPE_MODE=mock", 400);

  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  const part: any = await MockOnshapePart.findOne({ _id: id, companyId: ent.onshapeCompanyId });
  if (!part) return fail("Mock part not found", 404);

  part.properties = { ...(part.properties || {}), ...parsed.data.properties };
  part.markModified("properties");
  await part.save();

  if (!parsed.data.fireWebhook) {
    return ok({ saved: true, webhook: null });
  }

  const payload = {
    timestamp: new Date().toISOString(),
    event: "onshape.model.lifecycle.metadata",
    webhookId: ent.webhookId || `mock-webhook-${ent.onshapeCompanyId}`,
    messageId: `mock-msg-${Date.now()}`,
    companyId: ent.onshapeCompanyId,
    documentId: part.documentId,
    workspaceId: part.workspaceId,
    elementId: part.elementId,
    partId: part.partId,
    configuration: part.configuration,
    data: "simulated metadata change",
  };

  // Deliberately posts to the same tokenized callback URL that gets registered
  // with Onshape, so the simulator exercises the real authentication path.
  let webhookResult: unknown;
  try {
    const res = await fetch(webhookCallbackUrl(String(ent._id)), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    webhookResult = { status: res.status, body: await res.json().catch(() => null) };
  } catch (err: any) {
    webhookResult = { error: String(err?.message ?? err) };
  }

  return ok({ saved: true, payload, webhook: webhookResult });
});
