"use client";

import React from "react";

/**
 * Colour a lifecycle chip by what the state means, not by list position.
 *
 * Approved and Released are deliberately different colours. They are one step
 * apart and mean very different things — Approved is a decision PLM has taken
 * that Onshape has not yet acted on, and a reader scanning a list needs to see
 * that difference at a glance rather than read the word.
 */
export function StatusBadge({ status }: { status: string }) {
  const s = (status || "").toLowerCase();
  let bg = "var(--surface-2)", fg = "var(--text-muted)", bd = "var(--border)";

  if (s.includes("released")) { bg = "var(--ok-soft)"; fg = "var(--ok)"; bd = "var(--ok)"; }
  else if (s.includes("obsolete") || s.includes("cancel")) { bg = "var(--danger-soft)"; fg = "var(--danger)"; bd = "var(--danger)"; }
  else if (s.includes("reject")) { bg = "var(--danger-soft)"; fg = "var(--danger)"; bd = "var(--danger)"; }
  else if (s.includes("approved")) { bg = "var(--accent-soft)"; fg = "var(--accent)"; bd = "var(--accent)"; }
  else if (s.includes("review")) { bg = "var(--warn-soft)"; fg = "var(--warn)"; bd = "var(--warn)"; }

  return (
    <span className="badge" style={{ background: bg, color: fg, borderColor: bd }}>
      {status || "—"}
    </span>
  );
}

/**
 * A part's version, as one legible token: "A.3", "A*.3", or "–.2" before
 * release.
 *
 * The dash is not decoration. An unreleased part genuinely has no revision —
 * Onshape assigns it at release — and showing the iteration alone would read
 * as though the revision were simply missing from the display.
 *
 * The stars are PLM's own, never Onshape's — each one is an off-cycle star
 * release (a form-fit-function-equivalent swap, or a metadata/cosmetic note)
 * registered since Onshape last assigned this letter. See lib/star-release.ts.
 */
