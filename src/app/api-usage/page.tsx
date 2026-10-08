import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { ApiUsageClient } from "./ApiUsageClient";

export const dynamic = "force-dynamic";

/**
 * Where the Onshape API budget goes — admin only.
 *
 * A page rather than a log file because the question is never "what was call
 * 4,812" but "what costs the most to run", which is a sum, a filter and a
 * drill-down. The API behind it refuses non-admins too; this redirect is only
 * the courtesy.
 */
export default async function ApiUsagePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

  return (
    <Shell>
      <ApiUsageClient />
    </Shell>
  );
}
