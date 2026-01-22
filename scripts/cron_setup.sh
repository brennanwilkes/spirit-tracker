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

# 8 runs/day total:
# - Big runs (all stores) at 00:00 and 12:00
# - Small runs (2 stores) at 03:00, 06:00, 09:00, 15:00, 18:00, 21:00
CRON_BIG="${CRON_SCHEDULE_BIG:-0 0,12 * * *}"
CRON_SMALL="${CRON_SCHEDULE_SMALL:-0 3,6,9,15,18,21 * * *}"

# Comma-separated. Can be store keys OR names (main.js normalizes).
STORES_SMALL="${STORES_SMALL:-sierra_springs,craft_cellars}"

# Use a stable marker so we can replace old lines (including the previous "daily" one).
MARKER="# spirit-tracker"
CRON_LINE_BIG="$CRON_BIG NODE_BIN=$NODE_BIN MAIN_BRANCH=$MAIN_BRANCH DATA_BRANCH=$DATA_BRANCH bash \"$REPO_ROOT/scripts/run_daily.sh\" >> \"$REPO_ROOT/reports/cron.log\" 2>&1 $MARKER big"
CRON_LINE_SMALL="$CRON_SMALL STORES=$STORES_SMALL NODE_BIN=$NODE_BIN MAIN_BRANCH=$MAIN_BRANCH DATA_BRANCH=$DATA_BRANCH bash \"$REPO_ROOT/scripts/run_daily.sh\" >> \"$REPO_ROOT/reports/cron.log\" 2>&1 $MARKER small"

# Install (idempotent): remove any previous line with the marker, then append both.
{ crontab -l 2>/dev/null | grep -vF "$MARKER" || true; echo "$CRON_LINE_BIG"; echo "$CRON_LINE_SMALL"; } | crontab -

echo "Installed cron job:"
echo "$CRON_LINE_BIG"
echo "$CRON_LINE_SMALL"
