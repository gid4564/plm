import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { ItemsTable } from "./ItemsTable";
import { connectDb } from "@/lib/db";
import { Enterprise, User } from "@/lib/models";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  await connectDb();
  const [ent, user] = await Promise.all([
    Enterprise.findById(session.enterpriseId).lean<any>(),
    User.findById(session.userId).select("lastProductFilter").lean<any>(),
  ]);

  // Set by the "From assembly" link on an item, so following it lands on the
  // whole work package rather than an unfiltered list.
  const sp = await searchParams;
  const raw = sp.assembly;
  const initialAssembly = (Array.isArray(raw) ? raw[0] : raw) || "all";

  // An explicit ?product= — a deep link from an item's "View other parts", or
  // a bookmarked URL — wins for this visit. Failing that, fall back to the
  // product this user last had the dashboard filtered to, so a long list
  // opens already narrowed rather than starting over every time.
  const rawProduct = sp.product;
  const initialProduct =
    (Array.isArray(rawProduct) ? rawProduct[0] : rawProduct) ||
    (user?.lastProductFilter ? String(user.lastProductFilter) : "all");

  return (
    <Shell>
      <ItemsTable
        statuses={ent?.statuses ?? []}
        facilities={ent?.facilities ?? []}
        myEmail={session.email}
        initialAssembly={initialAssembly}
        initialProduct={initialProduct}
      />
    </Shell>
  );
}
