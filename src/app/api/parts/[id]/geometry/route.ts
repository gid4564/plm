import { connectDb } from "@/lib/db";
import { Part, PartGeometry } from "@/lib/models";
import { requireSession } from "@/lib/auth/session";
import { geometryBytes } from "@/lib/geometry";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The stored glTF for a part, as a file.
 *
 * `?revision=B` picks one; without it the newest capture is served, which is
 * what a viewer on the part page wants.
 *
 * Deliberately not wrapped in the JSON `handler` used elsewhere: this returns
 * bytes, and a JSON envelope around a binary is no use to a <model-viewer> or
 * to somebody saving the file.
 */
export async function GET(req: Request, ctx: Ctx) {
  const s = await requireSession();
  const { id } = await ctx.params;
  await connectDb();

  /*
   * The part is checked first, and scoped to the caller's enterprise. Without
   * it, a geometry id from another tenant would be served on the strength of
   * knowing a part id.
   */
  const part: any = await Part.findOne({ _id: id, enterpriseId: s.enterpriseId })
    .select("_id number")
    .lean();
  if (!part) return new Response("Not found", { status: 404 });

  const wanted = new URL(req.url).searchParams.get("revision");
  const filter: Record<string, unknown> = { enterpriseId: s.enterpriseId, partId: id };
  if (wanted) filter.revision = wanted;

  const row: any = await PartGeometry.findOne(filter)
    .sort({ revision: -1, createdAt: -1 })
    .lean();

  /*
   * Decoded rather than trusted. See geometryBytes: a lean() read hands back a
   * BSON Binary whose `.length` is a function — always truthy — so checking
   * the raw field would let an empty row through as a valid model.
   */
  const bytes = geometryBytes(row?.data);

  if (!bytes.length) {
    /*
     * 404 with the reason in the body. A capture that failed and one never
     * attempted are different situations, and the person looking at a missing
     * model is the person who needs to know which.
     */
    return new Response(
      row?.failureReason
        ? `No 3D model stored: ${row.failureReason}`
        : "No 3D model has been captured for this part.",
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const name =
    `${part.number || "part"}${row.revision ? `-rev-${row.revision}` : ""}.glb`
      .replace(/[^A-Za-z0-9._-]+/g, "-");

  /*
   * A fresh Uint8Array view, because Response's typing does not accept a Node
   * Buffer directly even though it is one at runtime.
   */
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": row.contentType || "model/gltf-binary",
      "Content-Length": String(bytes.length),
      /*
       * Inline, so a viewer can load it in place; the filename is still there
       * for anyone who saves it. Private and immutable: a captured revision
       * never changes, but it is one tenant's data and must not be shared.
       */
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
