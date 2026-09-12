import { connectDb } from "@/lib/db";
import { Drawing, Part } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { kindForElementType, normalizeConfiguration, plainAttributes, syncPartFromOnshape } from "@/lib/sync";
import { clientForUser } from "@/lib/onshape/factory";
import { listDefinitions, missingForRelease } from "@/lib/attributes";
import { tasksForPart } from "@/lib/tasks";
import { currentProductFor } from "@/lib/products";
import { handler, ok, fail } from "@/lib/api";

/**
 * Resolve an Onshape part or assembly to its PLM object — the panel's entry point.
 *
 * ?sync=1 creates the object on the spot if PLM has never seen it, which is
 * what makes the panel useful before any webhook has fired.
 */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  await connectDb();

  const p = new URL(req.url).searchParams;

  // Second line of defence against unsubstituted Onshape {$token} placeholders
  // arriving from the panel. See the note in app/panel/page.tsx.
  const clean = (v: string | null) => (v && /^\{\$.*\}$/.test(v) ? null : v);

  const documentId = clean(p.get("documentId")) || "";
  const elementId = clean(p.get("elementId")) || "";
  const partId = clean(p.get("partId")) || "";
  const rawConfiguration = clean(p.get("configuration")) || "default";
  const workspaceId = clean(p.get("workspaceId"));
  const versionId = clean(p.get("versionId"));

  if (!documentId || !elementId) {
    return fail("documentId and elementId are both required", 422);
  }

  // Must match exactly how the sync engine keys the record, or the panel will
  // miss an existing object and create a second one.
  const configuration = await normalizeConfiguration(s.enterpriseId, rawConfiguration);
  const identity = { enterpriseId: s.enterpriseId, documentId, elementId, partId, configuration };
  let part: any = await Part.findOne(identity).lean();

  if (!part && p.get("sync") === "1") {
    /*
     * Establish what the panel is actually pointing at before creating anything.
     *
     * Onshape resolves {$documentId} and {$elementId} to the *assembly's* tab
     * while {$partId} names the selected instance. PLM tracks assemblies as
     * objects in their own right, so an assembly panel is legitimate here —
     * but an assembly tab *with* a partId is an instance of a part defined in
     * a Part Studio, and filing that under the assembly element would create a
     * second PLM object for a part already tracked. Refuse that one case.
     */
    const client = await clientForUser(s.userId);
    const el = await client.getElementInfo({
      documentId, elementId, partId, configuration, workspaceId, versionId,
    });

    const kind = el?.elementType ? kindForElementType(el.elementType) : null;

    if (el?.elementType && !kind) {
      return fail(
        `This panel syncs parts and assemblies. The selected item is in "${el.name}", ` +
        `which is a ${el.elementType}. Drawings reach PLM with a release package rather ` +
        `than through the panel.`,
        409
      );
    }

    if (kind === "assembly" && partId) {
      return fail(
        `"${el?.name}" is an Assembly and a part inside it is selected. That part is ` +
        `defined in a Part Studio — sync it there, or sync the assembly itself to bring ` +
        `in its structure.`,
        409
      );
    }

    // sync=1 is only ever set by a deliberate action — the panel's Sync to PLM
    // button — so this is one of the paths allowed to allocate a PLM number.
    const result = await syncPartFromOnshape(
      s.enterpriseId,
      { documentId, elementId, partId, configuration, workspaceId, versionId },
      {
        trigger: "panel:sync",
        create: true,
        createdBy: { userId: s.userId, email: s.email },
        kind: kind ?? undefined,
        /*
         * Filed into the product this person is working in.
         *
         * A deliberate action has somebody present to have an intention, so it is
         * honoured. An automatic path — a webhook, a release takeover — has
         * nobody to ask and falls back to Unassigned rather than inheriting
         * whatever product the integration account last had selected.
         */
        productId: (await currentProductFor(s.userId))?.productId ?? null,
      }
    );

    if (!result.partId) {
      return fail(
        `Onshape would not let PLM track this: ${result.action.replace(/-/g, " ")}.`,
        409
      );
    }

    part = await Part.findById(result.partId).lean();
  }

  if (!part) return ok({ part: null, known: false });

  const defs = await listDefinitions(s.enterpriseId, "PART");
  const attributes = plainAttributes(part.attributes);
  const drawings = await Drawing.find({ partIds: part._id })
    .select("number name revision lifecycleState currentFileId")
    .lean();
  /*
   * Tasks, so the panel inside Onshape can say there is work outstanding.
   *
   * Worth the query precisely here: somebody in Onshape looking at this part
   * is the person most likely to be about to change it, and the one most
   * helped by knowing a task has already asked for something.
   */
  const tasks = await tasksForPart(s.enterpriseId, String(part._id));

  return ok({
    known: true,
    tasks,
    openTaskCount: tasks.filter((t) => t.open).length,
    part: {
      id: String(part._id),
      number: part.number,
      name: part.name,
      kind: part.kind,
      revision: part.revision || "",
      iteration: part.iteration ?? 1,
      lifecycleState: part.lifecycleState,
      productId: part.productId ? String(part.productId) : null,
      productName: part.productName || "",
      onshapeState: part.onshapeState || "",
      attributes,
      documentName: part.documentName,
      elementName: part.elementName,
      pushPending: part.pushPending,
      writeBackBlocked: part.writeBackBlocked ?? null,
      lastPushError: part.lastPushError,
      lastSyncedFromOnshapeAt: part.lastSyncedFromOnshapeAt,
      lastPushedToOnshapeAt: part.lastPushedToOnshapeAt,
    },
    /*
     * The panel edits attributes too, so it needs the schema — and the same
     * server-computed editability the detail page gets. A panel that decided
     * for itself which fields are locked would be a second implementation of
     * the governance rules.
     */
    definitions: defs.map((d) => ({
      key: d.key,
      label: d.label,
      dataType: d.dataType,
      enumValues: d.enumValues ?? [],
      unit: d.unit ?? "",
      group: d.group ?? "",
      order: d.order ?? 100,
      requiredForRelease: Boolean(d.requiredForRelease),
      owner: d.owner ?? "onshape",
      editable:
        (d.editableInStates ?? []).length === 0
          ? !(d.frozenAtRelease && ["Released", "Obsolete"].includes(String(part.lifecycleState)))
          : (d.editableInStates ?? []).includes(String(part.lifecycleState)),
    })),
    missingForRelease: missingForRelease(defs, attributes),
    drawings: drawings.map((d: any) => ({
      id: String(d._id),
      number: d.number,
      name: d.name,
      revision: d.revision || "",
      lifecycleState: d.lifecycleState,
      currentFileId: d.currentFileId ? String(d.currentFileId) : null,
    })),
  });
});
