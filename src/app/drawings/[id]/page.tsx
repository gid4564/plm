import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { DrawingDetail } from "./DrawingDetail";

export const dynamic = "force-dynamic";

export default async function DrawingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;

  return (
    <Shell>
      <DrawingDetail id={id} />
    </Shell>
  );
}
