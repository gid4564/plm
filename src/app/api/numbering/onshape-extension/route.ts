import { connectDb } from "@/lib/db";
import { Enterprise, NumberIssuedLog } from "@/lib/models";
import { nextNumber, type NumberingType } from "@/lib/numbering";
import { authenticateBearer } from "@/lib/oauth-server";
import { readExtensionRequest } from "@/lib/onshape/extension-request";
import { handler, ok, fail } from "@/lib/api";

/**
 * The Action URL for Onshape's "Part number generator" app extension.
 *
 * Onshape calls this server-to-server whenever someone requests a number from
 * the Release candidate dialog, a properties dialog, the BOM table, or a
 * configuration table — and applies whatever `partNumber` this responds with
 * onto the part, assembly or drawing itself. PLM never writes to Onshape for
 * this: that write is Onshape's own job once it has an answer, which is the
 * whole point of using the real extension point.
 *
 * The Release candidate dialog is the important one. It is what puts a PLM
 * number on a part at the moment a release is raised, rather than after the
 * fact.
 *
 * **It is a batch endpoint.** Onshape POSTs a JSON *array* and expects an array
 * back, one answer per element, echoing the identifying fields alongside the
 * number:
 *
 *   → [ { id, documentId, elementId, workspaceId, elementType, partId }, … ]
 *   ← [ { …the same fields, partNumber: "PN-00042" }, … ]
 *
 * That shape is taken from Onshape's own reference implementation,
 * onshape-public/inventory-oauth2-app (`controllers/generator.js`), which
 * assigns `req.body` straight to a variable and reduces over it. An earlier
 * version of this route read the body as a single object and answered with a
 * single object; Onshape's array then presented as a request with no fields at
 * all, which is exactly what it looked like in the log.
 *
 * Unlike the context-menu extensions, this one offers no choice of method and no
 * Action Body in the Developer Portal — Onshape decides the payload, so there is
 * nothing to configure and nothing to get wrong.
 *
 * Authenticated by External OAuth: Onshape obtains a bearer token from PLM's own
 * token endpoint and presents it here, so the call is attributable to the PLM
 * user who granted access — which is what tells this route whose numbering
 * scheme to use.
 */
const ELEMENT_TYPE_TO_NUMBERING_TYPE: Record<string, NumberingType> = {
  PARTSTUDIO: "PART",
  ASSEMBLY: "ASSEMBLY",
  DRAWING: "DRAWING",
};

/** The fields Onshape sends and expects echoed back, per item. */
const ECHOED = ["id", "documentId", "elementId", "workspaceId", "elementType", "partId"] as const;

export const POST = handler(async (req: Request) => {
  const identity = await authenticateBearer(req);
  if (!identity) {
    console.warn("[PLM] numbering extension call rejected: missing or invalid bearer token");
    return fail(
      "Not authorized. This endpoint expects an OAuth bearer token issued by this PLM " +
      "instance — grant the extension External access in Onshape.",
      401
    );
  }

  const ext = await readExtensionRequest(req);

  console.log(
    `[PLM] numbering extension in: user=${identity.userId} | ${ext.describe()}`
  );

  if (ext.items.length === 0) {
    return fail(
      `No items arrived, so there is nothing to number. Onshape posts a JSON array of ` +
      `items to this endpoint. The request was: ${ext.describe()}`,
      422
    );
  }

  /*
   * Classify every item before allocating anything.
   *
   * A number is never reused, so allocating for the readable items and then
   * failing on a later one would burn numbers on a request that produced no
   * answer. Validating the whole batch first means a bad request costs nothing.
   */
  const classified: { item: Record<string, unknown>; type: NumberingType }[] = [];
  const unrecognised: string[] = [];

  for (const item of ext.items) {
    const raw = String(item.elementType ?? "").trim();
    const type = ELEMENT_TYPE_TO_NUMBERING_TYPE[raw.toUpperCase()];
    if (type) classified.push({ item, type });
    else unrecognised.push(raw || "(no elementType)");
  }

  if (unrecognised.length) {
    // Onshape shows this to the user, so it names what arrived rather than only
    // what was expected.
    return fail(
      `${unrecognised.length} of ${ext.items.length} item(s) have an element type PLM does ` +
      `not number: ${[...new Set(unrecognised)].join(", ")}. Expected a Part Studio, ` +
      `Assembly, or Drawing. Nothing was numbered, so no numbers were used up.`,
      422
    );
  }

  await connectDb();

  /*
   * The token names the enterprise, so companyId is a cross-check rather than
   * the lookup.
   *
   * A token issued for one PLM tenant being used to number a part in a
   * different Onshape company means either a misconfiguration or a token in the
   * wrong hands. Either way, issuing a number from the wrong scheme is worse
   * than refusing.
   */
  const enterprise: any = await Enterprise.findById(identity.enterpriseId).lean();
  if (!enterprise) return fail("The PLM enterprise for this token no longer exists.", 404);

  const companyId = String(ext.items[0]?.companyId ?? "").trim();
  if (companyId && enterprise.onshapeCompanyId && companyId !== enterprise.onshapeCompanyId) {
    return fail(
      `This token belongs to the PLM enterprise for Onshape company ` +
      `"${enterprise.onshapeCompanyId}", but the request came from "${companyId}".`,
      403
    );
  }

  const results: Record<string, unknown>[] = [];

  for (const { item, type } of classified) {
    const { number } = await nextNumber(String(enterprise._id), type);

    await NumberIssuedLog.create({
      enterpriseId: enterprise._id,
      type,
      number,
      source: "onshape",
      documentId: String(item.documentId ?? ""),
      elementId: String(item.elementId ?? ""),
      partId: String(item.partId ?? ""),
    });

    // Echo the identifying fields back beside the number — Onshape uses them to
    // know which object each answer belongs to.
    const echo: Record<string, unknown> = {};
    for (const key of ECHOED) if (item[key] !== undefined) echo[key] = item[key];
    // Present on some payload shapes; harmless to return, and Onshape's own
    // sample echoes whatever it was given.
    if (item.partNumberId !== undefined) echo.partNumberId = item.partNumberId;

    results.push({ ...echo, partNumber: number });
  }

  console.log(
    `[PLM] numbering extension out: issued ${results.length} number(s) — ` +
    `${results.map((r) => r.partNumber).join(", ")}`
  );

  /*
   * Answer in the shape the request arrived in.
   *
   * Onshape sends an array and expects one, and returning a bare object to it
   * would leave every item unnumbered. A single-object request — which is what
   * a manual test or a curl sends — gets a single object back, so the endpoint
   * stays testable by hand without pretending to be something it is not.
   */
  return ok(ext.bodyWasArray ? results : results[0]);
});
