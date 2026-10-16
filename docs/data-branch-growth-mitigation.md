# Data-branch growth: Findings & handoff — 2026-09-17

Forecast + measurements for GitHub free-tier limit exposure on `brennanwilkes/spirit-tracker`
(public repo). Every number below was re-verified against the `.worktrees/data` git store, the
GitHub API, `gh`, and the viz source before writing. See root `CLAUDE.md` §"Data-branch growth"
for the older (2026-09-04) baselines.

---

## 1. Headline forecast

> **Superseded 2026-10-10.** After the Release-asset migrations, growth fell to ~37 MiB/mo (GitHub-reported; ~61 local) at 682.3 MiB. 1 GB ≈ July 2027 at the current store count, ≈ Feb–Apr 2027 if the store count doubles. See CLAUDE.md §"Re-measurement + forecast — 2026-10-10". The forecast below is the original pre-migration one.

**The repo hits GitHub's 1 GB "keep it small" mark ≈ early December 2026 (±3 weeks).**
Everything else is a non-issue because the repo is PUBLIC.

| Limit (GitHub free, public repo) | Current | Threshold | Arrival |
|---|---|---|---|
| **Repo git size** (the only live one) | 653.7 MB (`gh api .size`, KB/1024) | 1 GB ideal / 5 GB strongly recommended (no hard cap; corrected 2026-10-10) | **1 GB ≈ Dec 3 2026**; 5 GB ≈ 2028–29 |
| Actions minutes | ~5,800 mo (est.) | public = unlimited | N/A — but **must stay public** (private 2,000-min bucket → ~10 days) |
| Actions/packages storage | ~0 | public = free | N/A |
| LFS storage+bandwidth | 0 files tracked | public = free | N/A (verified `git lfs ls-files` empty) |
| Release assets | 132.6 MB | public = free | N/A |
| Pages bandwidth | low | soft 100 GB/mo | N/A |

Forecast math: (1024 − 653.7) / 165 MiB·mo⁻¹ = 2.2 mo → Dec 3 (±3 wk: Nov 20 @180, Dec 7 @150).

---

## 2. Verified measurements

**Size** (deduped `objectsize:disk` over reachable blobs):
- GitHub API `size` = **653.7 MB** (this tracks packed/delta bytes, NOT content — deduped content is 28.5 GB).
- Local all-reachable pack = 737.5 MiB; data-branch-only = 733.8 MiB. The ~84 MiB local-vs-GitHub gap is local pack redundancy (29 packs), not a trend.

**Growth** (`git rev-list --objects <tip> --not <base>`, deduped `objectsize:disk`):

| Window | MiB |
|---|---|
| Feb–Apr (15d each) | 6–17 |
| May 7–21 | 36 |
| Jun 18–Jul 30 (15d each) | 72/108/78/61 |
| Jul 30–Aug 27 (15d each) | 101/72 |
| Aug 27–Sep 17 (15d + 7d) | 69 / 33 |
| Aug 18–Sep 17 (30d total) | 147.7 |

→ steady rate ≈ **150–180 MiB/mo**, accelerating as the catalog grows. Rate has ratcheted up ~5–10× since spring.

**All-time deduped-disk attribution** (what pruning reclaims):

| Path | MiB | Nature |
|---|---|---|
| `viz/data/index.json` | 276.6 | derived, HEAD-only — disposable history |
| `reports/common_listings_*.json` | 226.3 | only a stats-bundle REBUILD input; runtime = Release bundle |
| `data/db/**` | 129.0 | **the source of truth — keep** |
| `viz/data/skus/*` | 40.0 | derived, HEAD-only, regenerable |
| `viz/data/rarity.json` | 23.5 | derived, HEAD-only, regenerable |
| `viz/data/recent.json` | 21.1 | derived, HEAD-only, regenerable |
| `viz/data/db_commits.json` | 6.8 | build-tool manifest |
| `reports/*.txt` | 4.6 | per-run observability |
| `data/sku_links*` + code | ~8.6 | keep |
| `viz/data/other` | 1.3 | — |
| `stviz/issue-*` (133 branches) | 0.3 | cosmetic; delete anytime |

