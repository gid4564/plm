import { connectDb } from "@/lib/db";
import { ActivityLog, Enterprise, Part, PartGeometry } from "@/lib/models";
import type { OnshapeClient, PartCoords } from "@/lib/onshape/types";

/**
 * The 3D of a part, captured when it is released.
 *
 * Onshape owns the geometry; this keeps a copy of what a particular revision
 * looked like, taken from the version the release produced. That is the whole
 * value of it — a model in Onshape moves on, and "what did revision A actually
 * look like" stops being answerable the moment it does.
 *
 * Off unless the enterprise turns it on: it costs an Onshape call per released
 * item and stores a binary per revision, which is a decision for whoever runs
 * the tenant rather than something that starts happening on upgrade.
 */

/**
 * The largest glTF PLM will store, in bytes.
 *
 * MongoDB refuses a document over 16MB, and it refuses it with an error about
 * BSON size that says nothing about geometry. A part whose mesh is bigger than
 * this is a real situation — a dense assembly export easily is — so it is
 * caught here and recorded as a reason rather than thrown as a database fault.
 *
 * 12MB rather than 16: the document also carries its own fields, and Mongo
 * measures the encoded total.
 */
export const MAX_GEOMETRY_BYTES = 12 * 1024 * 1024;

/**
 * The bytes of a stored geometry row, whatever shape they came back in.
 *
 * A lean() read returns BSON's `Binary`, not a Node Buffer, and the difference
 * is silent in the worst way: `Buffer.from(binary)` yields an EMPTY buffer
 * rather than throwing, and `binary.length` is a FUNCTION — so a truthiness
 * check on it passes for a row with no bytes at all. Served through the
 * obvious code, that is a 0-byte download and a Content-Length built from a
 * function's source.
 *
 * A hydrated (non-lean) document gives a real Buffer, so both are handled.
 */
export function geometryBytes(value: unknown): Buffer {
  if (!value) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  const inner = (value as { buffer?: unknown }).buffer;
  if (inner) return Buffer.from(inner as Uint8Array);
  return Buffer.alloc(0);
}

export type CaptureResult = {
  ok: boolean;
  bytes: number;
  reason: string | null;
};

/** Whether this enterprise wants geometry captured at all. */
export async function geometryCaptureEnabled(enterpriseId: string): Promise<boolean> {
  await connectDb();
  const ent: any = await Enterprise.findById(enterpriseId).select("releaseGltfEnabled").lean();
  return Boolean(ent?.releaseGltfEnabled);
}

/**
 * Capture one part's geometry at the revision it has just been released at.
 *
 * Never throws. A release must not fail because a mesh export did — the
 * release is the governed act and the geometry is a record kept alongside it,
 * so a failure is written down and the release proceeds. That is also why the
 * failure reason is stored rather than logged and dropped: "Onshape refused
 * this" and "nobody captured it yet" look identical on a part page otherwise.
 */
export async function captureReleasedGeometry(
  client: OnshapeClient,
  enterpriseId: string,
  partId: string,
  coords: PartCoords,
  opts: { revision: string; releaseId?: string | null; isAssembly?: boolean }
): Promise<CaptureResult> {
  await connectDb();

  const key = {
    enterpriseId,
    partId,
    revision: opts.revision || "",
  };

  const fail = async (reason: string): Promise<CaptureResult> => {
    await PartGeometry.updateOne(
      key,
      {
        $set: {
          ...key,
          failureReason: reason.slice(0, 400),
          onshapeVersionId: coords.versionId ?? null,
          releaseId: opts.releaseId ?? null,
        },
        /* No bytes, and the old ones must not linger and look current. */
        $unset: { data: "", capturedAt: "" },
        $setOnInsert: { size: 0 },
      },
      { upsert: true }
    );
    return { ok: false, bytes: 0, reason };
  };

  try {
    const out = await client.exportGltf(coords, { isAssembly: opts.isAssembly });
    const bytes = out.data.length;

    if (!bytes) return await fail("Onshape returned an empty glTF.");
    if (bytes > MAX_GEOMETRY_BYTES) {
      return await fail(
        `The glTF is ${(bytes / 1024 / 1024).toFixed(1)}MB, over PLM's ` +
        `${(MAX_GEOMETRY_BYTES / 1024 / 1024).toFixed(0)}MB limit for a stored model. ` +
        `It is still in Onshape — export it there if you need it.`
      );
    }

    await PartGeometry.updateOne(
      key,
      {
        $set: {
          ...key,
          data: out.data,
          size: bytes,
          contentType: out.contentType || "model/gltf-binary",
          onshapeVersionId: coords.versionId ?? null,
          releaseId: opts.releaseId ?? null,
          translationId: out.via === "translation" ? out.translationId ?? null : null,
          capturedAt: new Date(),
          failureReason: null,
        },
      },
      { upsert: true }
    );

    await ActivityLog.create({
      enterpriseId,
      partId,
      direction: "onshape->plm",
      action: "synced",
      trigger: "release",
      ok: true,
      message:
        `Captured the 3D model at revision ${opts.revision || "(none)"} ` +
        `(${(bytes / 1024).toFixed(0)} KB${out.via === "translation" ? ", via a translation job" : ""}).`,
    });

    return { ok: true, bytes, reason: null };
  } catch (err: any) {
    const reason = String(err?.message ?? err);
    await ActivityLog.create({
      enterpriseId,
      partId,
      direction: "onshape->plm",
      action: "error",
      trigger: "release",
      ok: false,
      message: `Could not capture the 3D model at revision ${opts.revision || "(none)"}: ${reason.slice(0, 300)}`,
    }).catch(() => {});
    return await fail(reason);
  }
}

/**
 * What PLM holds for a part, newest revision first — metadata only.
 *
 * The bytes are deliberately not selected: a part page lists what exists, and
 * loading several megabytes of mesh to render a filename would be absurd.
 */
export async function geometryForPart(enterpriseId: string, partId: string) {
  await connectDb();
  const rows: any[] = await PartGeometry.find({ enterpriseId, partId })
    .select("-data")
    .sort({ revision: -1, createdAt: -1 })
    .lean();

  return rows.map((g) => ({
    id: String(g._id),
    revision: g.revision || "",
    size: g.size ?? 0,
    contentType: g.contentType || "model/gltf-binary",
    onshapeVersionId: g.onshapeVersionId ?? null,
    releaseId: g.releaseId ? String(g.releaseId) : null,
    capturedAt: g.capturedAt ?? null,
    failureReason: g.failureReason ?? null,
  }));
}
