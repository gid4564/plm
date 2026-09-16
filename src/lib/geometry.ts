import { connectDb } from "@/lib/db";
import { ActivityLog, Enterprise, Part, PartGeometry } from "@/lib/models";
import { gridfsDelete, gridfsDownload, gridfsUpload } from "@/lib/gridfs";
import { looksLikeZip, unpackGltfZip } from "@/lib/onshape/gltf-package";
import type { OnshapeClient, PartCoords } from "@/lib/onshape/types";

/** The GridFS bucket every captured model larger than INLINE_GEOMETRY_BYTES lives in. */
const GEOMETRY_BUCKET = "part-geometry";

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
 * Below this, a captured glTF is stored inline on the PartGeometry document
 * itself. MongoDB refuses any document over 16MB, and it refuses it with an
 * error about BSON size that says nothing about geometry — so this stays
 * comfortably under that, the document also carries its own fields and Mongo
 * measures the encoded total. Above it, the bytes go to GridFS instead (see
 * gridfs.ts), which has no such ceiling.
 */
const INLINE_GEOMETRY_BYTES = 12 * 1024 * 1024;

/**
 * The largest glTF PLM will store at all, in bytes.
 *
 * A dense assembly export can legitimately run to tens of megabytes — the
 * limit that used to sit at 12MB, matching MongoDB's per-document ceiling,
 * refused real assemblies for no reason once GridFS removed the reason it
 * existed. 100MB is not a technical ceiling — GridFS itself has none — it is
 * a sanity bound: an Onshape export past this is far more likely to be a
 * badly-tessellated mesh than a model worth keeping a full copy of, and PLM's
 * own database should not grow without any bound at all.
 */
export const MAX_GEOMETRY_BYTES = 100 * 1024 * 1024;

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

/**
 * The bytes of a stored geometry row, wherever they actually live.
 *
 * The one thing every reader of a PartGeometry row has to get right: check
 * gridfsFileId first, and only fall back to the inline field when it is
 * unset. geometryBytes alone is correct for a row captured before GridFS
 * support existed, or one small enough to have stayed inline — but silently
 * wrong for a large one, where the inline field is deliberately null and the
 * real bytes are in GridFS. This is what the serving route and anything else
 * that needs the actual model should call.
 */
export async function readGeometryBytes(
  row: { data?: unknown; gridfsFileId?: unknown } | null | undefined
): Promise<Buffer> {
  if (!row) return Buffer.alloc(0);
  if (row.gridfsFileId) {
    return gridfsDownload(GEOMETRY_BUCKET, row.gridfsFileId as any);
  }
  return geometryBytes(row.data);
}

/**
 * What the bytes Onshape sent actually are.
 *
 * Asked rather than assumed. The endpoint offers GLB and glTF-JSON at equal
 * quality values and PLM requests GLB explicitly, but content negotiation is
 * the server's to decide — and a 200 carrying an HTML error page from a
 * gateway is a shape this integration has met before. Storing one as "a model"
 * would put a file on a part record that no viewer can open, with nothing
 * saying why.
 *
 * Returns null when it is neither, which the caller turns into a refusal.
 */