Sum ≈ 737.8 (rounds to the 737.5 total — consistent).

**No gross waste**: `img` fields are URLs (no `data:` base64 — verified grep). Largest committed blob
≈ index.json 15.7 MB (well under the 100 MB/file push cap). Release assets already-uncommitted:
`sku_embeddings.json` (43 MB), `stats-series-latest` (5.8 MB), `model-ft-2026-06-06` (83 MB).

---

## 3. How the frontend loads data (verified in code, 2026-09-17)

All `viz/data/*` is served same-origin by GitHub Pages. The SPA fetches these at **HEAD only** —
nothing fetches `index.json`/`recent.json`/`rarity.json`/`skus` at a historical sha:

| File (as deployed) | Loader | Notes |
|---|---|---|
| `./data/index.json` | `state.js::loadIndex` | 15 MB catalog; fetched once, cached in memory. **Release asset `index-latest`, NOT committed** — staged into the Pages artifact at deploy by `pages.yaml`. Zero frontend change: the SPA still fetches `./data/index.json` same-origin. |
| `./data/recent.json` | `state.js::loadRecent` | activity feed |
| `./data/rarity.json` | `state.js::loadRarity` | rarity snapshot |
| `./data/skus/<sku>.json` | `item_page.js::loadSkuHistory` | per-item price history (lazy per SKU) |
| `./data/common_listings_commits.json` | `stats_page.js::loadCommonCommitsManifest` | which commits hold each report |
| `./data/sku_links.json` + `_auto` + `sku_hidden.json` | `api.js::loadSkuMetaBestEffort` | **NOT** in viz/data on the branch — committed at `data/`, copied into the site artifact at deploy by `.github/workflows/pages.yaml` (Empty-if-missing defaults) |
| `./data/gbt_model.json` | `linker_page/gbt.js` | committed (812 KB) |
| `./data/stats/<name>` | `stats_page.js` | bundles are **NOT committed**; `pages.yaml` downloads them from Release `stats-series-latest` into the artifact at deploy (same-origin) |
| `./data/sku_embeddings.json` → Release URL | `linker_page/embeddings.js` | NOT committed; local path 404s on Pages, then tries cross-origin Release |
| `reports/common_listings_<g>_top<s>.json` @ sha | `stats_page.js::loadRawSeriesFromCommits` (fallback) | the ONLY at-sha fetcher; via `raw.githubusercontent.com` |

**THE key constraint (curl-verified, matches `pages.yaml` note):** a browser CANNOT fetch
`github.com/…/releases/download/*`. The URL 302s to `release-assets.githubusercontent.com`, whose
final response carries **no `access-control-allow-origin`** (verified with `curl -sI -H "Origin: …"`
and `curl -L -D -`). So any file moved to a Release asset MUST be staged into the Pages artifact at
deploy time (the `stats` pattern) — NOT fetched cross-origin at runtime.

> ⚠️ **Stale comment to fix one day:** `embeddings.js` lines 22–23 claim "The Release CDN sends
> permissive CORS, so the cross-origin fetch works." It does NOT (verified above). In prod the
> linker silently runs the no-embed blend (graceful). `stats_page.js` (~line 390) documents the
> block correctly — trust that.

**Implication for migration (now implemented for `index.json` on 2026-09-17):** moving `index.json`
→ Release + `pages.yaml` download step required **ZERO frontend change** — the SPA keeps fetching
`./data/index.json` same-origin. The same is true for `recent.json`/`rarity.json`. `skus/` is one
tarball-ish upload (60 MB) but same pattern. `db_commits.json` & `common_listings_commits.json` are
consumed by build *tools* at HEAD in the worktree (`build_viz_index.js` reads
`viz/data/db_commits.json`; `build_viz_commits.js` writes both) — keep them committed (small).

---

## 4. Mitigation options

