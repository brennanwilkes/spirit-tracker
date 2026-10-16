# `#/stats` series bundles

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

## `#/stats` series bundles (2026-09-04)

`#/stats` used to rebuild history in the browser by fetching
`reports/common_listings_<group>_top<size>.json` at EVERY commit in the manifest — **214 requests**
and ~103 MB of JSON parsed for top250 (~374 MB for top1000). That was the whole reason the page took
tens of seconds to open. (It uses `raw.githubusercontent.com`, not the GitHub API, so it was never
rate-limited — the cost is round-trips + parsing.)

`tools/build_viz_stats_series.js` collapses each (group, size) history into ONE change-point bundle
in `viz/data/stats/`. `viz/app/stats_page.js::expandStatsBundle()` rebuilds the exact per-day report
shape the rest of the page already consumes, so every downstream consumer (baselines, floors,
`computeDailyStoreSeriesFromReport`, `computePriceBoundsFromReport`) is untouched. The old
per-commit walk survives as `loadRawSeriesFromCommits` and is the fallback when no bundle is found.

- **Encoding:** every series is `[[dayIndex, value], …]`, recorded only when the value CHANGES,
  where `null` means "absent that day". **Absence must stay explicit** — the per-day aggregates
  count only rows/stores actually present, so forward-filling a dropped listing would inflate
  coverage and skew the market median. Row emission is gated on `present === 1`, which is why the
  unreadable-commit `catch` only needs to null `present`.
- **NOT committed to the data branch.** Measured 455 KB of pack growth per run even after
  `git repack --depth=50 --window=250` (thousands of scattered insertions delta badly) ≈ **106 MB/mo**
  on top of the branch's existing ~180 MB/mo. So they ship as **GitHub Release assets** on the fixed
  tag `stats-series-latest`, overwritten each scrape — the same trade already made for
  `sku_embeddings.json`. The page tries `./data/stats/<name>` first, then the Release CDN.
- **The `:(exclude)viz/data/stats` pathspec in `run_daily.sh`'s `git add` is load-bearing.** The
  data branch keeps its OWN `.gitignore` that deliberately does not ignore `viz/data/` (that's what
  it stores), so a main-branch ignore rule would not protect it.
- **Only the 9 group/size combos the page can request are built** (`<all|bc|ab>_top<50|250|1000>`);
  the `cohort_*` reports carry no rows and are never fetched.
- **Incremental resume keys off the longest common sha PREFIX, not an exact match.**
  `build_viz_commits.js` keeps the newest commit per DATE, so the tail entry's sha is rewritten by
  every run within the same UTC day — an exact-prefix test full-rebuilt on ~7 of 8 runs. The resume
  truncates change points at `dayIdx >= p` and replays from there; because `pushChange` compares the
  last recorded VALUE, truncation alone restores correct state (no cursor bookkeeping). Verified
  byte-identical to `--force` on a real tail-rewrite pair, `generatedAt` aside. `MAX_DAYS_PER_FILE`
  (600) means the manifest eventually slides; that shifts day indices, so no prefix matches and a
  full rebuild happens — which is REQUIRED for correctness, not a regression.
- Measured: all_top250 562 KB (124 KB gz), all_top1000 1.67 MB (326 KB gz), 5.35 MB for all 9. Full
  build ~44 s; a no-op re-run is ~0.15 s. Release assets are not gzip-encoded, so prod downloads the
  raw size. Expanding all_top1000 allocates ~203k row objects (~96 MB heap) — still less than the
  old path, which held 214 fully parsed reports.
- **Fidelity is verified, not assumed:** expanding the real 214-commit bundle and diffing every day
  against `git show <sha>:reports/…` gives 0 mismatches across 50,750 row-days (row presence,
  `representative.priceNum`, `cheapest.priceNum`, every per-store price). The only intentional
  divergence is `meta` identity/search fields, which store the NEWEST observed values so a later
  rename stays searchable across all history. 11 commits from March 2026 are unreadable LFS
  pointers — exactly the days the old browser path also failed on.
