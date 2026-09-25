# Spirit Tracker

Automated price tracker for Canadian spirits (whisky, rum, gin) across 36 liquor retailers. Scrapes stores on a schedule, stores price history as JSON, and serves a browser-based visualization dashboard.

## Git Workflow (Critical)

Two-branch model:
- `main` — all source code lives here. Make code changes here.
- `data` — all scraped JSON databases, reports, and viz artifacts live here. Never commit code changes to this branch.

`.worktrees/data/` is a git worktree pointing at the `data` branch. It is managed entirely by `scripts/run_daily.sh`. Do not manually commit into it.

Remote branches `stviz/issue-*` are auto-created by GitHub Actions for issue-based edits to SKU link data.

## Git LFS removal (2026-06-11)

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

## Data-branch growth — measured 2026-09-04 (~180 MB/month)

The LFS-removal note above estimated ~15–25 MB/mo. Actual, measured by summing deduped
`objectsize:disk` over the commits in each 30-day window: **~197 MB, ~162 MB, ~195 MB** for the last
three months. Total `data`-branch pack: **757 MB**. GitHub emails about repos over 1 GB and hard-caps
at 5 GB, so the soft threshold is ~1.5 months out at this rate.

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

### Re-measurement + forecast — 2026-09-17

GitHub-reported repo `size` (API): **653.7 MB**. Local deduped pack: `data`-branch-only 733.8 MiB,
all-reachable 737.5 MiB — GitHub's counter tracks packed/delta bytes, NOT content (deduped content
is 28.5 GB). The ~84 MiB local-vs-GitHub gap is local pack redundancy (29 packs), not a trend.

Growth has **accelerated** (deduped `objectsize:disk` over `git rev-list --objects <tip> --not
<base>`, 15-day windows): Feb–Apr ~6–17 MiB/14d → May 36 → Jun–Aug 61–108 → Aug–Sep 61–101.
Current steady rate ≈ **150–180 MiB/mo** (why: catalog grew, so index.json/skus write more bytes
per rewrite.)

