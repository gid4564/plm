#!/usr/bin/env bash
# Install an extracted release into place and restart it. Runs ON THE SERVER.
#
# Ships inside the bundle, so after extracting you have it to hand:
#
#   tar -xzf /tmp/plm-release.tar.gz -C /tmp
#   /tmp/plm/deploy.sh              # shows what would change, changes nothing
#   /tmp/plm/deploy.sh --apply
#
# It exists because the rsync it wraps carries --delete, and typing that by hand
# is how a deploy goes wrong: a relative destination resolves against the working
# directory, and the deploy steps cd into the target first — so
# "home/gid/apps/plm/" became "/home/gid/apps/plm/home/gid/apps/plm". That
# attempt failed harmlessly, but the same slip onto a path that does exist would
# have emptied it.
set -euo pipefail

DEST="${PLM_DEST:-/home/ubuntu/apps/plm}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# --- The guards that make --delete safe to run -----------------------------

case "$DEST" in
  /*) ;;
  *)  echo "destination must be absolute, got '$DEST'." >&2
      echo "A relative path resolves against the working directory, which is" >&2
      echo "how this has gone wrong before. Set PLM_DEST to an absolute path." >&2
      exit 1 ;;
esac

# The parent must already exist. Without this a typo creates a plausible-looking
# tree somewhere unintended and deploys into it.
PARENT="$(dirname "$DEST")"
if [ ! -d "$PARENT" ]; then
  echo "$PARENT does not exist, so $DEST is probably not the path you meant." >&2
  exit 1
fi

# The source must be a bundle, not any old directory — server.js is what pm2
# runs, and rsyncing something without it would leave a broken deployment.
if [ ! -f "$SRC/server.js" ] || [ ! -f "$SRC/build-info.json" ]; then
  echo "$SRC does not look like an extracted PLM release (no server.js)." >&2
  exit 1
fi

# Refuse to --delete into a directory holding something unexpected. An existing
# deployment has server.js; an empty directory is a first deploy. Anything else
# is a directory that belongs to something other than PLM.
if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ] && [ ! -f "$DEST/server.js" ]; then
  echo "$DEST is not empty and holds no server.js, so it does not look like a" >&2
  echo "PLM deployment. Refusing to rsync --delete into it. Contents:" >&2
  ls -A "$DEST" | head -10 >&2
  exit 1
fi

mkdir -p "$DEST"

# --- What is about to happen ------------------------------------------------

NEW_BUILD="$(sed -n 's/.*"buildId": *"\([^"]*\)".*/\1/p' "$SRC/build-info.json")"
OLD_BUILD="$(sed -n 's/.*"buildId": *"\([^"]*\)".*/\1/p' "$DEST/build-info.json" 2>/dev/null || echo "none")"

echo "  from : $SRC   (build $NEW_BUILD)"
echo "  to   : $DEST  (build $OLD_BUILD)"
echo

# .env.local holds the secrets and .pm2 the logs: both belong to the server, not
# to the bundle, and must survive every deploy.
RSYNC=(rsync -a --delete --exclude .env.local --exclude .pm2 "$SRC/" "$DEST/")

if [ "$APPLY" = "0" ]; then
  echo "==> dry run"
  "${RSYNC[@]}" --dry-run --itemize-changes | head -40
  echo
  echo "Nothing changed. Re-run with --apply to deploy."
  exit 0
fi

echo "==> installing"
"${RSYNC[@]}"

if [ ! -f "$DEST/.env.local" ]; then
  echo
  echo "No .env.local in $DEST — this looks like a first deploy."
  echo "Write it, then start the app:"
  echo "  cd $DEST && cp env.example .env.local && \$EDITOR .env.local"
  echo "  pm2 start ecosystem.config.cjs && pm2 save"
  exit 0
fi

if ! command -v pm2 >/dev/null 2>&1; then
  # The code is already in place, so this is recoverable — say so rather than
  # leaving a bare "command not found" from inside a script.
  echo
  echo "pm2 is not installed or not on PATH, so the app was not restarted." >&2
  echo "The new build IS in $DEST. Install pm2 (npm i -g pm2), then:" >&2
  echo "  cd $DEST && pm2 start ecosystem.config.cjs && pm2 save" >&2
  exit 1
fi

echo "==> restarting"
cd "$DEST"
if pm2 describe plm >/dev/null 2>&1; then
  pm2 restart plm --update-env
else
  pm2 start ecosystem.config.cjs
  pm2 save
fi

# --- Confirm what is actually running --------------------------------------

PORT="$(sed -n 's/.*PORT: *\([0-9]*\).*/\1/p' "$DEST/ecosystem.config.cjs" | head -1)"
echo
echo "==> checking http://localhost:${PORT:-3005}/api/version"
for i in 1 2 3 4 5 6 7 8 9 10; do
  RUNNING="$(curl -fsS "http://localhost:${PORT:-3005}/api/version" 2>/dev/null \
    | sed -n 's/.*"buildId":"\([^"]*\)".*/\1/p' || true)"
  [ -n "$RUNNING" ] && break
  sleep 1
done

if [ -z "${RUNNING:-}" ]; then
  echo "  the app did not answer. Check: pm2 logs plm --lines 50" >&2
  exit 1
fi

if [ "$RUNNING" = "$NEW_BUILD" ]; then
  echo "  running build $RUNNING — matches what was just deployed."
else
  # Worth distinguishing from a code bug: the deploy did not take effect.
  echo "  running build $RUNNING, but $NEW_BUILD was deployed." >&2
  echo "  pm2 is still holding the old process. Try: pm2 delete plm && pm2 start ecosystem.config.cjs" >&2
  exit 1
fi
