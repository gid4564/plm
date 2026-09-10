import { Types } from "mongoose";
import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Release } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { submitReleaseFromPlm } from "@/lib/release";
import { decodeCursor, encodeCursor } from "@/lib/pagination";
import { handler, ok, fail } from "@/lib/api";

const PAGE_SIZE = 25;

/** Releases for this enterprise, newest first. */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  await connectDb();

  const url = new URL(req.url);
  const state = url.searchParams.get("state")?.trim();
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  if (url.searchParams.get("cursor") && !cursor) {
    return fail("That page marker is not valid — start again from the first page.", 422);
  }

  const filter: Record<string, unknown> = { enterpriseId: s.enterpriseId };
  if (state && state !== "all") filter.state = state;

  const total = await Release.countDocuments(filter);

  const pageFilter = cursor
    ? {
        $and: [
          filter,
          {
            $or: [
              { updatedAt: { $lt: new Date(cursor.updatedAtMs) } },
              { updatedAt: new Date(cursor.updatedAtMs), _id: { $lt: new Types.ObjectId(cursor.id) } },
            ],
          },
        ],
      }
    : filter;

  const releases = await Release.find(pageFilter)
    .sort({ updatedAt: -1, _id: -1 })
    .limit(PAGE_SIZE)
    .lean();

  const last = releases[releases.length - 1];

  // Counted here rather than in the list component: "3 under review" is the
  // number an approver opens this page for, and it should not depend on which
  // page they happen to be looking at.
  const underReview = await Release.countDocuments({
    enterpriseId: s.enterpriseId,
    state: "Under Review",
  });

  return ok({
    total,
    underReview,
    nextCursor:
      releases.length === PAGE_SIZE && last
        ? encodeCursor({ updatedAtMs: new Date(last.updatedAt).getTime(), id: String(last._id) })
        : null,
    releases: releases.map((r: any) => ({
      id: String(r._id),
      number: r.number,
      title: r.title,
      origin: r.origin,
      state: r.state,
      onshapeState: r.onshapeState || "",
      onshapeReleasePackageId: r.onshapeReleasePackageId ?? null,
      partCount: (r.items ?? []).filter((i: any) => i.kind === "part").length,
      drawingCount: (r.items ?? []).filter((i: any) => i.kind === "drawing").length,
      validationFailureCount: (r.validationFailures ?? []).length,
      submittedByEmail: r.submittedByEmail ?? null,
      submittedAt: r.submittedAt,
      decidedByEmail: r.decidedByEmail ?? null,
      decidedAt: r.decidedAt,
      transitionError: r.transitionError ?? null,
      drawingRefreshPending: Boolean(r.drawingRefreshPending),
      updatedAt: r.updatedAt,
    })),
  });
});

const Body = z.object({
  partIds: z.array(z.string().min(1)).min(1).max(50),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
});

/**
 * Raise a release from PLM.
 *
 * The mirror image of the takeover, and the path where PLM can genuinely
 * refuse: the release does not exist yet, so a missing release-required
 * attribute blocks it rather than merely being reported to an approver.
 */
export const POST = handler(async (req: Request) => {
  const s = await requireSession();

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);

  const result = await submitReleaseFromPlm(
    s.enterpriseId,
    parsed.data.partIds,
    { userId: s.userId, email: s.email },
    { title: parsed.data.title, description: parsed.data.description }
  );

  // A validation refusal is the caller's to fix, so it is a 422 with the gaps
  // named — not a bare failure.
  if (result.action !== "opened") {
    return ok({ ok: false, ...result }, 422);
  }

  return ok({ ok: true, ...result }, 201);
});
