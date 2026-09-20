# SKU-Link Audit Pipeline — Handoff for a Review Agent (2026-09-18)

This document is written so a **review agent** can verify and test the whole SKU-link
audit feature with minimal file reading. It summarizes the architecture, every tool's
contract, the exact commands, the measured baseline numbers to compare against, and the
safety invariants that must hold. Read the plan (`docs/audit-search-and-scale-plan.md`)
and run `--help` on each tool for full detail; this document is the fast path.

## 1. What this feature is

The SKU-link problem: ~6,600 raw listings across stores must be grouped into canonical
"same product" clusters (union-find over `data/sku_links.json`). Quality control has two
pillars:

1. **Auto-link classification** (`tools/auto_link_classify.mjs`, runs in CI) — appends
   high-confidence (`prob >= 0.95`) cross-store links as `status:"pending"`.
2. **Periodic AI-agent audits** — this feature. The agent reads a rich report of listings
   with live sameness scores, adjudicates link / no-link / need-human, and produces a
   **proposal** that a human reviews and applies. The human link pages (`#/link`,
   `#/link-rapid`, `#/link-review`) are slated for retirement once this loop is trusted.

The defect this feature addresses is a **retrieval wall**: the old blocker admitted
candidates only via distinctive tokens (IDF >= 4.6) plus SMWS cask keys, so a true match
whose brand term falls just under the cutoff (`glenfarclas` 4.45, `highland` 4.35) or that
is typo'd never entered the pool at all. Measured: the old blocker misses **60/5,723
(1.0%)** of known-positive pairs; the union leaves **0 absent from every channel** (56
recovered by token channels, 4 by embedding).

Two honest qualifications, both of which earlier drafts of this document got wrong:

1. **The comparable recall gain is 96.8% → 98.1% @ K=20, not 100%** (§5). The 100% figure
   was the `unionAny` column, which spends 4x the candidate budget.
2. **The union does not remove the 320/70 wall inside the ranker.** `recommendSimilar`
   still keeps `MAX_CHEAP_KEEP = 320` by deterministic score and fine-scores only
   `MAX_FINE = 70` before the GBT blend. The union changes what enters the pool; it cannot
   help a pair that cheap-scores below rank 70.

**Scope:** this changes the AUDIT REPORT only. `tools/auto_link_classify.mjs` (the CI
writer) does not import the core and still uses its own uncapped dist+SMWS blocker, so no
new pairs are auto-linked and no new alerts fire. None of this tooling runs in
`run_daily.sh` or CI — by design. It is hand-run for a one-time full-library audit and for
periodic (every few months) passes over new SKUs alongside a re-embed + retrain.

## 1.1 The scale answer — CORRECTED 2026-09-19

An earlier version of this section claimed ~21-25 tokens per SKU and that the entire
14,978-SKU library "fits as one readable load (~0.4-0.65M input tokens)". **Both were
wrong.** That estimate counted *title characters only* (`mean title 32.6 chars`), ignoring
every JSON key, SKU string, prob/det/price, hints array and the `why` prose that the tool
actually emits — and it contradicted this document's own §9 table by ~13x.

Measured from real compact output (`--only <funnel> --compact --format jsonl`):

| Funnel | rows | KB | B/row | tokens @4 B | tokens @3 B |
|---|---|---|---|---|---|
| near-misses | 900 | 649 | 738 | 166K | **221K** |
| orphans | 791 | 477 | 617 | 122K | 162K |
| want-links | 54 | 39 | 742 | 10K | 13K |

**~182-243 tokens per near-miss row**, not ~33. Use the 3 B/token column: compact rows are
dense JSON (15% digits, 25% structural punctuation), which tokenizes nearer 2.5-3 B/token,
not the 4 B/token prose heuristic. The document previously used 4 B/token throughout while
*also* citing 2.5 B/token in one place to justify a 1M-context claim; both divisors cannot
be right for the same bytes.

Consequences:
- The near-miss funnel is **~221K tokens and does not fit one 200K context**, paged or not.
- The full-history `all` funnel is ~4.9M tokens at 4 B/token, ~6.5M at 3 B — five to six
  full 1M contexts, not one.
