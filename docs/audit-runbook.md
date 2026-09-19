# Audit Runbook — auto-link coverage review (the agent's operating manual)

Status: **Phases 0–4 complete (2026-09-18)**. This is the agent-facing runbook for the SKU
link/unlink audit. It documents the full end-to-end loop: setup, the stage-1 rich generator and
its token-cheap stage-1.5 views, the Phase 1 search primitive, the Phase 4 anchor policy, and the
proposal/apply contract. Design + measured results live in
`docs/audit-search-and-scale-plan.md`; update both whenever the tooling lands.

## Why this exists

The human link pages (`#/link-rapid`, `#/link-review`) are being retired. Link quality control
becomes two pillars:

1. **Auto-classify** (`tools/auto_link_classify.mjs`) — high-confidence cross-store links appended
   automatically each scrape.
2. **AI-agent audits** — an agent walks the catalog (chiefly the misses/bad-links the linker gets
   wrong) and proposes link/unlink/ignore operations, which are applied to `data/sku_links.json`.

The dataset is huge, so nothing is handed to the agent raw: **stage 1 pre-computes a rich data
file**, and the agent reads **smart-filtered projections** of it, pulling full detail only when a
specific decision needs it. The **search primitive** (`tools/audit_search.mjs`) is the
non-token-consuming way to query the whole catalog (current + delisted) without pulling the rich
file into context.

## Pipeline (stages + apply + convergence)

```
SETUP   restore index.json + sku_embeddings.json (Releases), confirm db_commits.json fresh
   |
STAGE 1  generate the rich "all the data" file            (scripts/audit_new_listings.js)
   |        every listing, fully scored, full features, clusters, funnels, triage
   v
STAGE 1.5  smart-filter views over the rich file          (same script, --from <rich>)
   |        --only funnels, --offset/--limit pages, --compact projection, deep-dive lookups
   v
SEARCH PRIMITIVE  ad-hoc typo-robust lookups             (tools/audit_search.mjs --sku/--query)
   |        whole catalog incl. delisted; cheap evidence when a compact row is inconclusive
   v
POLICY CONSULT   read data/sku_link_policy.md            (loadSkuLinkPolicy, data branch)
   |        judge ambiguous classes by the human rules; PROPOSE — never self-apply — amendments
   v
STAGE 2  agent decision pass (this runbook)               -> proposal file (new file)
   |        read compact pages; anchor policy (below); deep-dive a sku when needed; emit ops
   v
STAGE 3  apply the proposal (write-only, human commits)   (tools/apply_audit_proposal.js)
   |        dry-run default; --apply writes; prints diff; never commits/pushes
   v
CONVERGENCE  re-generate + re-filter                       (same script)
             want-links=0, no pinned-unlinks, no unresolved near-misses; re-run is a no-op
```

Key rule: **decisions never re-score.** Stage 1 does all ranker work once; stage 1.5 and the agent
only read what it produced. `audit_search` is the only other scorer, and it runs the LIVE ranker
end-to-end (same paths as stage 1), so its numbers always match production.

## Setup (prerequisites + asset restore)

All commands run from the repo root unless noted.

- The `data` worktree exists at `.worktrees/data` (or pass `--root`/`--worktree`).
- **`viz/data/index.json` is NOT on the data branch** (it ships as a Release asset on the
  `index-latest` tag). Restore it — the scorer env reads it for the current catalog:
  ```bash
  curl -sL -o .worktrees/data/viz/data/index.json \
    https://github.com/brennanwilkes/spirit-tracker/releases/download/index-latest/index.json   # ~15.7 MB
  ```
- **`viz/data/sku_embeddings.json` is NOT committed either** (Release asset, `embeddings-latest`).
  Without it every candidate starves to `no-embedding` and the GBT is under-confident:
  ```bash
  curl -sL -o .worktrees/data/viz/data/sku_embeddings.json \
    https://github.com/brennanwilkes/spirit-tracker/releases/download/embeddings-latest/sku_embeddings.json   # ~43 MB
  ```
- `gbt_model.json` + `db_commits.json` ARE committed on the data branch — nothing to fetch.
  `db_commits.json` drives the **delisted-history cache** (`audit/.cache/history_surface.json`,
  keyed to its `generatedAt`). If the worktree is stale, delete the cache so it rebuilds:
  `rm -f audit/.cache/history_surface.json`.
- **First run of anything that builds the delisted surface takes ~2 minutes** (it walks 136 files
  of `data/db/**` git history). Every later run is ~2 s from `audit/.cache/history_surface.json`.
  Do not assume it has hung.
- Sanity check the env loads: `node tools/audit_search_core.mjs` prints
  `env: <n> aggregates ...` and `surface: <n> items (current=..., delisted=..., fromCache=...)`.
  `delisted ≈ 1,194` and `embeddings: 13429` are the healthy signatures. The surface cache is
  rebuilt only when `db_commits.json`'s `generatedAt` changes.

## Tool inventory (as of 2026-09-18)