1. **Extend the Release-asset + deploy-staging pattern to the HEAD-only derived files. ✅ `index.json` DONE
   (2026-09-17)** — the biggest single item (~85 MiB/mo). Now a fixed-tag Release asset
   (`index-latest`), uploaded by `run_daily.sh` before the push, staged into the Pages artifact at
   deploy by `pages.yaml`. Stops that ~85 MiB/mo; remaining growth source is `recent.json`/
   `rarity.json`/`skus/`/`db_commits.json` (much smaller). Doesn't reclaim the ~277 MB already in
   history. Mirror the ordering precedent (upload before push so the deploy finds them).
   **Caveat for the deploy step:** unlike the stats bundles (which degrade gracefully to the slow
   per-commit path), `index.json` is required by EVERY page (`loadIndex()`), so the staging step in
   `pages.yaml` FAILS LOUDLY rather than warning — an aborted deploy keeps the last good deployment
   live instead of shipping a broken site.
2. **One-time `git filter-repo` rewrite** of the `data` branch dropping the disposable paths from
   ALL history (**preserve `data/db/**`** — the product data lives only in git). Claws back ~500 MiB.
   Costs: all shas rewrite → re-clone `.worktrees/data`, brief Pages gap, stats at-sha fallback
   degrades for pre-rewrite windows, 133 `stviz` branches orphan, force-push. Only do together with
   #1 or the clock restarts.
3. **Hygiene:** stop committing `reports/*.txt` (~4 MiB/mo — keep on failure only); delete the 133
   `stviz/issue-*` branches (0.3 MiB, cosmetic); `git lfs prune` reclaims ~2.5 GB local disk.

**Recommendation:** ✅ #1 (`index.json`) done 2026-09-17; extend the same pattern to
`recent.json`/`rarity.json`/`skus/` when the remaining ~25 MiB/mo matters; pair with #2 if Dec 2026
feels too soon anyway.

---

## 5. Open questions / still to verify

- **GitHub `size` exact semantics**: `size`≈pack/delta bytes confirmed indirectly (not content), but
  the exact repack/dedup GitHub applies is opaque. Track `gh api .size` fortnightly for 2–3 points
  and compare against local deltas to calibrate the rate before committing to the deadline.
- **`data/sku_hidden.json` commit path**: it is on the branch but `run_daily.sh` only re-stages
  `data/sku_links*.json`; unclear whether cron updates it or it commits only on manual edits —
  irrelevant to growth, but check before relying on deploy staging.
- **Local-dev caveat after the `index.json` migration**: `tools/linker_eval.mjs`, `featurize.mjs`,
  `rarity_report.js` hard-read `.worktrees/data/viz/data/index.json`. A FRESH worktree has no
  `index.json` (no longer committed) until `build_viz_index.js` runs — so run a daily build (or
  `scripts/serve_viz.sh`, which auto-builds it when missing) before hand-running those tools.
  `run_daily.sh` builds it before any dependent step (auto-link classify, re-encode), so CI is
  unaffected.
- **Embassies of the CORS fix decision**: whether to also correct the stale `embeddings.js` comment
  or switch it to deploy-staged like stats (fixing it would make the linker use real embeddings in
  prod for the first time).
- **filter-repo specifics** (if option 2 is chosen): preserve refs exactly (`data`, keep
  `data/db/**`), verify Pages + email-pack + sku-cache `--full-reindex` still work from the rewritten
  history, and whether GitHub prunes the old objects in reasonable time.
- **Forcast**: whether the (~+2 wk/month) acceleration since spring continues — re-measure the 15-day
  window each month against the ~165 MiB/mo baseline above.

## 6. Reproduce in one command

```bash
# GH-reported size (MiB)
gh api repos/brennanwilkes/spirit-tracker --jq '.size/1024'
# growth MiB between two data-branch commits
git -C .worktrees/data rev-list --objects "$TIP" --not "$BASE" \
  | cut -d' ' -f1 | sort -u \
  | git -C .worktrees/data cat-file --batch-check='%(objecttype) %(objectsize:disk)' \
  | awk '$1=="blob"{s+=$2} END{printf "%.1f MiB\n", s/1048576}'
```

---

