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

# Run mode: big (full catalog) vs small (subset). Set by cron_tracker.yaml from the plan step.
# Defaults to big (a local run behaves like a full run). Common-listings reports are committed
# ONLY on big runs — the stats/manifest consumers are day-granular and every UTC day has a big
# run, so small-run commits are pure churn (~34 MiB/mo). Key on MODE, NOT on empty STORES: the
# one-shot retry dispatch passes mode=big with a stores override.
MODE="${MODE:-big}"

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
# viz/data/skus/** is NOT committed — it ships as a Release asset (tag skus-latest, see the upload
# step below): ~11.8 MiB/mo of git growth for a HEAD-only artifact the SPA fetches once per item
# page. BUT the per-SKU cache is INCREMENTAL: build_viz_sku_cache.js diffs each store's current db
# state against the LAST event in the on-disk cache, so a fresh CI worktree (which no longer
# receives skus from a checkout) must FIRST restore the previous cache from the Release — otherwise
# the incremental build sees an empty cache and treats the whole catalog as brand-new, collapsing
# all history into a single "current state" event. The stats bundles below follow the same
# restore-before-build pattern.
#
# If gh is missing, the Release has no asset yet (first run), or the download fails, restore is
# skipped and we fall back to --full-reindex (rebuild every SKU from data/db/** git history, which
# is plain git) — the correct, if slower, path. A local worktree whose skus dir already persists
# from a prior run skips the download and uses the on-disk cache directly.
if ! [[ -d viz/data/skus ]] && command -v gh >/dev/null 2>&1; then
  rm -f /tmp/spirit-tracker-skus.tar.gz
  if gh release download skus-latest \
       --pattern 'skus.tar.gz' --output /tmp/spirit-tracker-skus.tar.gz --clobber 2>/dev/null \
     && tar xzf /tmp/spirit-tracker-skus.tar.gz -C "$WORKTREE_DIR/viz/data" 2>/dev/null; then
    echo "INFO: restored skus cache from skus-latest Release for incremental build" >&2
  else
    echo "WARN: could not restore skus cache from skus-latest Release; running --full-reindex instead" >&2
  fi
  rm -f /tmp/spirit-tracker-skus.tar.gz
fi
if [[ -d viz/data/skus ]] && compgen -G "viz/data/skus/*.json" >/dev/null; then
  "$NODE_BIN" tools/build_viz_sku_cache.js
else
  "$NODE_BIN" tools/build_viz_sku_cache.js --full-reindex
fi
"$NODE_BIN" tools/build_viz_rarity.js

# --- #/stats series bundles ---
# Restore the PREVIOUS bundles from the Release first. They are Release assets, not committed, so
# a fresh CI worktree has none — and without a prior copy the incremental resume can never engage
# and every run full-rebuilds all 9 bundles from git history (~44s, and growing with history:
# build_viz_commits.js keeps up to MAX_DAYS_PER_FILE=600 days). With them restored the build only
# replays the days appended since the last run. Best-effort: a miss (first run, deleted release)
# just means a full rebuild, which is exactly the old behaviour.
if command -v gh >/dev/null 2>&1; then
  mkdir -p "$WORKTREE_DIR/viz/data/stats"
  if gh release download stats-series-latest --dir "$WORKTREE_DIR/viz/data/stats" \
       --pattern '*.json' --clobber 2>/dev/null; then
    echo "INFO: restored previous stats bundles for incremental build" >&2
  else
    echo "INFO: no previous stats bundles to restore (first run / release missing); full rebuild" >&2
  fi
fi
# Collapses the whole common-listings history into one change-point bundle per (group, size), so
# the stats page makes ONE request instead of re-fetching the report at all ~214 commits (~103 MB
# of JSON parsed for top250, ~374 MB for top1000 — the entire reason that page took tens of
# seconds). Needs the commits manifest, so it must run after build_viz_commits.js. Incremental:
# only commits appended since the last build are re-read. Best-effort — the page falls back to the
# per-commit walk if the bundles are missing, so a failure here must never abort the scrape.
set +e
"$NODE_BIN" tools/build_viz_stats_series.js
stats_rc=$?
set -e
[[ $stats_rc -ne 0 ]] && echo "WARN: stats series build failed (rc=$stats_rc); #/stats will use the slow per-commit path" >&2

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

