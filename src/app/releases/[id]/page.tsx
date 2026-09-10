import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { ReleaseDetail } from "./ReleaseDetail";

export const dynamic = "force-dynamic";

export default async function ReleasePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;

  return (
    <Shell>
      <ReleaseDetail
        id={id}
        canDecide={session.role === "approver" || session.role === "admin"}
        myEmail={session.email}
      />
    </Shell>
  );
}
