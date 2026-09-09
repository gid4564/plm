#!/usr/bin/env bash
# Build a deployable bundle on THIS machine, so the server never has to.
#
# Next's standalone output traces only the modules needed at runtime, and
# next.config.ts excludes sharp, so the result is pure JavaScript — a build on
# macOS runs unchanged on a Linux server. The server needs no npm install, no
# devDependencies, no build step, and only ~50MB of disk.
#
#   ./scripts/package-release.sh
#   scp dist/mos-release.tar.gz user@server:/tmp/
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist/mos"
cd "$ROOT"

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
mkdir -p "$OUT/docs"
cp docs/MANUAL.md docs/DEPLOYMENT.md "$OUT/docs/"

# A build stamp, so "is my fix actually deployed?" is answerable in one command
# instead of inferred from output formatting.
cat > "$OUT/build-info.json" <<JSON
{ "buildId": "$BUILD_ID", "sourceHash": "$BUILD_HASH" }
JSON

# A dev server writing into .next while this builds mixes development chunks
# into the bundle — many times larger, and not what runs in production. The
# giveaway is a static/development directory, which a production build never
# creates.
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

echo "==> packing"
tar -czf "$ROOT/dist/mos-release.tar.gz" -C "$ROOT/dist" mos

echo
echo "  build  : $BUILD_ID  (source $BUILD_HASH)"
echo "  bundle : dist/mos/              ($(du -sh "$OUT" | cut -f1))"
echo "  tarball: dist/mos-release.tar.gz ($(du -sh "$ROOT/dist/mos-release.tar.gz" | cut -f1))"
echo "  native binaries: 0 — portable"
echo
echo "On the server: untar, write .env.local (or set env vars), then"
echo "  pm2 start ecosystem.config.cjs"
