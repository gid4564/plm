"use client";

import React from "react";

/**
 * A task's priority, as a mark you can read at a glance.
 *
 * Priority on a board is scanned, not read: the question is "what needs me
 * first", asked of thirty cards at once. A word in a neutral chip makes every
 * card look the same until you read it, so this encodes urgency in shape AND
 * colour — direction for rank, weight for severity — and keeps the word as the
 * tooltip and the screen-reader label.
 *
 * Matched by LABEL, with the code only as a fallback. Onshape's stock task
 * workflow publishes `0=Low, 1=Medium, 2=High, 3=Very high`, but those codes
 * are a tenant's own list: another enterprise can number them differently, and
 * matching the word is what survives that. (The Task State property taught
 * this the hard way — see lib/tasks.ts.)
 */

type Rank = "very-high" | "high" | "medium" | "low";

const META: Record<Rank, { label: string; color: string; soft: string; title: string }> = {
  "very-high": {
    label: "Very high",
    color: "var(--danger)",
    soft: "var(--danger-soft)",
    title: "Very high priority",
  },
  high: {
    label: "High",
    color: "var(--warn)",
    soft: "var(--warn-soft)",
    title: "High priority",
  },
  medium: {
    label: "Medium",
    color: "var(--text-muted)",
    soft: "var(--surface-2)",
    title: "Medium priority",
  },
  low: {
    label: "Low",
    color: "var(--text-faint)",
    soft: "var(--surface-2)",
    title: "Low priority",
  },
};

/**
 * Which rank a priority value means.
 *
 * "Very high" has to be tested before "high", because it contains the word —
 * a naive check would rank the most urgent tasks as merely high.
 */
export function priorityRank(value: string | null | undefined): Rank | null {
  const v = String(value ?? "").trim();
  if (!v) return null;

  if (/very\s*high|urgent|critical|highest|blocker/i.test(v)) return "very-high";
  if (/high/i.test(v)) return "high";
  if (/medium|normal|moderate/i.test(v)) return "medium";
  if (/low|minor|trivial/i.test(v)) return "low";

  /* A bare code, from a tenant whose labels did not come through. */
  switch (v) {
    case "3": return "very-high";
    case "2": return "high";
    case "1": return "medium";
    case "0": return "low";
    default: return null;
  }
}

/** Sort weight, highest first — 0 for anything unrecognised. */
export function priorityWeight(value: string | null | undefined): number {
  const r = priorityRank(value);
  return r === "very-high" ? 4 : r === "high" ? 3 : r === "medium" ? 2 : r === "low" ? 1 : 0;
}

/**
 * The glyph for a rank.
 *
 * Direction carries rank — up for above normal, a bar for normal, down for
 * below — so the shapes stay distinguishable without colour, for a reader who
 * cannot separate the red from the orange.
 */
function Glyph({ rank, size }: { rank: Rank; size: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (rank === "very-high") {
    /* A double chevron: one more than high, which is the whole distinction. */
    return (
      <svg {...common}>
        <path d="M5 13l7-7 7 7" />
        <path d="M5 20l7-7 7 7" />
      </svg>
    );
  }
  if (rank === "high") {
    return (
      <svg {...common}>
        <path d="M5 16l7-7 7 7" />
      </svg>
    );
  }
  if (rank === "medium") {
    return (
      <svg {...common}>
        <path d="M5 12h14" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M5 8l7 7 7-7" />
    </svg>
  );
}

/**
 * The priority mark.
 *
 * `withLabel` puts the word beside the glyph, for places with room for it —
 * a detail panel, or a list row. A dense board card takes the glyph alone,
 * which is why the word is always in the tooltip and the aria-label rather
 * than only in the text.
 */
export function PriorityIcon({
  value,
  withLabel = false,
  size = 13,
}: {
  value: string | null | undefined;
  withLabel?: boolean;
  size?: number;
}) {
  const rank = priorityRank(value);
  /*
   * Nothing at all when there is no priority — not a grey placeholder. A mark
   * on every card trains people to stop seeing the ones that matter.
   */
  if (!rank) return null;

  const meta = META[rank];
  /* The tenant's own word where there is one, so a custom label still shows. */
  const word = String(value ?? "").trim() || meta.label;

  return (
    <span
      title={`${word} priority`}
      aria-label={`${word} priority`}
      role="img"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        color: meta.color,
        background: withLabel ? meta.soft : "transparent",
        border: withLabel ? `1px solid ${meta.color}` : "none",
        borderRadius: withLabel ? 999 : 0,
        padding: withLabel ? "1px 7px 1px 5px" : 0,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      <Glyph rank={rank} size={size} />
      {withLabel && <span>{word}</span>}
    </span>
  );
}
