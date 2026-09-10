import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { connectDb } from "@/lib/db";
import { User } from "@/lib/models";
import { isMock, baseUrl } from "@/lib/onshape/oauth";
import { SettingsClient } from "./SettingsClient";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  await connectDb();
  const user: any = await User.findById(session.userId).lean();

  return (
    <Shell>
      <SettingsClient
        mode={isMock() ? "mock" : "live"}
        role={session.role}
        appBaseUrl={baseUrl()}
        connected={Boolean(user?.onshapeConnectedAt)}
      />
    </Shell>
  );
}
