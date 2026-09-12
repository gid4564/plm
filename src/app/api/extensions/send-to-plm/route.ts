import { connectDb } from "@/lib/db";
import { Part } from "@/lib/models";
import { authenticateBearer } from "@/lib/oauth-server";
import { clientForUser } from "@/lib/onshape/factory";
import { kindForElementType, normalizeConfiguration, syncPartFromOnshape } from "@/lib/sync";
import { baseUrl } from "@/lib/onshape/oauth";
import { readExtensionRequest } from "@/lib/onshape/extension-request";
import { currentProductFor } from "@/lib/products";
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
async function sendToPlm(req: Request): Promise<Response> {
  const identity = await authenticateBearer(req);
  if (!identity) {
    return fail(
      "Not authorized. This endpoint expects an OAuth bearer token issued by this PLM " +
      "instance — grant the extension External access in Onshape.",
      401
    );
  }

  /*
   * Body or query, either encoding — see lib/onshape/extension-request.ts.
   * Shared with the numbering extension so the two read their input
   * identically; they were separate implementations, and only one of them
   * handled a context arriving in the URL.
   */
  const ext = await readExtensionRequest(req);
  const read = (key: string) => ext.read(key);

  console.log(`[PLM] send-to-plm in: user=${identity.userId} | ${ext.describe()}`);

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
    /*
     * Name both places the context can come from, because which one is at fault
     * depends on how the extension was registered — and the person reading this
     * is looking at the Developer Portal, not at this code.
     */
    return fail(
      "Onshape did not supply a document and element. For a GET extension, check the " +
      "Action URL includes the {$documentId} and {$elementId} placeholders; for POST, " +
      "check the Action Body does. Placeholders that arrive unsubstituted are treated " +
      "as absent, which is the same symptom.",
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
      /*
       * Filed into the product this person is working in.
       *
       * A deliberate action has somebody present to have an intention, so it is
       * honoured. An automatic path — a webhook, a release takeover — has
       * nobody to ask and falls back to Unassigned rather than inheriting
       * whatever product the integration account last had selected.
       */
      productId: (await currentProductFor(identity.userId))?.productId ?? null,
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
}

/*
 * Both verbs, because the Developer Portal makes the caller choose.
 *
 * A context-menu extension is registered with an explicit GET or POST, and
 * picking the one the route does not export produces a 405 before any of the
 * code above runs — a failure that looks like a broken endpoint rather than a
 * misconfigured menu item. Everything here is read from the query string when
 * it is not in a body, so both work identically.
 *
 * POST is the better choice where the form allows it: this creates a PLM object
 * and writes a part number back to Onshape, which is not what GET is for. GET is
 * safe rather than merely tolerated, though, because the operation is
 * idempotent — a second call reports the number that already exists instead of
 * allocating another. That property is what makes a prefetch, a double-click or
 * a retry harmless.
 */
export const POST = handler(sendToPlm);
export const GET = handler(sendToPlm);
