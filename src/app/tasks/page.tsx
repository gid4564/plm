import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { Shell } from "@/components/Nav";
import { TasksClient } from "./TasksClient";

export const dynamic = "force-dynamic";

/**
 * Onshape tasks, worked on in PLM.
 *
 * Onshape owns the task and its workflow; PLM mirrors it and provides
 * somewhere to act — the parts it concerns resolved to real PLM parts, a
 * thread, and the transitions the task itself offers.
 */
export default async function TasksPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return (
    <Shell>
      <TasksClient />
    </Shell>
  );
}
