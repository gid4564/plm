import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { Shell } from "@/components/Nav";
import { Alert } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Renders docs/MANUAL.md.
 *
 * Read from disk at request time rather than bundled, so the manual can be
 * corrected on the server without rebuilding and redeploying. The file is
 * authored by us and ships inside the release, so its HTML is trusted.
 */
function readManual(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "docs/MANUAL.md"),  // release bundle
    path.resolve(process.cwd(), "MANUAL.md"),       // flat layout
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    } catch {
      /* try the next location */
    }
  }
  return null;
}

export default async function ManualPage() {
  const md = readManual();

  return (
    <Shell>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        {!md ? (
          <Alert kind="warn">
            MANUAL.md was not found. It ships in the release bundle at{" "}
            <code>docs/MANUAL.md</code> — check it was extracted alongside{" "}
            <code>server.js</code>.
          </Alert>
        ) : (
          <article className="manual" dangerouslySetInnerHTML={{ __html: await marked.parse(md) }} />
        )}
      </div>
    </Shell>
  );
}
