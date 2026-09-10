"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, Field, Spinner } from "@/components/ui";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Set when arriving mid-OAuth from Onshape's Applications page, so sign-in
  // resumes the handshake instead of dumping the user on the dashboard.
  /*
   * Both spellings are accepted.
   *
   * The Onshape panel links here with ?returnTo=, and the OAuth flow with
   * ?next= — which is the conventional name and the one the authorize endpoint
   * builds. Accepting only one would silently drop the other's destination and
   * land the user on the dashboard, which in the OAuth case abandons the
   * authorization request entirely.
   */
  const returnTo = params.get("returnTo") ?? params.get("next");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [entName, setEntName] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const url = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    const body =
      mode === "login"
        ? { email, password }
        : { email, password, name, onshapeCompanyId: companyId.trim(), enterpriseName: entName };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      router.push(returnTo && returnTo.startsWith("/") ? returnTo : "/dashboard");
      router.refresh();
    } catch (err: any) {
      setError(String(err.message ?? err));
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icon.svg" alt="" width={44} height={44}
            style={{ display: "block", margin: "0 auto 12px" }}
          />
          <h1 style={{ fontSize: 21, margin: "0 0 5px", letterSpacing: "-.02em" }}>
            Product Lifecycle Management
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
            {mode === "login" ? "Sign in to continue" : "Create an account and bind it to an Onshape enterprise"}
          </p>
        </div>

        <form onSubmit={submit} className="card" style={{ padding: 20, display: "grid", gap: 14 }}>
          {error && <Alert kind="error" onDismiss={() => setError(null)}>{error}</Alert>}

          {mode === "register" && (
            <Field label="Your name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" />
            </Field>
          )}

          <Field label="Email">
            <input
              className="input" type="email" required autoComplete="email"
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
            />
          </Field>

          <Field label="Password" hint={mode === "register" ? "At least 8 characters." : undefined}>
            <input
              className="input" type="password" required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          {mode === "register" && (
            <>
              <Field
                label="Onshape Enterprise ID"
                hint="Your Onshape company id. Every item, webhook and property mapping is scoped to it. In mock mode any value works — try demo-enterprise."
              >
                <input
                  className="input mono" required value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)} placeholder="demo-enterprise"
                />
              </Field>
              <Field label="Enterprise display name">
                <input
                  className="input" value={entName}
                  onChange={(e) => setEntName(e.target.value)} placeholder="Acme Engineering"
                />
              </Field>
            </>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 2 }}>
            {busy && <Spinner />}
            {mode === "login" ? "Sign in" : "Create account"}
          </button>

          <div style={{ textAlign: "center", fontSize: 12.5, color: "var(--text-muted)" }}>
            {mode === "login" ? "No account yet? " : "Already registered? "}
            <button
              type="button"
              onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12.5, padding: 0 }}
            >
              {mode === "login" ? "Create one" : "Sign in"}
            </button>
          </div>
        </form>

        <p style={{ textAlign: "center", fontSize: 11.5, color: "var(--text-faint)", marginTop: 16, lineHeight: 1.5 }}>
          The first account created for an Onshape company id becomes its admin
          <br />and can set the attribute schema, the Onshape connection and the webhook.
          <br />
          <a
            className="link" href="/manual" target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11.5 }}
          >
            Setup instructions ↗
          </a>
        </p>
      </div>
    </div>
  );
}