| Tool | Purpose / CLI |
|------|---------------|
| `scripts/audit_new_listings.js` | Stage-1 rich generator + stage-1.5 views. `--since/--until/--only/--root/--format/--out`; `--from <rich>` views; `--compact`/`--ultra-compact`/`--limit-pairs` only with `--from`; `--id/--sku/--cluster/--pair`. Union-blocker env knobs: `AUDIT_POOL_BUDGET` (700), `AUDIT_POOL_PER_CHANNEL` (150), `AUDIT_POOL_EMB=1` (+ `AUDIT_POOL_EMB_K` 200) |
| `tools/audit_search.mjs` | **Phase 1 search primitive CLI.** `--sku <key>` or `--query "<text>"` (exactly one); `--top K` (25), `--worktree`, `--category`/`--store` (soft annotations — recorded, never filter), `--no-delisted`, `--json`, `--help/-h`. Exit 0 help / **exit 1 not-found / exit 2 bad-args**. Ranks by live `det` → (query mode) `similarityScore` → `prob` → `cos` → sku; `channels` names the blocking channels that surfaced each hit |
| `tools/audit_search_core.mjs` | Shared core. Exports `loadEnv` (sets `DATA_WORKTREE` before importing `featurize.mjs`, which resolves it at module load), `buildSurface` (current + delisted via git-history walk, **cached at `DEFAULT_CACHE_FILE=audit/.cache/history_surface.json`**), `loadSkuLinkPolicy`, `buildBlockIndex` (dist/topTerm/smws/twin/fuzzy + alias table), `buildEmbeddingIndex`, `normNameForTwin`. Run as a CLI = self-check (env/surface/block stats + optional `--sku` pool dump) |
| `tools/audit_search_eval.mjs` | **Phase 0 recall harness** over the gold set (all `data/sku_links.json` pairs). Channels `current` (old dist/SMWS), `topTerm`, `fuzzy`, `emb`, `union`; K-table 5/10/20/50/100 + `ms/anchor`. Env knobs: `ANCHOR_LIMIT` (250), `AUDIT_INCLUDE_DELISTED=1` (first run walks the git history ~3 min, then ~19 s warm from the cache). Re-run after any scorer/blocking change |
| `tools/mine_sku_aliases.mjs` | **Phase 3 alias miner.** Mines token-variant pairs from CONFIRMED links, drops alignments that appear in ignore pairs, keeps only unambiguous ≥2-support tokens → writes `viz/app/linker_page/sku_aliases.js` (~38 rows / 76 keys). Blocking-only. Regenerate after the link set grows |
| `tools/apply_audit_proposal.js` | **Stage 3 applier** (write-only). `--proposal <file>` (dry-run default), `--apply` writes, `--json` machine report, `--verbose` (full diff lists), `--force` (link on an ignored pair), `--root`. Validates and echoes the proposal's `review[]` but never acts on it. Never commits |
| `data/sku_link_policy.md` | **Phase 3b judgement rules**, human-owned, on the DATA branch. Read every run via `loadSkuLinkPolicy`; agent proposes amendments, never edits the file |

## Stage 1 — generate the rich file

```bash
# Full audit (every listing first seen since the auto-classify launch — the default window):
node scripts/audit_new_listings.js --format jsonl --out audit/rich.jsonl --root .worktrees/data

# Or constrained to a window:
node scripts/audit_new_listings.js --since 2026-09-01 --until 2026-09-20 --format jsonl --out audit/rich.jsonl
```

**Both bounds are INCLUSIVE dates.** `--until 2026-09-19` resolves to `< 2026-09-20T00:00Z`, i.e.
it includes everything first seen on the 19th. Pass the last day you want, not the day after.

The Phase 2 union blocker is ON by default (env knobs in the table above). Measured full run:
4,344 listings, 21,398 candidates, median pool 225, 64 s, 900 near-miss listings, 362
twins, 186 auto-linked, 772+ orphans, pool size min 0 / median 464 / max 700, ~100 s runtime.

Rich rows carry, per listing: identity (`id` = `<dbFile>|<sku>`), store/category, `current`
(name/url/price/removed), `links[]` (+ per-store resolved), `autoLinks[]`, `inIgnores`, `cluster`,
`triage` + `noopEvidence`, and `scores` = `{ candidates[] (with the 41-col decomposed `features` +
`suspicious`/`missHints`), verified[] (existing links re-scored; `pinned`/`absentFromCatalog`),
twins[] }`.

**Do not read rich rows into context in bulk** (~16.9 KB each). Use stage 1.5 views.

## Stage 1.5 — smart-filter views (no re-scoring)

All derive from the rich file, loaded and filtered in-memory (~0.5 s on the full 86 MB jsonl):

```bash
# A page of a funnel. Prefer --ultra-compact: ~37% fewer bytes, same decisions.
node scripts/audit_new_listings.js --from audit/rich.jsonl --only near-misses --ultra-compact \
  --format jsonl --limit 50 --offset 0 --out /tmp/page.jsonl
# --compact keeps id/category/firstSeen/removed/auto/inIgnores/why; use it only when you
# actually need one of those (they went unconsulted through an entire trial audit).

# Deep-dive ONE decision that the compact packet can't settle — full rich rows:
node scripts/audit_new_listings.js --from audit/rich.jsonl --id "<dbFile>|<sku>" --out /tmp/dive.json
node scripts/audit_new_listings.js --from audit/rich.jsonl --sku "<normalizedSku>"   --out /tmp/sku.json
node scripts/audit_new_listings.js --from audit/rich.jsonl --cluster "<canonicalSku>" --out /tmp/cluster.json
node scripts/audit_new_listings.js --from audit/rich.jsonl --cluster "<canonicalSku>" --compact --out /tmp/cluster.json  # members as sku/name/store/price only
# The pair-level "was the score right?" view — live score + the 41-col features for ONE pair:
node scripts/audit_new_listings.js --from audit/rich.jsonl --pair "8289426|123851" --out /tmp/pair.json
```

