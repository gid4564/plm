import { getSession } from "@/lib/auth/session";
import { AssemblyPanelClient } from "./AssemblyPanelClient";

export const dynamic = "force-dynamic";

/**
 * Onshape "Element right panel" app extension, assembly context.
 *
 * A sibling of /panel rather than a branch inside it. Onshape can already
 * restrict an extension to one element type, so asking it which kind of tab is
 * open would be an API call spent re-learning something the configuration
 * states — and keeping the two panels apart means work here cannot regress the
 * part panel that is already in service.
 */
export default async function AssemblyPanelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // Onshape leaves a {$token} verbatim when it has nothing to substitute.
  const one = (k: string) => {
    const raw = sp[k];
    const v = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    return /^\{\$.*\}$/.test(v) ? "" : v;
  };

  const session = await getSession();

  const wv = one("workspaceOrVersion");
  const wvId = one("workspaceOrVersionId");

  const ctx = {
    documentId: one("documentId"),
    elementId: one("elementId"),
    workspaceId: wv === "v" ? "" : (wvId || one("workspaceId")),
    versionId: wv === "v" ? wvId : "",
    // The configuration the tab is showing. Without it the BOM is always
    // read for the assembly's default configuration.
    configuration: one("configuration"),
  };

  // Rebuilt server-side: reading window.location during render desynchronises
  // the markup and silently drops the context from the sign-in return URL.
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = Array.isArray(v) ? v[0] : v;
    if (val != null) query.set(k, val);
  }
  const search = query.toString() ? `?${query.toString()}` : "";

  return <AssemblyPanelClient ctx={ctx} signedIn={Boolean(session)} search={search} />;
}
