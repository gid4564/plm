import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { PartsTable } from "./PartsTable";
import { FavoritesSection } from "./FavoritesSection";
import { connectDb } from "@/lib/db";
import { LIFECYCLE_STATES, Product, Release, User } from "@/lib/models";

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

  /*
   * The remembered product, resolved server-side rather than left to the
   * client to adopt after the first paint.
   *
   * The table used to always render with initialProduct "all" and only
   * narrow to the remembered product once PartsTable's own fetch of
   * /api/products came back — which meant every dashboard load first drew
   * (and fetched) every part across every product, then replaced it a beat
   * later. That first request is not free, and on a real enterprise's part
   * count it was the visible state for long enough to look like the filter
   * simply was not applied.
   *
   * Only consulted when the URL did not already name a product — that is an
   * explicit request and outranks whatever was last remembered, the same
   * rule PartsTable itself applies. Re-checked against Product here rather
   * than trusted outright, because a remembered id can point at a product
   * since deleted; an unfiltered dashboard is the right fallback for that,
   * not a filter on a product that no longer exists.
   */
  let initialProduct = one("product");
  if (initialProduct === "all") {
    const user: any = await User.findById(session.userId).select("currentProductId").lean();
    if (user?.currentProductId) {
      const exists = await Product.exists({
        _id: user.currentProductId,
        enterpriseId: session.enterpriseId,
      });
      if (exists) initialProduct = String(user.currentProductId);
    }
  }

  return (
    <Shell>
      <div style={{ display: "grid", gap: 20 }}>
      <FavoritesSection />
      <PartsTable
        states={[...LIFECYCLE_STATES]}
        myEmail={session.email}
        canDecide={session.role === "approver" || session.role === "admin"}
        isAdmin={session.role === "admin"}
        underReview={underReview}
        initialState={one("state")}
        initialKind={one("kind")}
        initialRelease={one("release")}
        initialProduct={initialProduct}
      />
      </div>
    </Shell>
  );
}
