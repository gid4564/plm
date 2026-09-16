import { connectDb } from "@/lib/db";
import { Favorite, Part, Task } from "@/lib/models";
import { columnForTask } from "@/lib/tasks";

/**
 * A personal shortlist, not a shared one.
 *
 * Favoriting is per user: what one person wants to keep an eye on says
 * nothing about the object itself, and it must not appear or disappear on a
 * colleague's dashboard because they happen to share an enterprise.
 */

export type FavoriteKind = "part" | "task";

/** Whether one object is on this user's list, for a detail view's own toggle. */
export async function isFavorited(userId: string, kind: FavoriteKind, targetId: string): Promise<boolean> {
  await connectDb();
  return Boolean(await Favorite.exists({ userId, kind, targetId }));
}

/** Adds a star. Idempotent — starring something twice is one row, not an error. */
export async function addFavorite(
  enterpriseId: string, userId: string, kind: FavoriteKind, targetId: string
): Promise<void> {
  await connectDb();
  await Favorite.updateOne(
    { userId, kind, targetId },
    { $setOnInsert: { enterpriseId, userId, kind, targetId } },
    { upsert: true }
  );
}

/** Removes a star. A no-op, not an error, if it was never starred. */
export async function removeFavorite(userId: string, kind: FavoriteKind, targetId: string): Promise<void> {
  await connectDb();
  await Favorite.deleteOne({ userId, kind, targetId });
}

export type FavoriteRow =
  | {
      kind: "part";
      id: string;
      favoriteId: string;
      number: string | null;
      name: string;
      partKind: "part" | "assembly";
      lifecycleState: string;
      revision: string;
      iteration: number;
      productName: string;
      createdAt: string;
    }
  | {
      kind: "task";
      id: string;
      favoriteId: string;
      name: string;
      state: string;
      column: string;
      taskType: string;
      createdAt: string;
    };

/**
 * This user's favorites, resolved for display.
 *
 * A star on something since deleted is dropped rather than shown as a broken
 * row — the favorite row itself is left alone, so it resolves again if the
 * object comes back (a part removed and re-synced keeps its id).
 */
export async function listFavorites(enterpriseId: string, userId: string): Promise<FavoriteRow[]> {
  await connectDb();

  const stars: any[] = await Favorite.find({ enterpriseId, userId }).sort({ createdAt: -1 }).lean();
  if (!stars.length) return [];

  const partIds = stars.filter((f) => f.kind === "part").map((f) => f.targetId);
  const taskIds = stars.filter((f) => f.kind === "task").map((f) => f.targetId);

  const [parts, tasks] = await Promise.all([
    partIds.length
      ? Part.find({ _id: { $in: partIds } })
          .select("number name kind lifecycleState revision iteration productName")
          .lean()
      : [],
    taskIds.length ? Task.find({ _id: { $in: taskIds } }).lean() : [],
  ]);
  const partById = new Map(parts.map((p: any) => [String(p._id), p]));
  const taskById = new Map(tasks.map((t: any) => [String(t._id), t]));

  const rows: FavoriteRow[] = [];
  for (const f of stars) {
    const targetId = String(f.targetId);
    const createdAt = (f.createdAt ?? new Date()).toISOString?.() ?? String(f.createdAt);
    if (f.kind === "part") {
      const p = partById.get(targetId);
      if (!p) continue;
      rows.push({
        kind: "part",
        id: targetId,
        favoriteId: String(f._id),
        number: p.number ?? null,
        name: p.name ?? "",
        partKind: p.kind === "assembly" ? "assembly" : "part",
        lifecycleState: p.lifecycleState ?? "",
        revision: p.revision ?? "",
        iteration: p.iteration ?? 1,
        productName: p.productName ?? "",
        createdAt,
      });
    } else {
      const t = taskById.get(targetId);
      if (!t) continue;
      rows.push({
        kind: "task",
        id: targetId,
        favoriteId: String(f._id),
        name: t.name || "(untitled task)",
        state: t.state ?? "",
        column: columnForTask(t),
        taskType: t.taskType ?? "",
        createdAt,
      });
    }
  }
  return rows;
}
