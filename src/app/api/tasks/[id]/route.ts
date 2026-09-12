import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { connectDb } from "@/lib/db";
import { ActivityLog, Part, Task } from "@/lib/models";
import {
  columnForTask, commentOnTask, moveTaskToColumn, refreshTask, transitionTask, updateTaskFields,
} from "@/lib/tasks";
import { handler, ok, fail } from "@/lib/api";

type Ctx = { params: Promise<{ id: string }> };

/** One task, with its thread and the parts it is about. */
export const GET = handler(async (_req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;
  await connectDb();

  const t: any = await Task.findOne({ _id: id, enterpriseId: s.enterpriseId }).lean();
  if (!t) return fail("Task not found", 404);

  /* The linked parts, so a task can be acted on without leaving the page. */
  const partIds = (t.items ?? []).map((i: any) => i.partId).filter(Boolean);
  const parts: any[] = partIds.length
    ? await Part.find({ _id: { $in: partIds } })
        .select("number name kind lifecycleState revision iteration")
        .lean()
    : [];
  const partById = new Map(parts.map((p) => [String(p._id), p]));

  const logs: any[] = await ActivityLog.find({
    enterpriseId: s.enterpriseId,
    trigger: "task",
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return ok({
    task: {
      id: String(t._id),
      onshapeTaskId: t.onshapeTaskId,
      name: t.name,
      description: t.description,
      state: t.state,
      column: columnForTask(t),
      taskType: t.taskType,
      documentId: t.documentId,
      documentName: t.documentName,
      objectId: t.objectId,
      creatorEmail: t.creatorEmail,
      creatorName: t.creatorName,
      assignees: t.assignees ?? [],
      resolvedAt: t.resolvedAt,
      resolvedByEmail: t.resolvedByEmail,
      availableActions: t.availableActions ?? [],
      properties: (t.properties ?? []).map((pr: any) => ({
        propertyId: pr.propertyId, name: pr.name, value: pr.value ?? null,
        valueType: pr.valueType ?? "STRING",
        editable: Boolean(pr.editable), required: Boolean(pr.required),
        enumValues: pr.enumValues ?? [],
      })),
      commentable: Boolean(t.commentable),
      pushPending: Boolean(t.pushPending),
      lastPushError: t.lastPushError ?? null,
      lastSyncedFromOnshapeAt: t.lastSyncedFromOnshapeAt,
      items: (t.items ?? []).map((i: any) => {
        const p = i.partId ? partById.get(String(i.partId)) : null;
        return {
          label: i.label,
          partId: i.partId ? String(i.partId) : null,
          number: p?.number ?? null,
          name: p?.name ?? null,
          kind: p?.kind ?? null,
          lifecycleState: p?.lifecycleState ?? null,
          revision: p?.revision ?? "",
          iteration: p?.iteration ?? 1,
          onshapePartId: i.onshapePartId ?? "",
        };
      }),
      comments: (t.comments ?? []).map((c: any) => ({
        id: String(c._id),
        message: c.message,
        authorEmail: c.authorEmail,
        authorName: c.authorName,
        origin: c.origin,
        createdAt: c.createdAt,
        pushPending: Boolean(c.pushPending),
        pushError: c.pushError ?? null,
        plmOnly: Boolean(c.plmOnly),
        inOnshape: Boolean(c.onshapeCommentId),
      })),
    },
    logs: logs.map((l) => ({
      id: String(l._id), action: l.action, ok: l.ok, message: l.message, createdAt: l.createdAt,
    })),
    myEmail: s.email,
  });
});

const Body = z.object({
  action: z.enum(["comment", "transition", "refresh", "update", "move"]),
  message: z.string().max(4000).optional(),
  transition: z.string().max(120).optional(),
  intent: z.enum(["complete", "reject", "reopen", "start"]).optional(),
  name: z.string().max(400).optional(),
  description: z.string().max(8000).optional(),
  /** Property id -> value, for the metadata properties Onshape says are editable. */
  propertyValues: z.record(z.string(), z.unknown()).optional(),
  /** The board column a card was dropped on. */
  column: z.enum(["Open", "In Progress", "Resolved", "Rejected"]).optional(),
});

export const POST = handler(async (req: Request, ctx: Ctx) => {
  const s = await requireSession();
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Bad request", 400);
  const b = parsed.data;

  if (b.action === "refresh") return ok(await refreshTask(s.enterpriseId, id));

  if (b.action === "move") {
    if (!b.column) return fail("No column was given.", 400);
    return ok(await moveTaskToColumn(s.enterpriseId, id, b.column, { email: s.email }));
  }

  if (b.action === "update") {
    return ok(
      await updateTaskFields(
        s.enterpriseId, id,
        { name: b.name, description: b.description, propertyValues: b.propertyValues },
        { email: s.email }
      )
    );
  }

  if (b.action === "comment") {
    const r = await commentOnTask(s.enterpriseId, id, b.message ?? "", {
      userId: s.userId,
      email: s.email,
      name: s.email,
    });
    /*
     * 200 even when Onshape refused the push: the comment IS saved, and a
     * failure status would have the page discard what somebody typed. The
     * response says it is unsent, and the thread marks it.
     */
    return ok(r);
  }

  const r = await transitionTask(s.enterpriseId, id, {
    transition: b.transition,
    intent: b.intent,
    actor: { email: s.email },
  });
  return ok(r);
});
