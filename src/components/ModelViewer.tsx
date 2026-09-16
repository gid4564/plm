"use client";

import React from "react";

/**
 * A glTF viewer for a released part.
 *
 * Google's <model-viewer>, bundled rather than pulled from a CDN: nothing else
 * in this application loads a script from another origin, and a viewer that
 * stops working when a CDN is unreachable — or on a network that cannot reach
 * one at all — is not much of a record.
 *
 * It is heavy (the library is ~460KB minified before the model itself), so it
 * is imported inside an effect rather than at module scope. Next then splits it
 * into its own chunk, which is fetched when somebody asks to see a model and
 * never by anyone who does not.
 */

/*
 * The custom element, so TSX will accept it.
 *
 * Declared inside `declare module "react"`, not on the global JSX namespace:
 * React 19 moved JSX's types under the react module, and a global
 * `namespace JSX` augmentation is simply ignored there — the element then
 * fails to type-check with "does not exist on type JSX.IntrinsicElements".
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          alt?: string;
          poster?: string;
          "camera-controls"?: boolean | string;
          "auto-rotate"?: boolean | string;
          "camera-orbit"?: string;
          "field-of-view"?: string;
          "shadow-intensity"?: string;
          "environment-image"?: string;
          exposure?: string;
          ar?: boolean | string;
          "ar-modes"?: string;
        },
        HTMLElement
      >;
    }
  }
}

type Status = "idle" | "loading" | "ready" | "failed";

/** A point worth marking on the model — currently only its center of mass. */
export type ModelHotspot = {
  /** [x, y, z] in the model's own coordinate frame, in metres. */
  positionM: [number, number, number];
  label: string;
};

export function ModelViewer({
  src,
  label,
  height = 320,
  /**
   * The part's existing 2D render, if one has been cached — see PartThumb.
   * Shown in place of an empty box for every phase before the model itself
   * has anything to draw: while the library is loading, and again during
   * model-viewer's own brief gap between mounting and finishing the glTF
   * fetch. A part that already has a thumbnail then never shows a blank
   * placeholder at all, just a 2D image that becomes a 3D one.
   */
  poster,
  /**
   * Marked on the model once mass properties have actually been measured —
   * see PartDetail's Mass properties card. Not fetched here: that is a live
   * Onshape call, and a viewer nobody asked to measure anything should not
   * spend one.
   */
  hotspot,
}: {
  src: string;
  label: string;
  height?: number;
  poster?: string;
  hotspot?: ModelHotspot;
}) {
  const [status, setStatus] = React.useState<Status>("idle");
  const [error, setError] = React.useState<string | null>(null);

  /*
   * The library registers a custom element, which is a global side effect. It
   * is loaded once, on demand, and only in the browser — importing it at module
   * scope would run it during the server render, where customElements does not
   * exist.
   */
  React.useEffect(() => {
    if (status !== "loading") return;
    let cancelled = false;

    import("@google/model-viewer")
      .then(() => { if (!cancelled) setStatus("ready"); })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
        setStatus("failed");
      });

    return () => { cancelled = true; };
  }, [status]);

  const frame: React.CSSProperties = {
    height,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface-2)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // The part's existing 2D render, so "not loaded yet" looks like the part
    // rather than an empty box. Absent for a part with no cached thumbnail —
    // the frame's plain background then shows through exactly as before.
    ...(poster && {
      backgroundImage: `url(${poster})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    }),
  };

  if (status === "idle") {
    return (
      <div style={frame}>
        {/*
          * A solid backing behind the button rather than a bare button on top
          * of a photo — otherwise the button reads as part of the image.
          */}
        <button
          className="btn btn-sm"
          onClick={() => setStatus("loading")}
          style={poster ? { background: "var(--surface)", boxShadow: "0 1px 4px rgba(0,0,0,0.25)" } : undefined}
        >
          View in 3D
        </button>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div style={{ ...frame, fontSize: 12.5, color: "var(--text-faint)" }}>
        <span
          style={
            poster
              ? {
                  background: "var(--surface)", padding: "3px 8px", borderRadius: 4,
                  boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
                }
              : undefined
          }
        >
          Loading the viewer…
        </span>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div style={{ ...frame, flexDirection: "column", gap: 6, padding: 12 }}>
        <span style={{ fontSize: 12.5, color: "var(--danger)" }}>
          The 3D viewer could not load.
        </span>
        <span style={{ fontSize: 11.5, color: "var(--text-faint)", textAlign: "center" }}>
          {error}
        </span>
        <a className="btn btn-sm" href={src} download>Download the model instead</a>
      </div>
    );
  }

  return (
    <model-viewer
      src={src}
      alt={label}
      camera-controls
      auto-rotate
      /*
       * model-viewer's own default orbit is dead-on front ("0deg 75deg
       * 105%") — nearly a flat elevation on anything box-like, which is
       * exactly the wrong angle to prove something is 3D. A 3/4 angle shows a
       * top and a side face alongside the front, the way a product photo
       * would, so a part reads as a solid the instant it loads rather than
       * only once auto-rotate has carried it somewhere more revealing.
       */
      camera-orbit="-35deg 65deg 105%"
      /*
       * The default 30deg FOV leaves a part looking small and centered in a
       * lot of empty card — narrowing it brings the part closer to filling
       * the frame, which reads as "this is the subject" rather than "this is
       * a small thing floating in a box". 24deg is as far as that goes before
       * a part this size starts clipping against the card's edges.
       */
      field-of-view="24deg"
      shadow-intensity="1"
      /*
       * A touch over the library's default of 1: model-viewer's built-in
       * neutral studio environment is intentionally conservative so it never
       * blows out a bright material, which leaves an ordinary light-grey part
       * looking slightly flat. 1.15 gives it a bit more presence without
       * visibly clipping highlights.
       */
      exposure="1.15"
      // The same 2D render used before the library loaded — see `frame`
      // above — so the glTF's own fetch-and-parse gap, after model-viewer has
      // mounted, is covered too. `reveal` is left at its default ("auto"),
      // which swaps this out for the real scene the moment it is ready.
      poster={poster}
      /*
       * Handed to the device's own AR viewer — iOS Quick Look or Android
       * Scene Viewer over WebXR — where supported. model-viewer generates the
       * USDZ Quick Look needs on the fly, so this is the one attribute rather
       * than a second export pipeline. It renders nothing (no button, no
       * cost) on a browser or device that cannot do it, which is most of
       * where this is viewed today — but a demo that can hold a released
       * bracket up in the room it will actually be made for is worth the one
       * attribute even so.
       */
      ar
      style={{
        width: "100%",
        height,
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface-2)",
        // The element is block-level; without this it collapses in a flex row.
        display: "block",
      }}
    >
      {hotspot && (
        <button
          slot="hotspot-mass"
          data-position={`${hotspot.positionM[0]}m ${hotspot.positionM[1]}m ${hotspot.positionM[2]}m`}
          data-normal="0m 1m 0m"
          title={hotspot.label}
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--accent, #3c78dc)",
            border: "2px solid white",
            boxShadow: "0 0 0 1px var(--accent, #3c78dc), 0 1px 4px rgba(0,0,0,0.4)",
            padding: 0,
            cursor: "default",
          }}
        >
          <span
            style={{
              position: "absolute",
              left: 18,
              top: -8,
              whiteSpace: "nowrap",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "2px 6px",
              boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
            }}
          >
            {hotspot.label}
          </span>
        </button>
      )}
    </model-viewer>
  );
}
