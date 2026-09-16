import { z } from "zod";
import { connectDb } from "@/lib/db";
import { Part, Task } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { addFavorite, listFavorites, removeFavorite } from "@/lib/favorites";
import { handler, ok, fail } from "@/lib/api";

/** This user's favorite parts, assemblies and tasks, for the dashboard. */
export const GET = handler(async (_req: Request) => {
  const s = await requireSession();
  const rows = await listFavorites(s.enterpriseId, s.userId);
  return ok({ favorites: rows });
});

const Body = z.object({
  kind: z.enum(["part", "task"]),
  targetId: z.string().min(1),
});

/**
 * Not the object's own model, and not `handler`'s generic 400 — a favorite is
 * cross-cutting rather than owned by either route, and both callers need the
 * same "does this even exist, in this tenant" check before starring it.
 */
async function targetExists(enterpriseId: string, kind: "part" | "task", targetId: string): Promise<boolean> {
  await connectDb();
  const Model = kind === "part" ? Part : Task;
  return Boolean(await Model.exists({ _id: targetId, enterpriseId }));
}

export const POST = handler(async (req: Request) => {
  const s = await requireSession();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const { kind, targetId } = parsed.data;

  if (!(await targetExists(s.enterpriseId, kind, targetId))) {
    return fail(`No ${kind} with that id in this enterprise.`, 404);
  }

  await addFavorite(s.enterpriseId, s.userId, kind, targetId);
  return ok({ ok: true });
});

export const DELETE = handler(async (req: Request) => {
  const s = await requireSession();
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return fail(parsed.error.issues[0].message, 422);
  const { kind, targetId } = parsed.data;

  await removeFavorite(s.userId, kind, targetId);
  return ok({ ok: true });
});