export function RevChip({
  revision, iteration, starCount = 0, starReasons,
}: {
  revision: string; iteration: number; starCount?: number;
  /**
   * Each star release's reason, newest first — shown on hovering the stars
   * themselves, one line per event. Left off wherever fetching them would
   * cost a query per row (a long list); the stars still show, just without
   * the hover detail, and the chip's own title keeps saying how many there
   * are.
   */
  starReasons?: string[];
}) {
  const released = Boolean(revision);
  const stars = released ? "*".repeat(Math.max(0, starCount)) : "";
  const starTitle = starReasons?.length
    ? starReasons.join("\n")
    : starCount > 0
      ? `${starCount} star release${starCount === 1 ? "" : "s"} since ${revision} — open the part page for why`
      : undefined;
  return (
    <span
      className="badge mono"
      title={
        released
          ? `Revision ${revision}${stars}, iteration ${iteration}`
          : `Not yet released — iteration ${iteration}. Onshape assigns the revision at release.`
      }
      style={{
        background: released ? "var(--ok-soft)" : "var(--surface-2)",
        color: released ? "var(--ok)" : "var(--text-faint)",
        borderColor: released ? "var(--ok)" : "var(--border)",
      }}
    >
      {released ? revision : "–"}
      {stars && (
        // Its own title, so hovering the stars specifically shows why each
        // one happened rather than the chip's generic revision/iteration line.
        <span title={starTitle}>{stars}</span>
      )}
      .{iteration}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Alert({
  kind = "info", children, onDismiss,
}: {
  kind?: "info" | "ok" | "warn" | "error";
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const map = {
    info:  { bg: "var(--accent-soft)", fg: "var(--accent)", bd: "var(--accent)" },
    ok:    { bg: "var(--ok-soft)",     fg: "var(--ok)",     bd: "var(--ok)" },
    warn:  { bg: "var(--warn-soft)",   fg: "var(--warn)",   bd: "var(--warn)" },
    error: { bg: "var(--danger-soft)", fg: "var(--danger)", bd: "var(--danger)" },
  }[kind];

  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      style={{
        background: map.bg, color: map.fg, border: `1px solid ${map.bd}`,
        borderRadius: 8, padding: "9px 12px", fontSize: 13, lineHeight: 1.45,
        display: "flex", gap: 10, alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{children}</div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function Field({
  label, hint, children,
}: {
  label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "5px 0 0" }}>{hint}</p>}
    </div>
  );
}

/** Read-only key/value row used across the item detail and panel views. */
export function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
      <span style={{ color: "var(--text-faint)", minWidth: 110, flexShrink: 0 }}>{k}</span>
      <span className={mono ? "mono" : undefined} style={{ color: "var(--text)", wordBreak: "break-word", minWidth: 0 }}>
        {v || <span style={{ color: "var(--text-faint)" }}>—</span>}
      </span>
    </div>
  );
}

export function relTime(d: string | Date | null | undefined): string {
  if (!d) return "never";
  const t = new Date(d).getTime();
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(d).toLocaleDateString();
}

/**
 * Part rendering, fetched through PLM rather than Onshape directly —
 * Onshape's image endpoints need the service account's credentials.
 *
 * Failures fall back to a neutral tile instead of a broken-image icon, and
 * loading is lazy so a long dashboard does not request every picture at once.
 */
export function PartThumb({
  partId, size = 40, radius = 6, alt = "",
}: {
  partId: string; size?: number; radius?: number; alt?: string;
}) {
  const [failed, setFailed] = React.useState(false);

  const box: React.CSSProperties = {
    width: size, height: size, borderRadius: radius, flexShrink: 0,
    background: "var(--surface-2)", border: "1px solid var(--border)",
    objectFit: "cover", display: "block",
  };

  if (failed) {
    return (
      <div style={{ ...box, display: "grid", placeItems: "center", color: "var(--text-faint)", fontSize: size * 0.4 }} aria-hidden>
        ▢
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/parts/${partId}/thumbnail?size=${Math.max(120, size * 3)}`}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      style={box}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * The star that puts something on — or takes it off — a person's own
 * favorites list.
 *
 * Optimistic, with a revert on failure: a star is a light, frequent action —
 * scanning a BOM and starring several parts in a row — and waiting on a round
 * trip for each one would make the control feel heavier than what it does.
 */
export function FavoriteButton({
  kind, targetId, active, size = 18, onChange,
}: {
  kind: "part" | "task";
  targetId: string;
  active: boolean;
  size?: number;
  /** Told the outcome once the request settles, so a list can drop a row that was just unstarred. */
  onChange?: (active: boolean) => void;
}) {
  const [on, setOn] = React.useState(active);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => setOn(active), [active]);

  async function toggle(e: React.MouseEvent) {
    // Never the row underneath — a favorite lives beside a link to the same
    // object often enough that this has to stop the click there.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    const next = !on;
    setOn(next);
    setBusy(true);
    try {
      const r = await fetch("/api/favorites", {
        method: next ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, targetId }),
      });
      if (!r.ok) throw new Error();
      onChange?.(next);
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={on}
      aria-label={on ? "Remove from favorites" : "Add to favorites"}
      title={on ? "Remove from favorites" : "Add to favorites"}
      style={{
        background: "none", border: "none", padding: 0, lineHeight: 1,
        fontSize: size, cursor: busy ? "default" : "pointer",
        color: on ? "var(--warn)" : "var(--text-faint)",
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

/**
 * A titled block that remembers whether it is open, per browser.
 *
 * Not per account: which sections someone likes collapsed is a convenience
 * about this screen, not data worth a round trip or a field on the user
 * record — and it should not follow them to a machine where the dashboard
 * might not even be scrolled past the fold the same way.
 */
export function CollapsibleSection({
  title, storageKey, defaultOpen = true, right, children,
}: {
  title: React.ReactNode;
  /** Distinct per section — two sections sharing a key would open and close together. */
  storageKey: string;
  defaultOpen?: boolean;
  /** Rendered beside the title, outside the toggle button — counts, filters, actions. */
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  React.useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v != null) setOpen(v === "1");
    } catch {
      // A private window or a blocked store leaves the default, which is fine.
    }
  }, [storageKey]);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch {}
      return next;
    });
  }

  return (
    <div style={{ display: "grid", gap: open ? 12 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={toggle}
          aria-expanded={open}
          style={{
            display: "flex", alignItems: "center", gap: 8, background: "none", border: "none",
            padding: 0, margin: 0, cursor: "pointer", font: "inherit", color: "inherit",
          }}
        >
          <span
            aria-hidden
            style={{
              display: "inline-block", fontSize: 11, color: "var(--text-faint)",
              transform: open ? "rotate(90deg)" : "none", transition: "transform .15s",
            }}
          >
            ▶
          </span>
          {title}
        </button>
        {right}
      </div>
      {open && children}
    </div>
  );
}