- Every figure above is INPUT only. No output, no reasoning, no tool-call overhead, no
  re-reads, no deep-dives. §9 assumes "output ≈2.5x input" elsewhere in this document; if
  that holds, the near-miss pass is ~221K in + ~550K out.

What IS true and useful: **most SKUs need no decision.** 79% (window) / 86% (full) have no
above-bar or suspicious pair, so they need no adjudication. But they are still serialized
at full compact width (id, sku, canon, `why`, verified pairs), so "no decision" does not
mean "no tokens" — which is exactly why the measured 738 B/row is 6-7x the old estimate.

Nothing in the repo measures tokens with a real tokenizer. If a number matters, count it
with `messages.count_tokens`; do not trust a divisor.

## 2. Architecture (two layers)

**Layer A — the staged audit generator** (`scripts/audit_new_listings.js`):
- Stage 1 = generate a rich JSON file of listings-in-window + live-ranker scores per
  candidate AND per existing link.
- Stage 1.5 = derive views/deep-dives from the rich file with NO re-scoring
  (`--from`); `--compact` toy-sized rows; funnels (`--only`); deep-dive `--id/--sku/
  --cluster/--pair`.
- Stage 2 = (the agent) decide link/unlink/ignore per the runbook.
- Stage 3 = apply via `tools/apply_audit_proposal.js` (write-only, dry-run default).

**Layer B — the search primitive** (Phases 0-3b, this session): a **union blocking
index** that guarantees recall (closes the retrieval wall) and is shared by the CLI, the
generator, and the eval harness.

## 3. Files (and git state)

**Changes made 2026-09-19 during review** (all verified to leave the default-config output
byte-identical: 21,398 candidates, 900 near-miss, 41 above-bar pairs):
- `tools/audit_search_core.mjs` — apply `filterSimTokens` to fuzzy seeds (it was imported
  and never called, so the scorer's stoplist was bypassed and every generic word became a
  fuzzy seed). Median pool 464 → 225, runtime 100 s → 64 s, zero change to results.
  Rename `maxPerChannel` → `maxPerKey` (old name still accepted); count + export pool
  truncation.
- `tools/audit_search_eval.mjs` — add `unionMerged` (one pool, ranked once, cut at K) as the
  budget-comparable recall column; rename the old min-over-channels metric to `unionAny`.
  Add `EVAL_PROD_CAPS=1` to measure the shipped budgets.
- `viz/app/linker_page/suggestions.js` — `MAX_CHEAP_KEEP`/`MAX_FINE` overridable via
  `opts.maxCheapKeep`/`opts.maxFine`, defaults unchanged; the SPA passes neither.
- `scripts/audit_new_listings.js` — pass the above through as `AUDIT_MAX_CHEAP_KEEP`/
  `AUDIT_MAX_FINE`; log the previously-swallowed union-init error; report pool truncation.
- `tools/mine_sku_aliases.mjs` — human-owned `DENY_PAIRS` denylist so regeneration cannot
  resurrect the bogus rows (`light/night`, `doon/toon`, `dete/ete`, `port/post`,
  `rufty/tufty`, `gran/grand`). Table 38 → 32 rows; recall table unchanged.

Modified (tracked):
- `scripts/audit_new_listings.js` — Phase 2: `candidatesForAnchor` now builds its pool
  from `tools/audit_search_core.mjs::poolFor` (union of dist/topTerm/smws/twin/fuzzy, +
  optional embedding via `AUDIT_POOL_EMB=1`). Falls back to the OLD two-index blocker on
  any init failure. `_meta.eval` gains `pool` + `poolSizes`. Env knobs:
  `AUDIT_POOL_BUDGET` (700), `AUDIT_POOL_PER_CHANNEL` (150), `AUDIT_POOL_EMB` (0),
  `AUDIT_POOL_EMB_K` (200).
- `CLAUDE.md` — pointers to the plan and this document.

Untracked (new):
- `docs/audit-search-and-scale-plan.md` — the plan + measured results section.
- `docs/audit-runbook.md` — the agent's operating manual (setup, tool inventory, anchor
  policy, decision protocol, proposal schema, token budget, convergence).
