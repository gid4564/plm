import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { CleanupClient } from "./CleanupClient";

export const dynamic = "force-dynamic";

export default async function CleanupPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <Shell>
      <CleanupClient />
    </Shell>
  );
}
