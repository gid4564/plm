import mongoose from "mongoose";

/**
 * Next dev-mode hot reload re-evaluates modules, so the connection is cached on
 * globalThis to avoid opening a new pool on every reload.
 */
declare global {
  var __plmMongoose: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } | undefined;
}

const cached = globalThis.__plmMongoose ?? { conn: null, promise: null };
globalThis.__plmMongoose = cached;

export async function connectDb(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Copy .env.example to .env.local and fill it in.");

  if (!cached.promise) {
    cached.promise = mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB || "plm",
      serverSelectionTimeoutMS: 10_000,
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
