import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { ModelsClient } from "./ModelsClient";

export const dynamic = "force-dynamic";

/** The configurable models — and, for an admin, adding one. */
export default async function ConfiguratorPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <Shell>
      <ModelsClient isAdmin={session.role === "admin"} />
    </Shell>
  );
}
