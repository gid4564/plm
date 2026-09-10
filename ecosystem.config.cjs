/**
 * pm2 process definition for the PLM server.
 *
 * Runs the standalone server produced by `scripts/package-release.sh`, which is
 * a plain `node server.js` — no npm wrapper (npm does not forward SIGTERM
 * cleanly, so pm2 restarts can orphan the real process and leave it holding the
 * port) and no Next CLI needed on the server.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup     # survive reboots
 *
 * Named "plm" and on its own port so it can run alongside MOS on the same box.
 */
module.exports = {
  apps: [
    {
      name: "plm",
      script: "server.js",
      cwd: __dirname,

      // Fork mode, single instance. Cluster mode works, but each worker opens
      // its own MongoDB pool and its own in-process caches — not worth it until
      // the load justifies it.
      exec_mode: "fork",
      instances: 1,

      env: {
        NODE_ENV: "production",
        PORT: 3005,
      },

      /*
       * Next reads .env.local itself, and anything set here wins over that file
       * — which is the hook for injecting real secrets from deploy tooling.
       *
       * PORT is set here rather than left to .env.local on purpose: it is a
       * property of how this box is wired up, not of the application's
       * configuration, and pm2 is where someone looks for it. APP_BASE_URL is
       * the opposite — it belongs in .env.local, because it is the public HTTPS
       * URL Onshape must reach, not the local port.
       */

      max_memory_restart: "512M",
      autorestart: true,
      // Stop restart-looping on a config error that will never fix itself.
      max_restarts: 10,
      min_uptime: "20s",

      error_file: "./.pm2/error.log",
      out_file: "./.pm2/out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
