import { z } from "zod";
import { connectDb } from "@/lib/db";
import { ActivityLog, Enterprise, User } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { clientForUser } from "@/lib/onshape/factory";
import { handler, ok, fail } from "@/lib/api";

export const GET = handler(async () => {
  const s = await requireSession();
  await connectDb();

  const ent: any = await Enterprise.findById(s.enterpriseId).lean();
  if (!ent) return fail("Enterprise not found", 404);

  const FIELDS =
    "email name onshapeConnectedAt onshapeEmail onshapeName onshapeUserId " +
    "onshapeTokenFailedAt onshapeTokenError";

  const service: any = ent.integrationUserId
    ? await User.findById(ent.integrationUserId).select(FIELDS).lean()
    : null;

  const candidates: any[] = await User.find({
    enterpriseId: s.enterpriseId,
    onshapeAccessToken: { $ne: null },
  }).select(FIELDS).lean();

  return ok({
    name: ent.name,
    onshapeCompanyId: ent.onshapeCompanyId,
    onshapeDomain: ent.onshapeDomain ?? "",
    releaseTakeoverEnabled: Boolean(ent.releaseTakeoverEnabled),
    releaseGltfEnabled: Boolean(ent.releaseGltfEnabled),
    releasesIgnored: ent.releasesIgnored ?? 0,
    lastReleaseIgnoredAt: ent.lastReleaseIgnoredAt ?? null,
    ignoreConfigurations: ent.ignoreConfigurations !== false,
    onshapeReleaseWorkflowId: ent.onshapeReleaseWorkflowId ?? null,
    onshapeReleaseWorkflowName: ent.onshapeReleaseWorkflowName ?? "",
    webhookId: ent.webhookId ?? null,
    webhookRegisteredAt: ent.webhookRegisteredAt ?? null,
    /**
     * The Onshape account PLM acts as for the release transition.
     *
     * Named prominently because it is a setup prerequisite, not a detail:
     * Onshape restricts an approve transition to designated approvers, so this
     * account has to be one in the release workflow or every approval will be
     * refused.
     */
    /*
     * Both identities, deliberately. `email` is the PLM login that holds the
     * tokens; `onshapeEmail` is the Onshape account they authenticate as, and
     * that is the one Onshape checks against the workflow's approver list. They
     * are frequently different, which is the whole point of a service account.
     */
    serviceAccount: service
      ? {
          email: service.email,
          name: service.name ?? "",
          connectedAt: service.onshapeConnectedAt ?? null,
          onshapeEmail: service.onshapeEmail ?? null,
          onshapeName: service.onshapeName ?? null,
          onshapeUserId: service.onshapeUserId ?? null,
          /*
           * A connection that once worked is not the same as one that works.
           * Reported so Settings can say so rather than showing the timestamp
           * of a success that has since stopped being true.
           */
          tokenFailedAt: service.onshapeTokenFailedAt ?? null,
          tokenError: service.onshapeTokenError ?? null,
        }
      : null,
    serviceAccountCandidates: candidates.map((u) => ({
      id: String(u._id),
      email: u.email,
      name: u.name ?? "",
      connectedAt: u.onshapeConnectedAt ?? null,
      onshapeEmail: u.onshapeEmail ?? null,
      onshapeName: u.onshapeName ?? null,
      onshapeUserId: u.onshapeUserId ?? null,
    })),
  });
});

const Body = z.object({
  /**
   * Whether PLM takes over releases started in Onshape.
   *
   * Admin only, and off by default. Switched on, PLM begins approving and
   * rejecting real release packages on a shared tenant — that has to be
   * somebody's explicit decision.
   */
  releaseTakeoverEnabled: z.boolean().optional(),
  releaseGltfEnabled: z.boolean().optional(),
  ignoreConfigurations: z.boolean().optional(),
  /** Which connected Onshape account PLM acts as for background writes and transitions. */
  integrationUserId: z.string().min(1).optional(),
  onshapeDomain: z.string().max(200).optional(),
});

