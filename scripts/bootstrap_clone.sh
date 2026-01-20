#!/usr/bin/env bash
set -euo pipefail

MAIN_BRANCH="${MAIN_BRANCH:-main}"
DATA_BRANCH="${DATA_BRANCH:-data}"
WORKTREE_DIR="${DATA_WORKTREE_DIR:-.worktrees/data}"
RUN_DAILY="${RUN_DAILY:-0}"   # set RUN_DAILY=1 to run at the end

# must be in a git repo root-ish
git rev-parse --is-inside-work-tree >/dev/null

# ensure we have origin
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "ERROR: remote 'origin' not configured" >&2
  exit 1
fi

echo "[bootstrap] fetching..."
git fetch --prune origin

# ensure local main exists and tracks origin/main (best effort)
if git show-ref --verify --quiet "refs/remotes/origin/$MAIN_BRANCH"; then
  if git show-ref --verify --quiet "refs/heads/$MAIN_BRANCH"; then
    git checkout -q "$MAIN_BRANCH"
    git merge -q --ff-only "origin/$MAIN_BRANCH" || true
  else
    git checkout -q -b "$MAIN_BRANCH" "origin/$MAIN_BRANCH"
  fi
  git branch --set-upstream-to="origin/$MAIN_BRANCH" "$MAIN_BRANCH" >/dev/null 2>&1 || true
fi

# ensure local data branch exists (from origin/data)
if git show-ref --verify --quiet "refs/remotes/origin/$DATA_BRANCH"; then
  if git show-ref --verify --quiet "refs/heads/$DATA_BRANCH"; then
    # fast-forward local data to origin/data when possible; otherwise leave it alone
    git checkout -q "$DATA_BRANCH"
    git merge -q --ff-only "origin/$DATA_BRANCH" || true
  else
    git checkout -q -b "$DATA_BRANCH" "origin/$DATA_BRANCH"
  fi
  git branch --set-upstream-to="origin/$DATA_BRANCH" "$DATA_BRANCH" >/dev/null 2>&1 || true
else
  echo "ERROR: origin/$DATA_BRANCH not found. Did you push the data branch?" >&2
  exit 1
fi

# go back to main (so run_daily can merge main->data in the worktree cleanly)
git checkout -q "$MAIN_BRANCH" || true

echo "[bootstrap] preparing worktree..."
git worktree prune >/dev/null 2>&1 || true

# if dir exists but isn't a valid worktree checkout, remove it
if [[ -e "$WORKTREE_DIR" && ! -e "$WORKTREE_DIR/.git" ]]; then
  rm -rf "$WORKTREE_DIR"
fi

# ensure worktree exists for data branch
if [[ ! -e "$WORKTREE_DIR/.git" ]]; then
  mkdir -p "$(dirname "$WORKTREE_DIR")"
  git worktree add -f -q "$WORKTREE_DIR" "$DATA_BRANCH"
fi

# keep worktree data branch in a reasonable state
(
  cd "$WORKTREE_DIR"
  git fetch -q --prune origin || true
  git merge -q --ff-only "origin/$DATA_BRANCH" || true
  # merge main into data if main exists (best effort, matches your run_daily behavior)
  if git show-ref --verify --quiet "refs/heads/$MAIN_BRANCH"; then
    git merge -q --no-edit "$MAIN_BRANCH" || true
  fi
)

echo "[bootstrap] done."
echo "  main repo:   $(pwd)"
echo "  data worktree: $(cd "$WORKTREE_DIR" && pwd)"

if [[ "$RUN_DAILY" == "1" ]]; then
  echo "[bootstrap] running daily..."
  NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
  if [[ -z "$NODE_BIN" ]]; then
    echo "ERROR: node not found in PATH" >&2
    exit 1
  fi
  NODE_BIN="$NODE_BIN" bash scripts/run_daily.sh || true
fi
