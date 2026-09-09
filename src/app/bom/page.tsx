import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { BomClient } from "./BomClient";
import { connectDb } from "@/lib/db";
import { Enterprise, MockOnshapePart } from "@/lib/models";
import { isMock } from "@/lib/onshape/oauth";

export const dynamic = "force-dynamic";

/**
 * Explode an assembly's bill of materials into manufacturing orders.
 *
 * Reached either by pasting an assembly link or from the Onshape panel, which
 * hands over the context it already has — hence the prefilled ids.
 */
export default async function BomPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const one = (k: string) => {
    const raw = sp[k];
    const v = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    return /^\{\$.*\}$/.test(v) ? "" : v;
  };

  /**
   * In simulator mode a real Onshape link cannot resolve, because nothing is
   * talking to Onshape. Rather than let someone paste one and get an empty
   * table, offer the documents the simulator actually has.
   */
  const mock = isMock();
  let simulator: { documentId: string; documentName: string; elementId: string }[] = [];

  if (mock) {
    await connectDb();
    const ent: any = await Enterprise.findById(session.enterpriseId).lean();
    const docs: any[] = await MockOnshapePart.aggregate([
      { $match: { companyId: ent?.onshapeCompanyId ?? "" } },
      { $group: { _id: "$documentId", documentName: { $first: "$documentName" } } },
      { $sort: { documentName: 1 } },
      { $limit: 20 },
    ]);
    simulator = docs.map((d) => ({
      documentId: String(d._id),
      documentName: d.documentName || "Untitled document",
      // The simulator has no assembly tabs; any id that is not one of the
      // document's Part Studios stands in for one.
      elementId: `sim-assembly-${d._id}`,
    }));
  }

  return (
    <Shell>
      <BomClient
        initial={{
          documentId: one("documentId"),
          elementId: one("elementId"),
          workspaceId: one("workspaceId"),
          versionId: one("versionId"),
        }}
        mock={mock}
        simulator={simulator}
      />
    </Shell>
  );
}