**Paging is mechanical:** the view `_meta.window` carries `totalAfterFilter`, `shown`, `remaining`,
and `nextOffset` — advance with `--offset <nextOffset>` until `remaining` is 0 (the coverage
contract, enforced by the data rather than arithmetic). `--pair` returns `{found:<n>, matches:[{anchorSku, …, prob, det, features}]}` and may return
`found` > 1: the same pair can appear once per anchor row sharing a sku, so `matches[].anchorSku`
can repeat. `features` is the decomposed 41-column object; its multipliers (`sizePen`, `abvMult`,
`conceptMult`, `edMult`) are MULTIPLIERS applied to the deterministic score — below 1 is a penalty,
above 1 a boost.

**Pass an explicit `--out` on every command.** Running stage 1 with no `--out` (or, previously, any
unrecognized flag) defaults to `audit/new_listings_<since>_<until>.<ext>` and would OVERWRITE the
default audit file after a ~100 s full regeneration. `--from` now REQUIRES `--out` (exit 2
otherwise — it refuses to write the default rich path). Unknown flags hard-error (exit 2) and
`--help` prints usage, but an explicit `--out` is still the safe habit.

- `--only` values: `all | orphans | auto-linked | has-links | no-auto-link` (structural) and
  `want-links | need-unlinks | near-misses` (score-driven; derived from stored flags).
- `--compact` / `--ultra-compact` are **only** valid with `--from` (enforced). `--compact` projects
  each row to `{id, store, category, sku, canon, name, price, rar?, removed, firstSeen, links:<n>,
  auto, inIgnores, triage, why, pairs:[…]}`; `--ultra-compact` keeps only
  `{sku, store, name, price, rar?, triage, pairs:[…]}` and implies `--compact`.
  Each pair is `{t:"c|v|w", sku, name, prob, det, price?, st?, nst?, same?, rar?, pr?, prPct?,
  hints?, flag?}`. Features are dropped; deep-dive (`--pair`/`--id`) when you need them.
  View `_meta.legend` documents every one of these.
- `--limit-pairs <n>` caps pairs per row (default 6 under `--ultra-compact`, uncapped otherwise),
  ordered `hit` → `susp` → verified → rest, then by `prob`. **That ordering biases what you see**:
  flagged pairs are disproportionately `no-embedding` ones, so a truncated view looks like a much
  higher no-embedding rate than the funnel actually has. Do not infer population statistics from a
  capped page.

### Reading the fields (don't guess)

- `pairs[].t`: `c` live candidate, `v` verified existing link, `w` title-twin (identical normalized
  title that never reached the candidate pool).
- `pairs[].flag`: `hit` = above the auto-link bar — i.e. **auto-classify WOULD fire; that is NOT a
  correctness guarantee** (a top `hit` can still be a wrong sibling match). `susp` = suspicious
  below-bar miss. `pin` = deterministic floor-pin (do NOT unlink). `absent` = partner left the
  catalog. Precedence is `pin > absent > hit > susp`. Already-linked candidates are filtered out of
  the pool upstream (`recommendSimilar` `sameGroupFn`), so a `flag:"linked"` state does not exist.
- `pairs[].hints`: why a suspicious pair was crushed (`no-embedding`, `sizePen:…`, `abvMult:…`, …).
  `no-embedding` is PER-CANDIDATE, not global — this candidate's sku has no vector.
- `pairs[].st` / `nst`: the store(s) carrying the candidate — a bare string when there is exactly
  one, else the first two plus `nst` = the true count.
- `pairs[].same`: `1` when the ANCHOR's store also carries this candidate. **Evidence, not a
  verdict** — see the policy file's "Same store on both sides" section. Identical price points at
  a double-listing; a real price gap points at two products; and stores do simply mislist things.
- `pairs[].pr` / `prPct`: the price ratio (dearer/cheaper, omitted below 1.05) and where it falls
  in the DEARER store's own markup distribution over products it demonstrably shares
  (`_meta.eval.storePriceRatio`, computed per run over every multi-store canonical group).
  `>max` means that store has never been observed that far above the market on anything — the
  single most decisive field for catching a high-`prob` false positive. A ratio inside the store's
  normal band is weak evidence either way.
- `pairs[].rar` / row `rar`: rarity tier from `viz/data/rarity.json` — `rare` (top ~10%) or
  `staple` (bottom ~10%); the common 80% is omitted. The policy's bundle rule keys off this, and a
  `staple` ↔ `rare` mismatch on an otherwise identical-looking pair is a strong tell that the two
  listings are not the same product.
- Synthetic skus: `id:`/`upc:`/`u:` prefixes are aggregate/synthetic labels; a bare number and its
  `id:<n>` form can be the SAME entity (the loaders union them). Decide the *entity*, not the string.
  **`canon` is the strongest signal:** two rows with the same `canon` are already one entity
  (transitively linked) — never propose a link between them. Note this only helps for pairs you see
  as two anchor rows; a candidate already in the anchor's group is filtered out of the pool upstream
  and never appears.