# Archive: LFS removal, data-branch growth measurements and rollout check-ins (from CLAUDE.md)

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

### Git LFS removal (2026-06-11)

`viz/data/*` artifacts were formerly Git LFS-tracked. **They are no longer.** LFS *storage*
was never the problem — LFS **bandwidth** was: every CI job (cron worktree pull, Pages deploy,
email pack) did a full `lfs: true` checkout, re-smudging the entire ~60 MB working set on every
run (~24×/day ≈ 30–44 GB/mo), which blew the 10 GB/mo free LFS bandwidth budget in days. Plain-git
clone/fetch and Pages-CDN traffic are **not** metered, so the fix is: get everything out of LFS.

Every LFS file was a **derived artifact** regenerated each run from `data/db/**` (which is itself
plain git), so nothing of value lived only in LFS. Decision, by file (measured over 5 months of
real history — git delta-compresses these beautifully because consecutive versions are ~99%
identical; ~37–290 KB added per commit, not the whole file):

- `index.json`, `db_commits.json` → **plain git at the time** (the original "~15–25 MB/mo total"
  estimate here was measured wrong — see §"Data-branch growth" below). `recent.json` + `skus/**` were
  since migrated OFF the data branch to Release assets (2026-09-17, see §"Data-branch growth").
- `sku_embeddings.json` (~40 MB, rewritten ~3×/day, poor delta, retrain spikes) → **GitHub Release
  asset** on the fixed tag `embeddings-latest`, overwritten by `run_daily.sh` each scrape via
  `gh release upload --clobber`. Zero git/LFS growth, unmetered CDN download. Mirrors the encoder-
  checkpoint pattern. The browser linker page (`viz/app/linker_page/embeddings.js`) tries the local
  `./data/sku_embeddings.json` first (present in local dev) then falls back to the Release URL
  (prod). NOT committed: `run_daily.sh` keeps a worktree copy for local consumers but excludes it
  from the commit (`git rm --cached` + `:(exclude)` pathspec).

How it self-heals (no hand-commit to `data`; the next cron run does it):
1. `.gitattributes` drops all 5 LFS patterns.
2. `run_daily.sh` exports `GIT_LFS_SKIP_SMUDGE=1` so the worktree pull/merge never hits the
   (budget-blocked) LFS endpoint — still-LFS-tracked files in the old `data` HEAD arrive as
   pointer text instead of failing.