export function detectGltfFormat(bytes: Buffer): "glb" | "gltf-json" | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "glTF") return "glb";

  /* The JSON form: a glTF asset object. Sniffed from the head, not parsed. */
  const head = bytes.subarray(0, 512).toString("utf8").trimStart();
  if (head.startsWith("{") && /"asset"\s*:/.test(head)) return "gltf-json";

  return null;
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
    // Whatever this row previously held — inline or in GridFS — a failure
    // must not leave it behind looking current. See the matching cleanup on
    // the success path below for why a GridFS file needs an explicit delete
    // that an inline field does not.
    const existing: any = await PartGeometry.findOne(key).select("gridfsFileId").lean();
    if (existing?.gridfsFileId) await gridfsDelete(GEOMETRY_BUCKET, existing.gridfsFileId);

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
        $unset: { data: "", gridfsFileId: "", capturedAt: "" },
        $setOnInsert: { size: 0 },
      },
      { upsert: true }
    );
    return { ok: false, bytes: 0, reason };
  };

  try {
    const out = await client.exportGltf(coords, { isAssembly: opts.isAssembly });
    let data = out.data;
    let repacked = false;

    /*
     * An assembly export goes through a translation job, and Onshape cannot
     * always hand that back as one binary file — when it falls back to the
     * loose glTF form (a JSON file, a separate .bin, loose textures), a
     * translation's result can still only be one download, so the whole
     * folder arrives zipped instead. PLM keeps one Buffer per revision, so
     * that has to become a single GLB before anything past this point can
     * treat it as a model at all. See gltf-package.ts for what "unpack"
     * actually does.
     */
    if (looksLikeZip(data)) {
      try {
        data = await unpackGltfZip(data);
        repacked = true;
      } catch (err: any) {
        return await fail(
          `Onshape returned a zip instead of a glTF file, and it could not be repacked ` +
          `into one: ${String(err?.message ?? err)}`
        );
      }
    }

    const bytes = data.length;

    if (!bytes) return await fail("Onshape returned an empty glTF.");

    if (bytes > MAX_GEOMETRY_BYTES) {
      return await fail(
        `The glTF is ${(bytes / 1024 / 1024).toFixed(1)}MB, over PLM's ` +
        `${(MAX_GEOMETRY_BYTES / 1024 / 1024).toFixed(0)}MB limit for a stored model. ` +
        `It is still in Onshape — export it there if you need it.`
      );
    }

    /*
     * Verified, not assumed — see detectGltfFormat. A gateway's HTML error
     * page arrives with a 200 and a plausible length.
     *
     * After the size check, deliberately: an oversized REAL model is the
     * common case, and "this is 18MB, over the limit" is a far more useful
     * thing to be told than "this is not a glTF" — which is true of an
     * oversized buffer too, and says nothing anybody can act on.
     */
    const format = detectGltfFormat(data);
    if (!format) {
      return await fail(
        `Onshape returned ${bytes} bytes that are not a glTF file ` +
        `(content type "${out.contentType || "unknown"}"). Nothing was stored.`
      );
    }

    /*
     * Whichever this capture replaces — the previous revision-"" workspace
     * snapshot, or a retry of this same revision — its old GridFS file (if
     * it had one) has to go before the row is overwritten, or it becomes
     * orphaned storage nothing ever points at again.
     */
    const previous: any = await PartGeometry.findOne(key).select("gridfsFileId").lean();
    if (previous?.gridfsFileId) await gridfsDelete(GEOMETRY_BUCKET, previous.gridfsFileId);

    const useGridfs = bytes > INLINE_GEOMETRY_BYTES;
    const gridfsFileId = useGridfs
      ? await gridfsUpload(GEOMETRY_BUCKET, `${partId}-${opts.revision || "current"}.glb`, data)
      : null;

    await PartGeometry.updateOne(
      key,
      {
        $set: {
          ...key,
          // Never both: a model living in GridFS has nothing inline, and
          // vice versa — see the field comment on the schema.
          data: useGridfs ? null : data,
          gridfsFileId,
          size: bytes,
          /*
           * The format that ARRIVED. Both are viewable, but the stored content
           * type has to describe the bytes or the browser is handed a lie.
           */
          contentType: format === "glb" ? "model/gltf-binary" : "model/gltf+json",
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
        `(${format === "glb" ? "GLB" : "glTF-JSON"}, ${(bytes / 1024).toFixed(0)} KB` +
        `${out.via === "translation" ? ", via a translation job" : ""}` +
        `${repacked ? ", repacked from Onshape's zipped export" : ""}` +
        `${useGridfs ? ", stored in GridFS" : ""}).`,
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
 * Capture what a part currently looks like, before any release exists.
 *
 * Stored as the empty-revision row — see the `revision` field on
 * PartGeometry, which reserves "" for exactly this. It is what lets a demo (or
 * anyone browsing an in-work part) see a model right away instead of a blank
 * panel until the first release. captureReleasedGeometry then adds an
 * immutable row per revision once the part actually is released, so this row
 * keeps moving while those stay fixed — and once a released row exists, it
 * sorts ahead of this one everywhere PLM lists geometry.
 *
 * Same never-throws contract as captureReleasedGeometry: a sync must not fail
 * because a mesh export did.
 */
export async function captureWorkspaceGeometry(
  client: OnshapeClient,
  enterpriseId: string,
  partId: string,
  coords: PartCoords,
  opts: { isAssembly?: boolean } = {}
): Promise<CaptureResult> {
  return captureReleasedGeometry(client, enterpriseId, partId, coords, {
    revision: "",
    releaseId: null,
    isAssembly: opts.isAssembly,
  });
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
