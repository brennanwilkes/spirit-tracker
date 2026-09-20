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
- **Then check it is FRESH, not merely present. This is the single most damaging way an audit run
  can go wrong.** A stale embeddings file looks completely healthy: the file loads,
  `_meta.eval.embeddings` is `true`, and the run finishes. But every SKU added since the file was
  encoded has no vector, the GBT takes its conservative missing-embedding branch, and those pairs
  score near zero — so an audit whose whole purpose is NEW listings is blind on exactly the
  listings it was run for. Measured 2026-09-19: the `embeddings-latest` asset had been frozen since
  2026-08-20 (a CI venv failure, see CLAUDE.md), and the 2026-08-08..08-29 window re-run with fresh
  vectors went from **48% of near-miss pairs flagged `no-embedding` → 0%**, near-miss listings
  107 → 68, want-links 6 → 17. Nothing in the report said anything was wrong.
  ```bash
  gh release view embeddings-latest --json assets \
    --jq '.assets[] | "\(.name) updated=\(.updatedAt)"'     # must be within ~a day
  ```
  If it is stale, re-encode locally (~15 s on CPU once the venv exists) rather than auditing blind:
  ```bash
  node tools/linker_ml/build_dataset.mjs \
    && LINKER_MODEL_DIR=$PWD/tools/linker_ml/out/model_ft tools/linker_ml/.venv/bin/python tools/linker_ml/encode.py \
    && cp -f tools/linker_ml/out/embeddings.json .worktrees/data/viz/data/sku_embeddings.json
  ```
  Vector count must equal `sku_texts.jsonl`'s line count. A ~300-SKU shortfall against the 14,088
  catalog aggregates is EXPECTED and correct — those are `sku_hidden.json` listings, which the
  linker ML excludes from everything by design.
- `gbt_model.json` + `db_commits.json` ARE committed on the data branch — nothing to fetch.
  `db_commits.json` drives the **delisted-history cache** (`audit/.cache/history_surface.json`,
  keyed to its `generatedAt`). If the worktree is stale, delete the cache so it rebuilds:
  `rm -f audit/.cache/history_surface.json`.
- **First run of anything that builds the delisted surface takes ~2 minutes** (it walks 136 files
  of `data/db/**` git history). Every later run is ~2 s from `audit/.cache/history_surface.json`.
  Do not assume it has hung.
- Sanity check the env loads: `node tools/audit_search_core.mjs` prints
  `env: <n> aggregates ...` and `surface: <n> items (current=..., delisted=..., fromCache=...)`.
  `delisted ≈ 1,194` and `embeddings: 13785` are the healthy signatures (the embeddings
  count tracks the catalog — treat a number well below it as the staleness symptom above, not a
  constant to match). The surface cache is
  rebuilt only when `db_commits.json`'s `generatedAt` changes.

## Tool inventory (as of 2026-09-18)

| Tool | Purpose / CLI |
|------|---------------|
| `scripts/audit_new_listings.js` | Stage-1 rich generator + stage-1.5 views. `--since/--until/--only/--root/--format/--out`; `--from <rich>` views; `--compact`/`--ultra-compact`/`--limit-pairs` only with `--from`; `--id/--sku/--cluster/--pair`. Union-blocker env knobs: `AUDIT_POOL_BUDGET` (700), `AUDIT_POOL_PER_CHANNEL` (150), `AUDIT_POOL_EMB=1` (+ `AUDIT_POOL_EMB_K` 200) |
| `tools/audit_search.mjs` | **Phase 1 search primitive CLI.** `--sku <key>`, `--query "<text>"` or `--grep "<regex>"` (exactly one). **`--grep` is the exhaustive, unranked catalog census** — every listing whose name matches, with per-store urls; ranked search cannot answer "show me all the X", and a hand-rolled grep over `data/db` silently misses listings (measured: 2 found vs 8 real). Exit 1 when nothing matches. `--top K` (25), `--worktree`, `--category`/`--store` (soft annotations — recorded, never filter), `--no-delisted`, `--json`, `--help/-h`. Exit 0 help / **exit 1 not-found / exit 2 bad-args**. Ranks by live `det` → (query mode) `similarityScore` → `prob` → `cos` → sku; `channels` names the blocking channels that surfaced each hit |
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