**Forecast (post index.json-migration, measured 2026-09-17): first limit = the 1 GB repo-size
mark ≈ mid-January 2027** (range early-Jan to mid-Feb: remaining rate ≈ 85–110 MiB/mo after
dropping index.json's ~85 MiB/mo, headroom 370 MiB). Previous pre-migration forecast was early
Dec; this buys ~6 weeks. Re-measure from `gh api .../.size` at each check-in. **The
recent/skus/common_listings levers (§"Data-branch growth") cut another ~25 MiB/mo once verified
→ mid-to-late Jan holding. Hard 5 GB push cap ≈ 2028–29, sooner if the ratchet continues.** All other free-tier limits are NOT in play because the repo is public: Actions
minutes/storage (free) — the ~5,800 min/mo of runs (estimate: ~6.4 runs/day from the
report file count) would blow the 2,000-min **private**-repo bucket in ~10 days, so keeping the
repo public is load-bearing for CI; LFS (no longer used, free for public);
release assets (132 MB, free for public); Pages bandwidth (non-factor).

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

## SKU Identity & Canonical Mapping

Two link sources feed one canonical map (union-find):

- `data/sku_links.json` — **manually curated** via the `#/link` page; cross-store equivalences a human confirmed
- `data/sku_links_auto.json` — **auto-generated** by `src/tracker/merge.js` when `pickBetterSku()` upgrades a record's SKU in place (e.g., `u:URL-hash` → real numeric SKU after a hydration pass). Backfilled once from git history via `tools/backfill_sku_transitions.js`.

Consumers union both files via:
- Node: `src/utils/sku_map.js::loadSkuMap()`
- Viz: `viz/app/api.js::loadSkuMetaBestEffort()` → `viz/app/mapping.js::loadSkuRules()`

Tools that build local DSUs (`tools/rarity_report.js`, `tools/build_email_event_pack.js`) go through `src/utils/sku_canonical.js` (CJS) / `viz/app/sku_canonical.js` (ESM) — parallel files that must stay in sync.

The orphan-DB-file auto-flip in `src/tracker/orphan_dbs.js` handles the case where a store's category URL changes and the old DB file becomes stranded — runs at the end of every `node bin/tracker.js` invocation.

## Auto-Link Classification + Review (pending links)

`tools/auto_link_classify.mjs` (Node ESM) runs every scrape in `run_daily.sh` — AFTER the
per-build embeddings are written, BEFORE the email pack. It reuses the LIVE ranker end-to-end
(via `tools/linker_ml/featurize.mjs::buildEnv` + `recommendSimilar` + the GBT blend — never forks
scoring) to find cross-store matches and appends high-confidence ones (≥ `autoLinkConfidenceBar`,
the 99%-precision bar = 0.95) to `data/sku_links.json` as:

    { fromSku, toSku, status: "pending", confidence, source: "auto-classify", ts }

**Key invariant: a `status:"pending"` link is a REAL link everywhere, immediately.** Every
consumer (`src/utils/sku_map.js`, `viz/app/mapping.js`, `sku_canonical.js` both,
`build_email_event_pack.js`, `viz/app/api.js`) reads only `fromSku`/`toSku` and ignores extra
fields, so pending links group in the catalog and fire email alerts with NO loader changes. The
`status` field is purely the marker the review UI keys off. **Do not add a pending filter to those
consumers** — that would defeat the design.

- **Candidate blocking (speed).** A confident match shares a distinctive token (or SMWS cask code)
  with the anchor, so the tool scores only candidates from a distinctive-token/SMWS inverted index,
  not the full ~12.6k catalog — a per-anchor handful of comparisons. **Precision-preserving** (the
  full live scorer still runs on every candidate it scores; it can only drop a few zero-shared-token
  semantic matches, which `recommendSimilar`'s retrieve-then-rerank already misses). Measured: 6201
  anchors in ~38s, a 900-SKU store add in ~10s, full catalog sweep ~75s. `vocab`/`groupIndex`/
  `sameGroup` stay full-catalog so any candidate's score is identical to the live ranker.
- **Anchor recency-bound (idempotency).** `run_daily.sh` passes `--since 2` (anchor only on SKUs
  first-seen in the last 2 days; ample margin over the ≤12h run gap). The full catalog is still the
  CANDIDATE pool; only the ANCHOR set is bounded. Stable orphans were already scored on a prior run,
  so the window just avoids redundant rescans. Dedup against existing links/ignores makes re-runs a
  no-op (no write → no commit churn). Flushes every 400 anchors, so a cancelled run keeps its
  progress and a re-run resumes cleanly. `--max-anchors N` hard-caps (newest first); `--dry-run`
  previews. One-time backlog sweep over ALL SKUs: run by hand with no `--since`.
- **Review at `#/link-review`** (`viz/app/link_review_page.js`, off-menu, reachable from `#/link`
  and `#/link-rapid`). Newest-first feed of (a) pending auto-links — rendered as the TWO SKUs shown
  SEPARATELY side-by-side (not collapsed), Approve / Reject; and (b) orphan SKUs (canonical group
  size 1 AND single-store, i.e. no implicit cross-store link) with live candidate suggestions to
  Link / Ignore. Orphan candidates are scored lazily per chunk (`recommendSimilar`).
- **Approve / Reject** are local-write only (`viz/serve.js`): `POST /__stviz/sku-links/confirm`
  drops the `status` annotation in place (already a real link); `POST /__stviz/sku-links/reject`
  removes the entry AND records an `ignore` (a curated hard negative). API helpers:
  `apiConfirmSkuLink` / `apiRejectSkuLink` in `viz/app/api.js`. **`serve.js::dedupeLinks` now
  preserves whole link objects** (status/confidence/source/ts) so a later unrelated local write
  doesn't strip pending markers.
- **Active-learning loop:** Approve → trainable positive link; Reject → trainable hard-negative
  ignore. Both feed the next `tools/linker_ml` retrain. Neither sets `noTrain` (human-verified).
- **Review watermark (git-derived, no state file):** `#/link-review` shows only recommendations that
  appeared since your last **hand**-commit of `data/sku_links.json` — `GET /__stviz/review-watermark`
  walks `git log` and skips `run:` scrape commits. Committing by hand is the "done reviewing" signal;
  anything older (acted on or just scrolled past) is then omitted, no per-item state or finish button.
  A `🔍 Audit` toggle revisits the older ones; a dirty-flag banner nudges you to commit. See
  `viz/CLAUDE.md` §"Auto-link review".
- `run_daily.sh` stages `data/sku_links.json` so the classifier's appends commit (and reach the
  email pack + Pages, which already stage it into `viz/data/`).
- **`recommendSimilar` can return popularity filler, not matches.** When nothing survives its fine
  stage it falls back to `stores×2 + hasPrice×1.2 + hasName` (≈4.2) — a number that clears any
  probability bar. Those rows carry `fallback: true` (2026-09-23); every caller that thresholds
  `score` (CI, the audit) must skip them. Before the marker, a fully hard-vetoed pool would have been
  auto-linked. It never happened (all 22 links with confidence > 1 are SMWS pins at 1e9).

## Hidden Listings

`data/sku_hidden.json` curates per-`(storeId, rawSku)` listings that should never appear in the UI or fire email events (e.g. a store mis-categorized a wine under whisky). Hides apply to the specific store's record only — linked SKUs in the same canonical cluster from other stores are unaffected.

- Parallel loaders: `src/utils/sku_hidden.js` (CJS) and `viz/app/hidden.js` (ESM) — keep in sync. Both expose `loadHiddenSet()` and `isHiddenListing(set, storeId, sku)`.
- Edits via local dev only: `POST /__stviz/sku-hidden` body `{ storeId, sku, reason? }` in `viz/serve.js`. UI: a ✕ button on each store row of the item detail page, gated by `isLocalWriteMode()`.
- Enforcement: pre-aggregation filter in `viz/app/catalog.js` and at each page that loads from the index (`search_page.js`, `store_page.js`, `shortlist_page.js`, `item_page.js`); pre-emit filter in `tools/build_viz_recent.js` and `tools/build_common_listings.js`; ingest-time filter in `tools/build_email_event_pack.js::ingestDbObject` (so nothing about the hidden listing enters events/offers/cheapest).
- `tools/build_viz_sku_cache.js` and the scraper itself are intentionally NOT filtered — data preservation. Hide is a presentation/notification concern only.
- `.github/workflows/pages.yaml` stages `data/sku_hidden.json → viz/data/` parallel to `sku_links*.json` so the deployed SPA can fetch it.

## Rarity Scoring

`src/utils/rarity.js` (CJS) and `viz/app/rarity.js` (ESM) define `scoreSku()`, which combines five smooth signals into a 0..1 rarity score. `tools/build_viz_rarity.js` runs once per `run_daily.sh` and writes `viz/data/rarity.json` keyed by canonical SKU. Consumers (viz, email pack) canonicalize first then look up.

**Per-DB-file epoch.** Confidence's "post-epoch sellout might be an artifact" penalty is scoped per DB file, not globally. Each `data/db/*.json` carries a `createdAt` field stamped on first write (and one-time backfilled from `git log --diff-filter=A` via `tools/backfill_db_created_at.js`). `tools/build_viz_rarity.js` loads these via `src/utils/db_epochs.js` and injects `epochMs` into each `eventsByStore[file]` entry. `scoreSku` resolves an item's effective epoch as `min(entry.epochMs)` across the stores tracking it — earliest wins because once *any* DB file has been observing for 30+ days the OOS signal is no longer suspicious. `TRACKER_EPOCH_MS` (Jan 19 2026) survives only as a fallback for un-backfilled files. This matters because categories were added over time (e.g. gin much later than whisky); items in a late-added DB file shouldn't be flagged rare just because they sold out shortly after we started watching that page.

**Tier classification** uses dynamic 10th/90th percentile thresholds computed per build:
- `staple` (bottom ~10%): widely available, frequent restocks
- `rare` (top ~10%): hard to obtain (OOS or fast sellouts)
- `common` (middle ~80%): no special styling

**Color tokens** — defined in `viz/style.css` as CSS custom properties (`--rarity-staple-*`, `--rarity-rare-*`, plus light-theme overrides). Staple is warm amber (subtle border + glow), rare is deep purple with a diagonal corner sheen, purple ring, and outer glow. The same visual language must be mirrored in the email repo (`~/spirit-tracker-api`) as parallel CSS — neither thresholds nor colors are shipped in event packs. Each pack carries only the raw `rarity` number (0..1) per event; the renderer is responsible for thresholding and styling.

## Flip-Flop (Transient Change) Handling

Some stores report a change that reverts almost immediately — a price that drops and snaps
right back, or an item that goes OOS and returns within hours. Causes: session-state-dependent
pricing (Craft Cellars oscillates between two fixed values), bad scrapes, and same-day
round-trips (e.g. AMRUT @ ARC: $482.99 → $410.59 → $482.99 in one day, surfacing as TWO
events). These are noise, not real market moves.

**Canonical definition: a self-reverting change within a 48h window is a flip-flop.** Four
implementations enforce this; keep the window in sync across all of them:

- `tools/build_viz_recent.js` — coalesces the `recent.json` activity feed. First event of each
  `(store, sku, kind)` fires; a same-kind repeat within 48h is suppressed (for `price_up`/
  `price_down`, only when the new target is same-or-tamer — a genuine *deeper* drop fires).
- `tools/build_email_event_pack.js::isFlipFlop` — same 48h window for email alerts.
- `src/utils/rarity.js::coalescePeriods` — merges in-stock spells separated by a ≤24h OOS gap
  (narrower, since it's smoothing the rarity signal, not gating a "what changed" surface).
- `viz/app/flip_flop.js` (ESM) — the **item-page chart** consumer. This one is STRICTER than the
  suppressors and serves a different purpose: it does NOT suppress, it locates the oscillating
  region so the chart renders it dashed + dot-less ("something is going on here") instead of as
  solid, trustworthy history. **Definition: a repeating oscillation, not a single round-trip.** A
  one-off `A → B → A` (then stays at A) is just a one-day sale and is NOT flagged; only when the
  excursion repeats (`A → B → A → B …`, the value revisited) is it a flip-flop. It works on the
  per-SKU cache's change-point events (`{ts,p}` = in-stock; `{ts}` = OOS) reduced to "spells",
  finds a maximal run that strictly alternates between exactly two states (price↔price or
  price↔OOS) of length ≥ 4, and requires every interior leg to be short (≤ `FLAP_WINDOW_MS` = **3
  days**) — so a genuine *periodic* sale (drop a day, back for two months, repeat) is NOT flagged
  because its interior baseline leg is long. Leading/trailing long-stable spells (the price before
  flapping started, or the value it finally settled on) stay solid; only the unstable middle is
  dashed. `item_page.js` marks the affected day indices (`_flapSet`), hold-fills OOS-flap days at
  the pre-excursion price so the dashed line *bridges* the gap rather than breaking, dashes any
  segment touching a flap via `segment.borderDash`, and suppresses dots. Reuses the same dashed
  visual language as the "↑ above chart" outlier treatment (the dashed line is the only signal —
  no tooltip suffix).
  - Note: this `FLAP_WINDOW_MS` (3 days, per-leg) is independent of the suppressors' 48h
    single-round-trip window — different rule, different purpose; they do not need to match.

## Three fake-flip-flop ROOT CAUSES fixed (2026-09-04)

An audit of 35 days of `data` history found that most observed "flip-flops" were not market
behaviour at all. Three distinct scraper defects, all fixed; each was verified against production
data before and after. **Diagnostic method worth reusing:** walk `git log` on `data/db/*.json` and
compute the ACTIVE (non-`removed`) count per commit — a drop that recovers is the signature. Then
identity-test it (did the SAME urls come back?), then confirm against the live store.

1. **Orphan-DB detector flipped whole categories to `removed:true`.** `orphan_dbs.js` derived a
   category's expected DB filename from the RAW `cat.startUrl`, while `category_scan.js` derived
   the actual filename from `normalizeBaseUrl(cat.startUrl)`. `normalizeBaseUrl` inserts a `/`
   before a query string (`/products?x` → `/products/?x`) and returns `undefined` for a missing
   `startUrl` (hashing to the shared `d5d4cd07`), so **88 of 117 categories were never in the
   "expected" set** and were spared only by the `scannedDbFiles` belt-and-suspenders. Since
   `report.categories.push()` only runs after a SUCCESSFUL scan, any category that FAILED — in a
   store where at least one sibling succeeded — had its entire DB flipped to removed: a store-wide
   fake sellout that "restocked" on the next run. Confirmed: Co-op 2026-09-03 (4 categories, 416
   items, restored 8 min later by the retry) and Vessel 2026-09-03 (202 items).
   **Fix:** one shared `db.js::dbFileForCategory()` used by BOTH sites, so they can never drift.
   Verified: all 117 scan paths byte-identical to before (no store starts writing a new file), and
   117/117 expected paths now resolve (was 29/117). The 11 genuine orphans still detected are all
   already 100% removed, so nothing new is flipped.
   - A store whose categories ALL fail is absent from `ranStoreKeys` and was never affected —
     which is why Elbow Liquor (fails every run) never showed this, but Co-op did.

2. **SKU-collision annihilation in `merge.js`.** The skuKey-rematch branch exists to follow a
   product that MOVED url, and on a match it does `merged.delete(oldUrl)` — a HARD delete. When
   two genuinely DIFFERENT products are concurrently live under one normalized SKU, they
   annihilated each other every run, so the DB kept one record whose price alternated forever.
   Four such pairs found (≈614 fabricated price-change events, which also fired email alerts and
   `recent.json`): BSW `795231` (pendleton-directors-reserve $230 vs …-whisky-2018 $350, sku
   `795231-2` normalizes to the same key), BSW `798880` ($15,000 single vs $19,400 bundle, 235
   events), BSW `845142` (glengoyne-30-year-old-1 vs -3), Sierra Springs `001222`
   (j-p-wisers-special-blend-750ml $28.99 vs …-750ml-40 $24.99).
   **Fix:** only treat a skuKey match as a migration when the old url is NOT also in `discovered`
   this run (`!discovered.has(hit.url)`). Both URLs live ⇒ distinct products ⇒ keep both.
   - **Does NOT break Tudor's `?variant=` re-SKU flow** — `tudor.js` MUTATES `it.url` in place, so
     the bare url is never in `discovered` and the guard cannot fire. Verified by unit test.
   - Known trade-offs: those SKUs now show TWO same-store rows (accurate — they are different
     products), and the first run after shipping emits a one-time `new_item` burst for the
     resurrected twins. A genuine slug migration where the store serves both urls for one run now
     yields `new_item` + `removed` instead of a silent move; history survives (the per-SKU cache is
     sku-keyed), only the events feed is noisier. Unavoidable at scan time.

3. **ARC page-boundary skip (upstream pagination bug).** The Barnet API pages via LIMIT/OFFSET and
   re-runs its ORDER BY per request, so rows TIED on the sort key swap between requests: one is
   served on both neighbouring pages while its partner is served on NEITHER and silently skipped.
   Measured: `rowsFetched === paginator.items_count` and `duplicateRows === shortfall` in every
   category — the API always hands over exactly `items_count` rows, just with one repeated in place
   of another. Under the old `sortBy: "price_desc"` Rum served 101/102 and Whiskey 159/160; the
   Rum victims were 478594 and 265031, both $87.99, straddling the page-1/page-2 boundary, exactly
   one vanishing per run (they never both dropped — the mutual exclusion is the tell).
   **Fix:** ARC categories now use `sortBy: "name_asc"`, which is tie-free in this catalog and
   returns 160/160, 227/227, 102/102, 83/83. A completeness check (`rawIds.size < items_count`,
   counting RAW pre-stock-filter row ids) re-sweeps with a DIFFERENT sort as a self-healing net for
   a future tie — re-sweeping the SAME order is useless because the skip is deterministic (5/5
   identical sweeps repeated row 410603 and dropped the same partner).
   - **Deliberately NO "preserve unseen listings" fallback.** A genuine sellout also lowers
     `items_count`, so a leftover gap cannot be distinguished from one; preserving would pin a real
     sellout live forever. (An earlier attempt did preserve, on the mistaken belief that 287777
     STILLHEAD PX CASK RYE was genuinely OOS because it never appeared under `price_desc` and its
     product page matched an out-of-stock regex — a false positive. It was the straddle victim;
     `name_asc` returns it and it stays live. Don't reintroduce the fallback on that evidence.)
   - Other Barnet stores (`highpointbws`, `newdistrict`, `vintage`) still default to `price_desc`
     via `barnet_network.js` and were NOT audited — likely carry the same latent straddle.

**NOT bugs (verified against the live stores — leave alone):** Liberty's mass drops are REAL
(its Woo API sets `stockStatusFilter: "instock"` AND hides out-of-stock products from the catalog
entirely, so disappearance is the only OOS signal; of 203 items dropped 2026-09-02, the 39 that
never returned are absent from the live catalog and the 164 that returned are all live now).
Liquorama's toggles are a genuine `current_stock` signal (two back-to-back sweeps were identical,
245/245). Malts & Grains' apparent flapping was onboarding (0 → 538 over 2026-08-07→13).

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

## Datacenter-IP Blocking — OPEN (2026-07-06, WireGuard disabled 2026-07-16)

The GitHub-runner's Azure datacenter IP gets challenged by Cloudflare at several
stores (liberty, highlander, coop, colordevino, maltsandgrains, **elbowliquor/vinox**).

**elbowliquor (vinox.ca) is currently CI-blocked outright** (added 2026-09-04): all three
categories return `HTTP 403` with a Cloudflare interstitial (body starts
`<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie"` — that markup is the tell).
The adapter itself is fine: from a residential IP it scrapes cleanly (31 single-bottle listings,
31/31 real CSPCs). So its 3 failures/run are the datacenter-IP issue, NOT a broken scraper — check
that before "fixing" the adapter. Because every one of its categories fails, the store never enters
`ranStoreKeys`, so the orphan detector leaves its DB files alone and nothing is corrupted; the run
just records the failures honestly. Run it locally to refresh that store's data.
Note the block is an IP lottery, not deterministic — colordevino, on the same list, succeeded in
the same run.

**WireGuard attempt (DISABLED):** ProtonVPN WireGuard tunnel in `cron_tracker.yaml`.
UDP endpoint reachable but handshake never completes on cron runner — likely Azure
platform-level filtering of WireGuard protocol packets (Hyper-V virtual switch).
Diagnostic workflow (`vpn_diag.yaml`) worked on a different runner. Full config
commented out in `cron_tracker.yaml`. See `docs/vpn-setup.md` for research and
alternatives (Tailscale, residential proxy, Cloudflare whitelisting).

**Current status:** Stores are scraped without VPN. CF-blocked stores fail with 403s
on every run. The one-shot retry logic still fires but without a VPN it just retries
the same blocked IP. Workaround: run locally (different IP) or use a residential proxy.

## Tech Stack

- **Node.js 18+** required (uses global `fetch`). No npm install needed — there are no npm dependencies.
- **CommonJS** (`require`/`module.exports`) throughout the tracker source.
- **No build step** for anything — tracker runs directly, viz SPA uses native ES modules.

## Two Subsystems

| Subsystem | Location | Description |
|-----------|----------|-------------|
| Tracker/scraper | `src/`, `bin/tracker.js` | Node.js web scraper |
| Viz SPA | `viz/` | Vanilla JS single-page app |

See `src/CLAUDE.md` and `viz/CLAUDE.md` for subsystem-specific details.

## Running the Tracker

```bash
node bin/tracker.js                           # all stores
node bin/tracker.js --stores sierra_springs   # one store
node bin/tracker.js --stores kwm,bcl          # multiple stores
node bin/tracker.js --debug --maxPages 3      # debug with page cap
```

Exit code `3` = no meaningful changes (normal, not an error).

## CI / Automation

GitHub Actions (`.github/workflows/cron_tracker.yaml`) runs on two schedules (times
chosen so the **commit** — run end — lands ~on the 3-hour marks in Pacific time):
- **Big** (all 33 stores): 5:45 and 17:45 UTC daily (~1 h runtime → commits ~00:00 / 12:00 PT)
- **Small** (sierra_springs, craft_cellars, colordevino, liquorama, zyn): 0:45, 3:45, 9:45, 12:45, 15:45, 21:45 UTC (~12 min → commits ~03/06/09/15/18/21 PT)

**One-shot failed-store retry.** Store failures are usually a bad random Azure egress
IP (see §"Datacenter-IP Blocking"), and recover on the next run's different IP. So after
a run, if the tracker's `[[FAILED-STORES]]` sentinel is non-empty, `run_daily.sh` surfaces
those store keys as the `failed_stores` step output, and the workflow **re-dispatches
itself** for exactly those stores (`-f stores=… -f mode=big -f is_retry=true`) on a fresh
runner/IP. `is_retry=true` makes the retry skip its own retry step (no recursion — exactly
one retry), and `concurrency: tracker-cron` queues it until the first run fully completes.

Each run executes `scripts/run_daily.sh`, which:
1. Sets up / repairs the `.worktrees/data/` worktree
2. Pulls latest `data` branch and merges `main` into it
3. Runs the tracker (writes `data/db/` JSON + a `reports/*.txt` file)
4. Builds viz artifacts via `tools/build_*.js` scripts
5. **Re-encodes the linker embeddings** (`build_dataset.mjs` → `tools/linker_ml/encode.py`) with the
   fixed fine-tuned checkpoint so newly-scraped SKUs get vectors — weights are NOT retrained here.
   See `tools/linker_ml/CLAUDE.md` §"Shipping the checkpoint" (best-effort; skips if no venv/checkpoint).
6. **Auto-link classification** (`tools/auto_link_classify.mjs --since 2`) — appends high-confidence
   `status:"pending"` cross-store links to `data/sku_links.json` using the just-written embeddings.
   See §"Auto-Link Classification + Review". Best-effort; before the email pack so alerts reflect
   the new groupings.
7. Commits + pushes all changes to the `data` branch
8. Triggers the Pages deploy and email pack workflows

## Run Observability (commit messages)

Every `data`-branch commit from `run_daily.sh` encodes run health so failures are
visible at a glance in `git log` over time:

- **First line**: `run: <ts>` — and, when any category's scan threw, ` | FAILED(n): Store | Label; …`.
  Source of truth: the tracker prints a stable `[[FAILED-CATEGORIES]] …` sentinel on
  stdout (always, even on no-op runs); `run_daily.sh` tees tracker output and lifts it.
  Internally, `report.failedCategories[]` (populated in `run_all.js`'s catch) also
  renders a `FAILED CATEGORIES (n)` section in the report body.
- **Body**: a `runner: ip=<egress-ip> run_id=… os=… name=…` line (egress IP via
  best-effort `api.ipify.org`) so store blocks can be correlated to the runner IP —
  most store failures are datacenter-IP reputation (see §"Cloudflare Egress Proxy").
- **Limitation**: the `meaningful`-changes short-circuit means a run where *everything*
  fails (no data at all) writes no commit, so it leaves no record. Partial failures
  (the common case) do commit and are recorded.

## New-listings audit (`scripts/audit_new_listings.js`)

**Strategic direction (2026-09-17, sharpened by the owner 2026-09-20):** the human link pages are
being retired (long term). Link quality control becomes two pillars: (A) the auto-classify pipeline
(below), which is FREE and runs every scrape, and (B) **periodic AI-agent audits** driven by this
script, which are EXPENSIVE and run every few months. `#/link-rapid` / `#/link-review` are
scheduled for removal once the audit loop is the trusted path.

**The two pillars are not peers — B exists to correct AND to improve A.** Three consequences that
should drive every design decision in this tooling:

1. **The audit's job is the last X weeks/months of CI output**, both halves: the links CI missed
   and the links CI got wrong. It is a corrector running at a cadence CI cannot afford, not a
   second opinion on every scrape.
2. **The planned full-library pass is a label-production run, not a cleanup.** Its purpose is a
   high-quality labeled set over the WHOLE catalog so the places the auto-linker fails can be
   characterised and its accuracy raised at the source. That makes the `ignore` ops (curated hard
   negatives) worth exactly as much as the `link` ops, and makes COVERAGE matter more than speed —
   the opposite of the trade CI makes.
3. **Therefore: do not paper over CI's weaknesses inside the audit.** Adding mechanical screens to
   the audit report to catch what CI gets wrong (an independent-bottler screen was proposed and
   REJECTED on 2026-09-20) is backwards — it hides the failure the audit exists to measure, and it
   reimplements judgement the agent already does by reading the two names. `pairs[].pol` survives
   only because size buckets and store carriage are NOT legible in the names (see that section).
   Mechanical vetoes, if they are ever wanted, belong in `auto_link_classify.mjs`, which has no
   agent; that is an open, separate decision.

**Scale/search plan (2026-09-17):** `docs/audit-search-and-scale-plan.md` — two-tier cover
(conventional high-recall blocking + AI precision judge; O(N²) LLM review is impossible).
Measured: the audit's distinctive-token blocker (`candidatesForAnchor`, idf ≥ 4.6) structurally
drops **1.0% of known positives**, brand-biased (`glenfarclas` idf 4.45, `highland` 4.35 — popular
brands fall under the cutoff); embedding cosine is ~40× cheaper (9.3 ms/anchor vs 380.9 ms full
token scan) and higher-recall on weak overlap. M↔M merges are common but the ones conventional
tools *miss* are rare (genuine merges share easy tokens); the residual token-invisible M↔M set is
small and mostly precision traps. Errors concentrate in isolated SKUs (23.6% of catalog). Plan
phases: gold-set harness → search primitive CLI → union blocker (loosened IDF + embedding + fuzzy
alias) → alias learning from labels → agent loop.

The audit is the **collapsing layer**: it reads the big worktree sources (per-SKU caches,
`data/db/**`, both link files, hidden, rarity) and emits a compact, machine-readable report so an
agent only ever looks at decision-relevant rows. Read-only over the worktree; outputs to `audit/`
(git-ignored). Uses the LIVE ranker end-to-end (never forks scoring) — the same
`buildEnv` + `recommendSimilar` + GBT blend path as auto-classify, so every number equals
production.

**Full-library plan + session hand-off: `docs/audit-full-library-plan.md`** (compacted 2026-09-23)
— current state, what is left (the ≥ 0.95 existing-link pass, sized + estimated), the measured
per-run agent cost, and the operating rules. **Read it before starting any large audit.** Always
pass `--since 1970-01-01`: the generator's default window is only 12.7% of the library and has
already produced one false "the audit found nothing" conclusion.

### Three known limits of the audit, one of them an open question (2026-09-20)

Audited against the owner's stated goal — *classical tools cut the search space, they do not make
the decisions*. Three places where that is not strictly true; full detail in the runbook's
"What even a complete slice CANNOT see".

1. **Ignored pairs are hard-suppressed from the candidate pool** (`isIgnoredPair` → `recommendSimilar`,
   plus the twin scan), so all ~13,540 `ignores[]` entries are invisible to an audit agent and a
   WRONG ignore can never be overturned. Write-only, and ratcheting: the audit now produces ignores
   (+934 on 2026-09-20) and bad ones do get proposed (164 of Run 2's 497 were caught by hand).
   **OPEN — owner's call is to document and leave as-is.** The fix, if ever wanted, is an opt-in
   `--include-ignored` pooling them as `t:"i"`. Consequence today: the ignore-emission rule must
   stay tight, because an ignore is effectively permanent.
2. **`need-unlinks` is a below-bar funnel and cannot satisfy criterion 2** — a wrong link the model
   still likes (Aberfeldy 12 at 0.9904, Blanton's at 0.995) never enters it. Only a complete slice
   (`--only all` + reading `vl[]` per row) audits link precision. FIXED in the runbook's wording.
3. **Pool recall is conditional, an accepted cost/accuracy tradeoff.** 100% @K=100 is measured
   against a gold set that IS the link file, so it means "finds what the old tools could find".
   Measured saturated (8.5x pool → identical output; wider rerank cuts → 1 extra pair, a false
   positive), so this is inherent, not tunable. The twin scan and `audit_search --census` are the
   partial escapes. State it; do not engineer around it.

A full-history generate is cheap enough to be the default for any large pass: `--since 1970-01-01`
is **~10 min / 717 MB / 34,247 listings / 38,213 verified pairs**, and `--from` views off it are
seconds. Always pass `--since` explicitly; the default window is 12.7% of the library and has
already produced one false "the audit found nothing".

### Audit status after the 2026-09-23 session

**Links 5,924, ignores 16,126, collisions 21, hidden 461** (2026-09-24; from 5,975 / 13,540 on 2026-09-22). Every cheap
surface is adjudicated over all of history: near-miss and want-links (including the v5 residual),
orphans (3,061), every existing link below the bar (`< 0.30`: 23% wrong; `0.30–0.95`: 13.8% wrong),
38 ignore↔link contradictions, and the whole review backlog (0 open, bar 5 waiting on the deferred per-store split). **The 0.95–0.99 pilot of the
above-bar pass found 10.5% wrong** (65 of 622; bridges, editions, gift packs, sizes), so being above
the bar is weak evidence that a link is right.

**The ≥ 0.99 pass is complete: 92 of 5,632 edges wrong (1.6%)**, and every review queue is closed. Precision
is done. The ignore screen stopped after tier A (`tools/audit_ignore_slice.js`): the near-identical-name ignores
were only 0.43% wrong (3 of 694), so B–D (~4M tokens) was not worth it. Still optional: the recall backfill
(~30 agents). Agent cost is ~80K fixed + ~0.62 tokens/byte for group and ignore slices alike, so slices of
~700 KB end near 50% context, and 50% is a soft limit. **Collided skus stay in their
groups** (owner ruling 2026-09-24): no containment unlinks, because collisions will be handled in
the email pack and the frontend.

Rules from 2026-09-23:
- **Audit existing links group-major** (`tools/audit_link_group_slice.js`). A band slice hides a
  group's out-of-band edges, so splits decided from it come out incomplete.
- **Cap row-major orphan batches at ~200 KB**; one 251 KB batch hit 49%.
- **Merge concurrent proposals before applying** (`tools/merge_audit_proposals.js`).
- **A wrong `merge-auto` edge is removed with the applier's `unlink-auto` op.** It writes an ignore,
  and `src/tracker/sku_auto_links.js` skips ignored pairs, so the scraper cannot re-add it. That
  writer now also throws on an unparseable file instead of rewriting it from empty.

Per-run cost on the current model is in the plan doc's §"Measured agent cost".

Findings from 2026-09-22 that still hold:

1. **`prob` does not rank wrongness inside a band.** Of the 26 pairs below 0.30, 18 were CORRECT
   links and 6 wrong; the two lowest-scoring pairs in the slice (0.0005, 0.002) were both correct,
   and the wrongest link (0.0006) is indistinguishable from them. Choose the band, then read every
   row in it — do not sub-prioritise by score.
2. **36% of above-bar pairs were rejected** (28 of 77) in the want-links funnel. Upper bound on CI's
   own false-positive rate, since the audit pool is wider than the CI blocker. Only 1 of the 28
   carried a `pol` marker, and the decisive evidence was the **url slug** in 6 cases and the store's
   price ladder in 4 — none of which is on the row. Further evidence against mechanical screens.
3. **Neither named retrieval blind spot costs recall any more.** Across 1,535 near-miss rows, 0
   links came from `no-embedding` pairs (batch B: 0 of 1,584 — the asset is healthy) and 0 from
   title-twins. What actually loses recall is **unstated bottle sizes**, resolvable only from the
   store's price ladder.
4. **Three wrong ABOVE-BAR existing links were found by a recall pass reading `vl[]`** (Barrell
   Gold/Gray Label Dovetail 0.9495, Kraken Black/Gold Spiced 0.9502, Bombarda Culverin/Falconet) and
   removed. None was reachable via `need-unlinks`, which is below-bar by construction — more
   evidence that criterion 2 needs `vl[]` read on every row, not just the below-bar funnel.
5. **An `unlink` writes a hard negative by default and that is usually right — but not when you are
   severing to contain collision damage.** If the two products are genuinely the same and the link
   only does harm because one sku is polluted, pass `"ignore": false`. (For skus on the collision list, don't cut at all — owner ruling 2026-09-24.)

### Collided SKUs were corrupting the training set (found 2026-09-22, extended 2026-09-23)

`tools/linker_ml/build_dataset.mjs` builds positives as the full transitive CLOSURE of each
canonical group, asserting in a comment that "every pairing is a valid positive". False twice: one
faulty member of an N-member group yields N−1 bad positives, and a **collided sku is itself a group
member** — the trainer was being taught "Roseisle 12yr ≡ Laphroaig Càirdeas 2023" as a positive.
Unlinking cannot fix it; no link created the merge.

- **`data/sku_collisions.json`** (data branch) — curated, VERIFIED collisions only, **22 entries**
  (2026-09-23; 74 candidates adjudicated, ~10% real). Every real one crosses numbering systems (BC vs
  AB, or the Sierra Springs / Wine and Beyond `id:104xxxx` overlap). Worst: `744086` = Yellow Spot 12
  (6 stores) + Brinley Gold Shipwreck Spiced Rum (3 stores).
  Recorded only when the two products belong in DIFFERENT canonical groups. **A collision that
  policy would link anyway is benign and must not be listed** (`876891`: a Springbank bundle
  colliding with Springbank 10 — owner ruling 2026-09-22).
- `build_dataset.mjs` drops any pair touching a listed sku inside `add()` (so positives, ignores and
  `noTrain` are filtered uniformly) and **prints the count** (126 pairs at 22 entries), and strips collided skus from `groups.json` too — the embedder builds its contrastive positives from it and had been training 11 collided groups. A MISSING file warns and continues
  rather than throwing — `run_daily.sh` calls this under `set +e`, so a throw would skip the
  re-encode and silently re-freeze `sku_embeddings.json`, i.e. re-create the 2026-08-20 incident.
  Same shape as the `sku_hidden.json` loader in `featurize.mjs`.
- **`apply_audit_proposal.js` refuses any `link` op touching a listed sku** (2026-09-23; `--force` does not override).
- **`auto_link_classify.mjs` refuses any pair touching a listed sku** (2026-09-23) — Roseisle 12
  scored 0.977–0.998 against collided `id:1049495`, so a newly-scraped Roseisle would have merged a
  Laphroaig into its group. Prints the skip count; missing file warns.
- **`tools/detect_sku_collisions.mjs`** regenerates the candidate census from `index.json`
  (5,453 multi-store skus → 82 candidates). Candidates, not verdicts — judge on every store's listing.
- **This reopens the "0.09%, not worth fixing" ruling.** That rate came from a name-overlap test
  finding 4 in 4,445. The harm is recall + training data, not display.

### Two pre-apply guards now required

- **`node tools/validate_proposal_skus.js --proposal <file> [--fix]`** before every apply. The
  generator's listing ids/cluster keys strip `id:` while `pairs[].sku`/`vl[][0]` keep it. **Correction
  (2026-09-23): a bare ref is NOT a dead link** — every canonical loader folds `id:N` ≡ `N`. The real
  damage was ML-side: `bySku` is keyed by the prefixed form, and raw-key checks in `build_dataset`,
  `linker_eval`, `dump_features` and `featurize.linkAdj` silently dropped **4,828 of 14,442 ignores
  from training** and leaked the group split — all four fixed; see `tools/linker_ml/CLAUDE.md`
  §"2026-09-23". Keep the file in catalog form anyway; `--fix` rewrites bare refs.
- **Link ops against the collision list are refused by the applier** (since 2026-09-23). Linking TO a
  collided sku spreads contamination into a clean group — 2 otherwise-correct Roseisle links were
  withheld for this reason.

`tools/apply_audit_proposal.js` now also detects **ineffective unlinks** (the A–B entry removed but
A–C–B still connects them, so the canonical group does not split), reports `ineffectiveUnlinks[]`,
and withholds the automatic ignore for those pairs. Its component checks also union `sku_links_auto.json` (2026-09-23); before that, an unlink bridged only by an auto edge was reported as a successful split.

**The agent's operating manual is `docs/audit-runbook.md`** (pipeline, CLI surface, decision
protocol, proposal schema, coverage contract). Read it before running an audit. The tool is
**two-stage plus apply**: stage 1 generates a rich "all the data" file; stage 1.5 projects
token-cheap views/deep-dives from it (NO re-scoring); stage 2 is the agent's decision pass →
proposal file; stage 3 applies it write-only. **Reviewer handoff / test spec: `docs/audit-search-review.md`.**

**Search pipeline (2026-09-18, corrected + re-measured 2026-09-19):** the generator's
candidate pool comes from a **union blocking index** (`tools/audit_search_core.mjs`,
imported by `scripts/audit_new_listings.js`) — channels `dist` (idf≥4.6) + `topTerm` +
`smws` + `twin` + `fuzzy` (trigram+Levenshtein, alias-expanded), optional `emb` via
`AUDIT_POOL_EMB=1`; env budgets `AUDIT_POOL_BUDGET=700`/`AUDIT_POOL_PER_CHANNEL=150`
(the latter is per index KEY, not per channel); old two-index blocker is the fallback on
init failure, and that fallback now logs a WARN instead of failing silently.

**This is hand-run tooling and deliberately NOT wired into `run_daily.sh` or CI.** Two
intended uses: a one-time full-library audit, and a periodic (every few months) pass over
new SKUs paired with a re-embed + retrain. Nothing here writes links automatically.

**Scope of the fix — read this before quoting recall numbers.** The union changes the
AUDIT REPORT's candidate pool only. `tools/auto_link_classify.mjs` (the CI writer) still
uses its own uncapped dist+SMWS blocker and does NOT import the core, so no new pairs are
auto-linked and **no new alerts fire** as a result of this change. The audit's `want-links`
funnel can therefore surface above-bar pairs the CI writer structurally cannot see — that
is the point of the audit, but it means the audit no longer mirrors production candidate
generation. The *score* per pair still matches production exactly (same `buildEnv` +
`recommendSimilar` + GBT, full-catalog vocab/groupIndex).

Measured (2026-09-19, sampled gold set n=316 records, `tools/audit_search_eval.mjs`):

| K | current | fuzzy | emb | unionMerged | unionAny |
|---|---------|-------|-----|-------------|----------|
| 5 | 88.0 | 89.2 | 94.9 | 88.9 | 97.8 |
| 20 | 96.8 | 98.1 | 99.4 | **98.1** | 100.0 |
| 100 | 98.7 | 100.0 | 99.7 | **100.0** | 100.0 |

`unionMerged` (one pool, ranked once, cut at K) is the only budget-comparable column and
is the number to quote. `unionAny` = best rank in ANY of four separately-ranked channels,
so at K it spends up to 4×K slots — the earlier "100% recall @K=20" headline was this
column and was not comparable to `current`. Structurally the old blocker misses 60/5,723
known positives (1.0%) and the union leaves **0 absent from every channel**; that
structural claim stands. `EVAL_PROD_CAPS=1` re-runs at the shipped 700/150 budgets
(result: unchanged, so the caps are not currently costing recall).

**Caveat the recall numbers cannot see:** the gold set IS `data/sku_links.json` +
`sku_links_auto.json`, so 901 of 6,671 edges are the ranker's own auto-link output, and a
pair the old blocker could never retrieve could never have been shown to a human to become
a label. Recall here is conditional on "findable with the existing tools". The fuzzy
channel's alias table is also mined from those same labels with no split.

### The stale-embeddings incident (2026-08-20 → 2026-09-19) — the single most damaging defect found

**The `embeddings-latest` Release asset was frozen for a month while every cron job reported
success.** Root cause: the CI venv cache restores `tools/linker_ml/.venv`, whose `bin/python` is a
symlink into the runner image's interpreter; a Python patch bump in a new image dangled it, the
`-x "$PYTHON_BIN"` guard in `run_daily.sh` went false, and the skip printed a bare `INFO`. The
upload step then found no file and also printed a bare `INFO`. Nothing failed; nothing was loud.

Blast radius is production, not just the audit: `auto_link_classify.mjs` scores against those
vectors every scrape, so **every SKU first seen after 2026-08-20 had no vector, took the GBT's
conservative missing-embedding branch, and was never auto-linked.** The linker page reads the same
asset. Re-encoding is cheap — 13,785 SKUs in ~12 s on CPU — so the cost was pure silence.

Effect of a fresh encode on the full default window, no code change:

| | stale | fresh |
|---|---|---|
| `no-embedding` candidate pairs | 47.8% of near-miss | **0 / 21,497** |
| near-miss listings | 900 | **448** |
| want-links | 54 | **117** |
| need-unlinks | 0 | 2 |

**A previous claim here was wrong and is retracted:** the no-embedding hint was NOT "embeddings are
keyed by the aggregate SKU so a store's alias listing misses". It was staleness, full stop. With a
current file the rate is zero. The only SKUs legitimately without a vector are `sku_hidden.json`
listings, which `featurize.mjs` excludes from the linker ML entirely (~300 of 14,088) — see
[[feedback_notrain_and_hidden_exclusion]].

Hardening shipped (all three, because any one alone still fails silently):
1. `cron_tracker.yaml` salts the venv cache key with `python -VV` and adds a **validate-restored-venv**
   step that rebuilds when `import torch, sentence_transformers` fails. A dead cache now busts
   instead of poisoning.
2. `run_daily.sh` guards on a POPULATED checkpoint dir (the workflow comment already claimed this;
   the code only checked `-d`), and both skip branches are now `WARN`, not `INFO`.
3. `run_daily.sh` asserts the exact freshness invariant after the upload: **every SKU in the
   `sku_texts.jsonl` this run just wrote must have a vector in the file being shipped.** Percentage
   thresholds cannot catch this — a full month of freezing only moved catalog coverage from 1.8% to
   4.7% missing, well inside any sane tolerance.

**Recovery — DONE 2026-09-20.** The `embeddings-latest` asset was refreshed by hand
(`gh release upload --clobber`, after asserting all 13,785 encoder inputs had vectors), and the
one-time backlog sweep was run, because `--since 2` only anchors the last 2 days and would never
have re-scored the blind month.

`auto_link_classify --top 10 --since 40` found **66 above-bar pairs over 1,498 anchors** — and
16 of them were false positives, so **the sweep was NOT applied as-is**. It was triaged against
`data/sku_link_policy.md` and applied as an `agent-audit` proposal
(`audit/proposal-backlog-sweep-2026-09-20.json`): 46 links accepted (36 net, 10 transitively
redundant), 17 rejected to curated ignores, 3 to `review[]` and since resolved. Result: links
5,845 → 5,881, ignores 12,606 → 12,626.

**The lesson for the next sweep: a backlog sweep is not a cron run and must not be applied
blind.** A normal `--since 2` run anchors a handful of same-day SKUs; a 40-day sweep re-scores a
month of accumulated orphans at once, which is exactly the population where the near-bar
false-positive classes concentrate. The 16 rejects were: 6× `Drumshanbo Gunpowder Year of the
Dragon` vs plain Gunpowder (the literal named example in the limited-edition rule), 3× Shelter
Point `The Collective` vs `Cask Strength`, 2× Raasay unpeated vs peated single casks, Elijah Craig
Barrel Proof bourbon vs RYE batch A925, Ardbeg Dark Cove vs its Committee Release, G&M CC
Bruichladdich vs Bruichladdich Rare Cask, plus the two already-known FPs (Aberfeldy 12 `840932` ↔
`id:8289118`, Traveller `153264` ↔ `102811`).

### `status:"pending"` and the review watermark are now vestigial (2026-09-20)

Both exist only to serve `#/link-review`, and the link pages are being deleted. The owner's call:
**no use needs to be preserved.** Either repurpose the field or drop it — "I don't really care."

- `status:"pending"` on an auto-classify link is a marker for a review UI that will not exist.
  Nothing else reads it (every consumer takes `fromSku`/`toSku` and ignores extra fields), so
  removing it is safe and saves bytes in a file rewritten every scrape. `apply_audit_proposal.js`
  currently stamps it on `agent-audit` links too.
- The git-derived review watermark (`GET /__stviz/review-watermark`, walks `git log` for the last
  hand-commit of `data/sku_links.json`, skipping `run:` commits) has no consumer once the page is
  gone.

**Not removed yet** — it touches `auto_link_classify.mjs`, `apply_audit_proposal.js` and
`viz/serve.js`, and none of it blocks the full-library pass. Do it as part of the link-page
deletion, not before.

### Policy rulings + the cross-store SKU collision class (2026-09-20)

Six owner rulings were added to `data/sku_link_policy.md` (each tagged `owner ruling 2026-09-20`),
closing the amendments the earlier audit runs had left open:

| class | ruling |
|---|---|
| Independent bottler | **separate** — the bottler is part of identity. Adelphi/G&M/Signatory/Càrn Mòr/SCN/OMC ≠ the distillery's official bottling of the same age. Two listings of the SAME IB release still link. Mechanically screenable (IB marker on one side only) |
| Market / import variant | **link** — `(Uk)`, `Export`, `Travel Retail`, `Duty Free` are packaging. Only a stated ABV/volume difference separates, via the existing rows |
| Gift / sampler set | **separate even with ONE bottle** — a gift pack is its own purchase unit. Contrast `Vintage Packaging`, which is the same unit and links |
| Bundle of TWO rare items | link to the **rarer / more allocated** of the two (the old rule only covered one-rare and two-common) |
| Year-less annual edition | **judge, do not default** — evidence of difference ⇒ separate; nothing suggesting one ⇒ link; no data ⇒ best call, stated in `why` |
| Title with no expression name | resolve from the **store's own price ladder**. Worked example in the policy file: Kegn'Cork lists `PENDERYN MYTH` $68.96 *and* a bare `PENDERYN WELSH SINGLE MALT` $77.96, so the generic row is not Myth — $77.96 sits on the market-wide Madeira Finish band ($68.81–$82) |

**Cross-store SKU collisions — measured, rare, and NOT agent-fixable.** Two genuinely different
products can share one numeric SKU because store numbering namespaces overlap. Measured over every
live listing: **4,445 numeric SKUs appear at ≥2 stores and 4 are real collisions (0.09%)** —
`148534` (BCL Johnnie Walker GoT $60.99 vs G&M CC Highland Park 2005 ~$290 at three AB stores),
`111168`, `134037`, `136399`. Restricting to BCL-involving SKUs: 2 of 499, one of which is a
false alarm of the name-overlap test.

The critical property: **nothing in `sku_links.json` created these merges.** Listings aggregate by
canonical SKU and an unlinked numeric SKU is its own canonical, so the stores collapse into one
item for free. There is no link to remove, so no `unlink` op helps and an agent must not propose
one — report it in the proposal's `dataQuality[]` instead. Fixing them needs a new `(storeId, sku)`
split/"cuts" file that re-keys the odd listing, parallel to `sku_hidden.json`; **deliberately not
built** (owner's call 2026-09-20 — 0.09% does not justify touching both canonical-mapping loaders).
Distinct from the same-STORE collision class in `merge.js`, which is already fixed.

**Unlink semantics, hardened 2026-09-20.** An `unlink` op writes an ignore by default
(`normalizeOp`: `ignore: true` unless explicitly false) — removing a link IS the assertion that two
products differ. But removing the A–B entry is a no-op when A and B stay in one union-find
component via A–C–B, which a precision audit produces routinely because the agent judges one pair
at a time. The applier now re-checks every successful unlink against the FINAL link set, reports
`ineffectiveUnlinks[]` + a `WARN`, and **withholds the automatic ignore for those pairs** (a hard
negative on a pair still grouped as one product is incoherent, and ignored pairs never re-enter the
pool, so it would be unrecoverable). Splitting a group requires unlinking every edge holding it
together.

**`apply_audit_proposal.js` `dataQuality[]` validation had never executed** — it pushed onto
`errors` before that `const` was initialised, so any proposal carrying a `dataQuality` array died
with a TDZ `ReferenceError`. Fixed (its own `deferredErrors` array, merged into `reviewErrors`).
The schema is `{sku, store?, issue}`, not `{what, why}`.

### Mechanical policy screen on pair rows (`pairs[].pol`, 2026-09-19)

The GBT clears the 0.95 bar on pairs `data/sku_link_policy.md` calls SEPARATE, and nothing else on
the row said so. `scripts/audit_new_listings.js::policyConflicts` now emits a `pol` array for the
two rules that are purely mechanical:

- `size:<a>vs<b>` — both sides state a size and the canonical buckets (shared with the scorer via
  the newly-exported `viz/app/linker_page/size.js::canonSizeMl`, so 700≡750 / 350≡375 are already
  tolerated) are disjoint. The anchor side prefers THIS listing's title over the union of the
  aggregate's variants: `103252` is listed as both "Knut Hansen Gin 750mL" and "Knut Hansen Dry Gin
  500ml", and unioning makes an aggregate match every size at once.
- `store-exclusive:<store>` — a store's own marker is in exactly ONE title AND that store carries
  one of the two listings. Matching is whitespace-delimited after punctuation normalisation
  (`coop` must not fire on "Cooper's"; `co-op` must match "Co-op Exclusive"), and the marker table
  deliberately omits `legacy`, `liberty`, `vessel`, `gull` — real product-name words.

Measured over the full window: 259 size + 4 store-exclusive conflicts, **2 of them above the
auto-link bar** (`Glenfarclas 12 Year Old` ↔ `Glenfarclas 12 yr Co-op Exclusive Cask` 0.9677;
`Decadent Drams Glenlitigious 12 Year KWM` ↔ the non-KWM listing 0.9695) — both genuine
auto-linker false positives of the class the owner called out. It is a **marker, never a verdict**:
it tells the agent not to accept an above-bar pair on `prob` alone, and below bar it is the
cheapest possible dismissal. Judgement-shaped rules stay in the policy file where the human owns
them.

### Aggregate names were taken from removed listings (fixed 2026-09-19)

`featurize.mjs` kept the FIRST non-empty name per aggregate in index order, ignoring `removed`, so
a delisted store's title could name the whole SKU. **713 of 14,088 aggregates (5.1%)** were named
by a removed listing while a live one existed — e.g. `876891` was "Springbank 10 Year & Glen Scotia
12 Year Combo" (delisted Sierra Springs) instead of ZYN's live "Springbank 10 Year Old - 700 ml",
so every name feature and every blocking channel for that SKU pointed at Glen Scotia. Now the first
LIVE row's name wins; `accumulateAggregateName` is exported and shared with `tools/linker_eval.mjs`,
which had duplicated the old rule.

Measured before shipping (labeled set, existing `gbt_model.json`, embeddings held constant):
deterministic AUC+ 0.9157 → 0.9140, recall@99% 24.1% → 24.3%; GBT AUC 0.99732 → 0.99717,
recall@99% 88.16% → 87.86%, precision at the 0.95 bar 0.9920 → 0.9921. A wash in-sample, as
expected — the model was TRAINED on the old names, and the labeled set structurally cannot contain
the pairs the bad names prevented from ever being found.

The blocking half was fixed alongside it: `audit_search_core.mjs` now indexes and queries **every
per-store name variant** (`namesOf()`, `altNames` populated by the generator for 5,569 aggregates)
across all five channels, so a poisoned aggregate name can no longer hide a pair from the pool.
Cost on a 598-listing window: median pool 233 → 336, runtime 9.8 s → 12.6 s.

End-to-end on the motivating pair, `876891 ↔ 711620`: **det 0.0586 → 8.4672, prob 0.0009 → 0.9888**
(above the 0.95 bar). Both fixes were required — the name fix alone left it at 0.0129 because
`711620` was one of the vectorless SKUs.

**NOTE — a real train/serve skew remains, and the old comment asserting otherwise was false.**
`featurize.mjs` picks the first live name; `viz/app/catalog.js::selectBestDisplayInfo` sorts by
store display tier → has photo → longest name. They have never agreed. Not fixed here (it needs a
retrain to evaluate), but do not re-add a comment claiming parity.

First full-run verify (2026-09-19, after the stopword fix below): 4,344 listings, 21,398
candidates, median pool 225, 64 s; funnels **54 want-links, 0 need-unlinks**, 900
near-miss, 791 orphans (pre-union baseline: 33 / 0 / 869 / 772). Above-bar pair set is
byte-identical before and after the stopword fix (41 pairs, 0 lost, 0 gained).
**Superseded by the fresh-embeddings run above** (21,497 candidates, median pool 361, 80 s,
117 / 2 / 448 / 707) — quote those numbers, not these.

**The pool is NOT the binding constraint — `recommendSimilar`'s post-pool cuts are.**
Measured: running the generator at `AUDIT_POOL_BUDGET=6000 AUDIT_POOL_PER_CHANNEL=3000`
(8.5x wider, zero truncation, median pool 378) produced **exactly the same 41 above-bar
pairs and the same 21,398 candidates** as the 700/150 default. Raising the pool budget buys
nothing, because `MAX_CHEAP_KEEP = 320` (det-ranked) then `MAX_FINE = 70` gate what reaches
the GBT blend. Those two are now overridable via `opts.maxCheapKeep`/`opts.maxFine` on
`recommendSimilar` (defaults unchanged at 320/70 — the SPA passes neither, so production is
untouched) and via `AUDIT_MAX_CHEAP_KEEP`/`AUDIT_MAX_FINE` on the generator. Generator also
prints a `pool truncation:` line and records `_meta.eval.pool.truncation` when a cap binds.

**Raising them is measured NOT to help: run the one-time audit at the defaults.** At
1500/400 with a 6000/3000 pool (182 s vs 64 s) the run gains exactly ONE above-bar pair and
it is a **false positive** — `Macaloney's An Aba Lightly Peated` ↔ `Macaloney W&B Single
Barrel`, two different expressions, prob 0.9944. The retrieval layer is saturated; the
remaining headroom was the no-embedding gap — which turned out to be a stale embeddings file, now
fixed (see §"The stale-embeddings incident"), not blocking or funnel width.

Search CLI: `tools/audit_search.mjs --sku/--query` (typo-robust; `fuzzy` recovers
`glenfarklas`; delisted items via git-history walk, cached in `audit/.cache/`).
Alias miner: `tools/mine_sku_aliases.mjs` → `viz/app/linker_page/sku_aliases.js`
(blocking-only, never a verdict — verified: nothing in the scorer imports it).
Judgement-rules file: `data/sku_link_policy.md` on the DATA branch (human-owned; agent
proposes amendments, never applies). Harness: `tools/audit_search_eval.mjs`.

**Token cost, measured not estimated (2026-09-19, full window):** near-miss funnel 900 rows =
777 KB `--compact` / **492 KB `--ultra-compact`** ⇒ ~164K tokens at the 3 B/token dense JSON
actually costs. Orphans 791 rows = 324 KB ultra; want-links 54 rows = 33 KB ultra. But funnel
bytes are not the run cost: **a real supervised agent run over a 3-week window (1,227 listings)
burned 250K tokens / 30 tool calls / 21 min** ≈ 200 tokens per listing, so the full
4,344-listing library is **~900K tokens per pass** and must be split into ~4-5 batches by
`--offset` or by date window.

**First supervised end-to-end trial (2026-09-19).** A fresh agent given only `docs/audit-runbook.md`
audited 2026-08-29..09-19 and produced 111 ops (108 link / 3 ignore / 0 unlink). **That 36:1 link:ignore ratio is now treated as a DEFECT of the run, not a neutral fact** — the runbook was telling the agent to no-op rejections rather than record them, throwing away the hard negatives the retrain needs. Fixed 2026-09-20: rejections are a primary deliverable and every run reports its ratio. Independently
verified: **0 ops contradicted an existing human hard negative, 0 were redundant** against the live
link set, and only 1 was a group merge (both sides >=3 members). One identifiable false positive
(`153264` <-> `102811` Traveller Whiskey, same store, 1.41x). It also surfaced a **live
auto-linker false positive**: Aberfeldy 12 `840932` <-> `id:8289118`, prob 0.9904 with
`embedCos 0.972`, where the Liberty side is 2.24x the group median - outside Liberty's entire
observed markup range (n=273: p50 1.22, p90 1.60, max 2.41).

**Round-3 hardening from that trial (2026-09-19).** Its false positives all traced to one missing
input - store identity and price context - so those are now ON the row: `pairs[].st/nst`
(candidate's stores), `pairs[].same` (the anchor's store carries it too), `pairs[].pr` + `prPct`
(price ratio placed in the DEARER store's own markup distribution, computed per run over every
multi-store canonical group into `_meta.eval.storePriceRatio`), and `rar` rarity tiers from
`viz/data/rarity.json`. Plus `--ultra-compact` + `--limit-pairs`, a proposal `review[]`
needs-human channel the applier validates and echoes but never acts on, `apply --verbose`, and a
`decisions.jsonl` coverage artifact. The Aberfeldy pair now reads
`prob 0.9904 flag:hit pr:2.24 prPct:">p99" rar:rare vs staple sizePen:0.3` - a self-evident reject
with no external lookup needed.

**`data/sku_link_policy.md` had never been committed** (untracked on the data branch since
2026-09-18) even though the tooling reads it every run - on any other clone it silently found
nothing. Rewritten 2026-09-19 with the owner's calls: size separate but 700=750 / 375=350 within
tolerance, unstated sizes inferred from the store's price ladder; ABV/proof separate when
materially different; limited/annual editions separate; **bundles are judgement, and a bundle
containing a rare (allocated) item links to that rare item's group with the price premium
accepted**, two-common bundles stay unlinked, same-product multipacks stay separate from the
single bottle; same-store-both-sides demoted from a rule to a guide (stores double-list, reprice,
and simply mislist).

- **Listing unit** = `(dbFile, normalizedSku)` (matches the per-SKU cache + classifier). Each has
  a stable `id` (`<dbFile>|<sku>`) for agent references/diffs. Default window = since the first
  `source:"auto-classify"` commit (2026-06-12T18:47:49Z).
- **Two funnel filters via `--only`:** `want-links` = never auto-linked yet a live candidate
  `prob >= bar` today ("link the missed ones"); `need-unlinks` = an auto-classify pair whose live
  re-scored prob fell below bar ("unlink the bad ones"); `near-misses` = pairs scored BELOW bar that
  still share real overlap evidence (see `suspicious`/`missHints`). Score-driven modes score the
  whole universe first (only structural modes score just the windowed page). `--offset/--limit` page
  the output; `--format jsonl` gives a `_meta` line (meta+summary+window) then one listing per line.
- **Stage 1.5 — views + deep-dives (`--from <rich>`), no re-scoring.** The rich file is JSON
  (`{…,listings:[…]}`) or jsonl (`_meta` line + one listing per line). `--from <rich>` re-filters
  funnels/pages instantly and `--compact` projects each listing to identity + `triage` + `why` +
  only the decision-relevant pairs (median ~528 B vs ~16.9 KB rich — a 50-row page ≈ 31 KB). The row
  carries `canon` (canonical group rep: two rows sharing it are ALREADY one entity, so proposing a
  link between them is redundant). View `_meta` is ~6.6 KB (clusters are deliberately stripped; they
  were 99.5% of a ~973 KB meta line) and includes a `legend` decoding `t/flag/hints/price/canon`.
  `--ultra-compact` drops `id/category/firstSeen/removed/auto/inIgnores/why` for another ~37%;
  `--limit-pairs N` caps pairs per row, ordered flagged-first — which BIASES the sample toward
  above-bar and suspicious pairs; never infer population statistics from a capped page, and never
  cap a trust-nothing slice audit. **No default cap since 2026-09-20**; `--ultra-compact` used to
  imply 6, which was the ranker silently choosing which pairs the agent got to judge. Measured
  cost of removing it: 8 of 3,196 pairs and 0.17% of bytes on the near-miss funnel.
  `--compact` in the GENERATOR is refused (exit 2) — it is a view concern. Deep-dive a single
  decision with `--from <rich> --id "<dbFile>|<sku>"` / `--sku <normSku>` / `--cluster <canonicalSku>`
  (full rich rows / cluster members + `missingFromWindow`), or `--pair "<skuA>|<skuB>"` for ONE pair's
  live score + 41-col features (either order); all require `--from`. `--cluster --compact` returns
  members as sku/name/store/price only (full rows are unusable single-line JSON); `_meta.window`
  carries `remaining`/`nextOffset` for mechanical paging. View `_meta.legend` documents
  `pairs[].t/flag/hints`, `price`, `canon`, and synthetic-sku prefixes. Unknown flags hard-error
  (exit 2) and `--help` prints usage — a stray flag used to be swallowed as a value and silently
  trigger a full regen+overwrite; always pass an explicit `--out`. NOTE: already-linked candidates
  never appear in the pool (`recommendSimilar` filters same-group), so `canon` only helps when two
  listings both appear as anchors.
- **Stage 3 — `tools/apply_audit_proposal.js` (write-only).** `--proposal <file>` validates + applies
  the agent's ops to `data/sku_links.json`; dry-run by default, `--apply` writes, NEVER commits. It
  shares `src/utils/sku_links_file.js` (read/write + union-find `dedupeLinks`) with `viz/serve.js`,
  so both write byte-identical single-line files. New links are `{fromSku,toSku,status:"pending",
  confidence?,source:"agent-audit",ts}`. Contradictory ops on a pair (link vs unlink/ignore, ignore
  vs remove-ignore) fail closed. A `link` already in one union-find component is `skipped` with a
  note distinguishing `already linked in source` from `redundant — an earlier op in this proposal
  already links them` (a proposal's own transitive chain is normal, not an error). NOTE: the
  committed file is appended by `auto_link_classify` WITHOUT dedupe, so it holds
  transitively-redundant links that a `writeLinks` prunes — the tool reports this separately as
  `redundantLinksInSource` (first apply shows ~-24 links that are not explicit unlinks).
- **`scores.candidates[]`** = the ranker's top pairs (retrieve-then-rerank), each with the
  decomposed 41-column `features` object (`logDet`, overlap, hard-rule vetoes, the 13 `grp*`
  group features, `embedCos`). **`aboveBar` true ⇒ auto-linking would fire today.**
- **`scores.verified[]`** = the listing's EXISTING explicit links (auto-classify pending/confirmed
  AND manual/merge) re-scored directly, immune to candidate-rank truncation — the "is this link
  still good" surface. `absentFromCatalog` marks partners that left the live catalog.
- **Pin gotcha (critical):** `storedConfidence >= 1e8` means a **deterministic floor-pin** (shared
  SMWS cask code; `suggestions.js` keeps raw scores ≥1e8 out of the blend re-rank), NOT a
  calibrated probability. A pinned pair can show live `prob` just under 0.95 with `embedCos:
  null` + `aiDelta: 0` (both sides lack embedding vectors → GBT conservative missing-branch) and
  must NOT be flagged for unlinking. Verified entries carry `pinned: true`; `need-unlinks`
  excludes pins. GBT recall@99% is ~14.5%→~69% from embeddings, so `prob` without vectors is
  deliberately under-confident.
- **Embeddings requirement:** accurate reproduction needs `viz/data/sku_embeddings.json` in the
  worktree (CI writes it each run from the Release asset; a stale local worktree lacks it → every
  candidate starves to a null `embedCos`). Fetch via `curl -sL -o .worktrees/data/viz/data/sku_embeddings.json
  https://github.com/brennanwilkes/spirit-tracker/releases/download/embeddings-latest/sku_embeddings.json`
  (~43 MB, untracked — matches what CI keeps). **`index.json` and `viz/data/skus/**` are Release
  assets too, and pulling `data` refreshes none of the three** — the v3 full-history generate ran on
  a 4-day-old catalog while the branch was current. Refresh all three before every generate (runbook
  §Setup). **Present is not the same as fresh: check the
  asset's `updatedAt` before trusting a run** (`gh release view embeddings-latest --json assets`).
  `embedCos` null is PER-CANDIDATE and shows as `hints:["no-embedding"]`; on a current file that
  should be ~zero, and any material rate means the file is stale — re-encode rather than judging
  those pairs. `_meta.eval.embeddings` only confirms the file LOADED, not that it is current.
- **CJS↔ESM bridge:** the audit script stays CJS and dynamically `import()`s the linker `.mjs`
  modules. `featurize.mjs` resolves `WORKTREE` from `process.env.DATA_WORKTREE` at module load —
  must be set to the resolved `--root` BEFORE importing.
- Measured: full default window (4,287 listings) = ~34 s, 4,259 scored, 19,798 candidates, 4,350
  verified pairs, 869 near-miss listings, 335 title-twins scanned. Baseline: 186 auto-linked (4.3%),
  3,515 with links (82%), 772 orphans, 0 need-unlinks (all below-bar auto-links are SMWS pins), 33
  want-links (verified same products, e.g. everythingwine Glenfarclas Family Cask 2000, Casey Jones
  Wheated Bourbon, Bumbu Craft Rum ↔ Bumbu Original at 0.97 prob vs 0.0012 without embeddings).
  `--from` view load on the full 86 MB jsonl is ~0.5 s. Emit `--only want-links --format jsonl` for
  the daily link-miss feed; `--only near-misses --compact` for the highest-value audit surface.

## Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `run_daily.sh` | Full orchestration: scrape → build viz → commit → push |
| `audit_new_listings.js` | **Agent-facing audit generator + view/deep-dive tool** — every listing first seen in a range, with live sameness scores per candidate AND per existing link, canonical clusters, and decision funnels. Stage 1 emits the rich file; `--from <rich>` derives token-cheap views (`--compact`) and deep-dives (`--id/--sku/--cluster/--pair`) with no re-scoring. Runbook: `docs/audit-runbook.md`. See §"New-listings audit" below |
| `cron_setup.sh` | Install local cron jobs (idempotent) |
| `bootstrap_clone.sh` | Initial clone setup |
| `repo_setup.sh` | Configure repo settings |
| `repo_reset.sh` | Reset utility |

## Tools (`tools/`)

Post-processing scripts run by `run_daily.sh` after the tracker. They operate on the data worktree (not the main checkout):

| Tool | Purpose |
|------|---------|
| `build_viz_index.js` | Generate `viz/data/index.json` |
| `build_viz_commits.js` | Build commit history manifest |
| `build_viz_recent.js` | Build `viz/data/recent.json` |
| `build_viz_sku_cache.js` | Generate `viz/data/skus/{sku}.json` per-SKU price event files. Incremental by default; `--full-reindex` walks full git history. Run from `.worktrees/data/`. Output ships as the `skus-latest` Release tarball, not committed |
| `build_common_listings.js` | Top-N product lists by region (all/bc/ab) and size (50/250/1000) |
| `build_email_event_pack.js` | Package email event bundles |
| `apply_audit_proposal.js` | **Hand-run, write-only** — apply an audit agent's proposal (link/unlink/ignore ops) to `data/sku_links.json`. Dry-run by default, `--apply` writes, NEVER commits. Shares `src/utils/sku_links_file.js` (dedupe + single-line serialization) with `viz/serve.js`. See §"New-listings audit" |
| `auto_link_classify.mjs` | Auto-link SKUs with the live GBT blend; append `status:"pending"` links to `data/sku_links.json` (≥99%-precision bar). `--since N` bounds anchors by recency, `--top K`, `--dry-run`. See §"Auto-Link Classification + Review" |
| `diff_report.js` | Compare two report files |
| `discover_bad_skus.js` | Find synthetic (`u:`) SKUs that need repair |
| `rank_discrepency.js` | Analyze ranking discrepancies |
| `dedupe_skulinks.js` | Deduplicate SKU link entries |
| `stviz_apply_issue_edits.js` | Apply issue-based SKU edits (used by GH Actions) |
| `backfill_db_created_at.js` | One-time: stamp `createdAt` on every `data/db/*.json` from its first git commit. Run from `.worktrees/data/`. Idempotent. |
| `build_viz_stats_series.js` | Change-point bundles for `#/stats` → `viz/data/stats/*.json`. Needs the commits manifest, so run AFTER `build_viz_commits.js`, from `.worktrees/data/`. Incremental; `--force` rebuilds. NOT committed — uploaded as a Release asset. See §"#/stats series bundles" |

## Linker Evaluation & Training Harness (`tools/linker_eval/`)

Dev/analysis tooling for the SKU-matching algorithm. **NOT** run by `run_daily.sh` —
these are run by hand against the `.worktrees/data` worktree.

**Start here:** `tools/linker_eval/CLAUDE.md` is the iteration guide for future
sessions — the metrics that matter (AUC+, auto-link thresholds), the measure-risk-
before-adding-a-rule loop, the hard-won lessons (which discriminators are safe vs
which break confirmed links), and how to edit the links file safely.

- `tools/linker_eval/TECHNICAL_REPORT.md` — **canonical spec** of the scoring
  algorithm: full pipeline, formulas, every tuned constant, and the named benchmark
  cases. Update it whenever the scorer changes.
- `tools/linker_eval/CLASSIFIER_PLAN.md` — roadmap for the **future learned
  classifier** (calibrated yes/no model run in CI): log-linear blend of the existing
  factors, group-profile features with leave-one-out, hard-negative mining, and an
  optional fine-tuned MiniLM embedding for semantic matches (e.g. `PM` ↔ `Port
  Mourant`) the token-based scorer structurally cannot make. Precision-first; a human
  review queue (via the `stviz/issue-*` flow) handles everything below the auto-link
  threshold.
- `tools/linker_eval.mjs` — eval harness, scored ENTIRELY against the big labeled set
  (`sku_links.json` links = positives, ignores = curated hard negatives; no more
  `fixtures.json`). Headline metrics: **AUC+** (AUC vs auto-mined hard negatives — the
  one that matters; a trivial shared-word baseline is printed as the floor) and the
  **auto-link threshold table** (what cutoff hits 90/95/98/99% precision and the recall
  there). **Output convention (keep it):** every run prints aligned monospace tables —
  a headline-metrics table (AUC+, AUC vs ignores, trivial floor, pair counts), the
  threshold table, a precision/recall grid, and **worst false-positive / false-negative
  charts with a consistent column set** (`# · algo score · expected (LINK/IGNORE) · SKU A ·
  Name A · SKU B · Name B`) so they're scannable, not prose. Re-run on every scorer change.
  Imports the live scorer (`viz/app/linker_page/suggestions.js`) so eval and ranker never
  drift. NOTE: labels lag reality (hundreds of links/ignores still unadded) — treat the
  current links/ignores as ground truth and assume they keep improving; don't tune to the
  unlabeled middle.
- `tools/linker_outliers.mjs` — label QA + disagreement analytics. Emits
  `outliers.json` (missed links, suspect ignores/links, intra-group conflicts) and
  `algo_failures.md` (a readable, factor-decomposed report of where the algorithm
  disagrees with human labels — built for downstream analysis). Runs in ~5 s.

The single most important supervision signal is `data/sku_links.json` (manual links +
`ignores`); see "SKU Identity & Canonical Mapping" above. Implicit links (same raw SKU
at ≥2 stores) are captured for free by aggregating per raw SKU.

### How to REPORT benchmark results to the user (required format)

When presenting eval/benchmark output, do NOT paste the raw harness text. **Re-render it
yourself as clean Markdown tables** (the kind that draw nicely in the terminal), with
column headers, and **show every requested row** (e.g. all 15 worst offenders — never
truncate to a few). Prose analysis is welcome *before and after*, but the tables are
mandatory. Three tables, in this order:

1. **Headline metrics** — columns `Metric | Value | Floor / note`. Always include AUC+
   (vs hard negatives) with its trivial shared-word floor, AUC vs ignores, and the
   auto-link thresholds for 95% and 99% precision (with recall). These are the numbers
   that matter; the small-fixtures era is over.
2. **15 worst false positives** (ignored pairs scored high) — columns
   `# | Algo | Expected | SKU A | Name A | SKU B | Name B | Why`. Expected = `IGNORE`.
3. **15 worst false negatives** (linked pairs scored low) — same columns, Expected = `LINK`.

Always include the raw SKUs (so they're searchable) and a short "Why" cell per row
(size variant / one-sided age / SMWS-code-lost / possessive-brand / probable-mislabel …).
Flag suspected mislabels explicitly so they can be relabeled rather than chased.

## Learned Classifier + Attention Embedder (`tools/linker_ml/`)

The deterministic scorer is bag-of-tokens and structurally cannot match names that share no
tokens (`TBWC` ↔ `That Boutique-y Whisky Company`, `Compass Box Artist` ↔ `Great King Street
Artist's Blend`). `tools/linker_ml/` **augments** it (does not replace it) with a learned
classifier over the existing factors **+ 13 canonical-GROUP↔GROUP features + a MiniLM attention
embedding** (fine-tuned on `data/sku_links.json`, its text enriched with group-resolved
size/abv/year/category). The full deterministic score is one feature, so the current algo's
strengths are preserved. **The shipping classifier is a gradient-boosted tree** (`export_gbt.py`
→ `gbt_model.json`, run live via `viz/app/linker_page/gbt.js`); a logistic blend
(`blend_weights.js`) is the graceful fallback. The GBT fixed the linear blend's tail pathologies
(over-scored zero-token-overlap pairs; under-scored matches with a missing embedding vector).
Measured held-out auto-link **recall @99% precision: 14.5% → ~69% → 95.2%** (2026-09-24 retrain on the audited labels + ABV-parser, slug, hygiene and `prefixTok` fixes; see `tools/linker_ml/CLAUDE.md`).

**Start here:** `tools/linker_ml/CLAUDE.md` — the iteration + **re-train** guide (the retrain
chain to re-run when the labeled set grows, the venv prereqs, the no-leakage group split, the
hard-won notes, and **§"Shipping the checkpoint"** — the must-do re-release after every retrain so
CI's per-build re-encode uses the new weights). `tools/linker_ml/README.md` is the pipeline diagram.

**Per-build re-encode (SHIPPED):** `run_daily.sh` re-encodes `sku_embeddings.json` every scrape with
the FIXED fine-tuned checkpoint (`encode.py`), so new SKUs get vectors without retraining. The
checkpoint ships as a **GitHub Release asset** (`model-ft-<MODEL_VERSION>`), restored in CI via
`actions/cache` — NOT git/LFS (the cron never smudges data-branch LFS; details in that CLAUDE.md).

- Pure-Node, zero-dep substrate (`featurize.mjs`, `build_dataset.mjs`, `dump_features.mjs`,
  `train_blend.mjs`, `eval_gap.mjs`) — runs immediately, reuses the live scorer's helpers.
- Python venv (`train_embed.py`, CPU torch + sentence-transformers, manual MNRL loop — no
  `datasets` dep) fine-tunes the encoder. The venv (`.venv/`), HF cache (`.hf_cache/`), and
  all artifacts (`out/`, incl. `blend_weights.json` + `embeddings.json`) are gitignored.
- Headline metric: **recall at ≥99% precision** (a wrong auto-link corrupts a canonical
  group), then AUC+. Train/val is split by canonical group so the embedding lift isn't leaked.
