import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { ConfigureClient } from "./ConfigureClient";

export const dynamic = "force-dynamic";

/** Configure one model and see the result. */
export default async function ConfigurePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;
  return (
    <Shell>
      <ConfigureClient id={id} isAdmin={session.role === "admin"} />
    </Shell>
  );
}