/**
 * Change enterprise-wide behaviour.
 *
 * Admin only: these decide how other people's releases are handled, which is
 * not one user's call to make.
 */
export const PATCH = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change enterprise settings", 403);

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const b = parsed.data;

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId);
  if (!ent) return fail("Enterprise not found", 404);

  if (b.releaseTakeoverEnabled !== undefined) {
    ent.releaseTakeoverEnabled = b.releaseTakeoverEnabled;
    // Enabling starts a fresh count; the old one measured a different policy.
    if (b.releaseTakeoverEnabled) {
      ent.releasesIgnored = 0;
      ent.lastReleaseIgnoredAt = null;
    }
    await ActivityLog.create({
      enterpriseId: s.enterpriseId, direction: "plm", action: "updated",
      trigger: "user-edit", ok: true,
      message:
        `${s.email} turned release takeover ` +
        `${b.releaseTakeoverEnabled ? "on" : "off"} for this enterprise`,
    });
  }

  if (b.releaseGltfEnabled !== undefined) ent.releaseGltfEnabled = b.releaseGltfEnabled;
  if (b.ignoreConfigurations !== undefined) ent.ignoreConfigurations = b.ignoreConfigurations;
  if (b.onshapeDomain !== undefined) ent.onshapeDomain = b.onshapeDomain.trim();

  if (b.integrationUserId) {
    const user: any = await User.findOne({
      _id: b.integrationUserId,
      enterpriseId: s.enterpriseId,
    }).lean();
    if (!user) return fail("That user is not in this enterprise.", 404);
    if (!user.onshapeAccessToken) {
      return fail(
        `${user.email} has not connected their Onshape account, so PLM cannot act as them. ` +
        `Ask them to sign in and press Connect Onshape.`,
        422
      );
    }
    ent.integrationUserId = user._id;
  }

  await ent.save();
  return ok({
    releaseTakeoverEnabled: ent.releaseTakeoverEnabled,
    releaseGltfEnabled: ent.releaseGltfEnabled,
    ignoreConfigurations: ent.ignoreConfigurations,
    onshapeDomain: ent.onshapeDomain,
    integrationUserId: ent.integrationUserId ? String(ent.integrationUserId) : null,
  });
});

/**
 * Discover the Onshape release workflow this enterprise releases through.
 *
 * Needed before a release can be raised from PLM, and before PLM can name the
 * transitions on a package it takes over. Kept as an explicit action rather
 * than done lazily, because a tenant with no published custom workflow gets a
 * null back — a normal state that an admin should see stated plainly rather
 * than discover when the first release fails.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  if (s.role !== "admin") return fail("Only an admin can change enterprise settings", 403);

  const { action } = (await req.json().catch(() => ({}))) as { action?: string };
  if (action !== "discover-workflow") {
    return fail(`Unknown action "${action}". Use "discover-workflow".`, 422);
  }

  await connectDb();
  const ent: any = await Enterprise.findById(s.enterpriseId);
  if (!ent) return fail("Enterprise not found", 404);

  const client = await clientForUser(s.userId);
  const wf = await client.getReleaseWorkflow(ent.onshapeCompanyId);

  if (!wf) {
    return ok({
      workflow: null,
      message:
        "Onshape reported no release workflow for this company. An enterprise needs a " +
        "published release workflow before PLM can transition its release packages — see " +
        "Onshape's Enterprise settings → Release management.",
    });
  }

  ent.onshapeReleaseWorkflowId = wf.id;
  ent.onshapeReleaseWorkflowName = wf.name;
  await ent.save();

  return ok({
    workflow: wf,
    message:
      `Found "${wf.name}". Make sure the Onshape service account PLM acts as is a ` +
      `designated approver on this workflow, or approvals will be refused.`,
  });
});