- `docs/audit-search-review.md` — this document.
- `tools/audit_search_core.mjs` — shared core (see §4).
- `tools/audit_search_eval.mjs` — Phase 0 recall harness.
- `tools/audit_search.mjs` — Phase 1 search CLI.
- `tools/mine_sku_aliases.mjs` — Phase 3 alias miner.
- `viz/app/linker_page/sku_aliases.js` — generated alias table (re-emitted by the miner).
- `tools/apply_audit_proposal.js` — Stage 3 applier (pre-existing).
- `src/utils/sku_links_file.js` — shared read/write + dedupe for `data/sku_links.json`.

Gitignored (not tracked anywhere): `audit/` (rich files, `.cache/history_surface.json`).
On the DATA branch only (in `.worktrees/data/data/`): `sku_link_policy.md` — the
human-owned judgement-rules file; `sku_links.json` — the apply target.

**Working-tree assets the tools need** (all in `.worktrees/data/`, none on the data
branch): `viz/data/index.json` (restore from Release `index-latest`), `viz/data/
sku_embeddings.json` (restore from Release `embeddings-latest`), `viz/data/gbt_model.json`
(restore via `tools/linker_ml/CLAUDE.md` "Shipping the checkpoint" if absent),
`viz/data/db_commits.json` (committed), `data/sku_links.json` (committed).

## 4. `tools/audit_search_core.mjs` — API

Exports: `loadEnv(worktree)`, `normNameForTwin(name)`, `buildSurface({worktree, env,
includeDelisted, cacheFile})`, `loadSkuLinkPolicy(worktree)`, `buildBlockIndex(items,
{vocab, similarity, aliasTable})`, `buildEmbeddingIndex(worktree, items)`. Plus a CLI
self-check (`node tools/audit_search_core.mjs --worktree <wt> --sku <sku>`).

- `loadEnv` sets `process.env.DATA_WORKTREE` and dynamically imports
  `tools/linker_ml/featurize.mjs::buildEnv` → `{allAgg, vocab, sizeFn, priceFn,
  allLinks, ignoreEntries}`. Set the env var BEFORE importing.
- `buildSurface` → `{items, byKey, stats}`. `items` = current aggregates (`{sku,
  normKey, name, stores:Set, cheapestPriceNum, category, delisted:false}`) plus, when
  `includeDelisted`, **1,194 delisted SKUs** recovered by walking `data/db/**` git history
  via `db_commits.json` (~3 m 9 s cold first run; ~19 s warm, cached at
  `audit/.cache/history_surface.json`, keyed on `dbCommits.generatedAt`). Delisted items
  have last-seen names, no embedding vectors.
- `buildBlockIndex` → `{poolFor(anchor, {channels, maxPerChannel, limit})}`. Channels:
  `dist` (distinctive-unigram, IDF ≥ 4.6, the OLD blocker), `topTerm` (each item's most
  distinctive term — guarantees low-IDF brand reachability), `smws` (SMWS cask key),
  `twin` (normalized-title bucket), `fuzzy` (letter-trigram + bounded Levenshtein ≤1,
  ≤2 for len ≥6, alias-expanded via `SKU_ALIASES`, ≤8 variants/token). Auto-loads the
  alias table when `aliasTable` is null.
- `buildEmbeddingIndex` → `{count, vectorFor, nearest(item, K)}` (brute-force cosine,
  ~6.7 ms/anchor) or `null` if the file is missing. Keyed by raw + normalized SKU.

## 5. Measured baselines — CORRECTED 2026-09-19

### Recall (Layer B), sampled gold set n=316 records

| K | current | topTerm | fuzzy | emb | unionMerged | unionAny |
|---|---------|---------|-------|-----|-------------|----------|
| 5 | 88.0 | 75.0 | 89.2 | 94.9 | 88.9 | 97.8 |
| 10 | 95.3 | 77.8 | 96.5 | 98.4 | 96.2 | 99.1 |
| 20 | 96.8 | 78.5 | 98.1 | 99.4 | **98.1** | 100.0 |
| 50 | 98.4 | 78.5 | 99.7 | 99.7 | 99.7 | 100.0 |
| 100 | 98.7 | 78.5 | 100.0 | 99.7 | **100.0** | 100.0 |

