import { connectDb } from "@/lib/db";
import { Part } from "@/lib/models";
import { authenticateBearer } from "@/lib/oauth-server";
import { clientForUser } from "@/lib/onshape/factory";
import { kindForElementType, normalizeConfiguration, syncPartFromOnshape } from "@/lib/sync";
import { baseUrl } from "@/lib/onshape/oauth";
import { handler, ok, fail } from "@/lib/api";

/**
 * "Send to PLM" — the Action URL behind the context-menu extensions.
 *
 * Registered against three locations in the Developer Portal: the element
 * context menu, the tree context menu, and the document list context menu.
 * Onshape substitutes its {$...} tokens into the URL, calls this server to
 * server with an External OAuth bearer token, and shows the user whatever
 * message comes back.
 *
 * The distinction from the panel is worth keeping: the panel is a place to
 * work, and this is a single deliberate act. Someone right-clicks a part and
 * says "put this in PLM" — so unlike a metadata webhook, this path IS allowed
 * to create, and to allocate a PLM number.
 */
export const POST = handler(async (req: Request) => {
  const identity = await authenticateBearer(req);
  if (!identity) {
    return fail(
      "Not authorized. This endpoint expects an OAuth bearer token issued by this PLM " +
      "instance — grant the extension External access in Onshape.",
      401
    );
  }

  /*
   * Accept the context from the body or the query string.
   *
   * Onshape's action-URL contract differs by location: the part number
   * generator posts a JSON body, while a context-menu extension substitutes
   * placeholders into the URL itself. Reading both means one endpoint serves
   * every location, rather than three near-identical routes.
   */
  const url = new URL(req.url);
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;

  // Discard placeholders Onshape did not substitute — an element with no
  // configurations leaves {$configuration} verbatim, and passing that on makes
  // the follow-up metadata call fail with a 400.
  const read = (key: string): string => {
    const raw = String(body[key] ?? url.searchParams.get(key) ?? "");
    return /^\{\$.*\}$/.test(raw) ? "" : raw;
  };

  const documentId = read("documentId");
  const elementId = read("elementId");
  const partId = read("partId");
  const configurationRaw = read("configuration");

  // Onshape sends workspaceOrVersion ("w" | "v") plus a single id in some
  // contexts, and a named workspaceId in others.
  const wv = read("workspaceOrVersion");
  const wvId = read("workspaceOrVersionId");
  const workspaceId = wv === "v" ? "" : wvId || read("workspaceId");
  const versionId = wv === "v" ? wvId : read("versionId");

  if (!documentId || !elementId) {
    return fail(
      "Onshape did not supply a document and element. Check that the extension's Action " +
      "URL includes the {$documentId} and {$elementId} placeholders.",
      422
    );
  }

  await connectDb();
  const enterpriseId = identity.enterpriseId;
  const configuration = await normalizeConfiguration(enterpriseId, configurationRaw || "default");

  const existing: any = await Part.findOne({
    enterpriseId, documentId, elementId, partId: partId || "", configuration,
  }).lean();

  if (existing) {
    return ok({
      created: false,
      number: existing.number,
      url: `${baseUrl()}/parts/${existing._id}`,
      // Shown to the user by Onshape, so it has to read as a sentence rather
      // than as a status code.
      message:
        `Already in PLM as ${existing.number}` +
        `${existing.revision ? ` revision ${existing.revision}` : ""} ` +
        `(${existing.lifecycleState}).`,
    });
  }

  // Acting as the user who granted access, not the service account: this is
  // their deliberate act and the record should say so.
  const client = await clientForUser(identity.userId);

  const el = await client.getElementInfo({
    documentId, elementId, partId, configuration, workspaceId, versionId,
  });
  const kind = el?.elementType ? kindForElementType(el.elementType) : null;

  if (el?.elementType && !kind) {
    return fail(
      `"${el.name}" is a ${el.elementType}. Parts and assemblies can be sent to PLM; ` +
      `drawings arrive with a release package instead.`,
      409
    );
  }
  if (kind === "assembly" && partId) {
    return fail(
      `"${el?.name}" is an Assembly and a part inside it is selected. That part is defined ` +
      `in a Part Studio — send it from there, or send the assembly to bring in its structure.`,
      409
    );
  }

  const result = await syncPartFromOnshape(
    enterpriseId,
    { documentId, elementId, partId, configuration, workspaceId, versionId },
    {
      trigger: "extension:send-to-plm",
      client,
      create: true,
      kind: kind ?? undefined,
      // The token identifies the person who granted access, which is the best
      // available attribution for a context-menu action.
      createdBy: { userId: identity.userId, email: "" },
    }
  );

  if (!result.partId) {
    return fail(`PLM could not take this on: ${result.action.replace(/-/g, " ")}.`, 409);
  }

  return ok({
    created: result.action === "created",
    number: result.number,
    url: `${baseUrl()}/parts/${result.partId}`,
    message:
      result.action === "created"
        ? `Added to PLM as ${result.number}. Its part number has been written back to Onshape.`
        : `Updated in PLM as ${result.number}.`,
  });
});