- **Funnel overlap is universe-level, not page-level.** A pair can be in both `want-links` and
  `near-misses`, but pages are sorted per-funnel, so the overlapping rows may not appear on the page
  you happen to be reading. Don't assume page contents overlap.

### The funnels (what to prioritize)

- `want-links` — never auto-linked, yet a live candidate `prob ≥ bar` (0.95) today. "Link the missed ones."
- `need-unlinks` — an existing auto-classify pair whose live re-score fell below bar (pins excluded).
  "Unlink the bad ones."
- `near-misses` — **the highest-value surface**: pairs the linker scores LOW but that share real
  overlap evidence a human/agent eye instantly calls the same product. The compact `pairs[].hints`
  says why it was crushed (`no-embedding`, `sizePen:0.x`, `abvMult:0.x`; `edMult>1` is a boost, and
  `ageRel<0`/`conceptMult<1`/`edMult<1` pairs are genuinely DIFFERENT and are excluded). Includes
  `t:"w"` twin pairs — identically-titled products across stores that never even reached the
  candidate pool (blocking-index blind spot). Rows are sorted strongest-miss-first.

## Search primitive — `tools/audit_search.mjs` (Phase 1)

The non-token-consuming query tool for the **whole catalog, current + delisted** (delisted items
come from the git-history surface, cached). Use it when a compact row is inconclusive and you do
not want to load even a small rich view:

```bash
# By SKU (raw or normalized) — resolves delisted too:
node tools/audit_search.mjs --sku 8289426 --top 10
# Free-text, typo-robust (edit-distance tiebreak on top of the live scorer):
node tools/audit_search.mjs --query "glenfarclas 12 co op exclusive" --top 10
# Machine-readable:
node tools/audit_search.mjs --sku 8289426 --top 5 --json
# Exclude delisted history:
node tools/audit_search.mjs --sku 8289426 --no-delisted
```

- Exit codes: **0** = help/ok, **1** = `--sku` not found, **2** = bad args / unknown flag.
- Output columns: `det` (live deterministic score — the ranking driver), `cos` (embedding cosine),
  `prob` (live GBT probability), `channels` (which blocking channel(s) surfaced the candidate:
  `dist | topTerm | smws | twin | fuzzy | emb`). The footer notes pool size, embedded count, engine,
  and `(cached)` when the delisted surface came from the cache.
- `--category` / `--store` are **soft annotations**: recorded in `_meta`, they never filter results.
- **Embeddings requirement:** without `sku_embeddings.json` restored (Setup), every cosine is `-`
  and the GBT is under-confident — same as stage 1.

## Search/review eval — `tools/audit_search_eval.mjs` (Phase 0 harness)

Re-run after any change to the scorer or blocking:

```bash
node tools/audit_search_eval.mjs                                  # current-only, fast
AUDIT_INCLUDE_DELISTED=1 node tools/audit_search_eval.mjs         # first run warms the history cache
ANCHOR_LIMIT=700 node tools/audit_search_eval.mjs                 # bigger sample
```

Measured (2026-09-18, current-only, n=316): `current` blocker recall@100 **98.7%**; **union
(dist+topTerm+smws+twin+fuzzy+emb) 100% @ K=20**; HONEST subset (n=85) **100% @ K=5**; **0 pairs
still missed at K=100**. The gold set grows 5,723 → 6,638 pairs when delisted items are included and
`union@50 = 100%` on that run. Per-anchor latency: current ~0 ms, topTerm ~0 ms, fuzzy ~0.2 ms,
emb ~6.6 ms, union det-scoring ~59 ms. The union closing the hole is what the anchor policy relies
on — a drop in union recall means a blocker regression: stop and fix it before continuing.

## Alias table — `tools/mine_sku_aliases.mjs` + `viz/app/linker_page/sku_aliases.js` (Phase 3)

The committed alias table is mined from confirmed links and consulted by the block index so
`reserva`↔`reserve`, `barrel`↔`barrell`, `bourbo`↔`bourbon`, `michter`↔`michters`,
`abunadh`↔`bunadh` (top rows by support; 38 rows / 76 map keys) widen the candidate pool.

- **Blocking-only, never a verdict.** An alias hit only makes a pair *enter the pool* — the pair
  must still clear the live scorer's bar before any link is proposed. Never cite the alias table
  alone as "same product" evidence.
- **Known-trim list (human decision, ~5 flagged rows):** `light↔night`, `doon↔toon`, `dete↔ete`,
  `port↔post`, `rufty↔tufty` are questionable alignments that survived the ignore drop — they are
  blocking-only, so they only add candidates the scorer still rejects, but the human may want to
  remove them. They are NOT per-product decisions; leave the verdict to the scorer/policy.
- 30 candidate alignments were dropped because they appear in ignore pairs (a curated hard
  negative). Regenerate after the link/ignore set grows: `node tools/mine_sku_aliases.mjs`.

## Anchor policy (prioritise which listings to adjudicate)

When context or run budget is limited, work the funnels in this order. It mirrors where the
genuine misses concentrate (validated: errors concentrate in isolated SKUs; M↔M merges that the
conventional tools miss are rare):

1. **Isolated / orphan SKUs first** — canonical-group size 1 (and especially single-store orphans).
   These are where the genuine hard misses live.
2. **Newly-auto-linked / low-confidence links next** — links added recently or re-scoring near the
   bar: confirm they are right (link) or reject them (unlink + ignore).
