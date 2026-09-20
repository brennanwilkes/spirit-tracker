# skus/recent → Release + common_listings commit-gating — design handoff — 2026-09-17

Two changes decided (in priority order) to cut data-branch growth from ~106 to ~50 MiB/mo.
Both were verified against the live viz/email/build code paths this session. Do NOT hand-merge
main into data — run_daily.sh self-merges; these land atomically inside a cron run (see
`docs/index.json-release-rollout.md` "Migration is atomic inside ONE cron run").

## Lever 1 — Commit `reports/common_listings_*.json` only on big runs (saves ~34 MiB/mo)

Currently `run_daily.sh:122-130` regenerates all 9 report files and `:302` stages `reports` on
EVERY run (~8/day: 2 big + 6 small), but the only consumer that matters is day-granular:
- `build_viz_commits.js:45-46,86-87` collapses report commits to ONE point per DAY (newest that
  day) into `common_listings_commits.json`.
- `build_viz_stats_series.js` reads reports at those manifest shas via git — it needs ≥1 report
  commit per day, NOT 8.
- Big runs fire at 05:45 + 17:45 UTC **every day**, so gating reports to big runs keeps ≥2
  report-commits/day = zero change to stats/manifest coverage. Verified: every UTC day has a big
  run commit.
- The `#/stats` browser fallback (`stats_page.js::loadRawSeriesFromCommits`) reads reports at
  historical shas — history is kept, only intra-day churn stops. No viz change.

**Design:** pass `MODE: ${{ steps.plan.outputs.mode }}` to `run_daily.sh` env (the plan step
already computes it, cron_tracker.yaml:120-150; the retry dispatch uses `mode=big` even with a
`stores` override, so keying on empty `STORES` would misfire on retries — must use MODE). In
run_daily keep building all 9 reports every run (cheap; keeps tooling simple), but add
`:(exclude)reports/common_listings_*.json` to the `git add` pathspec unless `MODE == big`.
Cleanup: `git clean` already wipes the dirty worktree reports each run (run_daily.sh:115).

