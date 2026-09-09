import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { isMock } from "@/lib/onshape/oauth";
import { Alert } from "@/components/ui";
import { SimulatorClient } from "./SimulatorClient";

export const dynamic = "force-dynamic";

export default async function SimulatorPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  if (!isMock()) {
    return (
      <Shell>
        <Alert kind="info">
          The simulator is disabled because <code>ONSHAPE_MODE=live</code>. Work in your real
          Onshape enterprise instead — the webhook receiver and right panel behave identically.
        </Alert>
      </Shell>
    );
  }

  return (
    <Shell>
      <SimulatorClient />
    </Shell>
  );
}