3. **Delisted** — items left the catalog but still need correct links, so a later re-list or the
   history view stays accurate. The search primitive resolves them; the rich/compact funnels work
   on the current catalog, so delisted anchors are handled via `audit_search` deep-dives.
4. Sweep order within a funnel: **smallest canonical group first** (`canon` members count), since a
   wrong link corrupts a small group more than a large one.
5. **Never re-adjudicate pins.** `storedConfidence >= 1e8` means a deterministic floor-pin (SMWS
   cask code), not a calibrated probability. A pinned pair can show a live `prob` just under 0.95
   with `embedCos: null` + `aiDelta: 0` — do NOT flag it for unlinking, and NEVER propose an
   unlink on a pinned pair. `verified[]` entries carry `pinned: true`; `need-unlinks` already
   excludes pins.
6. **Route doubt to `review[]`, do not swallow it.** The proposal's `review` array (Stage 3) is the
   needs-human channel and the applier never acts on it. Put a pair there when the policy file has
   no rule, both readings are defensible, and price/size/abv/store/rarity evidence does not settle
   it. **An above-bar pair you decide against belongs in `review[]` too** — it is a live
   auto-linker false positive and the most valuable thing an audit can surface. Calibration: be
   generous proposing links you can justify from evidence you actually read, and put everything
   else in `review[]` rather than trimming the op list; recall is cheap to re-examine, a wrong
   link corrupts a canonical group permanently.

Token-budget guardrail: the whole near-miss funnel is ~164K tokens of input at 3 B/token under
`--ultra-compact` (measured 2026-09-19 — see §"Measured token cost"), and a real end-to-end agent
run over a 3-week window burned **250K total tokens**. Page by `--offset`, and use the policy table
+ search primitive to keep per-row context small.

## Policy file consult + amendment proposals (Phase 3b)

Read `data/sku_link_policy.md` at the START of every run (`loadSkuLinkPolicy` in
`audit_search_core.mjs` does it for you — cite its `rules[]` when reasoning). The seed table
decides the classes the scorer is ambiguous on: format/year wording → link; abbreviations → link
(never across a size/ABV/batch gap); packaging/re-list → link; size → separate (700≡750 and
375≡350 are within tolerance); ABV/proof → separate when materially different; vintage year →
separate; batch/cask → separate, **but a cask code that MATCHES on both sides is positive evidence
they ARE the same bottling**; limited/annual edition → separate; store/exclusive cask → judgement;
gift/sampler/tasting set → separate; bundle/multipack → judgement, and a bundle containing a rare
(allocated) item links to that rare item's group with its price premium accepted.

- Where the table has a rule, the decision is **determined**: follow it, cite it in the proposal
  `why`.
- Where the data suggests a NEW class or a changed call, **propose an amendment in the audit
  report** (`proposal.policy` field — see Stage 3), with concrete `(SKU, name)` evidence and the
  verdict you want. **Never edit the policy file and never decide by an unrecorded rule** — that is
  how the human-owned policy drifts.

## Stage 2 — the decision pass

Goal: **decide on every listing in the chosen universe**, in as few tokens as possible, and emit a
proposal. Easy rows must still be explicitly decided (see coverage contract).

Recommended loop:

1. Choose the universe: for routine audits start with `--only near-misses` (plus
   `want-links`/`need-unlinks`), which is where action is needed. A full-coverage pass uses
   `--only all`.
2. Fetch one `--ultra-compact` page at a time (`--limit 50` or `--limit 100` — see §"Measured token cost")
   and read its listing lines. The `_meta` line is tiny (~6.6 KB) and clusters are deliberately
   omitted from views, so read it once (or ignore it); cluster detail is only in the rich file.
3. Per listing, act on `triage`. **A row can show several pairs; decide each shown pair, and note
   that a `hit` (above-bar) pair is not automatically correct and a `check` triage can be driven by
   a `susp` pair even when a `hit` is present.**
   - `noop-verified` — read `triage` + `why`; accept unless the evidence looks wrong. No op.
   - `check` — a crushed/twin pair. Compare the two names/stores/prices (both sides' prices are on
     the row: anchor `price` + `pairs[].price`). Same product ⇒ `link`; genuinely different ⇒
     `ignore` (a hard negative). Consult the policy table for the class; deep-dive (`--id`,
     `--pair`, `--cluster`) or `audit_search` if unsure.
   - `review` — existing auto-link re-scores below bar ⇒ `unlink` (default also adds an ignore).
     Never outranks a `pin` flag.
   - `auto-high` — a candidate is above bar; confirm it (`link`) or reject it (`ignore`).
   - `pruned` — sku left the catalog; no op.
   - **Ignore policy:** only `ignore` pairs that are plausible enough to keep confusing the
     auto-linker (same brand/expression family, sibling editions, size variants). Do NOT ignore
     every obviously-different candidate on the row — that is ignore-spam and adds noise to the
     curated hard-negative set. When in doubt, leave it (no-op).
4. Decide each **undirected pair** once. If the other side appears later, reuse the decision
   (idempotent; the apply tool dedupes and errors on contradictory ops).
5. **Coverage contract — write it down, do not hold it in your head.** Emit a `decisions.jsonl`
   alongside the proposal: one `{"sku": "...", "verdict": "link|unlink|ignore|noop|review"}` per
   row you adjudicated. Diff its sku list against the funnel's to prove coverage mechanically.
   Tracking coverage in reasoning alone does not survive a 350-row funnel and produces a claim
   nobody can check — the first trial run could only assert coverage, not demonstrate it.

