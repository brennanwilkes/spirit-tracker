# Data-branch growth: Findings & handoff — 2026-09-17

Forecast + measurements for GitHub free-tier limit exposure on `brennanwilkes/spirit-tracker`
(public repo). Every number below was re-verified against the `.worktrees/data` git store, the
GitHub API, `gh`, and the viz source before writing. See root `CLAUDE.md` §"Data-branch growth"
for the older (2026-09-04) baselines.

---

## 1. Headline forecast

**The repo hits GitHub's 1 GB "keep it small" mark ≈ early December 2026 (±3 weeks).**
Everything else is a non-issue because the repo is PUBLIC.

| Limit (GitHub free, public repo) | Current | Threshold | Arrival |
|---|---|---|---|
| **Repo git size** (the only live one) | 653.7 MB (`gh api .size`, KB/1024) | 1 GB soft (email), 5 GB hard (push blocked) | **1 GB ≈ Dec 3 2026**; 5 GB ≈ 2028–29 |
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