**Deep-dive return shapes differ — do not guess:** `--id` returns ONE rich row (an object),
`--sku` returns a BARE ARRAY of rich rows, `--cluster` returns `{members, missingFromWindow}`,
and `--pair` returns `{found, matches:[…]}`. Rich rows carry `current.url`, which the compact
views drop; when a URL slug is the evidence you need (it routinely encodes the GTIN/EAN and the
bottle size) use `--id`, or `audit_search --grep`, which prints every matching listing's url.

**Which sku STRING to write in a proposal.** Both `7433052` and `id:7433052` occur; the loaders
run `normalizeImplicitSkuKey`, which strips the `id:` prefix, so the two forms resolve to the SAME
entity and either will work. **Write the form the row shows you** (the anchor's `sku` for an
anchor, `pairs[].sku` for a candidate) so the file stays greppable against the catalog. `u:` and
`upc:` prefixes are NOT stripped and must be written exactly.

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
  hints?, pol?, flag?}`. Features are dropped; deep-dive (`--pair`/`--id`) when you need them.
  View `_meta.legend` documents every one of these.
- `--limit-pairs <n>` caps pairs per row (default 6 under `--ultra-compact`, uncapped otherwise),
  ordered `hit` → `susp` → verified → rest, then by `prob`. **That ordering biases what you see**:
  flagged pairs are disproportionately `no-embedding` ones, so a truncated view looks like a much
  higher no-embedding rate than the funnel actually has. Do not infer population statistics from a
  capped page.

### Reading the fields (don't guess)

- **`vl` — THIS listing's existing links, re-scored live. The PRECISION surface; added 2026-09-20.**
  `[partnerSku, partnerName, prob, source, flag]`. `source`: `m` manual/legacy, `a` auto-classify,
  `g` agent-audit. `flag`: `!` re-scores BELOW bar and is NOT pinned — a removal candidate, judge
  it; `p` deterministic floor-pin (SMWS cask code, **not** a probability — never unlink). **No flag
  means it scored above bar, which is evidence but NOT proof: a wrong link the model still likes
  looks exactly like a correct one.** Before this field existed the compact views showed only
  `links: <count>`, and nothing at all under `--ultra-compact`, so an agent could propose new links
  but could not meaningfully remove bad ones. If you are auditing a slice for correctness, `vl` is
  half the job — do not skip rows just because they have no `pairs`.
- `pairs[].t`: `c` live candidate, `v` verified existing link, `w` title-twin (identical normalized
  title that never reached the candidate pool).
- **`pairs[].pol`: a HARD conflict with `data/sku_link_policy.md` that the scorer does not veto.**
  Two mechanical rules, both grounded in evidence rather than guesswork:
  - `size:<a>vs<b>` — both sides state a size and the canonical buckets are disjoint. 700≡750 and
    350≡375 are already tolerated, so this never fires on those. The anchor side uses THIS
    listing's own title when it states a size, falling back to the aggregate's name variants — a
    sku whose variants disagree with each other would otherwise match every size at once.
  - `store-exclusive:<store>` — that store's own marker appears in exactly ONE of the two titles,
    and that store actually carries one of the two listings. Per policy this almost always marks
    that store's exclusive single cask. Matching is whitespace-delimited, so `coop` does not fire
    on "Cooper's"; the marker list is deliberately narrow and omits words like `legacy`, `liberty`,
    `vessel` and `gull` that occur in real product names.

  **An above-bar pair carrying `pol` must not be accepted on `prob` alone** — decide it on the
  evidence or route it to `review[]`. Measured 2026-09-19 over the full window: 259 size conflicts
  and 4 store-exclusive conflicts, of which **2 were above the auto-link bar** (`Glenfarclas 12
  Year Old` ↔ `Glenfarclas 12 yr Co-op Exclusive Cask` at 0.9677, and `Decadent Drams Glenlitigious
  12 Year KWM` ↔ the non-KWM listing at 0.9695). Below bar, `pol` is the cheapest possible
  dismissal — a `size:50vs700` near-miss needs no deep-dive at all.
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
- `need-unlinks` — **ANY existing link, whatever wrote it**, whose live re-score fell below bar
  (pins excluded). **Changed 2026-09-20:** this was gated on `wasAutoLinked` + `kind ==
  "auto-link"`, so it could never see a manual link — and 5,622 of 5,922 link entries (95%) are
  manual/legacy with no `source`. `need-unlinks: 0` used to mean "no bad AUTO links", not "no bad
  links". On one window the gate hid 180 of 182 below-bar links. Do not read a pre-2026-09-20 run's
  `need-unlinks` count as evidence the link file is clean.
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
# EXHAUSTIVE unranked census — every listing whose name matches, with urls:
node tools/audit_search.mjs --grep "eagle rare"
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
they ARE the same bottling**; limited/annual edition → separate; store/exclusive cask → **separate** (a store name or abbreviation in the title marks its own single cask);
gift/sampler/tasting set → separate; bundle/multipack → judgement, and a bundle containing a rare
(allocated) item links to that rare item's group with its price premium accepted.

- Where the table has a rule, the decision is **determined**: follow it, cite it in the proposal
  `why`.
- Where the data suggests a NEW class or a changed call, **propose an amendment in the audit
  report** (`proposal.policy` field — see Stage 3), with concrete `(SKU, name)` evidence and the
  verdict you want. **Never edit the policy file and never decide by an unrecorded rule** — that is
  how the human-owned policy drifts.

## Auditing a COMPLETE SLICE (the trust-nothing mode)

The funnels above **sample**; they do not cover. A funnel pass answers "what stands out", not "is
this slice correct". When the task is to fully audit every SKU in a window — new links needed,
existing links removed, ignores recorded — use this mode instead.

**1. Define the slice explicitly, and know the default is not the library.** The generator defaults
to listings first seen since **2026-06-12T18:47:49Z** (the first auto-classify commit), which is
**4,344 of 34,247 listing units — 12.7%**. This has caused a real false conclusion: two Springbank
bundles the owner knew should link (`id:8768911`, `id:8768913`) were first seen 2026-05-27 and were
therefore invisible to every funnel, which read as "the audit found nothing" rather than "the audit
never looked". Pass `--since <ISO>` / `--until <ISO>` deliberately, and `--since 1970-01-01` for
whole history. State the slice in the proposal's `auditRef`.

Delisted listings ARE in scope and are not filtered (660 of 4,344 in one window carry
`current.removed:true`). Their price history still belongs to the right canonical group.

**2. Build the slice view with `--only all`, not a funnel.**

    node scripts/audit_new_listings.js --from <rich> --only all --ultra-compact \
         --offset <n> --limit <m> --format jsonl --out audit/slice-<n>.jsonl

`_meta.window` carries `remaining`/`nextOffset` for mechanical paging.

**3. Every row gets BOTH questions, and they use different fields.**

| question | field | verdict |
|---|---|---|
| Does it need a link it does not have? | `pairs[]` (candidates/twins) | `link`, or `ignore`, or no-op |
| Are the links it already has correct? | **`vl[]`** (existing links, re-scored) | `unlink` (+ auto ignore), or confirm |

A row with no `pairs` is NOT automatically a no-op — check `vl` first. A row with neither `pairs`
nor `vl` is a genuine no-op: an unlinked listing nothing matched. Record it as `noop` anyway; the
coverage contract is per-row, not per-op.

**4. Judging `vl`.** A `!` flag (below bar, not pinned) is a removal candidate, not a verdict —
re-score drift also happens when a store retitles or the aggregate name changes. Read the partner
name. A `p` flag is a deterministic floor-pin: never unlink. **An unflagged link is not proven
correct** — the known false positives (Aberfeldy 12 at prob 0.9904, Blanton's Original ↔ Special
Reserve at 0.995) all scored high. Apply the policy file to the two names exactly as you would to a
candidate pair; the fact that someone already linked them is not evidence.

**5. Coverage contract for a slice audit: every listing in the slice appears in `decisions.jsonl`.**
Not every funnel row — every row in the slice. Diff your ids against `--only all` for the same
offset/limit and report `0 missing, 0 extra`. A partial slice is fine if you say exactly where you
stopped (`--offset` reached); silently skipping rows is not.

**6. Report link:ignore:unlink:noop, and bucket ignores by the model's own `prob`.** A raw ignore
count is not informative — see the ignore policy in Stage 2. Report the band breakdown.

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
   - **`pol` on ANY pair overrides `prob`.** It is a hard conflict with the policy file that the
     scorer does not veto, so an above-bar `pol` pair is a likely auto-linker false positive, not
     a confirmation. Below bar it is the cheapest dismissal available — take it and move on
     without a deep-dive.
   - `pruned` — sku left the catalog; no op.
   - **Ignore policy — ignores are a PRIMARY deliverable, not cleanup.** The labeled set is the
     product of this audit (see CLAUDE.md §"Strategic direction"): `data/sku_links.json` links are
     the positives and its `ignores` are the curated hard negatives, and the next linker retrain
     learns from both. A run that emits 108 links and 3 ignores (trial 1, 2026-09-19) has thrown
     away most of its value — every pair you looked at and rejected was a hard negative you were
     handed for free and then discarded.

     **The rule: if you adjudicated a pair and decided against it, emit the `ignore`.** Not "if it
     was close". Not "if the policy has a row for it". You read it, you rejected it, it becomes a
     label. Anything on a pair row reached you through retrieval AND ranking, so by construction
     the tooling already found it plausible — that is exactly the population a hard negative is
     worth having.

     **But retrieval does NOT imply plausibility, and an earlier version of this rule said it did.**
     The blocker retrieves on shared tokens, and tokens collide by coincidence: the 2026-09-20
     orphan run emitted `West Cork Original` vs `High West Bourbon` (shared token "west"),
     `Leiper's Fork Bottled in Bond` vs `Rebecca Creek Bottled in Bond` ("in bond"), and
     `Inversion Passion Fruit Mai Tai` vs `Ron Caribu Passion Fruit`. Those are DIFFERENT BRANDS
     that share a generic word. They are correct rejections and worthless labels — nothing would
     ever have confused them. 105 of those 177 sat at `prob < 0.01`.

     **The test is confusability, not token overlap: would a careful person, or the model, have a
     real chance of treating these as the same product?** In practice that means the same brand AND
     the same product family. Emit the ignore when either holds:
     - the pair scores `prob >= 0.1`, OR
     - the two names share a genuine BRAND (not a generic word like west / bond / reserve / fruit)
       and differ on an expression, size, ABV, cask, edition or bottler.

     Below that, a plain no-op is correct and preferred. Do not sweep a row's unread low-ranked
     tail into ops to inflate the count; an ignore you cannot justify in `why` is worse than no
     label, and a formulaic `why` generated in bulk is a signal you were padding. "When in doubt"
     between LINK and IGNORE is `review[]`, never a silent no-op.
   - **A pair that is obviously not the same product may be `ignore`d without a policy row.**
     The policy file governs *ambiguous* classes; it is not a whitelist of permitted reasons.
     The "never decide by an unrecorded rule" line in `sku_link_policy.md` is about inventing
     rules for judgement calls, not about needing written permission to reject two plainly
     different whiskies. If you find yourself rejecting the same *class* repeatedly, that is
     when you propose a policy row via `proposal.policy`.
   - **An above-bar pair you reject gets BOTH the op and a `review[]` entry.** Emit the `ignore`
     (or `unlink`) so the auto-linker stops firing, AND a `review[]` entry so a human sees that
     production would currently disagree with you. That is not double-counting; they do
     different jobs, and the applier reports them separately.