### Measured token cost

**Re-measured 2026-09-19** over the full default window (4,344 listings), after the evidence
fields and `--ultra-compact` landed. Reproduce with:

```
node scripts/audit_new_listings.js --from <rich> --only near-misses --ultra-compact \
  --format jsonl --out /tmp/nm.jsonl && wc -c /tmp/nm.jsonl
```

| Funnel | rows | `--compact` KB | `--ultra-compact` KB | ultra B/row | ultra tokens @3 B |
|---|---|---|---|---|---|
| near-misses | 900 | 777 | **492** | 546 | **164K** |
| orphans | 791 | 552 | **324** | 409 | 108K |
| want-links | 54 | 49 | **33** | 606 | 11K |

**Use the 3 B/token column.** `bytes/4` is the English-prose rule of thumb; a compact row is dense
JSON (measured: 15% digits, 25% structural punctuation) and tokenizes nearer 2.5–3 B/token. These
are INPUT bytes only: no output, no reasoning, no tool-call overhead, no deep-dives. Nothing in the
repo measures tokens with a real tokenizer; if that matters, count them with `messages.count_tokens`
rather than any divisor.

**What a real run actually costs.** A supervised end-to-end trial on 2026-09-19 over a 3-week
window (1,227 listings; 13 want-links, 0 need-unlinks, 351 near-misses, 281 orphans) produced 111
proposed ops and consumed:

| Measure | Value |
|---|---|
| Total tokens | **250K** |
| Tool calls | 30 |
| Wall clock | 21 min (of which stage 1 is ~19 s) |
| Most expensive single step | reading the near-miss funnel (~88% of tool-output bytes) |

That is ~200 tokens per listing in the universe. **Extrapolating to the full library (4,344
listings) gives roughly 900K tokens for a single pass** — so the one-time full audit must be
batched by `--offset`, or split across several agent runs by date window, regardless of context
size. Plan ~4–5 batches of ~1,000 listings.

- Per-row context budget: rich row ≈ **16.9 KB**; ultra-compact row **≈ 546 B** on the near-miss
  funnel. Fetching the rich file is a one-time ~86 MB on disk and the agent never loads it in.
- Budget deep-dives explicitly — `--id` ≈ 6 KB, `--pair` ≈ 1.6 KB. Deep-diving even 10% of 1,800
  pairs at 6 KB costs more than the entire funnel. The `st`/`same`/`pr`/`prPct`/`rar` fields exist
  precisely so that most rows no longer need one.
- `--from` view load is ~0.5 s on the full 86 MB jsonl, so per-page and per-deep-dive calls are cheap.
- `_meta` in a view is ~6.6 KB (clusters stripped + a `legend`; without stripping it was ~973 KB — 99.5% clusters).
- **`hints:["no-embedding"]` is per-candidate, not global**, and covers **47.8% of near-miss pairs**
  (863 of 1,804, measured with the embeddings file loaded). `embedCos` is null whenever the
  candidate's sku has no vector in `sku_embeddings.json` (embeddings are keyed by the *aggregate*
  sku, so a store's alias listings — e.g. liberty `123851` vs canonical `id:8289426` — miss). This
  reproduces the live ranker exactly; the GBT's missing-branch handles it. Treat a below-bar
  no-embedding pair as **unscored, not negative**. Check `_meta.eval.embeddings === true` to
  confirm the file loaded at all (vs every row being starved).
  - Beware the sampling trap: `--limit-pairs` orders flagged pairs first, and flagged pairs are
    disproportionately the no-embedding ones, so a capped page reads as ~100% no-embedding. The
    47.8% is the funnel-wide figure.

## Stage 3 — proposal file + apply (built)

Proposal (written by the agent to a NEW file, e.g. `audit/proposal-<ts>.json`):

```json
{
  "generatedAt": "2026-09-17T00:00:00Z",
  "auditRef": { "file": "audit/rich.jsonl", "only": "near-misses", "eval": {"engine":"gbt","bar":0.95} },
  "ops": [
    { "op": "link",   "a": "123851", "b": "u:4924f385", "why": "identical title; same distillery/expression" },
    { "op": "unlink", "a": "...", "b": "...", "why": "re-scored 0.004 < bar; ages differ (12 vs 18)", "ignore": true },
    { "op": "ignore", "a": "...", "b": "...", "why": "confirmed different products" }
  ],
  "review": [
    { "a": "840932", "b": "id:8289118",
      "why": "prob 0.9904 would auto-link TODAY, but pr 2.24 is >p99 for Liberty, rar disagrees (staple vs rare) and sizePen 0.3 fired — probably a different format. Cannot name what it actually is." }
  ],
  "policy": [
    { "amend": "packaging/re-list - link", "proposal": "PM batches re-listed under a new label are the same spirit; add example pair ..." }
  ],
  "coverage": { "universe": 804, "reviewed": 804, "noop": 700, "notes": "near-miss funnel, one full pass" }
}
```

- **`review` is the needs-human channel.** Every entry needs `a`, `b` and a `why` (validated — an
  unexplained referral is not reviewable). The applier never acts on it and echoes it back in both
  the text and `--json` report, so a finding cannot be lost to chat scrollback. This is where an
  above-bar pair you decided against goes.
