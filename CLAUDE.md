# Spirit Tracker

Automated price tracker for Canadian spirits (whisky, rum, gin) across 33 liquor retailers. Scrapes stores on a schedule, stores price history as JSON, and serves a browser-based visualization dashboard.

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

## Datacenter-IP Blocking (known issue, unsolved)

Several Cloudflare-fronted stores serve a "Just a moment…" managed challenge to the
**GitHub-runner's Azure datacenter IP**, while a clean/residential IP gets normal
data. It is **pure IP reputation** — not headers, not TLS/JA3 (verified: from a clean
IP, `scripts/diag_liberty.sh` shows the scraper's store-API endpoint returns real
JSON via both curl AND Node fetch; the same endpoint 403s in CI). Affected:
**liberty** (consistent), **highlander** (intermittent), **coop** (intermittent), and
**maltsandgrains** (nginx, returns a ~175-byte stub instead of a CF challenge). gull/
sierra are *slow by deliberate rate-limit*, NOT IP-blocked.

- **Diagnostic**: `scripts/diag_liberty.sh` — run from any host; prints egress IP +
  curl/Node probes classified OK vs CHALLENGED. Use it to A/B a candidate egress.
- **Tried & REVERTED (2026-06-07): a Cloudflare Worker `/proxy`.** Hypothesis was
  CF-egress has clean reputation; it does NOT — the Worker's egress IP is itself
  challenged, so CF→CF relayed the same 403 (and a Worker `fetch()` can't solve the JS
  challenge). Fully removed from both repos. Do not re-attempt the CF-Worker route.
- **Real fix (deferred)**: a clean, non-datacenter egress IP — e.g. a free-cloud VM
  (Oracle Always-Free) as a self-hosted runner or proxy host. **Local runs are off the
  table** (per owner). Until then, failures are surfaced in commit messages (see
  §"Run Observability") rather than fixed.

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
- **Small** (sierra_springs, craft_cellars, colordevino, liquorama): 0:45, 3:45, 9:45, 12:45, 15:45, 21:45 UTC (~12 min → commits ~03/06/09/15/18/21 PT)

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
6. Commits + pushes all changes to the `data` branch
7. Triggers the Pages deploy and email pack workflows

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
Measured held-out auto-link **recall @99% precision: 14.5% → ~69%**.

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
