# SKU Link Audit — Search & Scale Plan

Status: **Phases 0–4 done** (implemented + measured 2026-09-18 — see §"Measured results").
Written 2026-09-17 to allow a session reset. Companion to `docs/audit-runbook.md` (the agent
operating manual) and root `CLAUDE.md` §"New-listings audit". The runbook now documents the full
end-to-end loop; this plan records the design, phases, and measured results.

## 1. Objective

Make periodic AI-agent audits of SKU link quality scale to the **whole catalog and all
history**, token-cheaply. Long-term, the human link pages (`#/link`, `#/link-rapid`,
`#/link-review`) are retired; link QC becomes (A) the auto-classify pipeline and (B) agent
audits driven by `scripts/audit_new_listings.js`.

### 1.1 End goal — cold-start full audit

The target dispatch is a single instruction to an agent:

> "Audit my entire library, from the beginning, and produce a correct `data/sku_links.json`."

Given that, the agent must (a) generate the candidate surface across the **whole library,
current + delisted history** (~14,953 SKUs ever, not just today's 14,063), (b) adjudicate every
surfaced pair with conventional evidence + the judgement-rules file (§5.5), and (c) hand back a
**proposal (not a committed file)** for human review/apply.

**Operational definition of "100% accurate"** — true ground truth is unknowable, so we build to
a verifiable proxy:

1. No known positive is absent from the candidate pool (gold-set enforced).
2. Every surfaced candidate is adjudicated (no unread rows).
3. The run **converges** — a re-run reports zero actionable items (`want-links` = 0, no
   below-bar auto-links, suspicious `near-misses` resolved) and is a no-op.
4. Every alias/typo class present in the labels is covered by the blocker.
5. Only genuinely hard calls land in a `needs-human` bucket; everything else is decided.

Acceptance test = dispatch → converge → **re-run is a no-op** → gold set green. Residual error
is then confined to unknown unknowns, which the evolving judgement-rules file steadily shrinks.

## 2. Design principle — two-tier cover

Neither tier alone works, and **O(N²) pairwise LLM review is impossible** (TB-scale context).

- **Conventional tier = recall + blocking + evidence.** Deterministic, auditable, cheap
  enough to run catalog-wide. Its job: never let a true candidate fall out of the pool, and
  attach the evidence the AI needs.
- **AI tier = precision judge.** Expensive per pair, so it only ever sees a few hundred /
  low-thousands of pairs. It decides accept / reject / ignore and writes a proposal.

**The one failure mode to engineer out: the conventional layer silently dropping the right
candidate before the AI can see it.** Today's token-only blocking does exactly this.

## 3. Where the current pipeline fails (measured 2026-09-17)

Environment: 13,760 aggregates, 6,671 link edges, 5,723 unique resolved positive pairs,
13,429 embedded SKUs (`.worktrees/data`).

### 3.1 Cost per anchor over the full catalog

| channel | per-anchor | full sweep (~8.6k anchors) |
|---|---|---|
| token scan `scorePairWithVocab` (full) | 380.9 ms | ~55 min |
| embedding cosine (13.4k × 384, brute force) | **9.3 ms** | ~80 s |

The audit already avoids the full scan via a distinctive-token/SMWS inverted index
(`audit_new_listings.js::candidatesForAnchor`, line ~856), which is why a full run is ~100 s.
So cost is fine **as long as blocking stays cheap**; the brute-force embedding channel is
cheap enough (~9 ms/anchor) to add as a second blocking pass.

### 3.2 Retrieval recall on known positives

| class | n | det@5 | emb@5 | det@10 | emb@10 |
|---|---|---|---|---|---|
| honest (TEST+VAL groups; embedder never trained) | 85 | 90.6% | **98.8%** | 96.5% | **100%** |
| shared-token = 1 | 38 | 55.3% | **84.2%** | 92.1% | 94.7% |
| shared-token = 0 | 1 | 0% | 100% | 0% | 100% |

The embedding channel is higher-recall on weak overlap **and** ~40× cheaper than a full token
scan. Strong case for it as a candidate generator (not just a rerank feature).

### 3.3 The blocking hole is real and brand-biased

The audit's blocker admits a candidate only if it shares a **distinctive unigram**
(idf ≥ `DISTINCTIVE_IDF` = 4.6) or an SMWS key. Measured: **60/5,723 (1.0%) of KNOWN positives
are structurally absent** from the pool, and they concentrate on the most-duplicated brands:

```
GLENFARCLAS - 12 YEAR OLD  <-> Glenfarclas 12 Year Old
HIGHLAND PARK 15 YO        <-> Highland Park 15 Year Old 'Viking Heart'
Compass Box Artist         <-> Great King Street Artist's Blend
```

Cause: `glenfarclas` df=159 → idf 4.45; `highland` 4.35; `park` 4.53 — all just under 4.6.
**The more stores carry a brand, the lower its IDF, the less likely it is a blocking key.**
The blocker fails hardest on the highest-value dedup targets. (SMWS rescues 11 of the 71
dist-only misses → 60 remain.)

### 3.4 Labels cannot measure the miss rate

Across 5,723 positives: 0 shared tokens 0.2%, 1 token 7.7%, ≥2 92.1%. The labels were
produced by the token pipeline, so recall-on-labels is a **floor**, not the metric. The true
miss rate is unknown until the embedding/fuzzy channels are in the loop and the agent
confirms pairs the old pipeline never proposed.

### 3.5 Errors concentrate in isolated SKUs (validated, with nuance)

Catalog composition: 62.6% in multi-member link components, **23.6% isolated (component size 1,
single store)**, 1,900 component-1 multi-store (implicit same-raw-SKU links).

Refined test — restrict to **zero shared distinctive tokens** (what the blocker dies on) with
embedding cos ≥ 0.8 (from a 700-anchor sample, `ANCHORS=700`):

- ALL cross-group cos≥0.8: SS 11.2% · SM 28.5% · MM 60.4%
- **ZERO-token** subset (n=85): SS 10.6% · SM 49.4% · MM 40.0%

But the zero-token M↔M cases are overwhelmingly **precision traps**, not missed merges
(`SMWS 8.47 ↔ SMWS 8.46`, `Balvenie 25 ↔ Balblair 25`, `Royal Reserve ↔ Crown Royal`,
`Highwood ↔ Potters`). The genuinely-suspicious pairs skew to the **isolated** side.

Extrapolated catalog-wide zero-token+high-cosine surface: **~1–2k pairs** — cross-checks
against the audit's existing near-miss funnel (1,775 pairs). This is the AI's actual workload:
small, mostly rejections.

**Conclusion (user's insight, refined):** cluster↔cluster (M↔M) merges are **common**, not rare —
but an M↔M merge the conventional tools *cannot see* is rare, because a genuine cross-cluster
merge almost always shares easy tokens (same distillery/brand/expression words), so the token
matcher already surfaces it. The zero-token M↔M bucket is therefore small and mostly rejectable
traps. So we don't need pairwise everything and don't need routine cluster↔cluster sweeps; we
need (a) high-recall candidate generation for the classes the token matcher structurally kills
(typos / abbreviations / no-shared-token isolates), and (b) an anchor policy that prioritises
isolated/orphan SKUs. Keep a rare periodic M↔M sweep via the embedding channel as a safety net.

## 4. Bounded search space

- **Scope: current + delisted history.** Achieved — `audit_search_core::buildSurface` reads
  `index.json` aggregates **and** walks `data/db/**` git history (via `db_commits.json`, cached)
  so links for delisted SKUs are correct too. Measured surface: 13,785 current + 1,194 delisted =
  14,979 searchable items. (The stage-1 generator remains current-catalog for scoring; the search
  primitive and its block index cover delisted.)
- **Anchors** (not all N): isolated/orphan SKUs (component size 1), newly-first-seen SKUs
  (the `--since` window), SKUs whose existing links are below the confidence bar, and SKUs
  flagged `near-misses`/`noop`. M↔M merges are common, but the ones conventional tools miss are
  rare (they normally share tokens), so clusters of ≥2 members are largely handled already; the
  residual token-invisible M↔M set is small and mostly rejectable traps. Prioritise isolates,
  where the genuine hard misses concentrate.
- **Candidates** = union of blocking channels (below), then rerank, then AI.
- Budget: cap candidates per anchor (K) and total pairs handed to the AI.

## 5. Architecture

### Blocking channels (union, cheap)
1. **Distinctive-token/IDF index** — keep, but **loosen**: lower/adaptive IDF floor and/or
   always index each SKU's `topTerm` (and maybe top-2), so popular brands don't vanish.
2. **Embedding cosine top-K** — brute force ~9 ms/anchor over 13.4k; add a vector store
   only if profiling demands. This is the channel that catches typos, abbreviations,
   spacing/possessive variants.
3. **SMWS cask key** — already present; keep.
4. **Fuzzy / alias table learned from confirmed links** — `Revelstoke↔Revel Stoke`,
   `Bumbu↔BUMBU 375`, `Macaloney↔Macaloneys`, `Tin Cup↔Tincup`. This is the "improve the
   conventional tool with the growing dataset" lever (edit-distance / char-trigram + mined
   token-alias pairs from `data/sku_links.json`). Canonicalise known variants (e.g.
   `glenfarclas`, `glen grant`) so IDF stops hiding them.
5. **Metadata filter** (optional tightening) — category / price band / size / abv / age, to
   shrink K without losing recall.

### Candidate assembly + evidence
Union → dedupe by canonical group → take top-M by det + embedding + group features → emit
per-candidate evidence (name, store, price, size, abv, age, det score, embed cos, GBT prob,
group features). Reuse the live ranker end-to-end (no forked scoring).

### AI decision
Binary accept / reject / ignore with a short reason per candidate. Emits the proposal schema
already consumed by `tools/apply_audit_proposal.js`.

### Apply
`tools/apply_audit_proposal.js` (write-only, dry-run default, never commits). Per decision
(§1.1) the autonomous run's output is a **proposal + diff for human review**, not a committed
file.

### 5.5 Judgement-rules file (human-owned policy)

A committed, human-editable file — proposed `data/sku_link_policy.md` on the data branch, beside
`sku_links.json` / `sku_hidden.json` — that encodes the user's calls on classes the scorer can't
decide. The agent reads it on every run; when it infers a new class it **proposes** an amendment
(in its proposal) and only the human merges it. This is the durable home for "ever-evolving
judgement": rules accumulate instead of being re-litigated each session.

Seed rule classes (from real label conflicts):

| Class | Example | Call |
|---|---|---|
| Format/year wording | `X 12YO` ↔ `X 12 Year Old` | same |
| Vintage year | `Glenfarclas 2001` ↔ `Family Cask 2002` | separate |
| Store/exclusive cask | `X 12yr Co-op Exclusive Cask` ↔ plain `X 12YO` | judgement |
| Packaging / re-list | `Vintage Packaging`, `(Without Tube)`, `PET` | same |
| Gift / sampler / set | gift packs, tasting sets | separate |
| Size | `750ml` ↔ `700ml` ↔ `375ml` | separate |
| Batch / cask | `Tamdhu Batch Strength 007 ↔ 008`; `SMWS 8.47 ≠ 8.46` | separate |
| Abbreviations | `TBWC`, `G&M`, `Macaloney↔Macaloneys`, `Tin Cup↔Tincup` | same |

## 6. Deliverables / phases

- **Phase 0 — Harness & gold set.** ✅ DONE. `tools/audit_search_eval.mjs` (env knobs
  `ANCHOR_LIMIT`, `AUDIT_INCLUDE_DELISTED`) computes blocker recall/latency per channel and the
  union over the gold set (all `data/sku_links.json` pairs). Proved the union closes the hole.
- **Phase 1 — Search primitive CLI.** ✅ DONE. `tools/audit_search.mjs` (CLI) + `tools/audit_search_core.mjs`
  (shared `loadEnv`/`buildSurface`/`buildBlockIndex`/`buildEmbeddingIndex`; the git-history-walked
  delisted surface is cached at `audit/.cache/history_surface.json`). Resolves **delisted** SKUs.
- **Phase 2 — Union blocker in the audit generator.** ✅ DONE. `scripts/audit_new_listings.js::candidatesForAnchor`
  now unions dist/topTerm/smws/twin/fuzzy (+optional embedding) via the shared core, budgeted
  (`AUDIT_POOL_BUDGET=700`, `AUDIT_POOL_PER_CHANNEL=150`, `AUDIT_POOL_EMB=1`). Any init failure
  falls back to the old two-index blocker; `--from` views are byte-compatible.
- **Phase 3 — Alias/typo learning.** ✅ DONE. `tools/mine_sku_aliases.mjs` mines token-variant pairs
  from confirmed links → committed `viz/app/linker_page/sku_aliases.js`. Consulted by the block
  index; blocking-only, never a final verdict.
- **Phase 3b — Judgement-rules file.** ✅ DONE. `data/sku_link_policy.md` on the data branch (seed
  8-row table), read via `loadSkuLinkPolicy`; agent proposes amendments, never self-applies.
- **Phase 4 — Agent loop.** ✅ DONE in docs. Anchor policy + token-budget validation written into
  `docs/audit-runbook.md`; measured geometry in §"Measured results".

## Measured results (2026-09-18)

All numbers below were produced by the shipped tools against `.worktrees/data` (current catalog
13,785 aggregates; 1,194 delisted recovered via the cached git-history walk; 13,429 embedded).

- **Phase 0 (blocker recall).** Current-only sampled n=316 ordered pairs: the **current**
  dist/SMWS blocker recall@100 is **98.7%**; the **union** (dist+topTerm+smws+twin+fuzzy+emb) is
  **100% @ K=20**; the HONEST subset (n=85, embedder never trained) is 100% @ K=5; **0 pairs still
  missed at K=100**. The 60 known-missed positives are all reachable (56 token, 4 emb-only); 0 of
  them need K>100. Latency per anchor: current ~0 ms, topTerm ~0 ms, fuzzy ~0.2 ms, emb ~6.6 ms,
  union det-scoring ~59 ms. Gold set grows **5,723 → 6,638 pairs** when delisted items are included;
  delisted items have no embedding vectors (emb rank −1 there; the token channels cover them). On
  the delisted run **union@50 = 100%**.
- **Phase 2 (generator integration, verified; re-measured 2026-09-19 after the fuzzy stopword
  fix: 21,398 candidates, median pool 225, 64 s, 54 want-links, 0 need-unlinks).** Full run: 4,344 listings, **21,506 candidates
  (+8.6% vs 19,798 baseline)**, 891 near-miss listings, 371 twins, 186 auto-linked, 772+ orphans;
  pool size min 0 / median 464 / max 700; ~100 s. The previously-missed Co-op `Glenfarclas 12
  Co-op Exclusive Cask` now surfaces at **prob 0.968
  (above bar)**. Fallback to the OLD two-index blocker on union-init failure is intact; `--from`
  views are byte-compatible with the pre-Phase-2 rich file.
- **Phase 3 (alias table).** 38 rows / 76 map keys (top by support: reserva↔reserve,
  barrel↔barrell, bourbo↔bourbon, michter↔michters, abunadh↔bunadh); 30 candidates dropped for
  appearing in ignore pairs. ~5 rows are flagged as questionable (`light↔night`, `doon↔toon`,
  `dete↔ete`, `port↔post`, `rufty↔tufty`) — keep as a known-trim list for a human. Aliases are
  **blocking-only**: they widen the candidate pool and are never a final verdict by themselves.
- **Phase 3b (policy file).** `data/sku_link_policy.md` lives on the DATA branch, human-owned,
  read every run via `loadSkuLinkPolicy`; the agent **proposes** amendments, never self-applies
  (the human may instruct an edit directly). NOTE: it was untracked until 2026-09-19 — the tooling
  read it every run but no other clone had it. Rewritten 2026-09-19 with size tolerance, ABV/proof,
  limited editions, bundle/multipack and same-store-as-a-guide rules.
- **Phase 4 (token budget).** Re-measured 2026-09-19 on the full window with `--ultra-compact`:
  near-miss **900 rows / 492 KB / 546 B per row ≈ 164K tokens** at 3 B/token; orphans 791 rows /
  324 KB; want-links 54 rows / 33 KB. **Funnel bytes are not the run cost.** A real supervised
  agent run over a 3-week window (1,227 listings) consumed **250K tokens / 30 tool calls / 21 min**
  ≈ 200 tokens per listing, so the full 4,344-listing library is **~900K tokens per pass** — split
  it into ~4–5 batches by `--offset` or date window. Anchor policy + full loop are documented in
  `docs/audit-runbook.md`.
- **Phase 5 (first supervised trial, 2026-09-19).** A fresh agent given only the runbook audited
  2026-08-29..09-19 → 111 ops (108 link / 3 ignore / 0 unlink). Verified independently: 0 ops
  contradicted a human hard negative, 0 redundant, 1 group merge, 1 identifiable false positive.
  It surfaced a live auto-linker false positive (Aberfeldy 12, prob 0.9904, 2.24× Liberty markup).
  Round-3 hardening followed: store/sameStore, price-ratio percentile vs the dearer store's own
  distribution, rarity tiers, `--ultra-compact`/`--limit-pairs`, a `review[]` needs-human channel,
  `apply --verbose`, `decisions.jsonl`.

## 7. Validation contract

- **Gold set:** must contain the 60 structurally-missed positives and the suspicious isolates
  (`Glenfarclas 12 Co-op Exclusive`, `SMWS 35.348/35.360`, `Glenfarclas FC 1979`).
- **Metric:** blocker recall@K on the gold set (K small, e.g. ≤40), then AI precision on the
  surfaced set. Target: no known positive is ever absent from the pool.
- **Token budget:** measure tokens per adjudicated pair end-to-end. **Re-measured 2026-09-19:**
  near-miss funnel = 900 rows / 492 KB `--ultra-compact` ≈ 164K tokens at 3 B/token; but the
  end-to-end agent cost is ~200 tokens per listing in the universe (250K for 1,227 listings
  measured), which puts a full-library pass at ~900K tokens. Batch it.
- **Convergence:** after apply, re-generate and assert zero `want-links`, no below-bar
  auto-links, and no unresolved suspicious near-misses; a second run must be a no-op.
- **Scope coverage:** the run must include delisted SKUs (measured 1,194 not in today's
  `index.json`, all reachable via the cached history surface and the search primitive).

## 8. Risks / open questions

- Embedding high-cosine on zero-token pairs is dominated by **same-distillery / different
  expression** traps → the AI must reject, and the precision bar must not be relaxed.
- Retraining the embedder must respect the group split. Alias learning from labels is now
  **edge-safe by construction**: `mine_sku_aliases.mjs` is consulted only for blocking (widening
  the candidate pool), never as a verdict, and drops any alignment seen in an ignore pair; still
  re-verify on a mined-table change before a human trims the flagged rows.
- Distinguishing "same product, different packaging/re-list" from "different expression"
  (e.g. `Co-op Exclusive Cask` vs plain 12YO) is a judgement call the AI should make with
  price/size/abv evidence, not the embedder alone — this is exactly what the policy file
  (`data/sku_link_policy.md`) encodes.
- Anchor policy must not miss a genuine cross-cluster merge; schedule a periodic (rare)
  cluster↔cluster sweep via embedding channel 2 rather than never.
- The judgement-rules file must stay **human-owned**; an agent that self-applies rules can
  drift. Agent proposes, human approves.
- Full-history scope is now covered by the cached git-history surface in `audit_search_core`
  (delisted items recovered from `data/db/**` history via `db_commits.json`, cached at
  `audit/.cache/history_surface.json`). Keep `db_commits.json` fresh in the worktree before a
  run; the cache keys off its `generatedAt` and rebuilds when it changes.

## 9. Scratch artifacts from this session (regenerable)

`/tmp/opencode/search_recall.mjs` (recall/latency), `label_tok_dist.mjs` (label bias),
`blocking_recall.mjs` (blocker hole), `orphan_hypothesis.mjs` / `orphan_hypothesis2.mjs`
(cluster-size concentration). The productive ones were promoted into shipped `tools/` across the
phases (`audit_search.mjs`, `audit_search_core.mjs`, `audit_search_eval.mjs`, `mine_sku_aliases.mjs`,
`apply_audit_proposal.js`); the rest are historical scratch.
