import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { connectDb } from "@/lib/db";
import { findClient, redirectAllowed } from "@/lib/oauth-server";
import { Enterprise } from "@/lib/models";

export const dynamic = "force-dynamic";

/**
 * The consent screen Onshape sends a user through.
 *
 * Server-rendered with a plain form POST rather than a client component with
 * fetch, deliberately: granting access is the one action here that must work
 * with no JavaScript at all, and a form post to the authorize endpoint is
 * exactly what the OAuth flow expects.
 *
 * The client and redirect URI are re-validated here even though the authorize
 * endpoint already did. This page is reachable by its own URL, and rendering
 * an approve button for an unregistered redirect URI would be offering to send
 * a code somewhere it should never go.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => {
    const raw = sp[k];
    return (Array.isArray(raw) ? raw[0] : raw) ?? "";
  };

  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  const state = one("state");
  const scope = one("scope");

  const session = await getSession();
  if (!session) {
    const back = `/oauth/consent?${new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, state, scope,
    }).toString()}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  await connectDb();
  const client = await findClient(clientId);
  const ent: any = await Enterprise.findById(session!.enterpriseId).lean();

  const problem = !client
    ? "That application is not registered with this PLM instance, or has been disabled."
    : !redirectAllowed(client, redirectUri)
      ? "The address that application asked to be sent back to is not one it registered. " +
        "Nothing has been granted."
      : null;

  return (
    <main style={{ maxWidth: 480, margin: "60px auto", padding: "0 20px" }}>
      <div className="card" style={{ display: "grid", gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18 }}>Allow access to PLM?</h1>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
            {problem
              ? "This request cannot be granted."
              : <><strong>{client.name}</strong> is asking to act in PLM on your behalf.</>}
          </p>
        </div>

        {problem ? (
          <div
            role="alert"
            style={{
              background: "var(--danger-soft)", color: "var(--danger)",
              border: "1px solid var(--danger)", borderRadius: 8, padding: "10px 12px", fontSize: 13,
            }}
          >
            {problem}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, display: "grid", gap: 8 }}>
              <Row k="Signed in as" v={session!.email} />
              <Row k="Enterprise" v={ent?.name ?? "—"} />
              <Row k="Sends you back to" v={redirectUri} mono />
              {scope && <Row k="Scope" v={scope} mono />}
            </div>

            <p style={{ margin: 0, fontSize: 12, color: "var(--text-faint)", lineHeight: 1.5 }}>
              This lets Onshape call PLM as you — issuing part numbers from the Release candidate
              dialog, and sending parts to PLM from a context menu. It does not let Onshape sign
              in as you or read anything outside {ent?.name ?? "your enterprise"}. An admin can
              withdraw it at any time in Settings.
            </p>

            <form method="POST" action="/api/oauth/authorize" style={{ display: "flex", gap: 8 }}>
              <input type="hidden" name="client_id" value={clientId} />
              <input type="hidden" name="redirect_uri" value={redirectUri} />
              <input type="hidden" name="state" value={state} />
              <input type="hidden" name="scope" value={scope} />
              <button className="btn btn-primary" type="submit" name="decision" value="approve">
                Allow
              </button>
              <button className="btn" type="submit" name="decision" value="deny">
                Refuse
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <span style={{ color: "var(--text-faint)", minWidth: 130, flexShrink: 0 }}>{k}</span>
      <span className={mono ? "mono" : undefined} style={{ wordBreak: "break-all", fontSize: mono ? 11.5 : 13 }}>
        {v}
      </span>
    </div>
  );
}
