# Spirit Tracker

Automated price tracker for Canadian spirits (whisky, rum) across 16 liquor retailers. Scrapes stores on a schedule, stores price history as JSON, and serves a browser-based visualization dashboard.

## Git Workflow (Critical)

Two-branch model:
- `main` — all source code lives here. Make code changes here.
- `data` — all scraped JSON databases, reports, and viz artifacts live here. Never commit code changes to this branch.

`.worktrees/data/` is a git worktree pointing at the `data` branch. It is managed entirely by `scripts/run_daily.sh`. Do not manually commit into it.

Remote branches `stviz/issue-*` are auto-created by GitHub Actions for issue-based edits to SKU link data.

## SKU Identity & Canonical Mapping

Two link sources feed one canonical map (union-find):

- `data/sku_links.json` — **manually curated** via the `#/link` page; cross-store equivalences a human confirmed
- `data/sku_links_auto.json` — **auto-generated** by `src/tracker/merge.js` when `pickBetterSku()` upgrades a record's SKU in place (e.g., `u:URL-hash` → real numeric SKU after a hydration pass). Backfilled once from git history via `tools/backfill_sku_transitions.js`.

Consumers union both files via:
- Node: `src/utils/sku_map.js::loadSkuMap()`
- Viz: `viz/app/api.js::loadSkuMetaBestEffort()` → `viz/app/mapping.js::loadSkuRules()`

Tools that build local DSUs (`tools/rarity_report.js`, `tools/build_email_event_pack.js`) go through `src/utils/sku_canonical.js` (CJS) / `viz/app/sku_canonical.js` (ESM) — parallel files that must stay in sync.

The orphan-DB-file auto-flip in `src/tracker/orphan_dbs.js` handles the case where a store's category URL changes and the old DB file becomes stranded — runs at the end of every `node bin/tracker.js` invocation.

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

GitHub Actions (`.github/workflows/cron_tracker.yaml`) runs on two schedules:
- **Big** (all 16 stores): 6:45 and 18:45 UTC daily
- **Small** (sierra_springs + craft_cellars only): 0:45, 3:45, 9:45, 12:45, 15:45, 21:45 UTC

Each run executes `scripts/run_daily.sh`, which:
1. Sets up / repairs the `.worktrees/data/` worktree
2. Pulls latest `data` branch and merges `main` into it
3. Runs the tracker (writes `data/db/` JSON + a `reports/*.txt` file)
4. Builds viz artifacts via `tools/build_*.js` scripts
5. Commits + pushes all changes to the `data` branch
6. Triggers the Pages deploy and email pack workflows

## Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `run_daily.sh` | Full orchestration: scrape → build viz → commit → push |
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
| `build_viz_sku_cache.js` | Generate `viz/data/skus/{sku}.json` per-SKU price event files (LFS). Incremental by default; `--full-reindex` walks full git history. Run from `.worktrees/data/` |
| `build_common_listings.js` | Top-N product lists by region (all/bc/ab) and size (50/250/1000) |
| `build_email_event_pack.js` | Package email event bundles |
| `diff_report.js` | Compare two report files |
| `discover_bad_skus.js` | Find synthetic (`u:`) SKUs that need repair |
| `rank_discrepency.js` | Analyze ranking discrepancies |
| `dedupe_skulinks.js` | Deduplicate SKU link entries |
| `stviz_apply_issue_edits.js` | Apply issue-based SKU edits (used by GH Actions) |
| `backfill_db_created_at.js` | One-time: stamp `createdAt` on every `data/db/*.json` from its first git commit. Run from `.worktrees/data/`. Idempotent. |