4. Decide each **undirected pair** once. If the other side appears later, reuse the decision
   (idempotent; the apply tool dedupes and errors on contradictory ops).
5. **Coverage contract — write it down, do not hold it in your head.** Emit a `decisions.jsonl`
   alongside the proposal: one `{"id": "<dbFile>|<sku>", "verdict": "link|unlink|ignore|noop|review"}`
   per row you adjudicated. **Key it on `id`, not `sku`** — the listing unit is
   `(dbFile, normalizedSku)` and the same sku routinely appears at several stores, so a
   sku-keyed artifact cannot be diffed against the funnel. Diff the id list against the funnel's
   to prove coverage mechanically.

   **Report the link:ignore ratio in your summary, and justify it if it is lopsided.** A window
   where nearly every adjudicated pair was a link means either the window genuinely had little
   confusable material, or — far more likely — rejections were dropped as no-ops instead of being
   recorded as hard negatives. The 2026-09-20 backlog sweep is the shape to aim for: 66 pairs
   adjudicated, 46 links, 17 ignores, 3 escalated, **0 silently dropped**.
6. **Discharging the `noop-verified` bucket.** It is the largest triage class and unreadable row
   by row. You do not have to read it: stage 1 emits `_meta.eval.noopVerified` =
   `{rows, unexaminedCandidates, flaggedVerifiedOnly}`. **`unexaminedCandidates` is the number
   that gates coverage** — it counts noop-verified rows carrying an above-bar or suspicious
   CANDIDATE or TWIN, i.e. a possible missed link nobody looked at. If it is 0, the whole bucket
   is safely discharged and you say so, citing the number. `flaggedVerifiedOnly` counts rows whose
   EXISTING link re-scored oddly; those are the `need-unlinks` funnel's business (pins excluded),
   not a coverage gap.

