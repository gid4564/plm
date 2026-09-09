import fs from "node:fs";
import path from "node:path";
import { handler, ok } from "@/lib/api";

/**
 * Report which build is running.
 *
 * Deployment problems are easy to mistake for code problems — a fix that looks
 * absent is often just a bundle that was never shipped. This makes that
 * distinction a single request. Unauthenticated on purpose: it exposes nothing
 * beyond a build id.
 */
export const GET = handler(async () => {
  let build: Record<string, unknown> = { buildId: "dev", sourceHash: "dev" };
  try {
    const p = path.resolve(process.cwd(), "build-info.json");
    if (fs.existsSync(p)) build = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* fall through to the dev placeholder */
  }
  return ok({ ...build, node: process.version, mode: process.env.ONSHAPE_MODE || "mock" });
});
