"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Me = {
  user: { email: string; name: string; role: string; onshapeConnected: boolean } | null;
  enterprise?: { name: string; onshapeCompanyId: string } | null;
};

/** A top-level nav item, or a group that opens as a dropdown. */
type NavItem =
  | { kind: "link"; href: string; label: string; adminOnly?: boolean }
  | { kind: "menu"; label: string; groups: NavGroup[] };

type NavGroup = {
  /** Shown above the group when it has more than a bare list of peers. */
  heading?: string;
  items: { href: string; label: string; hint?: string; adminOnly?: boolean }[];
};

/*
 * The navigation, as a shape rather than a flat list.
 *
 * Everything used to sit side by side, which put the three configuration pages
 * — read-only for most people — at the same weight as the two anybody uses
 * daily. The dropdown restores that difference without hiding anything an
 * admin needs.
 *
 * `adminOnly` hides an item from the menu; it does not protect the page. The
 * pages and their APIs do their own checking, and must — a nav is a
 * convenience, and a route is reachable by anyone who types it.
 */
const NAV: NavItem[] = [
  { kind: "link", href: "/dashboard", label: "Parts" },
  { kind: "link", href: "/bom", label: "BOM" },
  { kind: "link", href: "/releases", label: "Releases" },
  { kind: "link", href: "/tasks", label: "Tasks" },
  {
    kind: "menu",
    label: "Configuration",
    groups: [
      {
        items: [
          { href: "/attributes", label: "Attributes", hint: "What PLM records, and who owns each field" },
          { href: "/numbering", label: "Numbering", hint: "How part, drawing and release numbers are issued" },
          { href: "/settings", label: "Settings", hint: "The Onshape connection, webhooks and release takeover" },
        ],
      },
      {
        /*
         * Admin-only, and grouped apart because neither is part of the normal
         * flow: parts arrive from Onshape, so importing an assembly by hand is
         * a fallback, and the simulator exists to demonstrate PLM without an
         * Onshape tenant at all.
         */
        heading: "Tools",
        items: [
          {
            href: "/import", label: "Import from Assembly", adminOnly: true,
            hint: "Pull a BOM in by hand — normally parts arrive from Onshape",
          },
          {
            href: "/simulator", label: "Onshape Simulator", adminOnly: true,
            hint: "A stand-in Onshape, for demonstrating PLM without a tenant",
          },
        ],
      },
    ],
  },
  { kind: "link", href: "/manual", label: "Manual" },
];

const linkStyle = (active: boolean): React.CSSProperties => ({
  padding: "6px 11px", borderRadius: 7, fontSize: 13, textDecoration: "none",
  fontWeight: active ? 600 : 450,
  color: active ? "var(--accent)" : "var(--text-muted)",
  background: active ? "var(--accent-soft)" : "transparent",
});

/**
 * One dropdown in the nav bar.
 *
 * Closes on an outside click, on Escape, and on navigating — a menu still
 * hanging open over the page you just moved to is the usual bug in these.
 */
function NavMenu({
  label, groups, isAdmin, pathname,
}: {
  label: string;
  groups: NavGroup[];
  isAdmin: boolean;
  pathname: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  const visible = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly || isAdmin) }))
    .filter((g) => g.items.length > 0);

  // Every route in the menu, so the trigger shows as active when one is open.
  const active = visible.some((g) =>
    g.items.some((i) => pathname === i.href || pathname.startsWith(i.href + "/"))
  );

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (visible.length === 0) return null;

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        style={{
          ...linkStyle(active),
          border: "none",
          cursor: "pointer",
          font: "inherit",
          fontSize: 13,
          fontWeight: active ? 600 : 450,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        {label}
        <span
          aria-hidden
          style={{
            fontSize: 9,
            opacity: 0.7,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 120ms",
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 276,
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,.14)",
            padding: 6, zIndex: 30,
          }}
        >
          {visible.map((g, gi) => (
            <div key={g.heading ?? gi}>
              {gi > 0 && (
                <div style={{ borderTop: "1px solid var(--border)", margin: "6px 4px" }} />
              )}
              {g.heading && (
                <div
                  style={{
                    fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em",
                    color: "var(--text-faint)", padding: "4px 9px 3px",
                  }}
                >
                  {g.heading}
                </div>
              )}
              {g.items.map((i) => {
                const on = pathname === i.href || pathname.startsWith(i.href + "/");
                return (
                  <Link
                    key={i.href}
                    href={i.href}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    style={{
                      display: "block", padding: "7px 9px", borderRadius: 7,
                      textDecoration: "none",
                      background: on ? "var(--accent-soft)" : "transparent",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13, fontWeight: on ? 600 : 450,
                        color: on ? "var(--accent)" : "var(--text)",
                      }}
                    >
                      {i.label}
                    </div>
                    {i.hint && (
                      <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 1 }}>
                        {i.hint}
                      </div>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Nav() {
  const [me, setMe] = useState<Me | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  /*
   * Until /api/auth/me answers, treat the viewer as not an admin.
   *
   * The alternative flashes the admin-only tools to everyone for as long as
   * that request takes, which is the wrong way round to be wrong.
   */
  const isAdmin = me?.user?.role === "admin";

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

        <nav style={{ display: "flex", gap: 3, flex: 1, alignItems: "center" }}>
          {NAV.map((item) => {
            if (item.kind === "menu") {
              return (
                <NavMenu
                  key={item.label}
                  label={item.label}
                  groups={item.groups}
                  isAdmin={isAdmin}
                  pathname={pathname}
                />
              );
            }
            if (item.adminOnly && !isAdmin) return null;
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link key={item.href} href={item.href} style={linkStyle(active)}>
                {item.label}
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
