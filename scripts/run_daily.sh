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

# viz/data/* artifacts are no longer Git LFS-tracked (see .gitattributes). The data branch's
# HISTORY still contains old LFS pointer blobs, and our LFS bandwidth budget is exhausted, so any
# smudge attempt (worktree add / pull / merge / checkout) against those old pointers would fail
# the whole run. Skip smudge entirely: the build tools below regenerate every derived file from
# data/db/** (plain git) and re-add it as a normal blob, so we never need real LFS bytes.
export GIT_LFS_SKIP_SMUDGE=1

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

# Tee tracker output so we can lift its [[FAILED-CATEGORIES]] sentinel onto the
# commit first line, while still streaming everything to the CI log.
TRACKER_LOG="$(mktemp)"
set +e
"$NODE_BIN" bin/tracker.js "${TRACKER_ARGS[@]}" 2>&1 | tee "$TRACKER_LOG"
rc=${PIPESTATUS[0]}
set -e

# Surface failed store KEYS so CI can fire a one-shot retry on a fresh runner
# (new egress IP). Emitted even on a no-op run (rc=3), so failures that produced
# no committable data still get retried. Empty when nothing failed.
FAILED_STORES="$(grep -aoE '\[\[FAILED-STORES\]\].*' "$TRACKER_LOG" | tail -n1 | sed -E 's/^\[\[FAILED-STORES\]\] ?//')"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "failed_stores=${FAILED_STORES}" >> "$GITHUB_OUTPUT"
fi

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
# index/recent/db_commits are overwritten wholesale, so they self-heal from a skip-smudge
# (pointer-text) checkout. The per-SKU cache is INCREMENTAL — it only rewrites changed SKUs, so
# unchanged ones left as LFS pointer text by the skip-smudge checkout would persist as garbage.
# Detect any lingering pointer and do a one-time full reindex (rebuilds every SKU from data/db/**
# git history, which is plain git); this also self-heals any future stray pointer. Idempotent:
# once no pointers remain it reverts to the fast incremental path.
if [[ -d viz/data/skus ]] && grep -rlq "git-lfs.github.com" viz/data/skus 2>/dev/null; then
  echo "INFO: LFS pointer(s) found in viz/data/skus; running one-time --full-reindex to materialize real content" >&2
  "$NODE_BIN" tools/build_viz_sku_cache.js --full-reindex
else
  "$NODE_BIN" tools/build_viz_sku_cache.js
fi
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
EMB_OUT="$REPO_ROOT/tools/linker_ml/out/embeddings.json"
if [[ -x "$PYTHON_BIN" && -d "$LINKER_MODEL_DIR" ]]; then
  set +e
  "$NODE_BIN" "$REPO_ROOT/tools/linker_ml/build_dataset.mjs" \
    && "$PYTHON_BIN" "$REPO_ROOT/tools/linker_ml/encode.py" \
    && cp -f "$EMB_OUT" "$WORKTREE_DIR/viz/data/sku_embeddings.json"
  enc_rc=$?
  set -e
  if [[ $enc_rc -ne 0 ]]; then
    echo "WARN: embedding re-encode failed (rc=$enc_rc); keeping previous sku_embeddings.json" >&2
  fi
else
  echo "INFO: skipping embedding re-encode (no venv at $PYTHON_BIN or no checkpoint at $LINKER_MODEL_DIR)" >&2
fi

# sku_embeddings.json is NOT committed (a ~40 MB blob rewritten ~3x/day; see CLAUDE.md "LFS
# removal"). It ships as a GitHub Release asset on a FIXED tag, overwritten each scrape — zero
# git/LFS growth, unmetered CDN download. The browser linker page + ad-hoc tools fetch it from
# there. The worktree copy above is kept ONLY for local consumers (serve.js, eval harness) and is
# excluded from the commit below. Best-effort: needs gh + a token; never aborts the scrape.
if command -v gh >/dev/null 2>&1 && [[ -s "$WORKTREE_DIR/viz/data/sku_embeddings.json" ]]; then
  set +e
  gh release upload embeddings-latest "$WORKTREE_DIR/viz/data/sku_embeddings.json" --clobber 2>/dev/null \
    || gh release create embeddings-latest "$WORKTREE_DIR/viz/data/sku_embeddings.json" \
         --title "Latest SKU embeddings" \
         --notes "Auto-uploaded by run_daily.sh each scrape. Overwritten in place; only 'latest' is kept." 2>/dev/null
  up_rc=$?
  set -e
  [[ $up_rc -ne 0 ]] && echo "WARN: embeddings Release upload failed (rc=$up_rc); linker page will use the previous asset" >&2
