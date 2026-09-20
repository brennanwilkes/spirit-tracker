# index.json → Release asset — rollout handoff — 2026-09-17

Migrated `viz/data/index.json` off the `data` branch (~85 MiB/mo of growth; the largest single
item) to a fixed-tag GitHub Release asset, staged into the Pages artifact at deploy. Zero
frontend change. Verified saved: no at-sha consumer of `index.json` exists; `build_viz_index.js`
derives it purely from `data/db/*.json` + `viz/data/db_commits.json` + git history of `data/db`
(all still committed); `send_email_pack.yaml` does not read it.

## Changes shipped (committed+`pushed to main` 2026-09-17)

- `scripts/run_daily.sh` — uploads the freshly-built worktree `viz/data/index.json` to Release tag
  **`index-latest`** (`upload --clobber` → `|| create` on first run) BEFORE the push, so the deploy
  triggered by that push finds it. Then `git rm --cached --ignore-unmatch viz/data/index.json`
  (idempotent) and a `:(exclude)viz/data/index.json` pathspec keep it out of the commit while the
  worktree copy stays on disk for local consumers.
- `.github/workflows/pages.yaml` — new **"Stage index.json into site artifact"** step downloads
  `index-latest` into `viz/data/` at deploy. **Fails LOUDLY** (unlike the stats WARN): every page
  calls `loadIndex()`, so a site without `index.json` is a broken site — an aborted deploy keeps
  the last good deployment live.
- Docs updated: root `CLAUDE.md` (index.json attribution + mitigation) and
  `docs/data-branch-growth-mitigation.md` (marked option 1 step 1 done). Local-dev caveat added:
  a fresh worktree has no `index.json` until `build_viz_index.js` (or `scripts/serve_viz.sh`, which
  auto-builds when missing) runs; `tools/linker_eval.mjs` / `featurize.mjs` / `rarity_report.js`
  hard-read `.worktrees/data/viz/data/index.json`.

## Migration is atomic inside ONE cron run — do NOT hand-merge main into data

`run_daily.sh` merges `origin/main` into the data worktree itself (run_daily.sh:83-85). The
ordering upload→rm→commit→push is what avoids an outage window. A manual main→data merge would
push the new `pages.yaml` staging step before `index-latest` exists → deploy fails (loudly; old
site stays), half-applied state. Just run the cron.

## Rollout run

Dispatched: `gh workflow run "Tracker cron (updates data branch)" -f mode=big`
- Run: **35259848702** (started 2026-09-17T18:36:25Z, ~1h)
- Job: 105332535502, `sha head=74dd4e3a`
- Prior baseline: `gh api repos/brennanwilkes/spirit-tracker --jq '.size/1024'` = 653.7 MB

## Verification results — ALL GREEN

Run 35259848702 completed **success** (~47 min, 18:36→19:25, commit **4bb00af7ca**
`run: 2026-09-17T19:25:53Z`). Follow-up retry run 35264853632 also success (no new
commit — the 13 still-failing categories are the known CF/IP-blocked stores).

1. Cron step: **no upload WARN**; log shows `…/releases/tag/index-latest`.
2. `gh release view index-latest` → `index.json 15689583B` (15.7 MB).
3. `origin/data` HEAD no longer has the file: `git ls-tree origin/data
   viz/data/index.json` → empty. (The **local** `.worktrees/data` shows it still
   tracked — stale worktree, managed by `run_daily.sh` on next local run; not a problem.)
4. Pages deploy 35264848836 **success**; "Stage index.json into site artifact" →
   `staged index.json (15689583 bytes)`; then "Deploy to GitHub Pages" success.
5. Live site `http://spirit.codexwilkes.com/data/index.json` → **HTTP 200**, exactly
   15689583 bytes, `generatedAt 2026-09-17T19:19:15Z`, `items[33961]`, `countLive 25311`.
6. Repo size **653.71 MB** — flat vs 653.7 baseline (previously growing ~150-180 MiB/mo).
   Rough headroom to the Dec-2026 1 GB forecast now ~3-4 months.

Note: a scheduled run (35263765619) appeared at 19:15 and was **cancelled** — queued
behind the dispatch (same `tracker-cron` concurrency group) and cancelled when the retry
dispatch landed; no data was written by it.

## Known acceptable states (by design)

- If the index upload fails (WARN), the deploy still fails loudly → last good deployment stays live.
- The cron ALSO dispatches the Pages workflow explicitly (`--ref main`, cron_tracker.yaml:353), so
  deploy may run twice back-to-back (push-trigger + dispatch) — `pages` concurrency group queues
  them harmlessly.

## NOT done (later, separate)

- `git filter-repo` history rewrite (~277 MB of old index.json history still in the branch) — avoids
  the 1 GB soft mark ~Dec 2026; do before that if needed.
- `recent.json` / `rarity.json` / `viz/data/skus/*` migration (combined ~25 MiB/mo) — same pattern.
- Hygiene: reports/*.txt, 133 `stviz/issue-*` branches, `git lfs prune`.