- `policy` is optional — amendment proposals for `data/sku_link_policy.md`; see §policy consult.
  The applier ignores it, so the human reviews it in the same file.

Apply tool (`tools/apply_audit_proposal.js`):

```bash
node tools/apply_audit_proposal.js --proposal audit/proposal-<ts>.json              # dry-run (default)
node tools/apply_audit_proposal.js --proposal audit/proposal-<ts>.json --verbose   # list every diff line
node tools/apply_audit_proposal.js --proposal audit/proposal-<ts>.json --apply     # write the file
```

Diff lists are truncated at 40 entries unless you pass `--verbose` (or read `--json`, which is
always complete).

Reads the proposal + the live worktree `data/sku_links.json`, validates every op (a≠b, unknown op,
and any pair carrying contradictory ops — `link` vs `unlink`/`ignore`, or `ignore` vs
`remove-ignore` — which fails closed with exit 1 and **writes nothing**), applies to a working copy,
and prints a per-op status table + a structured pair diff. `--json` emits a machine report.

- **Write-only.** Dry-run is the default; `--apply` rewrites the file in the SAME format and with the
  SAME union-find dedupe as `viz/serve.js` (both now share `src/utils/sku_links_file.js`). It never
  commits or pushes — commit `data/sku_links.json` by hand.
- New links are `{fromSku, toSku, status:"pending", confidence?, source:"agent-audit", ts}` — the
  same shape auto-classify uses, so `#/link-review` and every loader treat them as real links.
- `unlink` removes the matching entry AND (unless `ignore:false`) records an ignore (the `reject`
  semantics). `ignore` records a hard negative; `remove-ignore` un-does one.
- **Pre-existing duplicates note:** the committed file is appended by `auto_link_classify` WITHOUT
  union-find dedupe, so it accumulates transitively-redundant links. Any `writeLinks` (this tool or
  `serve.js`) prunes them, so the first real apply will show a `-24`-ish link delta that is NOT
  explicit unlinks — the tool reports it separately as `redundantLinksInSource`.
- Unresolvable ops (unlink of a pair with no entry, ignore of an already-ignored pair) are reported
  as `skipped`, not errors; only contradictions/invalid ops abort.
- A `link` whose pair is already in one union-find component is `skipped` and the note distinguishes
  **`already linked in source`** (the file already had it) from **`redundant — an earlier op in this
  proposal already links them`** (your own ops formed a transitive chain). The latter is normal when
  you link many members of one family; it is not a coverage failure. Verified 2026-09-17: a retrial's
  11 skips were ALL self-closure, none pre-linked in source.

## Convergence re-check (after apply)

The acceptance test for the whole dispatch: **re-run → no-op → gold set green.**

1. Re-generate the rich file (only if the worktree data moved — views derived from the SAME rich
   file are already stale after an apply, so regenerate before re-checking):
   `node scripts/audit_new_listings.js --format jsonl --out audit/rich.jsonl --root .worktrees/data`.
2. `--from <rich> --only want-links --compact` → **0 want-links** (every missed product was linked).
3. `--from <rich> --only need-unlinks --compact` → 0 non-pin below-bar auto-links (every bad link
   unlinked). Pins staying put is correct.
4. `--from <rich> --only near-misses --compact` → no UNRESOLVED suspicious rows (all rows have been
   adjudicated as link/ignore/no-op in a prior pass; a re-run emits nothing new).
5. `node tools/audit_search_eval.mjs` → union recall still 100% at K in the measured range. A
   blocker regression shows up here first.
6. Apply again with the (now empty or identical-id) proposal → second run is a no-op.

## Current status / next steps

- [x] Stage 1 rich generator: funnels, triage, suspension (`suspicious`/`missHints`), twins always
      on, `_meta` coverage contract + readme.
- [x] Stage 1.5 `--from` views: re-filter/paging/`--compact` projection, deep-dive `--id/--sku/--cluster/--pair`.
- [x] Bugs fixed: `parseArgs` treats `--compact` as a flag; jsonl `_meta` detection no longer
      requires `_meta.listings`.
- [x] Stage 3 `tools/apply_audit_proposal.js` built + shared read/write via
      `src/utils/sku_links_file.js` (`viz/serve.js` refactored to reuse it).
- [x] Worked demo: compact near-miss page → proposal → dry-run apply against the real worktree
      (3 links + 1 ignore; correct +24 pre-existing-duplicate note).
- [x] Compact sizing measured; clusters stripped from view meta (973 KB → 4.7 KB).
- [x] **Trial-run hardening, round 1 (2026-09-17):** unknown flags hard-error / `--help` prints
      usage; compact rows carry the anchor `price`; `--pair` added; `_meta.legend` documents
      `t/flag/hints`/`price`/synthetic-sku prefixes; `apply --json` summary.
- [x] **Trial-run hardening, round 2 (2026-09-17):** compact rows carry `canon`; `--cluster
      --compact` members-only; mechanical paging (`remaining`/`nextOffset`); apply distinguishes
      `already linked in source` from self-closure.
- [x] **Phase 0 harness** `tools/audit_search_eval.mjs` — union closes the hole (see §eval).
- [x] **Phase 1 search primitive** `tools/audit_search.mjs` + `audit_search_core.mjs` — delisted
      surface via cached git-history walk.