**`unionMerged` is the number to quote — 98.1% @ K=20, not 100%.** It is one merged pool,
ranked once by det score, cut at K: the same contract as `current`. The previous headline
"union 100.0 @ K=20" was the `unionAny` column — the best rank across four *separately
ranked* lists (`r.union = Math.min(...)`), which at K spends up to 4xK candidate slots and
is not budget-comparable to `current`. The channels aren't even on one scale (token
channels rank by det score, `emb` by cosine). `unionAny` is kept for diagnosis only.

The honest summary of the gain: marginal at low K (88.0 → 88.9 @5, 96.8 → 98.1 @20),
real at depth (98.7 → 100.0 @100), and structurally real — the old blocker misses
**60/5,723 known positives (1.0%)** and the union leaves **0 absent from every channel**
(56 recovered by token channels, 4 by embedding). `EVAL_PROD_CAPS=1` re-runs at the shipped
700/150 budgets; result is unchanged, so the caps are not currently costing recall.

Note `emb` alone is the strongest single channel at low K (94.9 @5; 98.8 @5 on the HONEST
subset) — and it is **off by default** in production (`AUDIT_POOL_EMB=0`).

### What these numbers cannot tell you

- **The gold set is the labels the system helped create.** It is `data/sku_links.json` +
  `sku_links_auto.json`; 901 of 6,671 edges are the ranker's own auto-link output, hence
  tautologically retrievable. A pair the old blocker could never surface could never have
  been shown to a human to become a label, so "1.0% missed" is a floor that cannot see the
  population it estimates.
- **The fuzzy channel's alias table is mined from those same labels**, with no split.
- **No precision is measured anywhere.** The harness has one metric function, `recall()`.
  `env.ignoreEntries` holds 12,604 curated hard negatives and the eval never reads them.
- **The `HONEST` subset (n=85) is TEST+VAL**, includes VAL (used for model selection), and
  is effectively a handful of canonical groups rather than 85 independent samples. The
  "HONEST & shared-token=0" cell is n=0-1 and is not a measurement.
- Sampling is a deterministic every-k-th stride over link-file insertion order, not a
  seeded random sample, and it samples anchors (so high-degree clusters dominate).

### Layer A, full generator run (2026-09-19, after the stopword fix)

4,344 listings, 4,316 scored, **21,398 candidates**, 4,378 verified pairs, 900 near-miss
listings, 362 twins, 186 auto-linked, 791 orphans; pool size min 0 / **median 225** / max
700; runtime **64 s**. Funnels: **54 want-links, 0 need-unlinks**.

The stopword fix (applying `filterSimTokens` to fuzzy seeds, which was imported but never
called) halved median pool size (464 → 225) and cut runtime ~35% with **zero change to the
decision surface**: the above-bar pair set is identical before and after (41 pairs, 0 lost,
0 gained).

Pre-union baseline (2026-09-17) for comparison: 4,287 listings, 19,798 candidates, 869
near-miss, 772 orphans, 33 want-links, 0 need-unlinks. The want-links move 33 → 54 is the
union's actual yield: 21 more listings with an above-bar candidate to adjudicate.

### The pool is not the bottleneck (measured 2026-09-19)

| Config | pool budget / perKey | median pool | candidates | aboveBar pairs |
|---|---|---|---|---|
| shipped default | 700 / 150 | 225 | 21,398 | 41 |
| wide (no truncation) | 6,000 / 3,000 | 378 | 21,398 | **41** |

An 8.5x wider pool with zero truncation changes **nothing**. The binding constraint is
inside `recommendSimilar`: `MAX_CHEAP_KEEP = 320` (kept by deterministic score) then
`MAX_FINE = 70` (the only candidates that reach the GBT blend). A pair that cheap-scores
below rank 70 cannot be rescued by a bigger pool — and the det score is precisely what is
known to mis-rank pairs with a missing embedding.

