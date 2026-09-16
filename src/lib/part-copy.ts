import { Types } from "mongoose";
import { connectDb } from "@/lib/db";
import { ActivityLog, Part, PartIteration } from "@/lib/models";
import { allocatePartNumber, plainAttributes } from "@/lib/sync";

/**
 * Copy a part, entirely inside PLM.
 *
 * The copy gets a new PLM number and starts unreleased — everything else
 * about it (name, attributes, product) carries over as a snapshot of the
 * source at this moment, since that is the point: a quick stand-in for a
 * part whose real-world identity is changing (a supplier renumbering a
 * fastener) without retyping what did not change about it.
 *
 * It deliberately keeps no link to the source's Onshape object. A copy is
 * not an alternate view of the same CAD part — Onshape has never heard of
 * it, and nothing here should ever try to sync, push to, or fetch a picture
 * from an Onshape id that does not actually name this part. See
 * `Part.plmOnly` and `writeBackBlocked` on the schema.
 *
 * This is what makes the star-release swap complete for a supplier
 * renumbering: copy the part, edit its number/vendor attribute, then swap
 * it into the BOM in place of the original — see lib/star-release.ts.
 */
export async function copyPart(
  enterpriseId: string,
  actor: { userId: string; email: string },
  sourcePartId: string
): Promise<{ id: string; number: string }> {
  await connectDb();

  const source: any = await Part.findOne({ _id: sourcePartId, enterpriseId }).lean();
  if (!source) throw new Error("Part not found.");

  const kind: "part" | "assembly" = source.kind === "assembly" ? "assembly" : "part";
  const number = await allocatePartNumber(enterpriseId, kind);

  // Generated up front so the synthetic elementId below — which has to be
  // unique per the schema's own (enterpriseId, documentId, elementId,
  // partId, configuration) index — can be derived from it in one insert.
  const newId = new Types.ObjectId();

  const copy = await Part.create({
    _id: newId,
    enterpriseId,
    documentId: "plm-only",
    elementId: `plm-only:${newId.toString()}`,
    partId: "",
    configuration: "default",
    workspaceId: null,
    versionId: null,
    documentName: "",
    elementName: "",
    plmOnly: true,
    kind,
    number,
    name: source.name ?? "",
    productId: source.productId ?? null,
    productName: source.productName ?? "",
    attributes: plainAttributes(source.attributes),
    lifecycleState: "In Work",
    revision: "",
    starCount: 0,
    iteration: 1,
    createdByUserId: actor.userId,
    createdByEmail: actor.email,
    writeBackBlocked:
      "This part was copied entirely within PLM — it has no Onshape original to sync or write back to.",
  });

  await PartIteration.create({
    enterpriseId, partId: copy._id, iteration: 1, revision: "", lifecycleState: "In Work",
    attributes: plainAttributes(copy.attributes), onshapeVersionId: null,
    cause: "copy", changedKeys: [], createdByEmail: actor.email, releaseId: null,
  }).catch(() => {});

  await ActivityLog.create({
    enterpriseId, partId: copy._id, direction: "plm", action: "created", trigger: "manual", ok: true,
    message:
      `${actor.email} copied ${source.number || source.name || "a part"} to ${number} — PLM-only, ` +
      `nothing links back to Onshape.`,
  });

  return { id: String(copy._id), number };
}
