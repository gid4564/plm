import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { NumberingClient } from "./NumberingClient";

export const dynamic = "force-dynamic";

/**
 * A standalone number-generator tool.
 *
 * Deliberately its own page, not folded into the dashboard: it demonstrates a
 * different Onshape integration pattern — an external app handing out the
 * next number in a sequence and writing it onto a part, assembly or drawing —
 * and has nothing to do with manufacturing orders.
 */
export default async function NumberingPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <Shell>
      <NumberingClient isAdmin={session.role === "admin"} />
    </Shell>
  );
}
