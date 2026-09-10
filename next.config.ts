import type { NextConfig } from "next";

/**
 * The panel page is loaded by Onshape inside an iframe, so it must NOT be
 * blocked by frame-ancestors. Everything else stays frame-denied.
 */
const config: NextConfig = {
  /**
   * Emit .next/standalone — a self-contained server with only the modules the
   * app actually needs at runtime, traced from the build.
   *
   * This lets the build happen on a workstation or CI box and ship a small
   * artifact, instead of requiring the server to hold ~1.5GB of RAM and 600MB of
   * disk to compile Next itself.
   */
  output: "standalone",

  /**
   * sharp is only used by next/image, which this app never renders. Left in, the
   * tracer copies the host's platform-specific libvips binaries into the bundle
   * and the artifact stops being portable. Excluding it keeps the standalone
   * output pure JavaScript, so a build on macOS runs unchanged on a Linux server.
   */
  outputFileTracingExcludes: {
    "*": ["node_modules/@img/**", "node_modules/sharp/**"],
  },
  async headers() {
    return [
      {
        /*
         * Every panel route, not just /panel.
         *
         * The assembly panel lives at /panel/assembly, and matching only
         * "/panel" left it with no frame headers at all — frameable by
         * accident rather than by decision. `:path*` covers the parent and its
         * children, so adding a third panel needs no change here.
         */
        source: "/panel/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self' https://*.onshape.com http://localhost:* ;",
          },
        ],
      },
      {
        source: "/panel",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self' https://*.onshape.com http://localhost:* ;",
          },
        ],
      },
      {
        source: "/((?!panel).*)",
        headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }],
      },
    ];
  },
};

export default config;
