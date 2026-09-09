#!/usr/bin/env bash
# Local MongoDB for development.
#
# Self-contained: data and logs live under .localdb/ in this project, nothing is
# registered as a system service. Exists because corporate TLS inspection
# (Zscaler) intercepts port 27017 and prevents this machine reaching Atlas.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/.localdb/data"
LOG="$ROOT/.localdb/mongod.log"
PORT="${PLM_DB_PORT:-27017}"

running() { pgrep -f "mongod --dbpath $DATA" >/dev/null 2>&1; }

case "${1:-}" in
  start)
    if running; then echo "already running on port $PORT"; exit 0; fi
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      # Almost always the MOS instance on the same machine. Two databases on one
      # mongod is exactly what is wanted here, so this is a no-op rather than a
      # failure — PLM only needs its own database, not its own server.
      echo "a mongod is already listening on 127.0.0.1:$PORT."
      echo "PLM will use its own database on it. Nothing to start."
      exit 0
    fi
    mkdir -p "$DATA"
    mongod --dbpath "$DATA" --port "$PORT" --bind_ip 127.0.0.1 --fork --logpath "$LOG" >/dev/null
    echo "mongod up on 127.0.0.1:$PORT  (log: .localdb/mongod.log)"
    ;;
  stop)
    if ! running; then echo "not running"; exit 0; fi
    mongosh --quiet --port "$PORT" --eval 'db.getSiblingDB("admin").shutdownServer()' >/dev/null 2>&1 || true
    sleep 1
    running && { echo "did not stop cleanly; sending TERM"; pkill -f "mongod --dbpath $DATA" || true; } || true
    echo "mongod stopped"
    ;;
  status)
    if running; then
      echo "running on 127.0.0.1:$PORT"
      mongosh --quiet --port "$PORT" --eval 'print("  ping ok, dbs: " + db.adminCommand({listDatabases:1}).databases.map(d=>d.name).join(", "))' 2>/dev/null || true
    else
      echo "not running"
    fi
    ;;
  logs) tail -n "${2:-40}" "$LOG" ;;
  *) echo "usage: $0 {start|stop|status|logs [n]}" >&2; exit 2 ;;
esac