- [x] **Phase 2 union blocker** wired into the generator (budgeted, fallback intact, `--from`
      byte-compatible) + **Phase 3 alias miner** + **Phase 3b policy file**.
- [x] **Phase 4 (2026-09-18):** anchor policy + token-budget validation documented here.
- [x] **First supervised end-to-end trial (2026-09-19)** — a fresh agent, given only this runbook,
      audited a 3-week window and produced 111 ops (108 link / 3 ignore / 0 unlink) with no op
      contradicting an existing human hard negative, no redundant op, and one identifiable false
      positive. It also caught a live auto-linker false positive (Aberfeldy 12 ↔ a Liberty listing
      at 2.24x, `prob` 0.9904). Cost: 250K tokens, 30 tool calls, 21 min.
- [x] **Trial-run hardening, round 3 (2026-09-19)** — everything the trial exposed:
      `pairs[].st/nst/same` (store + same-store), `pairs[].pr/prPct` (price ratio vs the dearer
      store's own distribution, from `_meta.eval.storePriceRatio`), `rar` rarity tiers,
      `--ultra-compact` (-37% bytes) and `--limit-pairs`, the proposal `review[]` needs-human
      channel (validated + echoed by the applier), `apply --verbose`, and a `decisions.jsonl`
      coverage artifact. Policy file rewritten: size tolerance, ABV/proof, limited editions,
      bundles/multipacks, same-store as a guide.
- [ ] Re-run the trial on a 6-weeks-ago → 3-weeks-ago window to measure whether the new evidence
      fields remove the false positives without costing recall, and whether per-run tokens drop.
- [ ] **The real remaining headroom is scoring, not retrieval or tooling:** 47.8% of near-miss
      pairs have no embedding vector because embeddings are keyed by the aggregate sku. Keying the
      re-embed by raw listing sku would make about half the near-miss surface scorable.
- [ ] Optimization: byte-offset index sidecar for `--from` deep-dives on the full ~100 MB rich file.
- [ ] Optional: `auto_link_classify` could persist via `writeLinks` (deduped) so the file stops
      accumulating transitive-redundant links and the first-apply `-24` surprise disappears.

## Gotchas learned

- Check `eval.embeddings` in `_meta` to confirm the file loaded at all. But even with it loaded,
  `hints:["no-embedding"]` is common and PER-CANDIDATE — the embeddings are keyed by the *aggregate*
  sku, so a store's alias listings (e.g. liberty `123851` vs canonical `id:8289426`) have no vector.
  This reproduces the live ranker exactly; don't treat it as a global load failure.
- `storedConfidence >= 1e8` = deterministic floor-pin (SMWS cask code), NOT a calibrated prob. Never
  unlink a pin.
- `flag:"hit"` means "auto-classify WOULD fire", NOT "correct". A same-brand sibling (e.g. Blue Run
  Reflection **II** vs **I**) can score ≥ bar; the agent must catch it. This is exactly what the
  audit exists for.
- Identical titles at different stores usually mean the SAME product but a different SKU — the
  `twins[]` surface is a real correctness win, not noise.
- The audit is read-only over the worktree; only the apply tool writes, and only `sku_links.json`.
- **One sku, two products (collision).** If a funnel page shows the same sku with different names
  (e.g. Blacksboat **12** vs Blacksboat **Bridge** 12 under one sku), the store has re-used a SKU for
  two products. The pair is link-worthy from one side and wrong from the other — do NOT link it; omit
  it (or ignore) and note it. This is the same class the `merge.js` collision guard fixes at ingest.
- Never run the generator without an explicit `--out` (unless you truly mean to regenerate the
  default rich file). Unknown flags now error, but a bare `node scripts/audit_new_listings.js` still
  regenerates.
- Delisted items have NO embedding vectors (emb rank −1) — the token channels must carry them. The
  search primitive includes delisted by default; `--no-delisted` excludes them (delisted ≈ 1,194).
- The delisted/history surface is CACHED: after the worktree's `db_commits.json` moves, delete
  `audit/.cache/history_surface.json` so the walk rebuilds — otherwise `audit_search` silently
  serves a stale surface.
- **`sizePen` can fire while `grpSizeConflict:0` and `grpSizeJaccard:1`.** The hint comes from the
  pairwise name-level size comparison, the `grp*` features from the canonical GROUPS' resolved
  sizes; they answer different questions and can legitimately disagree when one side's size is
  unstated. Treat `sizePen` as "the names imply different volumes", not as a group-level verdict.
- **A price quoted in prose is not evidence.** Prices differ per store and the row carries the
  anchor's price plus each candidate's *cheapest*; the trial run repeatedly justified links with
  prices that did not match any listing in `index.json`. Cite `price`/`pr`/`prPct` off the row.
- **Do not build ad-hoc heuristics and then apply them inconsistently.** The trial's
  "same store + different price ⇒ different products" rule rejected three pairs and was then
  ignored on three others; one of the links it allowed through was the run's only clear false
  positive. If a heuristic is worth using, it belongs in `data/sku_link_policy.md` where the human
  can see and rule on it — propose it there via `proposal.policy`.
- **Self-reported telemetry drifts.** The trial agent reported 21 tool calls against a harness-
  measured 30, and its context estimate was low by a wide margin. Report what you can measure
  (bytes read, rows paged) and leave token accounting to the harness.