Both are now overridable (`opts.maxCheapKeep` / `opts.maxFine`, defaults 320/70 unchanged;
the SPA passes neither) and exposed to the generator as `AUDIT_MAX_CHEAP_KEEP` /
`AUDIT_MAX_FINE`. Truncation is counted and reported (`_meta.eval.pool.truncation`); at the
shipped budgets it drops ~1.46M per-key candidate slots across 4,316 anchors.

**But widening the funnel does not help either — measured, and the result argues AGAINST it:**

| Config | pool | cheapKeep/fine | runtime | aboveBar | new |
|---|---|---|---|---|---|
| default | 700/150 | 320/70 | 64 s | 41 | — |
| wide pool | 6000/3000 | 320/70 | 99 s | 41 | 0 |
| deep funnel | 6000/3000 | 1500/400 | 182 s | 42 | **1, and it is a false positive** |

The single pair the deep funnel adds is `309805 | id:1045917` at **prob 0.9944**:
`Macaloney's Island Distillery An Aba Lightly Peated Single Malt 700 mL` vs
`MACALONEY W&B SINGLE BARREL SINGLE MALT WHISKY 750ML` — two *different* expressions from
one distillery, i.e. exactly the same-distillery-different-expression noise the IDF vocab
exists to suppress, scored above the 0.95 auto-link bar.

**Conclusion: the retrieval layer is saturated at the shipped defaults.** For the one-time
full-library audit, run at the defaults. Do not raise the pool budget (no effect) and do not
raise the funnel cuts (3x runtime for one wrong answer). The knobs exist now so this can be
re-tested cheaply when the catalog or the model changes, not because they should be turned
up. The remaining recall headroom is not in retrieval — it is in the 48% of near-miss pairs
that have no embedding vector (below).

### The scoring gap the recall numbers hide

Retrieval is fixed; scoring on alias listings is not. In the measured near-miss funnel,
**858 of 1,784 pairs (48%) carry `hints:["no-embedding"]`** — with `sku_embeddings.json`
loaded (`_meta.eval.embeddings: true`). Embeddings are keyed by the aggregate SKU, so a
store's alias listing has no vector. **42 pairs have byte-identical names to their anchor
and still score below bar:**

```
0123851 | 123851    prob=0.28  $1799.99 vs $1799.99  Glenfiddich 21 Year Old Wedgwood Decanter
u:01363b66|u:c6d5f307 prob=0.14 $699.99 vs $699.99   Michters Single Barrel 10 Yr Bourbon
u:1bba385b|u:0fee1ce2 prob=0.67 $199.99 vs $199.99   Weller Antique 107 750mL
```

GBT recall@99% is 14.5% → 69% *from* embeddings, so `prob` without a vector is deliberately
under-confident. **Treat a below-bar no-embedding pair as unscored, not as a negative.**
This is structural, not the environment caveat in §7.

### Alias table, policy, apply

Alias table: 38 aliases / 76 map keys, support >= 2, deterministic. Blocking-only — verified
by full-repo grep that no scoring or featurization module imports it. Human-trim pending on
`light/night`, `doon/toon`, `dete/ete`, `port/post`, `rufty/tufty`, and also `gran/grand`
(Gran Patron vs Grand Marnier) — `port` in particular is a load-bearing whisky term.

Policy file: `data/sku_link_policy.md` on the data branch, 8 seed decision rows.
Apply: `data/sku_links.json` is 5,770 links / 12,604 ignores, ~24 transitively redundant.

## 6. Review checklist

Setup:
1. `cd /home/brennan/spirit-tracker`.
2. Restore the worktree assets (see §3) if missing: `index.json` from Release
   `index-latest`, `sku_embeddings.json` from Release `embeddings-latest`, `gbt_model.json`
   per `tools/linker_ml/CLAUDE.md`.
3. `node --check` every file in §3 (all must pass).

Functionality (run each; compare to §5):
4. `node tools/audit_search_eval.mjs` → recall table matches §5; `unionMerged` must read
   98.1 @ K=20 and 100.0 @ K=100 (env knobs `ANCHOR_LIMIT`, `AUDIT_INCLUDE_DELISTED=1`,
   `EVAL_PROD_CAPS=1`). Quote `unionMerged`, never `unionAny`.
