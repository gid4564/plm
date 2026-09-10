#!/usr/bin/env bash
# Build a deployable bundle on THIS machine, so the server never has to.
#
# The server has too little RAM to run `next build` — Next needs well over a
# gigabyte to compile, while the traced output runs in a fraction of that. So the
# build happens here and the server receives finished JavaScript: no npm install,
# no devDependencies, no build step, and only ~50MB of disk.
#
# Next's standalone output traces only the modules needed at runtime, and
# next.config.ts excludes sharp, so a build on macOS runs unchanged on Linux.
#
#   ./scripts/package-release.sh
#   scp dist/plm-release.tar.gz user@server:/tmp/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/plm"
cd "$ROOT"

# A dev server writing into .next while this builds mixes development chunks
# into the bundle. Checked up front rather than only afterwards, so the failure
# comes before spending a minute on the build.
if lsof -nP -iTCP:3011 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "a dev server is listening on 3011." >&2
  echo "It writes into .next while this builds, which mixes development chunks" >&2
  echo "into the bundle. Stop it first." >&2
  exit 1
fi

echo "==> typechecking"
# Shipping a bundle that does not typecheck is worse than a slower build: the
# failure surfaces on the server, where there is no toolchain to diagnose it.
npx tsc --noEmit

echo "==> building"
rm -rf .next dist
npx next build >/dev/null

if [ ! -d .next/standalone ]; then
  echo "no .next/standalone — is output:'standalone' still set in next.config.ts?" >&2
  exit 1
fi

echo "==> stamping build"
BUILD_ID="$(date -u +%Y%m%d-%H%M%S)"
BUILD_HASH="$(find src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec shasum {} \; | shasum | cut -c1-8)"

echo "==> assembling"
mkdir -p "$OUT/.next"
cp -R .next/standalone/. "$OUT/"
cp -R .next/static "$OUT/.next/static"
[ -d public ] && cp -R public "$OUT/public"
cp ecosystem.config.cjs "$OUT/"
# Admin tooling that must run where the database is reachable.
cp scripts/find-duplicates.mjs "$OUT/"

# The manual is read from disk at request time, so it ships as a file rather
# than being compiled in — it can be corrected on the server without a rebuild.
# The integration spec travels too: it is what someone reaches for when a live
# tenant behaves differently from the mock.
mkdir -p "$OUT/docs"
cp docs/MANUAL.md docs/DEPLOYMENT.md docs/ONSHAPE-INTEGRATION-SPEC.md "$OUT/docs/"

# A template rather than the real thing: .env.local is gitignored and holds
# secrets, so it is never packaged. The server keeps its own.
cp .env.example "$OUT/env.example"

# A build stamp, so "is my fix actually deployed?" is answerable in one command
# instead of inferred from output formatting.
cat > "$OUT/build-info.json" <<JSON
{ "buildId": "$BUILD_ID", "sourceHash": "$BUILD_HASH" }
JSON

# The giveaway for a dev-contaminated bundle is a static/development directory
# or hot-update chunks, neither of which a production build ever creates.
# Checked again here because the port probe above only catches a dev server
# still running — not one that was stopped mid-build.
if [ -d "$OUT/.next/static/development" ] || \
   find "$OUT/.next/static" -name '*.hot-update.*' -print -quit 2>/dev/null | grep -q .; then
  echo "refusing to ship: development artifacts in the bundle." >&2
  echo "A dev server was writing to .next during the build. Stop it and re-run." >&2
  exit 1
fi

# A bundle carrying host-specific binaries would not survive the trip.
NATIVE=$(find "$OUT" \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \) | wc -l | tr -d ' ')
if [ "$NATIVE" != "0" ]; then
  echo "refusing to ship: $NATIVE native binaries traced into the bundle" >&2
  find "$OUT" \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \) >&2
  exit 1
fi

# The server runs `node server.js` directly, so its absence is the one failure
# that would only show up as a crash loop under pm2.
if [ ! -f "$OUT/server.js" ]; then
  echo "refusing to ship: no server.js in the bundle" >&2
  exit 1
fi

echo "==> packing"
tar -czf "$ROOT/dist/plm-release.tar.gz" -C "$ROOT/dist" plm

PORT_IN_PM2=$(grep -oE 'PORT: *[0-9]+' "$OUT/ecosystem.config.cjs" | grep -oE '[0-9]+')

echo
echo "  build  : $BUILD_ID  (source $BUILD_HASH)"
echo "  bundle : dist/plm/               ($(du -sh "$OUT" | cut -f1))"
echo "  tarball: dist/plm-release.tar.gz ($(du -sh "$ROOT/dist/plm-release.tar.gz" | cut -f1))"
echo "  port   : $PORT_IN_PM2 (from ecosystem.config.cjs)"
echo "  native binaries: 0 — portable"
echo
cat <<'NEXT'
On the server:

  scp dist/plm-release.tar.gz user@server:/tmp/
  ssh user@server
  sudo mkdir -p /opt/plm && sudo chown $USER /opt/plm
  tar -xzf /tmp/plm-release.tar.gz -C /tmp
  rsync -a --delete --exclude .env.local --exclude .pm2 /tmp/plm/ /opt/plm/
  cd /opt/plm

First deploy only — write the environment, then start:

  cp env.example .env.local && $EDITOR .env.local
  pm2 start ecosystem.config.cjs && pm2 save

Later deploys — the rsync above already replaced the code:

  pm2 restart plm

Check it:

  curl -s localhost:3005/api/version     # build id should match above
NEXT