else
  echo "INFO: skipping embeddings Release upload (no gh CLI or no embeddings file)" >&2
fi

# --- Auto-link classification (learned classifier) ---
# With fresh embeddings now in the worktree, score unlinked SKUs with the live GBT blend and
# append high-confidence (≥99%-precision bar) cross-store matches to data/sku_links.json as
# status:"pending" links. They are treated as REAL links everywhere immediately (catalog
# grouping + email alerts, which read only fromSku/toSku); the #/link-review page lets a human
# approve/reject them later. Runs AFTER embeddings and BEFORE the email pack (triggered
# post-commit) so alerts reflect the new groupings. Uses $REPO_ROOT absolute path so featurize's
# default WORKTREE resolves the worktree (same pattern as the re-encode above); it reads + writes
# the worktree's data/sku_links.json (staged below). Best-effort: a failure must NOT abort the
# scrape commit.
#
# --since 2: anchor ONLY on SKUs first-seen in the last 2 days (a comfortable margin over the
# ≤12h gap between runs). The tool blocks candidates by shared distinctive token / SMWS code, so
# per-anchor cost is a handful of comparisons, not a full-catalog scan — ~10s even for a fresh
# 900-SKU store add, seconds on a normal run. A stable orphan was already scored on an earlier run
# and nothing changed, so the window just avoids redundant rescans; new cross-store matches are
# still found (the candidate POOL is the full catalog, only the ANCHOR set is recency-bounded).
# (One-time backlog sweep over ALL SKUs: run the tool by hand with no --since, ~75s.) Dedup against
# existing links/ignores makes re-runs a no-op, and the tool flushes every 400 anchors so a
# cancelled/timed-out run keeps its progress and resumes cleanly.
set +e
"$NODE_BIN" "$REPO_ROOT/tools/auto_link_classify.mjs" --top 10 --since 2
alc_rc=$?
set -e
[[ $alc_rc -ne 0 ]] && echo "WARN: auto-link classification failed (rc=$alc_rc); no pending links added this run" >&2

# Drop sku_embeddings.json from version control — it now lives as a Release asset (uploaded
# above), not in git. One-time on the first post-migration run; idempotent thereafter
# (--ignore-unmatch is a no-op once it's untracked). The ':(exclude)' pathspec below then keeps
# the (still-on-disk, for local consumers) worktree copy from being re-staged.
git rm --cached --quiet --ignore-unmatch viz/data/sku_embeddings.json 2>/dev/null || true

# Stage only data/report/viz outputs (embeddings excluded — see above)
git add -A data/db reports viz/data ':(exclude)viz/data/sku_embeddings.json'
# Auto-generated SKU links (written by the tracker when pickBetterSku upgrades a record's SKU).
# May not exist on first run; -- pathspec avoids erroring out in that case.
git add -A -- data/sku_links_auto.json 2>/dev/null || true
# Curated SKU links incl. status:"pending" entries appended by auto_link_classify.mjs above. Stage
# ONLY when that step succeeded (alc_rc==0): on a clean cron worktree the classifier is the sole
# writer of this file, so this commits exactly its appends — and gating on success means a crash
# mid-write can never commit a half-written sku_links.json. (No change → git diff is empty → no-op.)
if [[ ${alc_rc:-1} -eq 0 ]]; then
  git add -A -- data/sku_links.json 2>/dev/null || true
fi

if git diff --cached --quiet; then
  echo "No data/report/viz changes to commit." >&2
  exit 0
