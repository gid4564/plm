import { GridFSBucket, ObjectId } from "mongodb";
import { connectDb } from "@/lib/db";

/**
 * Large binaries that do not fit in an ordinary document.
 *
 * MongoDB refuses any document over 16MB, counted after encoding — so a field
 * holding a file's bytes directly caps out well under that once the rest of
 * the document is counted too. GridFS is Mongo's own answer: it chunks a file
 * across many small documents in its own two collections (`<bucket>.files`,
 * `<bucket>.chunks`), so there is no such ceiling. Used only for what actually
 * needs it — small files still live inline, see geometry.ts's
 * INLINE_GEOMETRY_BYTES — since GridFS costs an extra round trip a normal
 * document field does not.
 */

const buckets = new Map<string, GridFSBucket>();

async function bucketFor(name: string): Promise<GridFSBucket> {
  const cached = buckets.get(name);
  if (cached) return cached;

  const conn = await connectDb();
  const db = conn.connection.db;
  if (!db) throw new Error("No database connection available for GridFS.");

  const bucket = new GridFSBucket(db, { bucketName: name });
  buckets.set(name, bucket);
  return bucket;
}

/** Store bytes under this bucket, returning the id they were saved as. */
export async function gridfsUpload(
  bucketName: string,
  filename: string,
  data: Buffer,
  metadata?: Record<string, unknown>
): Promise<ObjectId> {
  const bucket = await bucketFor(bucketName);
  return new Promise((resolve, reject) => {
    const upload = bucket.openUploadStream(filename, { metadata });
    upload.on("error", reject);
    upload.on("finish", () => resolve(upload.id as ObjectId));
    upload.end(data);
  });
}

/**
 * Read a whole file back into memory.
 *
 * Buffered rather than streamed to the eventual HTTP response: the files this
 * serves are large mechanical assemblies, not video — tens of megabytes, not
 * gigabytes — and buffering keeps the serving route the same shape whether a
 * model came from GridFS or an inline field. Resolves to an empty buffer for
 * an id that does not exist, matching geometryBytes' own "no bytes" contract,
 * rather than throwing on what is usually just a stale reference.
 */
export async function gridfsDownload(bucketName: string, id: ObjectId): Promise<Buffer> {
  const bucket = await bucketFor(bucketName);
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    const stream = bucket.openDownloadStream(id);
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", () => resolve(Buffer.alloc(0)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Remove a file. Never throws — GridFS delete refuses an id it does not have,
 * and a re-capture that is replacing an old file must not fail the whole
 * capture over a cleanup step, at worst leaving one orphaned file.
 */
export async function gridfsDelete(bucketName: string, id: ObjectId | string): Promise<void> {
  try {
    const bucket = await bucketFor(bucketName);
    await bucket.delete(typeof id === "string" ? new ObjectId(id) : id);
  } catch {
    // Already gone, or never existed — either way, nothing left to do.
  }
}
