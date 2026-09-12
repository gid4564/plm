import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Enterprise, MockOnshapePart } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForUser } from "@/lib/onshape/factory";
import { isMock, webhookCallbackUrl } from "@/lib/onshape/oauth";
import { handler, ok, fail } from "@/lib/api";

const Body = z.object({
  /** Mock part document ids to put in the release candidate. */
  partIds: z.array(z.string().min(1)).min(1).max(50),
  /** Fire the webhook after creating it — i.e. behave like a real Onshape release. */
  fireWebhook: z.boolean().optional().default(true),
});

/**
 * The designer's "Release candidate" in the simulated Onshape.
 *
 * This is the demo's most important button, because it is the moment
 * requirement 2 begins: Onshape creates the release package, adds the active
 * drawings to it itself, and fires `onshape.workflow.transition` — and PLM has
 * to take it from there.
 *
 * The webhook is posted over real HTTP to the same tokenized callback URL that
 * gets registered with Onshape, so the receiver is exercised exactly as
 * Onshape would exercise it, including its authentication path. Calling
 * takeOverReleasePackage directly would prove much less.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  if (!isMock()) return fail("The simulator is only available when ONSHAPE_MODE=mock", 400);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  const parts: any[] = await MockOnshapePart.find({
    _id: { $in: parsed.data.partIds },
    companyId: ent.onshapeCompanyId,
  }).lean();

  if (!parts.length) return fail("None of those parts exist in the mock tenant.", 404);

  const client = await clientForUser(s.userId);
  const wfid = ent.onshapeReleaseWorkflowId
    || (await client.getReleaseWorkflow(ent.onshapeCompanyId))?.id
    || "mock-workflow";

  const pkg = await client.createReleasePackage(wfid, {
    // Onshape assigns the changeOrderId itself; a caller cannot supply one.
    // PLM allocates its own number when it adopts the package, which is what
    // distinguishes the takeover path from a release raised in PLM.
    items: parts.map((p) => ({
      documentId: p.documentId,
      elementId: p.elementId,
      partId: p.partId,
    })),
  });

  if (!parsed.data.fireWebhook) {
    return ok({ package: { rpid: pkg.id, state: pkg.state, items: pkg.items.length }, webhook: null });
  }

  const payload = {
    timestamp: new Date().toISOString(),
    event: "onshape.workflow.transition",
    webhookId: ent.webhookId || `mock-webhook-${ent.onshapeCompanyId}`,
    messageId: `mock-msg-${Date.now()}`,
    companyId: ent.onshapeCompanyId,
    // The field PLM reads to find the package. Onshape's own payload shape for
    // this event is undocumented — see the note on releasePackageIdFrom in the
    // webhook receiver — so the simulator sends the most explicit form and the
    // receiver accepts several.
    objectType: "RELEASE",
    releasePackageId: pkg.id,
    workflowObjectId: pkg.id,
    state: pkg.state,
    documentId: parts[0].documentId,
  };

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

  return ok({
    package: {
      rpid: pkg.id,
      state: pkg.state,
      items: pkg.items.length,
      drawings: pkg.items.filter((i) => i.elementType === "DRAWING").length,
    },
    payload,
    webhook: webhookResult,
  });
});
