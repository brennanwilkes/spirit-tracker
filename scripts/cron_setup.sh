#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
DATA_BRANCH="${DATA_BRANCH:-data}"

NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/reports"

# Default: run 4 times/day (every 6 hours). Override via:
#   CRON_SCHEDULE="15 */4 * * *"  (example)
CRON_SCHEDULE="${CRON_SCHEDULE:-0 */6 * * *}"

# Use a stable marker so we can replace old lines (including the previous "daily" one).
MARKER="# spirit-tracker"
CRON_LINE="$CRON_SCHEDULE NODE_BIN=$NODE_BIN MAIN_BRANCH=$MAIN_BRANCH DATA_BRANCH=$DATA_BRANCH bash \"$REPO_ROOT/scripts/run_daily.sh\" >> \"$REPO_ROOT/reports/cron.log\" 2>&1 $MARKER"

# Install (idempotent): remove any previous line with the marker, then append.
{ crontab -l 2>/dev/null | grep -vF "$MARKER" || true; echo "$CRON_LINE"; } | crontab -

echo "Installed cron job:"
echo "$CRON_LINE"
