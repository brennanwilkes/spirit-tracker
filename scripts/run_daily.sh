#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
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

# If the dir exists but isn't a valid worktree checkout, remove it properly.
if [[ -e "$WORKTREE_DIR" && ! -e "$WORKTREE_DIR/.git" ]]; then
  rm -rf "$WORKTREE_DIR"
fi

# If the worktree directory is missing, add it (force is safe after prune).
if [[ ! -e "$WORKTREE_DIR/.git" ]]; then
  mkdir -p "$(dirname "$WORKTREE_DIR")"
  git worktree add -f -q "$WORKTREE_DIR" "$DATA_BRANCH"
fi

cd "$WORKTREE_DIR"

REMOTE="${REMOTE:-origin}"

# Update remote refs
git fetch -q "$REMOTE"

# Pull latest data branch from remote (merge commits allowed)
if git show-ref --verify --quiet "refs/remotes/$REMOTE/$DATA_BRANCH"; then
  git pull -q --no-edit "$REMOTE" "$DATA_BRANCH"
fi

# Merge latest main from remote into data
if git show-ref --verify --quiet "refs/remotes/$REMOTE/$MAIN_BRANCH"; then
  git merge -q --no-edit "$REMOTE/$MAIN_BRANCH"
fi

# Run tracker (writes data/db + a plain report file in reports/)
TRACKER_ARGS=()
if [[ -n "${STORES:-}" ]]; then
  TRACKER_ARGS+=(--stores "${STORES}")
fi
set +e
"$NODE_BIN" bin/tracker.js "${TRACKER_ARGS[@]}"
rc=$?
set -e

if [[ $rc -eq 3 ]]; then
  echo "No meaningful changes; resetting worktree and skipping commit." >&2
  git reset --hard -q
  git clean -fdq -- reports data/db viz/data
  exit 0
fi
if [[ $rc -ne 0 ]]; then
  exit $rc
fi

# Build viz artifacts on the data branch
"$NODE_BIN" tools/build_viz_index.js
"$NODE_BIN" tools/build_viz_commits.js
"$NODE_BIN" tools/build_viz_recent.js

# Stage only data/report/viz outputs
git add -A data/db reports viz/data

if git diff --cached --quiet; then
  echo "No data/report/viz changes to commit." >&2
  exit 0
fi

# Commit message: include the latest report as the commit body.
ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

REPORT_FILE=""
if compgen -G "reports/*.txt" > /dev/null; then
  REPORT_FILE="$(ls -1t reports/*.txt | head -n 1 || true)"
fi

MSG_FILE="$(mktemp)"
{
  echo "run: ${ts}"
  echo
  if [[ -n "$REPORT_FILE" && -f "$REPORT_FILE" ]]; then
    cat "$REPORT_FILE"
  else
    echo "(no report file found in reports/*.txt)"
  fi
} > "$MSG_FILE"

git commit -F "$MSG_FILE" -q
rm -f "$MSG_FILE"

git push -q
