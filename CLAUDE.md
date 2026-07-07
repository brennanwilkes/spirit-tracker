# Spirit Tracker

Automated price tracker for Canadian spirits (whisky, rum, gin) across 33 liquor retailers. Scrapes stores on a schedule, stores price history as JSON, and serves a browser-based visualization dashboard.

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

- `index.json`, `recent.json`, `db_commits.json`, `skus/**` → **plain git**. Sustainable
  (~15–25 MB/mo total, squashable since the `data` branch is regenerable).
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
4. All workflow checkouts are now `lfs: false`. Net metered LFS traffic: **zero**.

Bonus fix: this also un-breaks Pages deploys (they'd been failing on the LFS-budget 403 since the
budget ran out → prod was frozen on a stale deploy, e.g. `gbt_model.json` 404'd). With `lfs: false`
they succeed again.

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

## Datacenter-IP Blocking — SOLVED (2026-07-06)

The GitHub-runner's Azure datacenter IP was getting challenged by Cloudflare at several
stores (liberty, highlander, coop, colordevino, maltsandgrains). **Fix: WireGuard tunnel
to ProtonVPN in the CI workflow** (`.github/workflows/cron_tracker.yaml`). The runner
connects to ProtonVPN via WireGuard before the tracker runs — all `fetch()` calls exit
from a clean residential-class IP. The tunnel is per-run (ephemeral runner), requires
no code changes to the scraper, and best-effort (if the secret or kernel module is
missing, the run continues without the VPN).

- **Secret**: `PROTONVPN_WG_CONF` — full WireGuard config (the `[Interface]` + `[Peer]`
  block) downloaded from ProtonVPN's WireGuard key page. Generate at
  `account.proton.me/u/0/vpn/WireGuard` — use a fresh key (the movie-server uses a
  different key already).
- **One-time to do**: generate new WireGuard config, copy its contents verbatim into
  the GitHub repo secret `PROTONVPN_WG_CONF`.
- **Diagnostic**: `scripts/diag_liberty.sh` — run from any host; prints egress IP +
  curl/Node probes classified OK vs CHALLENGED. Use it to verify the fix.
- **What we tried that didn't work**: a Cloudflare Worker proxy (2026-06-07, CF→CF
  relay still got challenged) and proxychains4/SOCKS5 (ProtonVPN does not offer SOCKS5).
- **Existing retry logic**: the one-shot failed-store retry on a fresh runner still
  fires up WireGuard on the new runner (the tunnel step runs every time), so retries
  also get a clean IP.

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
| `auto_link_classify.mjs` | Auto-link SKUs with the live GBT blend; append `status:"pending"` links to `data/sku_links.json` (≥99%-precision bar). `--since N` bounds anchors by recency, `--top K`, `--dry-run`. See §"Auto-Link Classification + Review" |
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