5. CLI smokes (`node tools/audit_search.mjs`):
   - `--sku 773002 --top 10` → Aberfeldy 12 rows (e.g. `u:9c600168`, `upc:500027700345`,
     `upc:501806620025`-style names);
   - `--query "glenfarclas 12 co-op exclusive" --top 10` → Co-op Glenfarclas 12 at #1;
   - `--query "glenfarklas 12" --top 10` → Typo recovered via the `fuzzy` channel;
   - `--json` on either → valid JSON (`[ {_meta}, {rank,...}, ... ]`);
   - delisted rows appear by default, absent with `--no-delisted`;
   - exit codes: `--help` 0, missing `--sku`/`--query` 2, unknown flag 2,
     not-found SKU 1.
6. Generator: `node scripts/audit_new_listings.js --root /home/brennan/spirit-tracker/
   .worktrees/data --out audit/review_check.jsonl` (~64 s) → 21,398 candidates, 900
   near-miss, 54 want-links, 0 need-unlinks (within catalog-growth noise); then
   `--from audit/review_check.jsonl --only near-misses --compact --format jsonl` works; a
   `--from ... --pair "<a>|<b>"` deep-dive returns 41 features; and confirm the Glenfarclas
   Co-op pair scores >= 0.95.
7. Alias miner: `node tools/mine_sku_aliases.mjs` → re-emits 32 rows, byte-identical
   output (deterministic), reports `dropped vs denylist: 6`,
   `node --check viz/app/linker_page/sku_aliases.js`.
8. Policy: `loadSkuLinkPolicy("<worktree>")` → `exists:true`, 8 rules; file present at
   `.worktrees/data/data/sku_link_policy.md`.
9. Apply (write-only): craft a tiny proposal (context: each link is `{fromSku,toSku}`;
   `unlink` ops or `ignore` ops), run
   `node tools/apply_audit_proposal.js --proposal <f>` → dry-run diff + `summary`;
   confirm **no file write** without `--apply`; confirm contradictory ops fail closed;
   confirm `git status` in the worktree shows no change to `data/sku_links.json` after
   dry-run.

Non-regression / invariants (the whole point):
10. None of the tools commit, push, or write to the data branch; only
    `apply_audit_proposal.js --apply` writes `data/sku_links.json` (intentionally).
11. `--from` views do zero scoring (verify `poolFor`/`buildEmbeddingIndex` are never
    called on the `--from` path).
12. Pins protected: never propose/review unlinking `storedConfidence >= 1e8` links
    (SMWS floor-pins; `need-unlinks` excludes them).
13. Generator falls back to the old two-index blocker if the core import/init fails
    (simulate by pointing `ROOT` at a broken worktree or renaming the core module).
14. `git status` tracked-modified set: `CLAUDE.md`, `scripts/audit_new_listings.js`,
    `viz/app/linker_page/suggestions.js` (opts-only, defaults unchanged), plus the user's
    own `.github/workflows/cron_tracker.yaml` zyn edit — leave that alone. Untracked: §3.
15. Default-config regression guard: the generator at default env must still emit **21,398
    candidates / 900 near-miss / 41 above-bar pairs**. Any drift means an opts default
    leaked into production scoring.

## 7. Known caveats & risks

- **Delisted items have no embedding vectors** (last-seen names only) → emb rank −1 for
  those pairs; token channels are the coverage there. Delisted items also weighed the
  union token channels' recall only slightly (union@50 100% both runs).
- **Pool truncation cuts in catalog order, not by relevance.** `poolFor` fills channels
  sequentially (dist first) and both caps (`maxPerKey`, then `limit`) take the first N in
  Set-insertion order — there is no score at pool-build time. The old blocker in
  `auto_link_classify.mjs` is UNCAPPED, so on a bucket deeper than `maxPerKey` the union
  can drop a candidate the old path kept. Measured at the shipped 700/150 budgets the
  recall table is unchanged, so it is not currently costing anything, but it is now
  counted: `_meta.eval.pool.truncation` reports keys/anchors hit and candidates dropped,
  and the generator prints a line when a cap binds. **For a one-time full-library audit,
  raise `AUDIT_POOL_BUDGET`/`AUDIT_POOL_PER_CHANNEL` rather than accepting the defaults** —
  they were tuned for a fast incremental run.
