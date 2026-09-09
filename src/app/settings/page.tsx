import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { connectDb } from "@/lib/db";
import { Enterprise, User } from "@/lib/models";
import { isMock, baseUrl } from "@/lib/onshape/oauth";
import { SettingsClient } from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  await connectDb();
  const ent: any = await Enterprise.findById(session.enterpriseId).lean();
  const user: any = await User.findById(session.userId).lean();
  const integration: any = ent?.integrationUserId
    ? await User.findById(ent.integrationUserId).lean()
    : null;

  return (
    <Shell>
      <SettingsClient
        mode={isMock() ? "mock" : "live"}
        role={session.role}
        appBaseUrl={baseUrl()}
        enterprise={{
          name: ent?.name ?? "",
          onshapeCompanyId: ent?.onshapeCompanyId ?? "",
          statuses: ent?.statuses ?? [],
          moPrefix: ent?.moPrefix ?? "MO",
          moCounter: ent?.moCounter ?? 0,
        }}
        connected={Boolean(user?.onshapeConnectedAt)}
        integrationEmail={integration?.email ?? null}
      />
    </Shell>
  );
}
