/**
 * pm2 process definition for the MOS server.
 *
 * Runs the standalone server produced by `scripts/package-release.sh`, which
 * is a plain `node server.js` — no npm wrapper (npm does not forward SIGTERM
 * cleanly, so pm2 restarts can orphan the real process and leave it holding the
 * port) and no Next CLI needed on the server.
 *
 * If you instead build on the server, change script/args to:
 *   script: "./node_modules/.bin/next", args: "start -p 3000"
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup     # survive reboots
 */
module.exports = {
  apps: [
    {
      name: "mos",
      script: "server.js",
      cwd: __dirname,

      // Fork mode, single instance. Cluster mode works, but each worker opens its
      // own MongoDB pool and its own in-process caches — not worth it until the
      // load justifies it.
      exec_mode: "fork",
      instances: 1,

      env: {
        NODE_ENV: "production",
        PORT: 3003,
      },

      // Next.js reads .env.local itself. Anything set here wins over that file,
      // which is the hook for injecting real secrets from your deploy tooling.

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