### Measured token cost

**Re-measured 2026-09-19** over the full default window (4,344 listings), after the evidence
fields and `--ultra-compact` landed. Reproduce with:

```
node scripts/audit_new_listings.js --from <rich> --only near-misses --ultra-compact \
  --format jsonl --out /tmp/nm.jsonl && wc -c /tmp/nm.jsonl
```

| Funnel | rows | `--compact` KB | `--ultra-compact` KB | ultra B/row | ultra tokens @3 B |
|---|---|---|---|---|---|
| near-misses | 448 | 401 | **269** | 615 | **92K** |
| orphans | 707 | — | **251** | 362 | 86K |
| want-links | 117 | — | **57** | 499 | 19K |
| need-unlinks | 2 | — | 7 | — | 2K |

The near-miss funnel HALVED (900 → 448 rows, 164K → 92K tokens) and want-links more than doubled
(54 → 117) purely from re-encoding a stale `sku_embeddings.json` — no code change. That is the
same defect described in Setup, and it is the reason the freshness check there is not optional:
a stale file silently converts real links into near-misses, inflating both the token bill and the
agent's workload while hiding the answers.

**Use the 3 B/token column.** `bytes/4` is the English-prose rule of thumb; a compact row is dense
JSON (measured: 15% digits, 25% structural punctuation) and tokenizes nearer 2.5–3 B/token. These
are INPUT bytes only: no output, no reasoning, no tool-call overhead, no deep-dives. Nothing in the
repo measures tokens with a real tokenizer; if that matters, count them with `messages.count_tokens`
rather than any divisor.

