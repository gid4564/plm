import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { AttributesClient } from "./AttributesClient";

export const dynamic = "force-dynamic";

export default async function AttributesPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <Shell>
      <AttributesClient isAdmin={session.role === "admin"} />
    </Shell>
  );
}