- **Post-pool truncation is untouched and is the residual wall.** `recommendSimilar` keeps
  `MAX_CHEAP_KEEP = 320` by deterministic score, then fine-scores only `MAX_FINE = 70`
  before the GBT blend runs. The det score is exactly what is known to mis-rank matches
  with a missing embedding, and it is the sole gate into the blend. Growing the pool cannot
  help a pair that cheap-scores below rank 70. Verified: the above-bar pair set is
  unchanged (41 pairs) across the stopword fix, but nothing has measured this boundary
  directly.
- **48% of near-miss pairs have no embedding vector** even with the file loaded — see §5.
  A below-bar `prob` on such a pair is unscored, not a negative. `_meta.eval.embeddings`
  only reports whether the FILE loaded; per-candidate starvation is separate.
- **No precision/false-positive measurement exists** for the union change. The harness
  measures recall only; the 12,604 curated ignores in `env.ignoreEntries` are never read.
  Before trusting "precision-preserving", diff the `aboveBar` pair set pre/post and sample
  new fuzzy-only pairs that clear 0.95.
- **Eval labels are the labeled set, not truth**: shared-token/recall-on-labels is a
  floor; the gold set grows as links are confirmed (5,723 → 6,638 with delisted).
- **Alias table dubious rows** (see §5): `light/night`, `doon/toon`, `dete/ete`,
  `port/post`, `rufty/tufty`, `gran/grand` — blocking-only, human-trim pending.
- **`mine_sku_aliases.mjs`/`audit_search_core.mjs` have no `--help`** (only the CLI,
  generator, and applier do); core self-check is the `node … --worktree … --sku …`
  invocation.
- **`scripts/audit_new_listings.js` now depends on `tools/audit_search_core.mjs`** at
  runtime (dynamically imported; graceful fallback exists).
- Do NOT run the generator (stage-1) without `--out` when you didn't mean to regenerate —
  it overwrites the default `audit/*` path. (`--from` view/deep-dive mode without `--out`
  is now a hard exit 2, so that path is safe.)
- Full near-miss pass needs 9 `--offset` batches (default window) / 56 pages (full
  history). At a realistic 3 B/token it is ~221K tokens and does NOT fit a single 200K
  context — batch it, and budget output + deep-dives separately (see §1.1).
- Delisted-name recovery first run is ~3 m 9 s cold (~19 s warm) and cached; delete
  `audit/.cache/history_surface.json` only if the db history changes shape.

## 8. Environment

- Public repo `brennanwilkes/spirit-tracker`; main checkout + `.worktrees/data` worktree
  (data branch) are both present locally. `git remote*` is blocked by policy.
- No npm deps; plain Node 18+; ESM mixed with CJS via dynamic `import()` — set
  `process.env.DATA_WORKTREE` before importing `featurize.mjs`.
- User commits code manually at end of session. Only the user's own
  `cron_tracker.yaml` edit exists besides this feature's changes.
- **Not wired into CI, by design.** Intended use is (a) a one-time audit across the whole
  library and (b) a periodic pass over new SKUs every few months, run together with a
  re-embed + retrain. Approve → trainable positive, reject → trainable hard negative, so
  audit quality feeds the next `tools/linker_ml` retrain directly.

## 9. Post-QA + full-history scale (2026-09-18, afternoon)

**Note (2026-09-19):** a later review round DID find substantive problems that this
section's "no bugs" framing missed — a dead `filterSimTokens` import that disabled the
fuzzy channel's stopword guard, a non-comparable headline recall metric, and token
estimates 6-7x low. See §1.1, §5 and §7. The items below remain accurate as far as they go.

