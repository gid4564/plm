import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { PartsTable } from "./PartsTable";
import { connectDb } from "@/lib/db";
import { LIFECYCLE_STATES, Release } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  await connectDb();

  const sp = await searchParams;
  const one = (k: string) => {
    const raw = sp[k];
    return (Array.isArray(raw) ? raw[0] : raw) || "all";
  };

  // Shown as a banner rather than left for the approver to discover: a release
  // waiting on a decision is the one thing in this system that blocks somebody
  // else's work.
  const underReview = await Release.countDocuments({
    enterpriseId: session.enterpriseId,
    state: "Under Review",
  });

  return (
    <Shell>
      <PartsTable
        states={[...LIFECYCLE_STATES]}
        myEmail={session.email}
        canDecide={session.role === "approver" || session.role === "admin"}
        isAdmin={session.role === "admin"}
        underReview={underReview}
        initialState={one("state")}
        initialKind={one("kind")}
        initialRelease={one("release")}
        initialProduct={one("product")}
      />
    </Shell>
  );
}