Do NOT gate the per-run `.txt` scrape report (reports/*.txt, ~4.3 MiB/mo) — it's tiny and the
commit message needs it.

## Lever 2 — `viz/data/recent.json` → Release asset (saves ~6.5 MiB/mo) — trivial

Exact replica of the index.json pattern you already shipped:
- Verified consumers: ONLY `viz/app/state.js:18` fetches `./data/recent.json` HEAD-only,
  same-origin. Nothing fetches it at a sha. `build_email_event_pack.js` does NOT read it.
- `build_viz_recent.js` regenerates it WHOLESALE each run (no incremental state, no prior copy
  needed — verified no read of prior recent.json/skus in that tool).
- `scripts/serve_viz.sh:51-54` already auto-builds it when missing.

Steps (mirror index.json): upload worktree copy to tag **`recent-latest`** before push,
`git rm --cached --ignore-unmatch viz/data/recent.json` + `:(exclude)viz/data/recent.json`,
and a **WARN-level** pages.yaml staging step (recent is optional — state.js's RECENT load has a
catch fallback, unlike index's fail-loud loadIndex).

## Lever 2b — `viz/data/skus/**` → Release asset (saves ~11.8 MiB/mo) — CAREFUL

This is NOT the index.json pattern. Three verified constraints differ:

1. **Incremental build needs the previous cache in the worktree.**
   `build_viz_sku_cache.js:156-191` (incremental) diffs each current db state against the last
   event in the ON-DISK cache. It does NOT walk git history unless `--full-reindex`. A fresh CI
   checkout with an empty `skus/` would emit the whole catalog as brand-new (addEventIfChanged
   against an empty cache) — corrupts history. So run_daily must RESTORE the prior cache from the
   Release before the incremental build, fall back to `--full-reindex` if the restore fails.
   This is the same restore-before-build pattern already used for the stats bundles
   (run_daily.sh:150-165).

2. **Email pack reads the cache from the data-branch CHECKOUT, not the worktree.**
   `send_email_pack.yaml:22-46` does a fresh `actions/checkout` of `data` and runs
   `build_email_event_pack.js`, which reads `viz/data/skus/{canonSku}.json` from `process.cwd()`
   (build_email_event_pack.js:74). If skus isn't committed, `loadSkuHistory` returns null →
   flip-flop detection silently degrades (line 551-552 `if (!hist || !hist.stores) continue`) →
   MORE false-positive emails. So send_email_pack.yaml needs a restore step (download
   `skus-latest`, extract) BEFORE building. Note: the pack ships the cache from the LATEST run;
   replaying an OLD `data_sha` would use a newer-than-commit cache — acceptable, flag it.

3. **Deploy must extract, not just stage.** The SPA fetches `./data/skus/{sku}.json` per-item
   (item_page.js:101, `.catch(() => null)` → missing = chart silently gone). So pages.yaml must
   download `skus-latest` AND extract into `viz/data/skus/`. Recommend WARN-level (site works
   without charts) or fail-loud — your call.

**Upload format:** 14,953 tiny files (~60 MB unrolled) → **one `skus.tar.gz`** per run
(measured 1.8 MB gz) on tag **`skus-latest`**, upload-before-push, `--clobber`. Precedent:
`model_ft.tar.gz` already ships this way. All three restore sites do `gh release download
skus-latest --pattern skus.tar.gz` + `tar xzf` into `viz/data/`.

Also verify `tools/build_viz_rarity.js:32` reads the worktree `skus/` — safe: it runs AFTER the
incremental build inside the same run_daily. Same for `tools/rarity_report.js`,
`rarity_debug_unnamed.js`, `scripts/audit_new_listings.js` (all read a run's live worktree).
Local dev caveat: `scripts/serve_viz.sh` does NOT restore `skus/` — a fresh local worktree has
no item charts until one `run_daily.sh` (or a manual `gh release download`+extract) happens.

## Expected result

| Path | current MiB/mo | after |
|---|---|---|
| reports/common_listings_*.json | 45.1 | ~11 (big-runs only) |
| viz/data/skus/** | 11.8 | 0 (Release) |
| viz/data/recent.json | 6.5 | 0 (Release) |
| data/db/** | 36.0 | 36.0 (source of truth — keep) |
| reports/*.txt + db_commits | 7.2 | 7.2 (keep) |
| **Total** | **~106** | **~50** |

Verified no other viz/email consumer of these three paths (full grep of `viz/app`, `tools`,
`scripts`, workflows for `data/skus`, `recent.json`, `common_listings`, `rarity.json`; email
pack reads skus + rarity only, and rarity stays committed). `rarity.json` itself (~0 current,
23.5 all-time history) is left committed — it's tiny and prunable only via the filter-repo
rewrite.

## Suggested sequence (all main-branch, push, then ONE big cron run)

1. Add MODE env + gate common_listings `git add` (tiny diff).
2. Embeddings-style upload prefix in run_daily for `recent-latest` + `skus-latest`
   (+ `skus.tar.gz` restore-before-build), `git rm --cached` + exclude pathspecs.
3. pages.yaml: stage recent.json (warn) + download/extract skus-latest (warn or fail-loud).
4. send_email_pack.yaml: restore skus-latest → `viz/data/skus/` before build (REQUIRED).
5. One big cron run to verify: no upload WARNs, deploy shows staged recent.json + skus extract,
   item pages show charts, stats/#/stats unchanged, email pack still suppresses flip-flops.
6. Re-measure `gh api repos/... --jq '.size/1024'` into
   `docs/data-branch-growth-mitigation.md` + the CLAUDE.md forecast line; then revisit
   filter-repo with the settled ~50 MiB/mo rate.

## Implementation status (2026-09-17) — steps 1–4 DONE, code written, NOT yet run

All code is on `main`, committed by hand (this is a pure main-branch change set — nothing needs a
hand-merge into `data`. `run_daily.sh` self-merges on the next run). Changes made this session:

- **`scripts/run_daily.sh`**: `MODE="${MODE:-big}"` (key on MODE, default big for local runs);
  skus **restore-before-build** block (`gh release download skus-latest skus.tar.gz` →
  extract into `$WORKTREE_DIR/viz/data`, only when `viz/data/skus` is ABSENT — a persisted local
  worktree cache is reused as-is; `--full-reindex` fallback if restore fails/empty);
  `recent-latest` + `skus-latest` upload blocks after the index upload (both `--clobber`,
  `mktemp` tarball, upload-BEFORE-push); `git rm --cached --ignore-unmatch viz/data/recent.json`
  + `git rm -r --cached --ignore-unmatch viz/data/skus`; the `git add` pathspec is now a
  `GIT_ADD_EXCLUDES=()` array extended with `:(exclude)reports/common_listings_*.json` when
  `MODE != big`.
- **`.github/workflows/cron_tracker.yaml`**: added `MODE: ${{ steps.plan.outputs.mode }}` to the
  run_daily step env. The plan step already outputs `mode`; retry dispatch uses `-f mode=big`.
- **`.github/workflows/pages.yaml`**: two new stage steps between the index stage and the
  sku_links stage — `Stage recent.json` (WARN-level) and `Stage per-SKU history cache`
  (download + `tar xzf` into `viz/data`, WARN-level — item_page catches, charts just hide).
- **`.github/workflows/send_email_pack.yaml`** + **`send_email_pack_replay.yaml`**: restore step
  before "Build email pack" (download skus-latest, extract to `viz/data/`, FAIL loudly if
  missing — flip-flop suppression silently degrades otherwise).
- **`scripts/serve_viz.sh`**: same skus restore when the dir is absent (local-dev parity).
- **`CLAUDE.md`** + tool table: LFS-self-heal note replaced, forecast + check-in block updated
  (`recent/skus/common_listings` levers verified-add ~25 MiB/mo → mid-to-late Jan).

### Next agent: trigger + verify

1. Commit `main`, push. Do NOT touch `.worktrees/data/`.
2. Trigger ONE big cron run (workflow_dispatch of `cron_tracker.yaml`, mode=big, no stores
   override — or wait for the 05:45/17:45 UTC schedule).
3. Watch the run log for `WARN: * Release upload failed` (index/recent/skus/stats/embeddings) —
   there should be none; expect the skus "restored … incremental build" INFO line and the three
   uploads as normal commits (index already had uploads).
4. Verify the `data` push commit contains NO `viz/data/recent.json` and NO `viz/data/skus/`
   (`git ls-tree origin/data viz/data`), and that the small-run commits in the same window
   contain no `reports/common_listings_*.json` (big-run commits DO).
5. `gh release view recent-latest` + `gh release view skus-latest` → recent.json ≈ few MB,
   skus.tar.gz ≈ 1.8 MB, `createdAt` fresh; `gh release view index-latest` unchanged behaviour.
6. Pages deploy: serve `…/data/recent.json` HTTP 200; visit a random item page → charts render
   (skus extracted); `#/stats` still one-request bundles; search page loads.
7. Email pack run (fires after the push): no skus-restore error; pack still suppresses flip-flops
   (spot-check a known oscillating pair from §"Flip-Flop Handling").
8. Re-measure `gh api repos/brennanwilkes/spirit-tracker --jq '.size/1024'` against the 653.71
   baseline + update CLAUDE.md forecast line per §"Data-branch growth".

**Local smoke test option (before CI, optional but cheap):** `bash scripts/run_daily.sh
--stores sierra_springs` from the repo root with a local worktree present, then confirm
`git -C .worktrees/data status` shows skus/recent as untracked (not staged), the skus-latest
upload INFO line, and no WARNs. Note: with `MODE` unset it defaults to big, so common_listings
WILL stage — that's the documented local behaviour.