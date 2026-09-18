#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_BRANCH="${DATA_BRANCH:-data}"
WORKTREE_DIR="${DATA_WORKTREE_DIR:-$REPO_ROOT/.worktrees/data}"

NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"
git rev-parse --is-inside-work-tree >/dev/null

# Ensure data branch exists.
if ! git show-ref --verify --quiet "refs/heads/$DATA_BRANCH"; then
  echo "ERROR: data branch not found: $DATA_BRANCH" >&2
  exit 1
fi

# Create/repair worktree for data branch.
git worktree prune >/dev/null 2>&1 || true

# If dir exists but isn't a valid worktree checkout, remove it.
if [[ -e "$WORKTREE_DIR" && ! -e "$WORKTREE_DIR/.git" ]]; then
  rm -rf "$WORKTREE_DIR"
fi

# If missing, add it.
if [[ ! -e "$WORKTREE_DIR/.git" ]]; then
  mkdir -p "$(dirname "$WORKTREE_DIR")"
  git worktree add -f -q "$WORKTREE_DIR" "$DATA_BRANCH"
fi

cd "$WORKTREE_DIR"

# Ensure viz artifacts exist (helpful if you haven't run daily yet)
if [[ ! -f "viz/data/index.json" ]]; then
  echo "viz/data/index.json missing; building..." >&2
  "$NODE_BIN" tools/build_viz_index.js
fi
if [[ ! -f "viz/data/db_commits.json" ]]; then
  echo "viz/data/db_commits.json missing; building..." >&2
  "$NODE_BIN" tools/build_viz_commits.js
fi
if [[ ! -f "viz/data/recent.json" ]]; then
  echo "viz/data/recent.json missing; building..." >&2
  "$NODE_BIN" tools/build_viz_recent.js
fi

# viz/data/skus/** is a Release asset (tag skus-latest), not committed, so a fresh worktree has
# no per-SKU history → item pages render without charts. Best-effort restore, same as run_daily.
if ! [[ -d "viz/data/skus" ]] && command -v gh >/dev/null 2>&1; then
  if gh release download skus-latest \
       --pattern 'skus.tar.gz' --output /tmp/spirit-tracker-skus.tar.gz --clobber 2>/dev/null \
     && tar xzf /tmp/spirit-tracker-skus.tar.gz -C "$WORKTREE_DIR/viz/data" 2>/dev/null; then
    echo "restored skus cache from skus-latest Release" >&2
  else
    echo "WARN: could not restore skus cache from skus-latest; item charts will be missing until a run_daily.sh" >&2
  fi
  rm -f /tmp/spirit-tracker-skus.tar.gz
fi

exec "$NODE_BIN" viz/serve.js