3. The build tools overwrite `index/recent/db_commits` wholesale → re-staged as plain blobs under
   the new LFS-free attributes. For the **incremental** per-SKU cache, `run_daily.sh` detects any
   lingering pointer in `viz/data/skus` (`grep git-lfs.github.com`) and runs a one-time
   `build_viz_sku_cache.js --full-reindex` (rebuilds every SKU from `data/db/**` git history) so
   unchanged SKUs don't persist as pointer text. Reverts to incremental once no pointers remain.
   (This pointer check was REPLACED 2026-09-17: skus/** is now a Release-asset tarball, restored
   before every build — see §"Data-branch growth".)
4. All workflow checkouts are now `lfs: false`. Net metered LFS traffic: **zero**.

Bonus fix: this also un-breaks Pages deploys (they'd been failing on the LFS-budget 403 since the
budget ran out → prod was frozen on a stale deploy, e.g. `gbt_model.json` 404'd). With `lfs: false`
they succeed again.

### Data-branch growth — measured 2026-09-04 (~180 MB/month)

The LFS-removal note above estimated ~15–25 MB/mo. Actual, measured by summing deduped
`objectsize:disk` over the commits in each 30-day window: **~197 MB, ~162 MB, ~195 MB** for the last
three months. Total `data`-branch pack: **757 MB**. GitHub has no hard repo-size cap; see the
2026-10-10 section for what the limits really are. (That was the pre-migration rate; for the current one see the 2026-10-10 re-measurement below.)

Attribution over the last 30 days (deduped blobs per path):

| Path | 30d growth | Notes |
|------|-----------|-------|
| `viz/data/index.json` | 84.9 MB | 15 MB file rewritten wholesale 8×/day; **history is dead weight** |
| `reports/common_listings_*.json` | 45.1 MB | history IS load-bearing — `#/stats` reads it at historical shas |
| `data/db` | 36.0 MB | the actual source of truth; legitimate |
| `viz/data/skus` | 11.8 MB | incremental, well-behaved |
| `viz/data/recent.json` | 6.5 MB | fine |
| `reports/*.txt` | 4.3 MB | per-run scrape reports |
| `viz/data/db_commits.json` | 2.9 MB | fine |

**The `data` branch is NOT squashable.** `data/db/*.json` holds only CURRENT state (`name`, `price`,
`sku`, `url`, `img`, `removed`) — there is no history inside the files. The entire price history IS
the git commit history of `data/db/**` (that is what `build_viz_sku_cache.js --full-reindex` walks).
Squashing it would destroy the dataset. Likewise `reports/common_listings_*` history is read at
specific shas by the `#/stats` fallback path.

The one large artifact whose history was genuinely disposable — **`index.json`** (84.9 MB/mo, ~47%
of growth): only ever fetched at HEAD (`viz/app/state.js` → `./data/index.json`), never at a sha —
**was moved to a Release asset on 2026-09-17** (tag `index-latest`; same pattern as
`sku_embeddings.json` and the `#/stats` bundles): `run_daily.sh` uploads it before the push,
`pages.yaml` stages it into the Pages artifact at deploy (zero frontend change). Its ~277 MB of
history stays in the branch until the optional filter-repo rewrite. Locally, `.git/lfs` also holds
~2.5 GB of orphaned objects (nothing is LFS-tracked any more) — reclaimable with `git lfs prune`.

#### Re-measurement + forecast — 2026-10-10 (supersedes the 2026-09-17 "mid-Jan 2027" forecast)

GitHub-reported repo `size` (API): **682.3 MiB** (653.7 on 2026-09-17). GitHub's counter tracks
packed/delta bytes, not content, and updates lazily; the local deduped `objectsize:disk` over
`git rev-list --objects origin/data --not <base>` is the pessimistic bound.

After the Release-asset migrations the rate roughly HALVED versus the 85–110 MiB/mo predicted:
**~37 MiB/mo GitHub-reported, ~61 MiB/mo local** (46.5 MiB over 23 days). Attribution of those
23 days: `data/db` 23.1, `reports/common_listings_*` 10.6, `db_commits` + `common_listings_commits`
5.7, `rarity.json` 2.9, `sku_links.json` 1.9, other 2.3. Before the migration the rate had been
climbing to 150–180 MiB/mo as the catalog grew.

**What the limits actually are (GitHub docs, checked 2026-10-10):** "ideally less than 1 GB, and
less than 5 GB is strongly recommended"; the repository-limits page recommends ≤10 GB on disk. Over
those, "you might receive an email from GitHub Support asking you to take corrective action". There
is NO automated email at 1 GB and NO push block at 5 GB; that earlier claim in these docs was wrong.
The only hard limits are 100 MiB per file and 2 GB per push. The real cost of size is CI clone time,
because `cron_tracker.yaml` checks out with `fetch-depth: 0`: 63 s at 682 MiB.

**Forecast for the 1 GB recommendation (342 MiB headroom):** status quo ≈ **July 2027**. **Doubling the store
count** (the store hunt, `STORE_HUNT_HANDOFF.md`: the 85 INCLUDE catalogs list ~27k whisky/rum/gin
against 35.5k tracked listings today, so listings roughly double. Both are per-size listing counts, the
tracker's unit, so the 2026-10-10 distinct-product recount (~1.34× lower) doesn't change this comparison) about doubles the store-scaled
paths. That gives ~70 MiB/mo GitHub-reported (~110 local) → **~Feb–Apr 2027** if the stores land
around Nov 2026, plus a one-time onboarding bump of a few tens of MiB. 5 GB ("strongly recommended") ≈ 2031+.
The `git filter-repo` rewrite (~500 MiB back) is the reserve lever; it is not needed yet.
Re-measure from `gh api repos/brennanwilkes/spirit-tracker --jq '.size/1024'` at each check-in.

Other free-tier limits, checked 2026-10-10, none of them close. All depend on the repo staying
**public**. Actions minutes are unlimited. The ~5,800 min/mo of runs would exhaust the 2,000-min
private-repo bucket in ~10 days, so public visibility is load-bearing for CI. Big runs take ≤37 min
(median of all runs 11), so after doubling expect ~60–75 min: far under the 6 h job cap, but the
email lands ~30 min later. Actions cache is 0.68 of 10 GB. Release assets: `index.json` 15 MB and
embeddings 43 MB against a 2 GiB per-file cap. The largest committed file is 2.8 MB
(`db_commits.json`), against the 50/100 MB push limits. Pages bandwidth is a non-factor. LFS is no
longer used.

All-time deduped-disk attribution (what pruning would reclaim):

| Path | MiB | Verdict |
|------|-----|---------|
| `viz/data/index.json` | 276.6 | HEAD-only, regenerable — disposable |
| `reports/common_listings_*.json` | 226.3 | needed only as stats-bundle rebuild input; runtime path is the Release asset |
| `data/db/**` | 129.0 | THE source of truth — keep |
| `viz/data/skus/*` | 40.0 | HEAD-only, regenerable (`--full-reindex`) — disposable |
| `viz/data/rarity.json` | 23.5 | HEAD-only, regenerable |
| `viz/data/recent.json` | 21.1 | HEAD-only, regenerable |
| `viz/data/db_commits.json` | 6.8 | tooling-only, small |
| `reports/*.txt` | 4.6 | observability, small |
| `data/sku_links*` + code | ~8.6 | keep |

No base64-image waste: `img` fields are URLs. The 133 `stviz/issue-*` remote branches hold only
0.3 MiB unique — cosmetic only. Bottom line: ~110 of every ~180 MB/mo was derived, HEAD-only
copy-of-the-DB (index/recent/rarity/skus/db_commits) whose history is dead weight, and ~550 MB of
such history already sits in the branch. `index.json` (largest, ~85 MiB/mo), `recent.json`
(~6.5 MiB/mo) and `viz/data/skus/**` (~11.8 MiB/mo) are now Release assets; `common_listings`
reports are committed only on big runs. Mitigation options are logged in `docs/` design notes the
remaining lever is a one-time `git filter-repo` history rewrite to drop them retroactively (claws
back ~500 MiB in one move; must preserve `data/db/**`).

**index.json→Release rollout check-in (2026-09-17, revisit in ~1 week):**
- `gh release view index-latest` → asset `index.json` present, size ≈15–16 MB; grows with the catalog.
- `git ls-tree origin/data viz/data/index.json` → empty (never re-tracked by a merge/edit).
- `gh api repos/brennanwilkes/spirit-tracker --jq '.size/1024'` → compare to 653.71 baseline; delta
  should be a fraction of the old ~85 MiB/mo rate.
- Site `…/data/index.json` serves HTTP 200, byte-identical to the Release asset.
- Each `run:` commit on `data` must contain the `index-latest` upload BEFORE the push (deploy needs
  it); a `WARN: index Release upload failed` in run output means the next deploy will fail loudly.

**recent/skus/common_listings rollout (2026-09-17, in code — verify the first big cron run):**
Follow `docs/recent-skus-release-and-common-listings-gating.md`. Key checks: no `WARN: … Release
upload failed` in run output; `gh release view recent-latest`/`skus-latest` have fresh assets
(recent.json ≈ a few MB; skus.tar.gz ≈ 1.8 MB); deploy serves `…/data/recent.json` 200 and item
pages still draw charts (skus extracted at deploy); email pack still suppresses flip-flops (it now
restores `skus-latest` into `viz/data/skus/` before building); small-run commits contain NO
`reports/common_listings_*.json` (big-run commits still do); `git ls-tree origin/data viz/data`
shows neither `recent.json` nor `skus/`. The `recent-latest`/`skus-latest` uploads MUST happen
before the push in the same run, or the deploy + email pack use stale assets.