fi

# Commit message: failed-category summary on the first line, runner metadata +
# the full report in the body.
ts="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

REPORT_FILE=""
if compgen -G "reports/*.txt" > /dev/null; then
  REPORT_FILE="$(ls -1t reports/*.txt | head -n 1 || true)"
fi

# Failed categories: lift from the tracker's sentinel (empty after the marker
# when nothing failed). Last occurrence wins (one per process).
FAILED_LINE=""
if [[ -f "$TRACKER_LOG" ]]; then
  FAILED_LINE="$(grep -aoE '\[\[FAILED-CATEGORIES\]\].*' "$TRACKER_LOG" | tail -n1 | sed -E 's/^\[\[FAILED-CATEGORIES\]\] ?//')"
fi

# Mass-removal guard trips: a category whose scan came back so short that the DB
# was preserved instead of mass-removing. Data is intact, but the scraper is
# broken — surface it on the commit first line so `git log` shows it over time.
GUARDED_LINE=""
if [[ -f "$TRACKER_LOG" ]]; then
  GUARDED_LINE="$(grep -aoE '\[\[GUARDED-CATEGORIES\]\].*' "$TRACKER_LOG" | tail -n1 | sed -E 's/^\[\[GUARDED-CATEGORIES\]\] ?//')"
fi

FIRST_LINE="run: ${ts}"
if [[ -n "$FAILED_LINE" ]]; then
  n="$(awk -F'; ' '{print NF}' <<<"$FAILED_LINE")"
  FIRST_LINE="${FIRST_LINE} | FAILED(${n}): ${FAILED_LINE}"
fi
if [[ -n "$GUARDED_LINE" ]]; then
  g="$(awk -F'; ' '{print NF}' <<<"$GUARDED_LINE")"
  FIRST_LINE="${FIRST_LINE} | GUARDED(${g}): ${GUARDED_LINE}"
fi

# Runner egress IP + identity, so store blocks can be correlated to the IP over
# time. Best-effort: never let it abort the commit.
RUNNER_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo unknown)"

MSG_FILE="$(mktemp)"
{
  echo "$FIRST_LINE"
  echo
  echo "runner: ip=${RUNNER_IP} run_id=${GITHUB_RUN_ID:-local} os=${RUNNER_OS:-?} name=${RUNNER_NAME:-?}"
  echo
  # VPN diagnostics: multi-line content from the tunnel step's temp file.
  # Each line is a self-contained status like "vpn: ok (egress X, store ...)".
  if [[ -n "${VPN_DIAG_FILE:-}" && -f "$VPN_DIAG_FILE" ]]; then
    cat "$VPN_DIAG_FILE"
  elif [[ -n "${VPN_OK:-}" ]]; then
    # Fallback for older env-var style (local runs, etc.)
    if [[ "$VPN_OK" == "true" ]]; then
      echo "vpn: ok (egress ${VPN_EGRESS_IP:-unknown})"
    else
      echo "vpn: off"
    fi
  fi
  echo
  if [[ -n "$REPORT_FILE" && -f "$REPORT_FILE" ]]; then
    cat "$REPORT_FILE"
  else
    echo "(no report file found in reports/*.txt)"
  fi
} > "$MSG_FILE"

git commit -F "$MSG_FILE" -q
rm -f "$MSG_FILE" "$TRACKER_LOG"

# --no-thin: a thin pack deltifies against base objects git assumes the remote already has;
# right after a large main→data merge the remote may lack such a base, which it rejects as
# "missing object" (the failure that lost a full scrape on 2026-06-06). A self-contained pack
# avoids it. Retry once after re-syncing in case a concurrent run advanced origin/data.
if ! git push --no-thin -q; then
  echo "push rejected; re-syncing with $REMOTE/$DATA_BRANCH and retrying once" >&2
  git fetch -q "$REMOTE" "$DATA_BRANCH"
  git merge -q --no-edit "$REMOTE/$DATA_BRANCH"
  git push --no-thin -q
fi
