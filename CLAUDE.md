# Spirit Tracker

Automated price tracker for Canadian spirits (whisky, rum, gin) across 36 liquor retailers. Scrapes stores on a schedule, stores price history as JSON, and serves a browser-based visualization dashboard.

Long-form history, measurements and incident write-ups live in `docs/`; each section below points to its doc. Read the pointed doc before working in that area.

## Git Workflow (Critical)

Two-branch model:
- `main` — all source code lives here. Make code changes here.
- `data` — all scraped JSON databases, reports, and viz artifacts live here. Never commit code changes to this branch.

`.worktrees/data/` is a git worktree pointing at the `data` branch. It is managed entirely by `scripts/run_daily.sh`. Do not manually commit into it.

Remote branches `stviz/issue-*` are leftovers of the retired GitHub-issue link-edit flow (workflow and tool removed 2026-10-12); safe to delete (0.3 MiB unique, cosmetic).

## Data branch, Release assets, repo size

Full history (LFS removal, growth measurements, forecasts, limits, rollout check-lists): `docs/data-branch-growth-mitigation.md` (archive section at the end).

- **No Git LFS** (removed 2026-06-11: LFS *bandwidth* blew the free budget). All workflow checkouts are `lfs: false`; `run_daily.sh` exports `GIT_LFS_SKIP_SMUDGE=1`. Locally `.git/lfs` holds ~2.5 GB orphaned objects (`git lfs prune` reclaims).
- **The `data` branch is NOT squashable.** `data/db/*.json` holds only CURRENT state (`name`, `price`, `sku`, `url`, `img`, `removed`); the price history IS the git commit history of `data/db/**` (what `build_viz_sku_cache.js --full-reindex` walks). `reports/common_listings_*` history is also read at historical shas (stats-bundle rebuild input / `#/stats` fallback).
- **HEAD-only derived artifacts ship as GitHub Release assets on fixed tags, overwritten each scrape (`gh release upload --clobber`), NOT committed:** `sku_embeddings.json` (`embeddings-latest`), `index.json` (`index-latest`), `recent.json` (`recent-latest`), `viz/data/skus/**` as `skus.tar.gz` (`skus-latest`), `#/stats` bundles (`stats-series-latest`). `run_daily.sh` keeps worktree copies but excludes them from the commit (`git rm --cached` + `:(exclude)` pathspecs, which are load-bearing because the data branch's own `.gitignore` does not ignore `viz/data/`). `pages.yaml` stages them into the Pages artifact at deploy. skus tarball is restored before every build (and by the email pack).
- **Uploads MUST happen before the push in the same run**, or the deploy and email pack use stale assets. A `WARN: … Release upload failed` in run output means the next deploy is broken/stale.
- `reports/common_listings_*.json` are committed only on big runs. Rollout verification steps: `docs/recent-skus-release-and-common-listings-gating.md`.
- Size (2026-10-10): 682 MiB GitHub-reported, growing ~37 MiB/mo (≈ July 2027 to the 1 GB *recommendation*; ~Feb–Apr 2027 if the store count doubles). There is NO automated email at 1 GB and NO push block at 5 GB; hard limits are 100 MiB/file and 2 GB/push. Real cost of size is CI clone time (`fetch-depth: 0`). Reserve lever: one-time `git filter-repo` dropping derived-artifact history (~500 MiB back; must preserve `data/db/**`). Re-measure with `gh api repos/brennanwilkes/spirit-tracker --jq '.size/1024'`.
- Free-tier limits depend on the repo staying **public** (Actions minutes would exhaust a private bucket in ~10 days).

## SKU Identity & Canonical Mapping

Two link sources feed one canonical map (union-find):

- `data/sku_links.json` — written by the CI auto-linker and hand-run agent audits (the human `#/link*` pages were removed 2026-10-12); cross-store equivalences + `ignores[]` (hard negatives)
- `data/sku_links_auto.json` — **auto-generated** by `src/tracker/merge.js` when `pickBetterSku()` upgrades a record's SKU in place (e.g., `u:URL-hash` → real numeric SKU after a hydration pass). Backfilled once from git history via `tools/backfill_sku_transitions.js`.

Consumers union both files via:
- Node: `src/utils/sku_map.js::loadSkuMap()`
- Viz: `viz/app/api.js::loadSkuMetaBestEffort()` → `viz/app/mapping.js::loadSkuRules()`

Tools that build local DSUs (`tools/rarity_report.js`, `tools/build_email_event_pack.js`) go through `src/utils/sku_canonical.js` (CJS) / `viz/app/sku_canonical.js` (ESM) — parallel files that must stay in sync. Every canonical loader folds `id:N` ≡ `N`.

The orphan-DB-file auto-flip in `src/tracker/orphan_dbs.js` handles the case where a store's category URL changes and the old DB file becomes stranded — runs at the end of every `node bin/tracker.js` invocation. It and `category_scan.js` must both derive filenames via `db.js::dbFileForCategory()` (drift once flipped whole categories to removed; see `docs/history-flip-flop-root-causes.md`).

**Readers of `sku_links.json` must not swallow errors.** `build_email_event_pack.js` once read it via `git show` with the default 1 MiB `maxBuffer`, swallowed ENOBUFS, and lost every link for 5 days (2026-10-04→09). Now 512 MiB buffer; only "path absent at that commit" returns null; a missing links file throws (`diff_report.js` too).

### SKU collision splits (`data/sku_collisions.json`)

Two different products can share one SKU when store numbering overlaps (BC vs AB, Sierra Springs / Wine and Beyond `id:104xxxx`, or a store re-using a sku). Listings aggregate by sku, so they merge with no link to remove; the fix re-keys one side to a synthetic `c:<normSku>:<tag>` key. Detail: `docs/linker-audit-findings.md` §"SKU collision splits" (the referenced `docs/sku-collision-split-plan.md` does not exist in the repo).

- Entry: `sku`, `products`, `keep`, `split[]` = `{key, listings: [{storeId[, url]}]}`; `storeId` is the db-file prefix; `url` only when one store carries both products. List only collisions whose products belong in DIFFERENT groups (`876891` Springbank bundle vs Springbank 10 is benign: do not list).
- **Resolved where a `data/db` row is read, never written into `data/db`**: `src/utils/sku_collisions.js` `loadCollisionSplits().resolve(storeId, sku, url)`, called by every build tool, the tracker's auto-link writer and cheapest index, and the audit tools. The SPA never loads the file; only `displaySku` strips `c:…`.
- **A missing or malformed file throws**, including at tracker startup (`src/main.js`), so run `bin/tracker.js` from `.worktrees/data` (or with a `DATA_DIR` that has it).
- Hidden entries match the RESOLVED key (hide a split listing as `c:…`).
- Edit = JSON edit + `node tools/validate_sku_collisions.js` in the data worktree (0 ERROR). The SKU cache self-rebuilds affected history via `viz/data/skus/_collisions.stamp`. The scraper re-points `sku_links_auto.json` onto new splits but never back: removing a split or renaming a tag needs a hand edit of the auto links.
- `c:` keys are ordinary skus (linkable, trainable, embeddable). Ignores aimed at a split-off product no longer apply; re-add them on the `c:` key.
- `tools/detect_sku_collisions.mjs` regenerates the candidate census from `index.json` (candidates, not verdicts; ~10% real).
- Distinct from the same-STORE collision class in `merge.js` (fixed: a skuKey rematch is a url migration only when the old url is NOT also in `discovered` this run).

## Auto-Link Classification (CI)

`tools/auto_link_classify.mjs` (Node ESM) runs every scrape in `run_daily.sh` — AFTER the per-build embeddings are written, BEFORE rarity and the email pack. It reuses the LIVE ranker end-to-end (`tools/linker_ml/featurize.mjs::buildEnv` + `recommendSimilar` + the GBT blend — never forks scoring) and appends pairs ≥ `autoLinkConfidenceBar` (0.95, the 99%-precision bar) to `data/sku_links.json` as `{ fromSku, toSku, confidence, source: "auto-classify", ts }`. Full detail + measurements: `docs/linker-audit-findings.md`.

- **An auto-link is a REAL link everywhere, immediately** (all consumers read only `fromSku`/`toSku`; it groups in the catalog and fires email alerts at once). Old entries may carry `status:"pending"`; nothing reads it.
- **CI is NOT a complete linker.** Recall at the bar is ~45% for a new listing joining a group, and it anchors only SKUs first-seen in the last 25 days (`--since 25`). Older and below-bar pairs are left to the **whole-catalog undecided-pair pass**, whose candidates are the UNION of every generator at its own bar: the retired page replayed by `tools/audit_page_oracle.mjs` (modes classical / prod / linear / ai, plus `--all-anchors`; owner bar 0.2 for classical and prod), classical over store-name variants (`audit_classical_pairs.mjs`), GBT top-20 (the `audit_new_listings.js` rich file) and embedding neighbours (`--emb-neighbours`). Every scoring model is its own generator: models that disagree surface pairs the others bury. Done = `tools/audit_coverage_check.js` MISSING 0 per generator; its `--union-out` feeds `audit_undecided_pairs.js --union --compact`. Runbook: `docs/audit-runbook.md` first section. Running handoff: `audit/oracle-2026-10-14/HANDOFF.md` (local; ~31k pairs undecided at the 0.2 bar on 2026-10-16).
- Candidate blocking: only candidates sharing a distinctive token / SMWS cask code are scored (precision-preserving; `vocab`/`groupIndex`/`sameGroup` stay full-catalog so scores equal the live ranker). Only the ANCHOR set is recency-bound; the full catalog is the candidate pool. Dedup against links/ignores makes re-runs a no-op; flushes every 400 anchors. `--max-anchors N`, `--dry-run`, `--top K`. Backlog sweep over all SKUs: by hand with no `--since`.
- **A backlog sweep is not a cron run and must not be applied blind** — triage it as an `agent-audit` proposal (the 2026-09-20 40-day sweep had 16 of 66 false positives).
- **`recommendSimilar` can return popularity filler** (≈4.2, clears any bar) when nothing survives its fine stage; those rows carry `fallback: true` and every caller that thresholds `score` must skip them.
- `run_daily.sh` stages `data/sku_links.json` so appends commit.
- Precision first: improve features/labels before ever lowering the bar.

## Hidden Listings

`data/sku_hidden.json` curates per-`(storeId, rawSku)` listings that should never appear in the UI or fire email events. Hides apply to that store's record only. Details and sweep history: `docs/hidden-listings.md`.

- Parallel loaders `src/utils/sku_hidden.js` (CJS) / `viz/app/hidden.js` (ESM) — keep in sync (`loadHiddenSet()`, `isHiddenListing(set, storeId, sku)`).
- Edits via local dev only: `POST /__stviz/sku-hidden` `{ storeId, sku, reason? }` in `viz/serve.js`; ✕ button on item-page store rows, gated by `isLocalWriteMode()`.
- Enforced in `viz/app/catalog.js` + each index-loading page (`search_page.js`, `store_page.js`, `shortlist_page.js`, `item_page.js`), `tools/build_viz_recent.js`, `tools/build_common_listings.js`, and `build_email_event_pack.js::ingestDbObject`.
- `tools/build_viz_sku_cache.js` and the scraper are intentionally NOT filtered (data preservation). Hidden SKUs are excluded from linker ML training/eval.
- `pages.yaml` stages `data/sku_hidden.json → viz/data/`.
- Policy: off-category listings (tequila, wine, cognac, liqueur, RTDs, non-alcoholic, non-products) and **multi-dram sets** (advent calendars, tasting/sampler sets, Drinks by the Dram, SMWS outturn kits) are hidden at EVERY store carrying the sku — but check each store's row by name, the same sku can be a different product elsewhere. Brand gift packs of minis and packs of real bottles (incl. mixed-expression packs: Appleton 3×200, JW Family Collection 4×200) stay tracked. Flavoured whiskies (Fireball, Crown Royal Peach, Skrewball…) stay visible (owner 2026-10-16: no strong policy wanted). Manual; no name-pattern rule. Count 871 (2026-10-16).

## Rarity Scoring

`src/utils/rarity.js` (CJS) and `viz/app/rarity.js` (ESM) define `scoreSku()` (five smooth signals → 0..1). `tools/build_viz_rarity.js` runs once per `run_daily.sh` (AFTER `auto_link_classify.mjs`) and writes `viz/data/rarity.json` keyed by canonical SKU; consumers canonicalize first. Details, the 2026-10-12 review, and rejected ideas: `docs/rarity-scoring.md`.

- Per-DB-file epoch: each `data/db/*.json` has `createdAt` (loaded via `src/utils/db_epochs.js`); effective epoch = `min(entry.epochMs)` across stores. `TRACKER_EPOCH_MS` is only a fallback.
- `dropOneShotBatches` drops <30 h one-shot blips when ≥7 share a first-seen run timestamp (artifact runs).
- Rarity = obtainability: no price term, no "gone too long" decay (owner rulings).
- ESM `scoreSku` is unused by the viz but must stay output-equal to the CJS one; re-check parity after any scorer edit.
- Tiers: dynamic 10th/90th percentiles per build — `staple` / `common` / `rare`.
- Colors: `viz/style.css` custom properties (`--rarity-staple-*`, `--rarity-rare-*`); mirrored as parallel CSS in the email repo `~/spirit-tracker-api`. Packs carry only the raw `rarity` number; the renderer thresholds and styles. **Email gotcha:** Gmail dark mode inverts solid colours but not gradients, so no opaque colour may sit in a card gradient; the rare star fade is baked into `viz/email-assets/rare-stars-fade.svg`, so the Pages deploy must ship it before the email worker.

## Flip-Flop (Transient Change) Handling

**Canonical definition: a self-reverting change within a 48h window is a flip-flop.** Keep the window in sync across: `tools/build_viz_recent.js` (feed coalescing; a deeper drop still fires), `tools/build_email_event_pack.js::isFlipFlop`, and `src/utils/rarity.js::coalescePeriods` (≤24h OOS gap, deliberately narrower). `viz/app/flip_flop.js` (item chart) is a different, stricter rule: it flags only a *repeating* two-state oscillation (≥4 spells, interior legs ≤ `FLAP_WINDOW_MS` = 3 days) and renders it dashed, never suppresses; its window need not match. Full spec: `docs/history-flip-flop-root-causes.md`.

Before "fixing" apparent flip-flops, read that doc: three scraper root causes were fixed 2026-09-04 (orphan-DB filename drift, same-store SKU-collision annihilation in `merge.js`, ARC/Barnet page-boundary skip), with a reusable diagnostic method. Live gotchas from it:
- ARC uses `sortBy: "name_asc"` plus a re-sweep with a DIFFERENT sort when `rawIds.size < items_count`. **Deliberately no "preserve unseen listings" fallback** (would pin real sellouts live). Other Barnet stores (`highpointbws`, `newdistrict`, `vintage`) still default to `price_desc` and likely carry the same latent straddle.
- Tudor's `?variant=` flow mutates `it.url` in place; the `merge.js` `!discovered.has(hit.url)` guard relies on that.
- NOT bugs: Liberty's mass drops (hides OOS products), Liquorama's toggles, Malts & Grains onboarding.

## `#/stats` series bundles

`tools/build_viz_stats_series.js` collapses each `reports/common_listings_<group>_top<size>.json` history into one change-point bundle (`viz/data/stats/`, only the 9 `<all|bc|ab>_top<50|250|1000>` combos); `viz/app/stats_page.js::expandStatsBundle()` rebuilds the per-day report shape. Ships as Release asset `stats-series-latest` (page tries `./data/stats/<name>` first). Old per-commit walk `loadRawSeriesFromCommits` is the fallback. Run AFTER `build_viz_commits.js`. Absence must stay explicit (`null`), never forward-filled. Incremental resume keys off the longest common sha prefix. Detail + measurements: `docs/stats-series-bundles.md`.

## Datacenter-IP Blocking / VPN egress

Cloudflare challenges the runner's Azure IP at several stores (elbowliquor, colordevino, sherbrooke, gull, highlander, intermittently others). **Check this before "fixing" an adapter**: these scrape cleanly from a residential IP. A store whose categories ALL fail never enters `ranStoreKeys`, so its data goes stale, not corrupted. Everything Wine is challenged even residentially. Detail: `docs/vpn-setup.md` (archive section).

- Routing: smalls dispatched with `vpn=true`, bigs `vpn=false`; the retry uses the OPPOSITE egress. Tunnel: `scripts/vpn_up.sh` (secret `PROTONVPN_WG_CONF`), best-effort, falls back to direct with a `::warning::` and a `vpn:` commit-body line. (The 2026-07 "Azure filters WireGuard" conclusion was wrong.)
- BCL bad responses (403 / HTTP 200 `Total=0`) are caught by the central zero-scan guard `merge.js::guardLargeCategoryOnly` → `FAILED` category → retry. A store renaming urls must be followed by sku in both `merge.js` and `build_viz_index.js` (first-seen keyed by sku). (`docs/incident-2026-10-06-bcl-wnb-wipe.md` is referenced historically but does not exist in the repo.)

## New-store discovery + onboarding

**Onboarding (in progress): `STORE_ONBOARDING_PLAN.md`** (repo root) is the staged todo list (~62 new store keys in 7 platform waves, pre-onboarding link audit, small-scrape trials); resume from its "Current position" line. Store verdicts: `audit/store_hunt/round5-candidate-eval.md` (2026-10-16; supersedes round 4 for verdicts). Count = in-stock whisky+rum+gin DISTINCT products (sizes count once; minis/packs/liqueurs/RTDs/fees don't). Owner rulings: soft ~50 bar, interest over count (rare / indie / cask strength / Benromach-type staples; mainstream-only stores dropped); drop only truly stale catalogs (a week without movement is fine); a chain = ONE store unless its locations price differently.

Research closed 2026-10-10. Decision document: **`STORE_HUNT_HANDOFF.md`** (repo root); working data `audit/store_hunt/` (gitignored, `round4-strict-counts.md` authoritative for counts). Durable discovery facts (Barnet shop enumeration, gulp.tech, Liquor Connect, DataDome/PerimeterX walls): `docs/store-discovery-notes.md`. How to write an adapter: `docs/writing-store-scrapers.md`.

## Search matching + brand aliases

Search (`viz/app/sku.js` `normSearchText`/`tokenizeQuery`/`matchesAllTokens`) matches every token as a SUBSTRING of a group's `searchText` (sku, name, url, store label). A one-character token must be a whole word. Brand aliases (`viz/app/search_aliases.js`, G&M only so far) detect on RAW text; after any edit run `node tools/check_search_aliases.mjs`. A distillery alias table must never feed linking. Owner principle: prefer a broader match. `stats_page.js` has its own tokenizer. Detail + next bottlers: `docs/gm-search-aliasing.md`.

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

Exit code `3` = no meaningful changes (normal, not an error). It needs `data/sku_collisions.json`
next to `data/db/` and throws without it, so run it from `.worktrees/data`.

## CI / Automation

Detail (schedule measurements, retry mechanics, commit-message format): `docs/ci-and-run-observability.md`.

- `.github/workflows/cron_tracker.yaml` is **dispatch-only**. Its clock is a Cloudflare Worker cron in `~/spirit-tracker-api` (`src/tracker_schedule.ts`, `crons = ["25,48 * * * *"]`) matching Pacific wall time, POSTing `workflow_dispatch` with secret `GH_DISPATCH_TOKEN`. Do not move it back to GitHub `schedule:` (2-5 h late, 31% never fired).
- **Big** (all stores, direct) 23:25 / 11:25 PT; **Small** (sierra_springs, craft_cellars, colordevino, liquorama, zyn, highlander; VPN) :48 before 03/06/09/15/18/21 PT.
- **One-shot failed-store retry:** non-empty `[[FAILED-STORES]]` → workflow re-dispatches itself for those stores with `is_retry=true` and the opposite `vpn`; no recursion; `concurrency: tracker-cron` queues it.
- `scripts/run_daily.sh` order: set up/repair worktree → pull `data` + merge `main` → tracker → `tools/build_*.js` → re-encode embeddings with the FIXED checkpoint (no retrain; `tools/linker_ml/CLAUDE.md` §"Shipping the checkpoint") → `auto_link_classify.mjs --since 25` → rarity → Release uploads → commit + push `data` → trigger Pages deploy + email pack.
- **Embedding freshness is asserted, not assumed:** every SKU in the run's `sku_texts.jsonl` must have a vector in the shipped file; skips print `WARN`. The venv cache is salted with `python -VV` and validated. A month-long silent freeze happened once: `docs/history-stale-embeddings-incident.md`.
- Commit messages encode run health: first line `run: <ts>` plus ` | FAILED(n): Store | Label; …` (from the tracker's `[[FAILED-CATEGORIES]]` sentinel); body has a `runner: ip=… run_id=…` line. A run where everything fails writes no commit.

## Link audits (`scripts/audit_new_listings.js` and friends)

Hand-run tooling, deliberately NOT in `run_daily.sh`/CI; nothing here writes links automatically except an explicit `--apply`. Link QA is two pillars: (A) CI auto-classify (free, every scrape) and (B) periodic AI-agent audits (expensive) whose job is to correct AND improve A. Audits are label-production runs over the WHOLE catalog: `ignore` ops (hard negatives) are worth as much as `link` ops, and coverage beats speed. **Do not paper over CI's weaknesses inside the audit** with mechanical screens (an independent-bottler screen was rejected); mechanical vetoes, if ever wanted, belong in `auto_link_classify.mjs`.

**Read before any audit:** `docs/audit-runbook.md` (operating manual: pipeline, CLI, decision protocol, proposal schema, coverage contract), `docs/audit-full-library-plan.md` (state + measured agent cost), `docs/audit-campaign.md` (rolling campaign), `data/sku_link_policy.md` on the DATA branch (human-owned judgement rules; agents propose amendments, never apply), `docs/audit-search-and-scale-plan.md`, `docs/audit-search-review.md`. All findings, measurements, funnels, CLI detail and history: `docs/linker-audit-findings.md`.

Pipeline: stage 1 generator writes a rich file → stage 1.5 `--from <rich>` views/deep-dives (`--compact`, `--ultra-compact`, `--id/--sku/--cluster/--pair`, no re-scoring) → stage 2 agent proposal → stage 3 `tools/apply_audit_proposal.js` (dry-run default, `--apply` writes, NEVER commits). Uses the LIVE ranker, so every score equals production. Outputs go to `audit/` (git-ignored).

Hard rules:
- **Always pass `--since` explicitly** (`--since 1970-01-01` for any large pass: ~10 min); the default window is 12.7% of the library and once produced a false "found nothing". Always pass an explicit `--out`.
- **Refresh `index.json`, `viz/data/skus/**` and `viz/data/sku_embeddings.json` from their Release assets before every generate** (pulling `data` refreshes none), and check the asset's `updatedAt` (`gh release view embeddings-latest --json assets`). A material `no-embedding` hint rate means a stale file: re-encode rather than judge those pairs.
- `featurize.mjs` reads `process.env.DATA_WORKTREE` at module load; set it before importing (the audit script is CJS and dynamically imports the `.mjs` modules).
- **Pin gotcha:** `storedConfidence >= 1e8` is a deterministic SMWS floor-pin, not a probability; never flag a pinned pair for unlinking.
- `need-unlinks` is below-bar only; link precision is audited only by a complete slice reading `vl[]` on every row. `prob` does not rank wrongness inside a band: pick the band, read every row. Above-bar is weak evidence (0.95–0.99 pilot: 10.5% wrong).
- **Ignored pairs never re-enter the candidate pool**, so a wrong ignore is effectively permanent; keep the ignore-emission rule tight (owner: leave as-is).
- `--limit-pairs` biases toward flagged pairs; never cap a trust-nothing slice or infer population stats from a capped page.
- Run `node tools/validate_proposal_skus.js --proposal <file> [--fix]` before every apply (keep catalog `id:` form). **Merge concurrent proposals first** (`tools/merge_audit_proposals.js`). **Commit an applied proposal before the next cron run** (CI cannot see uncommitted ignores; a `git pull` over the dirty file drops them; recover by backup → clean pull → re-apply, idempotent).
- Audit existing links group-major (`tools/audit_link_group_slice.js`); cap row-major orphan batches at ~200 KB; agent slices ~700 KB end near 50% context (soft limit).
- `unlink` writes an ignore by default; pass `"ignore": false` only when severing to contain collision damage (better: split the sku). Removing A–B is a no-op if A–C–B still connects them; the applier reports `ineffectiveUnlinks[]` and withholds their ignores. A wrong `merge-auto` edge is removed with `unlink-auto`.
- A cross-store SKU collision has no link to remove: report it in `dataQuality[]` (`{sku, store?, issue}`) and fix it with a collision split.
- `pairs[].pol` (`size:` / `store-exclusive:` markers) is a marker, never a verdict.
- Known skew (unfixed, needs a retrain): `featurize.mjs` names an aggregate by its first LIVE listing, while `catalog.js::selectBestDisplayInfo` sorts by tier → photo → longest name. Do not add comments claiming parity.

Status (2026-10-16): links 6,265, ignores 30,477, collision splits 29; precision passes closed; campaign frontier nearly exhausted; whole-catalog undecided-pair pass is the current work.

## Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `run_daily.sh` | Full orchestration: scrape → build viz → commit → push |
| `audit_new_listings.js` | Agent-facing audit generator + view/deep-dive tool (see §"Link audits"; runbook `docs/audit-runbook.md`) |
| `vpn_up.sh` | WireGuard/ProtonVPN egress bring-up for CI |
| `cron_setup.sh` | Install local cron jobs (idempotent) |
| `bootstrap_clone.sh` | Initial clone setup |
| `repo_setup.sh` | Configure repo settings |
| `repo_reset.sh` | Reset utility |

## Tools (`tools/`)

Post-processing scripts run by `run_daily.sh` after the tracker operate on the data worktree (not the main checkout):

| Tool | Purpose |
|------|---------|
| `build_viz_index.js` | Generate `viz/data/index.json` (Release asset) |
| `build_viz_commits.js` | Build commit history manifest |
| `build_viz_recent.js` | Build `viz/data/recent.json` (Release asset) |
| `build_viz_sku_cache.js` | Per-SKU price event files `viz/data/skus/{sku}.json`. Incremental; `--full-reindex` walks full git history. Run from `.worktrees/data/`. Ships as the `skus-latest` tarball |
| `build_viz_rarity.js` | `viz/data/rarity.json` |
| `build_viz_stats_series.js` | `#/stats` bundles; run AFTER `build_viz_commits.js`; `--force` rebuilds; Release asset |
| `build_common_listings.js` | Top-N product lists by region (all/bc/ab) and size (50/250/1000) |
| `build_email_event_pack.js` | Package email event bundles |
| `auto_link_classify.mjs` | CI auto-linker (§"Auto-Link Classification") |
| `apply_audit_proposal.js` | **Hand-run, write-only** proposal applier; shares `src/utils/sku_links_file.js` (dedupe + single-line serialization) with `viz/serve.js` |
| `audit_classical_pairs.mjs` | **Hand-run** page-parity classical similarity (retired `#/link-rapid` scoring) over every store-name variant; ~100 s; input to `audit_undecided_pairs.js --classical` |
| `audit_undecided_pairs.js` | **Hand-run** whole-catalog undecided-pair batches (`--classical` ∪ `--from` rich-file pairs, or `--union` from `audit_coverage_check.js --union-out`, minus grouped/ignored); `--compact` writes one summary per group (~1.2K Haiku tokens/pair vs ~2.9K); `--collect <dir>` merges decisions and needs a dir holding ONLY judged batches. Prompt `tools/audit_undecided_prompt.md` |
| `audit_campaign.js` | **Hand-run** rolling audit campaign (`mine`/`next`/`mark`/`coverage`/`collect`/`round-close`; local retrains never shipped). Manifest `audit/campaign/manifest.json`, prompt `tools/audit_campaign_prompt.md` |
| `audit_search.mjs` / `audit_search_core.mjs` / `audit_search_eval.mjs` | Audit search CLI, union blocking index, recall harness |
| `mine_sku_aliases.mjs` | Alias miner → `viz/app/linker_page/sku_aliases.js` (blocking only, never a verdict) |
| `validate_proposal_skus.js`, `merge_audit_proposals.js`, `audit_link_group_slice.js`, `audit_ignore_slice.js` | Audit helpers (see §"Link audits") |
| `validate_sku_collisions.js`, `detect_sku_collisions.mjs` | Collision-split validator / candidate census |
| `check_search_aliases.mjs` | Search-alias regression check |
| `diff_report.js` | Compare two report files |
| `discover_bad_skus.js` | Find synthetic (`u:`) SKUs that need repair |
| `rank_discrepency.js` | Analyze ranking discrepancies |
| `dedupe_skulinks.js` | Deduplicate SKU link entries |
| `backfill_db_created_at.js` | One-time: stamp `createdAt` on every `data/db/*.json` from its first git commit. Run from `.worktrees/data/`. Idempotent |
| `stamp_pwa.js` | **Deploy-time only** (`pages.yaml`): stamps PWA build hash + precache list into the site artifact. Never commit a stamped file. See `viz/CLAUDE.md` §"PWA" |

## Linker evaluation + learned classifier

Overview, harness description and history: `docs/linker-eval-and-ml-overview.md`.

- **`tools/linker_eval/CLAUDE.md`** — iteration guide for the deterministic scorer (AUC+, auto-link thresholds, measure-risk-before-adding-a-rule, safe vs dangerous discriminators). `tools/linker_eval/TECHNICAL_REPORT.md` is the canonical scorer spec: **update it whenever the scorer changes.** `tools/linker_eval.mjs` (eval harness, imports the live `viz/app/linker_page/suggestions.js`; re-run on every scorer change), `tools/linker_outliers.mjs` (label QA).
- **`tools/linker_ml/CLAUDE.md`** — the retrain guide for the GBT blend (`gbt_model.json`, run live via `viz/app/linker_page/gbt.js`; logistic `blend_weights.js` fallback) + 13 group features + fine-tuned MiniLM embedding. **After every retrain, re-release the checkpoint** (§"Shipping the checkpoint", Release asset `model-ft-<MODEL_VERSION>`) so CI's re-encode uses the new weights. Headline metric: recall at ≥99% precision (honest 2026-10-09: 45% new-listing, 85% existing-listing); train/val split by canonical group.
- Labels (`sku_links.json` links + ignores) are ground truth; linker ML excludes noTrain pairs and `sku_hidden.json` SKUs.

**How to REPORT benchmark results to the user (required format).** Never paste raw harness text; re-render as Markdown tables, showing every requested row, prose before/after welcome. Three tables in order:
1. **Headline metrics** — `Metric | Value | Floor / note`: AUC+ (vs hard negatives) with its trivial shared-word floor, AUC vs ignores, auto-link thresholds for 95% and 99% precision (with recall).
2. **15 worst false positives** (ignored pairs scored high) — `# | Algo | Expected | SKU A | Name A | SKU B | Name B | Why`, Expected = `IGNORE`.
3. **15 worst false negatives** (linked pairs scored low) — same columns, Expected = `LINK`.

Always include raw SKUs and a short "Why" per row (size variant / one-sided age / SMWS-code-lost / possessive-brand / probable-mislabel …); flag suspected mislabels explicitly.