**Adversarial QA round.** A hostile-review agent tried to break every contract;
it found the following, all fixed:
- `--from` (deep-dive/view) WITHOUT `--out` now **exits 2** and refuses to touch the
  default rich path (previously it silently overwrote `audit/new_listings_*.jsonl`).
- An **empty/blank `--from` file** now **exits 2** ("unrecognized file shape") instead of
  producing a valid-shaped empty view.
- **Streaming I/O landed**: stage-1 writes batched ndjson (`writeJsonlBatched`, BATCH=200)
  and `--from` reads via `readline`, so arbitrarily large rich files work. Verified:
  full-history `scale_full.jsonl` (715.8 MB) view-emits 5,522 near-miss rows in **6.6 s**
  and `--pair` deep-dives in 7.0 s (previously both hit `RangeError` /
  `ERR_STRING_TOO_LONG`). Legacy single-JSON and jsonl reads still work; output formats
  unchanged.
- Missing `viz/data/index.json` now prints a friendly **`index-latest` restore hint** then
  exits 1 (no silent fallback).
- Numeric refresh: eval now computes the missed-positives count live — **60/5,723 (1.0%)**
  missed by the current blocker, 56 token-recoverable, 4 embedding-only, **0 still
  absent**; `featureColumns: 41` everywhere; default-window regen re-measured **~100-108 s**;
  delisted cold rebuild ~3 m 9 s / warm ~19 s.
- Apply-tool dry-runs left `data/sku_links.json` **byte-identical** across the whole
  hostile suite; contradictory ops, unknown ops, self-links all fail closed.

**Full-history ("entire library from the beginning") — measured** (start: 2026-01-19):
- Rich generation: **34,247 listings, 164,537 candidates, 37,318 verified pairs,
  5,522 near-miss listings / 12,158 pairs**, wall time **11 m 52 s**, ~716 MB file
  (now streamable end-to-end). One-time cost; incremental windows are ~45-100 s.
- Compact funnel geometry (tokens ≈ B/4; pages at 100 rows/page):

| Funnel | rows | KB | tokens @4 B | tokens @3 B | pages |
|---|---|---|---|---|---|
| all | 34,247 | 19,028 | 4.87M | **6.51M** | 343 |
| has-links | 30,949 | 17,274 | 4.42M | 5.90M | 310 |
| near-misses | 5,522 | 4,010 | 1.03M | **1.37M** | 56 |
| orphans | 3,298 | 1,761 | 451K | 601K | 33 |
| want-links | 470 | 295 | 76K | 101K | 5 |
| auto-linked | 448 | 251 | 64K | 86K | 5 |
| need-unlinks | 0 | 5 | 1.3K | 1.7K | 1 |

Use the 3 B/token column (§1.1). Note the full-history near-miss funnel alone exceeds a 1M
context at a realistic divisor, and `all` is five to six full 1M contexts — so §1.1's
former "entire library in one load" claim was wrong by roughly an order of magnitude.

- SKU coverage: 14,978 unique SKUs = 11,220 live-now + 6,580 ever-delisted (8,398
  live-only, 3,758 delisted-only, 2,822 both). Default-window increment scale-up:
  ×7.9 listings, ×7.7 candidates, ×6.8 near-miss pairs vs the 9-page default audit.
- Effort (disclosed assumptions: tokens≈B/4, output ≈2.5× input, deep-dive ≈2.4K
  tokens/call, ~150K usable per 200K ctx): exhaustive two-pass read-along of ALL funnels
  ≈ 193-257 sessions @200K (~39-51 @1M); single-pass near-miss sweep ≈ 56 pages / ~30-40
  sessions @200K (~6-8 @1M). Combine with §1.1's per-SKU numbers — the high-value skim
  (near-misses + orphans, ~86 pg) is comfortably a 1M-context handful of sessions.
- Sanity kept: page-token ≈ 15-20K each (a 200K session holds 10-13 pages; a 1M session
  50-66).

**Still-open items** (see runbook): batch the full-history funnel by `--offset` when
context-constrained; human-trim the 5 dubious alias rows; re-run the alias miner when the
confirmed-link set grows; the deep-dive `--pair` "40-col → 41-col" prose is fixed in code
and docs.