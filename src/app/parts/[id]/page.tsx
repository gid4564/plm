import { redirect, notFound } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { connectDb } from "@/lib/db";
import { Enterprise, ManufacturingItem } from "@/lib/models";
import { ItemDetail } from "./ItemDetail";

export const dynamic = "force-dynamic";

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  await connectDb();

  const item: any = await ManufacturingItem.findOne({
    _id: id, enterpriseId: session.enterpriseId,
  }).lean().catch(() => null);
  if (!item) notFound();

  const ent: any = await Enterprise.findById(session.enterpriseId).lean();

  return (
    <Shell>
      <ItemDetail itemId={id} statuses={ent?.statuses ?? []} facilities={ent?.facilities ?? []} />
    </Shell>
  );
}
