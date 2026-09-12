import { requireSession } from "@/lib/auth/session";
import { clientForUser } from "@/lib/onshape/factory";
import { parseOnshapeUrl } from "@/lib/onshape/bom";
import { annotateTracked, assessLine, describeAssembly, importableLines, MAX_IMPORT } from "@/lib/bom-import";
import { handler, ok, fail } from "@/lib/api";
import type { AssemblyCoords } from "@/lib/onshape/types";

/**
 * Read the bill of materials of an assembly.
 *
 * Accepts either a pasted Onshape URL or explicit ids, because the two entry
 * points are a person copying a link out of the browser bar and the Onshape
 * panel handing over the context it already has.
 */
export const GET = handler(async (req: Request) => {
  const s = await requireSession();
  const p = new URL(req.url).searchParams;

  let coords: AssemblyCoords | null = null;

  const pasted = p.get("url");
  if (pasted) {
    const parsed = parseOnshapeUrl(pasted);
    if (!parsed) {
      return fail(
        "That does not look like an Onshape assembly link. Open the assembly in Onshape and " +
        "copy the address from the browser bar — it should contain /documents/…/w/…/e/….",
        422
      );
    }
    coords = parsed;
  } else {
    const documentId = p.get("documentId") || "";
    const elementId = p.get("elementId") || "";
    if (!documentId || !elementId) return fail("Provide an Onshape URL, or documentId and elementId.", 422);
    coords = {
      documentId,
      elementId,
      workspaceId: p.get("workspaceId") || null,
      versionId: p.get("versionId") || null,
    };
  }

  if (!coords.workspaceId && !coords.versionId) {
    return fail("The link is missing a workspace or version. Copy it from an open assembly tab.", 422);
  }

  const multiLevel = p.get("multiLevel") !== "0";
  const client = await clientForUser(s.userId);
  const assembly = await describeAssembly(client, coords);

  // Onshape answers a BOM request on a Part Studio with an opaque error. Saying
  // which tab was actually selected is more use than relaying that.
  const elementType = assembly.elementType;
  if (elementType && elementType !== "ASSEMBLY") {
    return fail(
      `"${assembly.elementName || coords.elementId}" is ${elementType === "PARTSTUDIO" ? "a Part Studio" : `a ${elementType}`}, ` +
      `not an assembly. Open the assembly tab and copy its link. Individual parts are synced from the PLM panel instead.`,
      409
    );
  }

  // A BOM read that fails is never a fault in PLM: either the coordinates
  // are wrong, the account cannot see the document, or Onshape refused. Relay
  // the reason with a status that says so, rather than a 500 that buries a
  // useful message in a server error.
  let table;
  try {
    table = await client.getAssemblyBom(coords, { multiLevel });
  } catch (err: any) {
    const message = String(err?.message ?? err);
    return fail(message, client.mode === "mock" ? 409 : 502);
  }

  const tracked = await annotateTracked(s.enterpriseId, table.lines);

  return ok({
    assembly,
    multiLevel,
    maxImport: MAX_IMPORT,
    // Reported so a payload shape this parser has not met is visible in the UI
    // rather than looking like an empty assembly.
    shape: table.shape,
    headers: table.headers,
    importable: importableLines(table).length,
    // Surfaced so an unmapped column reads as a parsing problem rather than as
    // an assembly whose parts all happen to be unnumbered.
    lines: table.lines.map((l) => ({
      key: l.key,
      quantity: l.quantity,
      partNumber: l.partNumber,
      name: l.name,
      description: l.description,
      material: l.material,
      revision: l.revision,
      state: l.state,
      indentLevel: l.indentLevel,
      importable: assessLine(l).importable,
      unresolvable: assessLine(l).reason,
      tracked: tracked.get(l.key) ?? null,
    })),
  });
});
