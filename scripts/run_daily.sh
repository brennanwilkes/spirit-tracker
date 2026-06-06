#!/usr/bin/env bash
set -euo pipefail

# --- parse wrapper args (only --debug for now) ---
DEBUG=0
FORWARD_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug)
      DEBUG=1
      shift
      ;;
    --) # stop parsing; forward the rest
      shift
      while [[ $# -gt 0 ]]; do FORWARD_ARGS+=("$1"); shift; done
      ;;
    *)
      # keep unknown args to forward (or error if you prefer)
      FORWARD_ARGS+=("$1")
      shift
      ;;
  esac
done

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
TRACKER_ARGS=("${FORWARD_ARGS[@]}")
if [[ -n "${STORES:-}" ]]; then
  TRACKER_ARGS+=(--stores "${STORES}")
fi
if [[ $DEBUG -eq 1 ]]; then
  TRACKER_ARGS+=(--debug)
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

# Build common listings reports FIRST (so commits manifest can see them)
for group in all bc ab; do
  for top in 50 250 1000; do
    "$NODE_BIN" tools/build_common_listings.js \
      --group "$group" \
      --top "$top" \
      --out "reports/common_listings_${group}_top${top}.json"
  done
done

# Build viz artifacts on the data branch
"$NODE_BIN" tools/build_viz_index.js
"$NODE_BIN" tools/build_viz_commits.js
"$NODE_BIN" tools/build_viz_recent.js
"$NODE_BIN" tools/build_viz_sku_cache.js
"$NODE_BIN" tools/build_viz_rarity.js

# --- Re-encode SKU embeddings with the FIXED fine-tuned encoder (linker page) ---
# Cheap per-scrape vector refresh so newly-scraped SKUs get embeddings WITHOUT retraining weights
# (the encoder + GBT stay hand-trained — see tools/linker_ml/CLAUDE.md). encode.py is deterministic,
# so an unchanged catalog yields byte-identical output → no LFS churn. Scripts run from REPO_ROOT
# (so OUT_DIR + venv resolve in the main checkout) but featurize reads the worktree's fresh
# index/links. Best-effort: a failure must NOT abort the scrape commit (viz falls back to the
# no-embed blend if embeddings go stale). Skips cleanly when the venv/checkpoint aren't present
# (e.g. a plain local run).
PYTHON_BIN="${PYTHON_BIN:-$REPO_ROOT/tools/linker_ml/.venv/bin/python}"
# CI sets LINKER_MODEL_DIR to the Release-asset checkpoint it restored; a local run defaults to
# out/model_ft (where train_embed.py saved it). encode.py reads LINKER_MODEL_DIR from the env.
export LINKER_MODEL_DIR="${LINKER_MODEL_DIR:-$REPO_ROOT/tools/linker_ml/out/model_ft}"
if [[ -x "$PYTHON_BIN" && -d "$LINKER_MODEL_DIR" ]]; then
  set +e
  "$NODE_BIN" "$REPO_ROOT/tools/linker_ml/build_dataset.mjs" \
    && "$PYTHON_BIN" "$REPO_ROOT/tools/linker_ml/encode.py" \
    && cp -f "$REPO_ROOT/tools/linker_ml/out/embeddings.json" "$WORKTREE_DIR/viz/data/sku_embeddings.json"
  enc_rc=$?
  set -e
  if [[ $enc_rc -ne 0 ]]; then
    echo "WARN: embedding re-encode failed (rc=$enc_rc); keeping previous sku_embeddings.json" >&2
  fi
else
  echo "INFO: skipping embedding re-encode (no venv at $PYTHON_BIN or no checkpoint at $LINKER_MODEL_DIR)" >&2
fi

# Stage only data/report/viz outputs
git add -A data/db reports viz/data
# Auto-generated SKU links (written by the tracker when pickBetterSku upgrades a record's SKU).
# May not exist on first run; -- pathspec avoids erroring out in that case.
git add -A -- data/sku_links_auto.json 2>/dev/null || true

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
