import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { BomClient } from "./BomClient";

export const dynamic = "force-dynamic";

/**
 * A product's bill of materials.
 *
 * Distinct from the Onshape assembly import (now at /import): that reads a
 * structure out of CAD, this reads the structure PLM already holds, with PLM's
 * numbers, states and effectivity on it.
 */
export default async function BomPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const one = (k: string) => {
    const raw = sp[k];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  return (
    <Shell>
      <BomClient initialProduct={one("product") ?? null} initialView={one("view") ?? "structured"} />
    </Shell>
  );
}
