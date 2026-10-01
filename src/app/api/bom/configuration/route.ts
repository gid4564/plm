import { requireSession } from "@/lib/auth/session";
import { clientForUser } from "@/lib/onshape/factory";
import { handler, ok, fail } from "@/lib/api";

/**
 * The configuration dropdowns of an assembly, so the panel can offer them as
 * choices instead of a text box whose format Onshape does not forgive.
 */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  const p = new URL(req.url).searchParams;
  const documentId = p.get("documentId") || "";
  const elementId = p.get("elementId") || "";
  const workspaceId = p.get("workspaceId") || null;
  const versionId = p.get("versionId") || null;
  if (!documentId || !elementId || (!workspaceId && !versionId)) {
    return fail("documentId, elementId and a workspace or version are required.", 422);
  }

  const client = await clientForUser(s.userId);
  try {
    return ok(await client.getConfigurationDefinition({ documentId, elementId, workspaceId, versionId }));
  } catch (err: any) {
    // Cosmetic for the panel: without it the free-text field still works.
    return fail(String(err?.message ?? err), client.mode === "mock" ? 409 : 502);
  }
});