**What a real run actually costs.** Two supervised end-to-end trials on 2026-09-19, both run
BEFORE the stale-embeddings fix (so both are upper bounds — see the caveat below):

| Trial | Window | Listings | Ops | Peak context | Tool calls | Wall clock |
|---|---|---|---|---|---|---|
| 1 | 3 weeks | 1,227 | 111 | **250K** | 30 | 21 min |
| 2 | 6→3 weeks | 598 | 33 | **195K** | — | — |

**These are PEAK CONTEXT, not cumulative billed tokens.** Cache re-reads mean the billed figure is
several times higher; peak context is the number that decides how many listings fit in one run.

Fitting the two points gives **peak ≈ 142K + 88 tokens per listing**. Treat the intercept
sceptically — it is an n=2 fit and the constant is suspiciously large (it is the runbook, the
policy file, and the `_meta` legend, which are genuinely fixed costs, plus whatever the fit is
absorbing). At 65% of a context window: a 200K window does not fit at all (the intercept alone
exceeds the budget); a 1M window holds roughly **5,800 listings**.

**Both trials ran against a month-stale `sku_embeddings.json`, which roughly DOUBLED the near-miss
funnel** (900 → 448 rows on the full window once re-encoded). The near-miss funnel was ~88% of
tool-output bytes in trial 1, so the real per-listing slope on a healthy pipeline is plausibly
closer to ~50 tokens/listing. Nobody has measured that yet — **take a third measurement on the
first fresh-pipeline run and correct this table.** Until then, plan with the 88 figure and treat
any headroom as a bonus.

