import { connectDb } from "@/lib/db";
import { Enterprise, NumberIssuedLog } from "@/lib/models";
import { nextNumber, type NumberingType } from "@/lib/numbering";
import { authenticateBearer } from "@/lib/oauth-server";
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
 * Authenticated by **External OAuth**, not a shared secret. Onshape obtains a
 * bearer token from PLM's own token endpoint and presents it here, so the call
 * is attributable to the PLM user who granted access — which is what tells this
 * route which enterprise's numbering scheme to use. MOS put a secret in the
 * query string because it had no authorization server; PLM does.
 *
 * Contract: https://onshape-public.github.io/docs/app-dev/extensions/
 * (Location: "Part number generator").
 */
const ELEMENT_TYPE_TO_NUMBERING_TYPE: Record<string, NumberingType> = {
  PARTSTUDIO: "PART",
  ASSEMBLY: "ASSEMBLY",
  DRAWING: "DRAWING",
};

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

  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  const {
    id, partNumberId, documentId, elementId, workspaceId, elementType, partId, companyId,
  } = body;

  console.log(
    `[PLM] numbering extension in: elementType=${elementType ?? "-"} ` +
    `doc=${documentId ?? "-"} el=${elementId ?? "-"} part=${partId ?? "-"} ` +
    `company=${companyId ?? "-"} user=${identity.userId}`
  );

  const type = ELEMENT_TYPE_TO_NUMBERING_TYPE[String(elementType ?? "").toUpperCase()];
  if (!type) {
    return fail(
      `Unrecognised elementType "${elementType}" — expected a Part Studio, Assembly, or Drawing.`,
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

  if (companyId && enterprise.onshapeCompanyId && companyId !== enterprise.onshapeCompanyId) {
    return fail(
      `This token belongs to the PLM enterprise for Onshape company ` +
      `"${enterprise.onshapeCompanyId}", but the request came from "${companyId}".`,
      403
    );
  }

  const { number } = await nextNumber(String(enterprise._id), type);

  await NumberIssuedLog.create({
    enterpriseId: enterprise._id,
    type,
    number,
    source: "onshape",
    documentId: documentId ?? "",
    elementId: elementId ?? "",
    partId: partId ?? "",
  });

  // Echo the request's identifiers back alongside the number, as the extension
  // contract requires — Onshape uses them to know which object to apply it to.
  return ok({
    id, partNumberId, documentId, elementId, workspaceId, elementType, partId,
    partNumber: number,
  });
});