# The #/stats bundles are NOT committed either. Measured: ~455 KB of pack growth per run even
# after an aggressive repack (thousands of scattered change-point insertions delta badly) —
# ~106 MB/month on top of the data branch's existing ~180 MB/month. Same fix as the embeddings:
# a fixed Release tag, overwritten each scrape. The worktree copies stay for local dev and are
# excluded from the commit below. Best-effort; never aborts the scrape.
if command -v gh >/dev/null 2>&1 && compgen -G "$WORKTREE_DIR/viz/data/stats/*.json" >/dev/null; then
  set +e
  gh release create stats-series-latest --title "Latest #/stats series bundles" \
    --notes "Auto-uploaded by run_daily.sh each scrape. Overwritten in place; only 'latest' is kept." 2>/dev/null
  gh release upload stats-series-latest "$WORKTREE_DIR"/viz/data/stats/*.json --clobber 2>/dev/null
  st_rc=$?
  set -e
  [[ $st_rc -ne 0 ]] && echo "WARN: stats series Release upload failed (rc=$st_rc); #/stats will use the previous asset" >&2
else
  echo "INFO: skipping stats series Release upload (no gh CLI or no bundles)" >&2
fi

# viz/data/index.json is NOT committed either — it is the largest single source of data-branch
# growth (~85 MiB/mo): a ~15 MB file rewritten wholesale every scrape whose history is dead
# weight (the SPA fetches it ONLY at HEAD via state.js). Same fix as embeddings/stats: a fixed
# Release tag, overwritten each scrape. The worktree copy stays for local consumers and is
# excluded from the commit below; pages.yaml stages it into the Pages artifact at deploy so prod
# still serves it SAME-ORIGIN from ./data/index.json (zero frontend change). MUST upload BEFORE
# the push — the Pages deploy fires on the push and downloads from this tag. Best-effort; never
# aborts the scrape (a stale asset serves the last good catalog if this fails).
if command -v gh >/dev/null 2>&1 && [[ -s "$WORKTREE_DIR/viz/data/index.json" ]]; then
  set +e
  gh release upload index-latest "$WORKTREE_DIR/viz/data/index.json" --clobber 2>/dev/null \
    || gh release create index-latest "$WORKTREE_DIR/viz/data/index.json" \
         --title "Latest catalog index" \
         --notes "Auto-uploaded by run_daily.sh each scrape. Overwritten in place; only 'latest' is kept." 2>/dev/null
  idx_rc=$?
  set -e
  [[ $idx_rc -ne 0 ]] && echo "WARN: index Release upload failed (rc=$idx_rc); next Pages deploy will use the previous asset" >&2
else
  echo "INFO: skipping index Release upload (no gh CLI or no index.json)" >&2
fi

# viz/data/recent.json is NOT committed — HEAD-only (state.js) and wholesale-regenerated every
# run, so its git history is dead weight (~6.5 MiB/mo). Same Release-asset pattern as index;
# pages.yaml stages it into the Pages artifact at deploy. Best-effort.
if command -v gh >/dev/null 2>&1 && [[ -s "$WORKTREE_DIR/viz/data/recent.json" ]]; then
  set +e
  gh release upload recent-latest "$WORKTREE_DIR/viz/data/recent.json" --clobber 2>/dev/null \
    || gh release create recent-latest "$WORKTREE_DIR/viz/data/recent.json" \
         --title "Latest recent activity feed" \
         --notes "Auto-uploaded by run_daily.sh each scrape. Overwritten in place; only 'latest' is kept." 2>/dev/null
  rec_rc=$?
  set -e
  [[ $rec_rc -ne 0 ]] && echo "WARN: recent Release upload failed (rc=$rec_rc); next Pages deploy will use the previous asset" >&2
else
  echo "INFO: skipping recent Release upload (no gh CLI or no recent.json)" >&2
fi

# viz/data/skus/** is NOT committed either — see the restore-before-build step above: the per-SKU
# price-history cache is INCREMENTAL and the SPA fetches it HEAD-only per item page (~11.8 MiB/mo
# of dead-weight history). Ships as ONE tar.gz on tag skus-latest (14,953 tiny files, measured
# ~1.8 MB compressed), overwritten each scrape; pages.yaml and the email pack workflows download +
# extract it. MUST upload BEFORE the push. Best-effort: a stale asset serves the last good cache.
if command -v gh >/dev/null 2>&1 && [[ -d "$WORKTREE_DIR/viz/data/skus" ]] \
  && compgen -G "$WORKTREE_DIR/viz/data/skus/*.json" >/dev/null; then
  set +e
  # gh release upload names each asset after the FILE's basename (the `#label` suffix only sets a
  # display label, not the asset name) — so the tarball file must literally be `skus.tar.gz`, or
  # every consumer's `--pattern 'skus.tar.gz'` misses it.
  SKUS_TAR_DIR="$(mktemp -d)"
  tar czf "$SKUS_TAR_DIR/skus.tar.gz" -C "$WORKTREE_DIR/viz/data" skus
  gh release upload skus-latest "$SKUS_TAR_DIR/skus.tar.gz" --clobber 2>/dev/null \
    || gh release create skus-latest "$SKUS_TAR_DIR/skus.tar.gz" \
         --title "Latest per-SKU price history cache" \
         --notes "Auto-uploaded by run_daily.sh each scrape. Overwritten in place; only 'latest' is kept." 2>/dev/null
  sku_rc=$?
  rm -rf "$SKUS_TAR_DIR"
  set -e
  [[ $sku_rc -ne 0 ]] && echo "WARN: skus Release upload failed (rc=$sku_rc); next Pages deploy + email pack will use the previous asset" >&2
else
  echo "INFO: skipping skus Release upload (no gh CLI or no skus cache)" >&2
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
# Same treatment for the #/stats series bundles (Release assets, see the upload step above).
# The data branch's .gitignore ignores the Release-only viz/data paths, so the staging command
# below lists only the small committed viz artifacts instead of adding the whole viz/data dir.
# This line makes it self-healing if a bundle ever did get committed. Idempotent.
git rm -r --cached --quiet --ignore-unmatch viz/data/stats 2>/dev/null || true
# Same treatment for viz/data/index.json (Release asset on index-latest, see the upload step
# above — the largest single source of data-branch growth at ~85 MiB/mo). Idempotent.
git rm --cached --quiet --ignore-unmatch viz/data/index.json 2>/dev/null || true
# Same treatment for viz/data/recent.json + viz/data/skus/** (Release assets on recent-latest /
# skus-latest, see the upload steps above). Idempotent.
git rm --cached --quiet --ignore-unmatch viz/data/recent.json 2>/dev/null || true
git rm -r --cached --quiet --ignore-unmatch viz/data/skus 2>/dev/null || true

# Common listings reports are committed ONLY on big runs (see the MODE note at the top). Keep the
# exclude pathspec conditional so small runs still stage the per-run .txt scrape report (used by
# the commit body + observability) but not the common_listings_*.json files.
GIT_ADD_EXCLUDES=()
if [[ "$MODE" != "big" ]]; then
  GIT_ADD_EXCLUDES+=(':(exclude)reports/common_listings_*.json')
fi

# Stage only data/report/viz outputs. Release-only artifacts are intentionally ignored by the
# data branch's .gitignore, so do not pass the whole viz/data directory to git add.
git add -A \
  data/db \
  reports \
  viz/data/common_listings_commits.json \
  viz/data/db_commits.json \
  viz/data/rarity.json \
  "${GIT_ADD_EXCLUDES[@]}"
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
