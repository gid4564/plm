import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { ReleasesClient } from "./ReleasesClient";

export const dynamic = "force-dynamic";

export default async function ReleasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const raw = sp.state;
  const initialState = (Array.isArray(raw) ? raw[0] : raw) || "all";

  return (
    <Shell>
      <ReleasesClient initialState={initialState} />
    </Shell>
  );
}
