import { connectDb } from "@/lib/db";
import { Enterprise, NumberIssuedLog } from "@/lib/models";
import { nextNumber, type NumberingType } from "@/lib/numbering";
import { handler, ok, fail } from "@/lib/api";

/**
 * The Action URL for Onshape's own "Part number generator" app extension.
 *
 * Onshape calls this directly — server to server, no MOS session — whenever
 * someone requests a number from the Release dialog, a properties dialog, the
 * BOM table, or a configuration table, and applies whatever `partNumber` this
 * responds with onto the part, assembly, or drawing itself. The MOS never
 * writes to Onshape for this: that write is Onshape's own job once it has an
 * answer, which is the whole point of using the real extension point rather
 * than a link a person pastes in by hand.
 *
 * Contract: https://onshape-public.github.io/docs/app-dev/extensions/
 * (Location: "Part number generator"). Request and response shapes below are
 * copied from that page, not guessed — Onshape does not otherwise document a
 * failure shape for this endpoint, so an unrecoverable problem here is a
 * plain HTTP error rather than an invented one.
 */
const ELEMENT_TYPE_TO_NUMBERING_TYPE: Record<string, NumberingType> = {
  PARTSTUDIO: "PART",
  ASSEMBLY: "ASSEMBLY",
  DRAWING: "DRAWING",
};

export const POST = handler(async (req: Request) => {
  // Onshape does not support a placeholder in this extension's Action URL, so
  // a shared secret has to be baked into the URL itself when registering it
  // in the Developer Portal — the same query-token approach the webhook
  // receiver uses, for the same reason. Optional: unset, the endpoint is open,
  // which is fine for local or trusted-network testing.
  const expected = process.env.ONSHAPE_NUMBERING_SECRET;
  if (expected) {
    const fromQuery = new URL(req.url).searchParams.get("token");
    if (fromQuery !== expected) {
      console.warn("[MOS] numbering extension call rejected: bad or missing token");
      return fail("Not authorized", 401);
    }
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  const {
    id, documentId, elementId, workspaceId, elementType, partId, companyId,
  } = body;

  console.log(
    `[MOS] numbering extension in: elementType=${elementType ?? "-"} ` +
    `doc=${documentId ?? "-"} el=${elementId ?? "-"} part=${partId ?? "-"} company=${companyId ?? "-"}`
  );

  const type = ELEMENT_TYPE_TO_NUMBERING_TYPE[String(elementType ?? "").toUpperCase()];
  if (!type) {
    return fail(`Unrecognised elementType "${elementType}" — expected a Part Studio, Assembly, or Drawing.`, 422);
  }

  await connectDb();
  const enterprise: any = await Enterprise.findOne({ onshapeCompanyId: companyId }).lean();
  if (!enterprise) {
    return fail(`No MOS enterprise is registered for Onshape company "${companyId}".`, 404);
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

  return ok({ id, documentId, elementId, workspaceId, elementType, partId, partNumber: number });
});
