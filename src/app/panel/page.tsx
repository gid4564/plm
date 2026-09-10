import { getSession } from "@/lib/auth/session";
import { PanelClient } from "./PanelClient";

export const dynamic = "force-dynamic";

/**
 * Onshape "Element right panel" app extension.
 *
 * Onshape substitutes the {$...} tokens configured on the extension into the
 * iframe URL, so the part context arrives as plain query params.
 */
export default async function PanelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  /**
   * Read one query parameter, discarding Onshape placeholders that were never
   * substituted.
   *
   * Onshape does not fill in every {$token} in every extension context — an
   * element with no configurations leaves {$configuration} verbatim. Passing that
   * string on as a real value makes Onshape reject the follow-up metadata call
   * with a 400, so anything still shaped like a token is treated as absent.
   */
  const one = (k: string) => {
    const raw = sp[k];
    const v = (Array.isArray(raw) ? raw[0] : raw) ?? "";
    return /^\{\$.*\}$/.test(v) ? "" : v;
  };

  const session = await getSession();

  // Onshape sends workspaceOrVersion ("w" | "v") plus a single id.
  const wv = one("workspaceOrVersion");
  const wvId = one("workspaceOrVersionId");

  const ctx = {
    documentId: one("documentId"),
    elementId: one("elementId"),
    partId: one("partId"),
    configuration: one("configuration") || "default",
    workspaceId: wv === "v" ? "" : (wvId || one("workspaceId")),
    versionId: wv === "v" ? wvId : "",
    companyId: one("companyId"),
    userId: one("userId"),
  };

  // Rebuild the query string server-side. Reading window.location during render
  // desynchronises server and client markup, and React leaves the mismatch in
  // place — which silently dropped the part context from the sign-in return URL.
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = Array.isArray(v) ? v[0] : v;
    if (val != null) query.set(k, val);
  }
  const search = query.toString() ? `?${query.toString()}` : "";

  // Nothing enterprise-scoped is needed up front any more: the attribute
  // schema travels with the lookup, together with the server-computed
  // editability for this part's lifecycle state.
  return <PanelClient ctx={ctx} signedIn={Boolean(session)} search={search} />;
}
