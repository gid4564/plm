"use client";

import { useState } from "react";
import { Alert, Spinner } from "@/components/ui";

/**
 * Chrome shared by the Onshape right-panel extensions.
 *
 * There are two panels — one for a part in a Part Studio, one for an assembly —
 * and the signed-out flow below took several attempts to get right across
 * browsers. Sharing it means the second panel cannot quietly regress it.
 */

export const panelWrap: React.CSSProperties = {
  padding: 12, fontSize: 13, minHeight: "100vh",
  background: "var(--bg)", display: "grid", gap: 11, alignContent: "start",
};

export function PanelHeader({ title = "PLM" }: { title?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" width={17} height={17} style={{ display: "block" }} />
      <strong style={{ fontSize: 12.5 }}>{title}</strong>
    </div>
  );
}

/**
 * Signed-out state inside the Onshape iframe.
 *
 * Two browser behaviours have to be worked around here:
 *
 *  1. The panel is a third-party context, so the session cookie must be
 *     SameSite=None; Secure to be sent at all (see lib/auth/session.ts).
 *  2. Safari blocks third-party cookies outright, and Chrome is restricting
 *     them. The Storage Access API is the sanctioned way back in, but it needs
 *     a real user gesture — hence the explicit button rather than an on-mount
 *     call.
 *
 * Flow: sign in via a top-level tab (which sets the cookie), come back, then
 * grant storage access so the iframe is allowed to use it.
 */
export function SignedOut({
  title,
}: {
  title?: string;
}) {
  const [checking, setChecking] = useState(false);
  const [denied, setDenied] = useState(false);

  async function grantAndReload() {
    setChecking(true);
    setDenied(false);
    try {
      const d = document as Document & {
        requestStorageAccess?: () => Promise<void>;
        hasStorageAccess?: () => Promise<boolean>;
      };

      if (typeof d.requestStorageAccess === "function") {
        const already = (await d.hasStorageAccess?.()) ?? false;
        if (!already) await d.requestStorageAccess();
      }
      window.location.reload();
    } catch {
      // The browser refused, or the user dismissed the prompt.
      setDenied(true);
      setChecking(false);
    }
  }

  return (
    <div style={panelWrap}>
      <PanelHeader title={title} />
      <p style={{ color: "var(--text-muted)", margin: 0, lineHeight: 1.55 }}>
        Connect this Onshape session to your MOS account to see and edit manufacturing data here.
      </p>

      {/*
        The new tab lands on the dashboard, not back on this panel.
        Returning it here left the signed-in user staring at a second copy of
        the panel rendered as a full page — no navigation, since panels carry
        no app chrome by design, and nothing to do on it. The panel they came
        from is still open in Onshape; this tab exists only to set the cookie,
        so it should land somewhere they can actually use.
      */}
      <a
        className="btn btn-primary"
        href="/api/onshape/oauth/start?returnTo=%2Fdashboard"
        target="_blank"
        rel="noopener noreferrer"
      >
        Sign in to MOS ↗
      </a>

      <button className="btn" onClick={grantAndReload} disabled={checking}>
        {checking && <Spinner />} I&apos;ve signed in — continue
      </button>

      {denied && (
        <Alert kind="warn">
          Your browser blocked this panel from using its MOS session. Allow cookies for
          this site, or use the full record in a normal tab.
        </Alert>
      )}

      <p style={{ fontSize: 11, color: "var(--text-faint)", margin: 0, lineHeight: 1.5 }}>
        Sign-in opens in a new tab because browsers restrict cookies inside embedded panels.
      </p>
    </div>
  );
}
