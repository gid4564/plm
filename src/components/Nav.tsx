"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Me = {
  user: { email: string; name: string; role: string; onshapeConnected: boolean } | null;
  enterprise?: { name: string; onshapeCompanyId: string } | null;
};

const LINKS = [
  { href: "/dashboard", label: "Parts" },
  { href: "/releases", label: "Releases" },
  { href: "/bom", label: "Import from Assembly" },
  { href: "/attributes", label: "Attributes" },
  { href: "/numbering", label: "Numbering" },
  { href: "/settings", label: "Settings" },
  { href: "/simulator", label: "Onshape Simulator" },
  { href: "/manual", label: "Manual" },
];

export function Nav() {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then(setMe).catch(() => {});
  }, [pathname]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header
      style={{
        borderBottom: "1px solid var(--border)", background: "var(--surface)",
        position: "sticky", top: 0, zIndex: 20,
      }}
    >
      <div
        style={{
          maxWidth: 1280, margin: "0 auto", padding: "0 20px", height: 54,
          display: "flex", alignItems: "center", gap: 22,
        }}
      >
        <Link
          href="/dashboard"
          style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none", color: "var(--text)" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" width={24} height={24} style={{ display: "block" }} />
          <strong style={{ fontSize: 14.5, letterSpacing: "-.01em" }}>PLM</strong>
        </Link>

        <nav style={{ display: "flex", gap: 3, flex: 1 }}>
          {LINKS.map((l) => {
            const active = pathname === l.href || pathname.startsWith(l.href + "/");
            return (
              <Link
                key={l.href}
                href={l.href}
                style={{
                  padding: "6px 11px", borderRadius: 7, fontSize: 13, textDecoration: "none",
                  fontWeight: active ? 600 : 450,
                  color: active ? "var(--accent)" : "var(--text-muted)",
                  background: active ? "var(--accent-soft)" : "transparent",
                }}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        {me?.user && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12.5 }}>
            <div style={{ textAlign: "right", lineHeight: 1.3 }}>
              <div style={{ color: "var(--text)" }}>{me.user.email}</div>
              <div style={{ color: "var(--text-faint)", fontSize: 11 }}>
                {me.enterprise?.name}
                {!me.user.onshapeConnected && (
                  <span style={{ color: "var(--warn)" }}> · Onshape not connected</span>
                )}
              </div>
            </div>
            <button className="btn btn-sm" onClick={logout}>Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main style={{ maxWidth: 1280, margin: "0 auto", padding: "26px 20px 70px" }}>{children}</main>
    </>
  );
}