For the full library (4,344 listings) that is ~525K peak on the conservative slope — comfortably
one pass in a 1M window, but **split it anyway**: two batches of ~2,200 by date window or
`--offset`, so a bad batch is cheap to redo and each proposal stays reviewable.

- Per-row context budget: rich row ≈ **16.9 KB**; ultra-compact row **≈ 546 B** on the near-miss
  funnel. Fetching the rich file is a one-time ~86 MB on disk and the agent never loads it in.
- Budget deep-dives explicitly — `--id` ≈ 6 KB, `--pair` ≈ 1.6 KB. Deep-diving even 10% of 1,800
  pairs at 6 KB costs more than the entire funnel. The `st`/`same`/`pr`/`prPct`/`rar` fields exist
  precisely so that most rows no longer need one.
- `--from` view load is ~0.5 s on the full 86 MB jsonl, so per-page and per-deep-dive calls are cheap.
- `_meta` in a view is ~6.6 KB (clusters stripped + a `legend`; without stripping it was ~973 KB — 99.5% clusters).
- **`hints:["no-embedding"]` should now be RARE — a nonzero rate is a staleness alarm, not a
  property of the data.** Measured 2026-09-19 on the full default window with a freshly encoded
  file: **0 of 21,497 candidate pairs**. The earlier "47.8% of near-miss pairs" figure — and the
  explanation that embeddings are keyed by the aggregate sku so store alias listings miss — was
  **wrong**: the cause was a `sku_embeddings.json` that had been frozen for a month, nothing
  structural. If you see this hint at any material rate, stop and re-encode (Setup) before
  judging a single pair; you are looking at unscored pairs, not weak ones. The only SKUs
  legitimately without a vector are `sku_hidden.json` listings, which the linker ML excludes from
  everything by design (~300 of 14,088). When it does appear, `embedCos` is null and the GBT's
  missing-branch handles it conservatively — treat that pair as **unscored, not negative**. Check
  `_meta.eval.embeddings === true` to
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
- **Titles almost never state a bottle size** (0-9% by store, measured). Size decisions therefore
  rest on inference: a linked sibling, the URL slug, or the store's price ladder — see the policy
  file's "Inferring an unstated size", which also documents Tudor House's `-ml-`/`-l-` slug
  marker and its one-slug-many-sizes `?variant=` trap.
- **A cross-store sku collision can poison the AGGREGATE NAME, and then blocking goes to the wrong
  neighbourhood entirely.** sku `876891` is ZYN's "Springbank 10 Year Old - 700 ml" and Sierra
  Springs' "Springbank 10 Year & Glen Scotia 12 Year Combo"; the aggregate took the combo name, so
  every candidate retrieved for it was Glen Scotia and the obvious ZYN 700/750 twin never entered
  the pool. If a row's candidates look like a different product family than its name, check the
  other stores on that sku with `audit_search --grep`.
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