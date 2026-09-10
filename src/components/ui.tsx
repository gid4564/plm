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
 * A part's version, as one legible token: "A.3", or "–.2" before release.
 *
 * The dash is not decoration. An unreleased part genuinely has no revision —
 * Onshape assigns it at release — and showing the iteration alone would read
 * as though the revision were simply missing from the display.
 */
export function RevChip({ revision, iteration }: { revision: string; iteration: number }) {
  const released = Boolean(revision);
  return (
    <span
      className="badge mono"
      title={
        released
          ? `Revision ${revision}, iteration ${iteration}`
          : `Not yet released — iteration ${iteration}. Onshape assigns the revision at release.`
      }
      style={{
        background: released ? "var(--ok-soft)" : "var(--surface-2)",
        color: released ? "var(--ok)" : "var(--text-faint)",
        borderColor: released ? "var(--ok)" : "var(--border)",
      }}
    >
      {released ? revision : "–"}.{iteration}
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
