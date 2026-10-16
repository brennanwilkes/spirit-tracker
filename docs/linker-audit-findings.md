# Linker: auto-link classification, the new-listings audit, and audit findings

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

## Auto-Link Classification

`tools/auto_link_classify.mjs` (Node ESM) runs every scrape in `run_daily.sh` — AFTER the
per-build embeddings are written, BEFORE the email pack. It reuses the LIVE ranker end-to-end
(via `tools/linker_ml/featurize.mjs::buildEnv` + `recommendSimilar` + the GBT blend — never forks
scoring) to find cross-store matches and appends high-confidence ones (≥ `autoLinkConfidenceBar`,
the 99%-precision bar = 0.95) to `data/sku_links.json` as:

    { fromSku, toSku, confidence, source: "auto-classify", ts }

**An auto-link is a REAL link everywhere, immediately.** Every consumer (`src/utils/sku_map.js`,
`viz/app/mapping.js`, `sku_canonical.js` both, `build_email_event_pack.js`, `viz/app/api.js`) reads
only `fromSku`/`toSku`, so new links group in the catalog and fire email alerts at once; agent audits
correct wrong ones later. The old `status:"pending"` review marker was dropped 2026-10-12 with the
human link pages; older entries may still carry it and nothing reads it.

**CI is NOT a complete linker, and nothing else is either: run the whole-catalog pass.** Measured
recall at the bar is ~45% for a new listing joining a group, and CI anchors only SKUs first seen in the
last 25 days (`--since 25`, raised from 2 on 2026-10-12: Gretzky Ginger Beer Cask at W&B crossed the bar
days after arriving and a 2-day window never re-scored it). Older pairs and below-bar matches are left to
the **whole-catalog undecided-pair pass** (`tools/audit_classical_pairs.mjs` + `tools/audit_undecided_pairs.js`, runbook's first section),
the replacement for the removed link pages. Before it existed, every audit was scoped by first-seen
window or top-K-by-prob, so pairs the old `#/link-rapid` page surfaced instantly were never judged: on
2026-10-12 that pass (pilot + 6 Haiku batches, ~930 pairs) added ~60 links and ~760 ignores.
**Open (2026-10-13): candidate generation must be the UNION of every generator** (the page's display-name
`recommendSimilar` card score, classical over name variants, GBT top-K, embedding neighbours), with an
acceptance check that replays the page's worklist and finds 0 undecided pairs outside the batches. Only the
classical + GBT generators are wired in today. Plus 111 unresolved review pairs, 1,085 unjudged pairs and
≥7 mixed groups: see the running handoff `audit/oracle-2026-10-14/HANDOFF.md` (local).

- **Candidate blocking (speed).** A confident match shares a distinctive token (or SMWS cask code)
  with the anchor, so the tool scores only candidates from a distinctive-token/SMWS inverted index,
  not the full ~12.6k catalog — a per-anchor handful of comparisons. **Precision-preserving** (the
  full live scorer still runs on every candidate it scores; it can only drop a few zero-shared-token
  semantic matches, which `recommendSimilar`'s retrieve-then-rerank already misses). Measured: 6201
  anchors in ~38s, a 900-SKU store add in ~10s, full catalog sweep ~75s. `vocab`/`groupIndex`/
  `sameGroup` stay full-catalog so any candidate's score is identical to the live ranker.
- **Anchor recency-bound (idempotency).** `run_daily.sh` passes `--since 25` (anchor only on SKUs
  first-seen in the last 25 days). The full catalog is still the
  CANDIDATE pool; only the ANCHOR set is bounded. Stable orphans were already scored on a prior run,
  so the window just avoids redundant rescans. Dedup against existing links/ignores makes re-runs a
  no-op (no write → no commit churn). Flushes every 400 anchors, so a cancelled run keeps its
  progress and a re-run resumes cleanly. `--max-anchors N` hard-caps (newest first); `--dry-run`
  previews. One-time backlog sweep over ALL SKUs: run by hand with no `--since`.
- `run_daily.sh` stages `data/sku_links.json` so the classifier's appends commit (and reach the
  email pack + Pages, which already stage it into `viz/data/`).
- **`recommendSimilar` can return popularity filler, not matches.** When nothing survives its fine
  stage it falls back to `stores×2 + hasPrice×1.2 + hasName` (≈4.2) — a number that clears any
  probability bar. Those rows carry `fallback: true` (2026-09-23); every caller that thresholds
  `score` (CI, the audit) must skip them. Before the marker, a fully hard-vetoed pool would have been
  auto-linked. It never happened (all 22 links with confidence > 1 are SMWS pins at 1e9).

**Email pack lost every link 2026-10-04 → 10-09.** `build_email_event_pack.js` read `sku_links.json` via
`execFileSync("git show")` with the default 1 MiB `maxBuffer` and swallowed the ENOBUFS, so once the file passed
1 MiB every store's listing was its own product ("new to market" for a Benromach 15 sold at 18 stores). Fixed:
512 MiB buffer, only "path absent at that commit" returns null, a missing links file throws (`diff_report.js` too).

## New-listings audit (`scripts/audit_new_listings.js`)

**Strategic direction (2026-09-17, sharpened by the owner 2026-09-20):** the human link pages are
removed (2026-10-12). Link quality control becomes two pillars: (A) the auto-classify pipeline
(below), which is FREE and runs every scrape, and (B) **periodic AI-agent audits** driven by this
script, which are EXPENSIVE and run every few months.

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

**Links 6,034, ignores 26,100, collisions 28 (split), hidden 591** (2026-10-05, after campaign rounds 1–3; 5,969 / 16,415 on 2026-10-02). Every cheap
surface is adjudicated over all of history: near-miss and want-links (including the v5 residual),
orphans (3,061), every existing link below the bar (`< 0.30`: 23% wrong; `0.30–0.95`: 13.8% wrong),
38 ignore↔link contradictions, and the whole review backlog (0 open, bar 5 waiting on the deferred per-store split). **The 0.95–0.99 pilot of the
above-bar pass found 10.5% wrong** (65 of 622; bridges, editions, gift packs, sizes), so being above
the bar is weak evidence that a link is right.

**The ≥ 0.99 pass is complete: 92 of 5,632 edges wrong (1.6%)**, and every review queue is closed. Precision
is done. The ignore screen stopped after tier A (`tools/audit_ignore_slice.js`): the near-identical-name ignores
were only 0.43% wrong (3 of 694), so B–D (~4M tokens) was not worth it. The unscored-group sweep is done (2026-09-29), and the recall-backfill pilot came back NO-GO (2026-10-01: 1 link in
485 random rows ≈ 63 projected against a 150 gate), so the ~30k-row backfill is not run. The `c:` keys were linked
2026-10-02. The rolling campaign (`docs/audit-campaign.md`, manifest `audit/campaign/manifest.json`; resumable batches, local
retrains never shipped) ran rounds 1–3 on 2026-10-03/05: +60 links, ~9,700 ignores, ~5.4M agent tokens. Campaign
metrics before 2026-10-09 were on leaky rows; round-close now reports the honest `cut`/`new` views. Its frontier is
nearly exhausted. `mine` drops pairs whose names share no brand word. Agent cost is ~80K fixed + ~0.62 tokens/byte for group and ignore slices alike, so slices of
~700 KB end near 50% context, and 50% is a soft limit. Collisions are fixed by the split (§"SKU collision splits"), never by
containment unlinks.

Rules from 2026-09-23:
- **Audit existing links group-major** (`tools/audit_link_group_slice.js`). A band slice hides a
  group's out-of-band edges, so splits decided from it come out incomplete.
- **Cap row-major orphan batches at ~200 KB**; one 251 KB batch hit 49%.
- **Merge concurrent proposals before applying** (`tools/merge_audit_proposals.js`).
- **Commit an applied proposal before the next cron run.** CI cannot see an uncommitted ignore: the 2026-09-24 sweeps sat unpushed for 4 days, and CI auto-linked a pair one of them had rejected. A `git pull` over the dirty file would have dropped 48 ignores. To recover, back up the file, pull clean, and re-apply the proposals; they are idempotent.
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
   only does harm because one sku is polluted, pass `"ignore": false`. (For a collided sku, split it in `sku_collisions.json` instead of cutting links.)

### SKU collision splits (shipped 2026-10-01; plan + evidence: `docs/sku-collision-split-plan.md`)

Two different products can share one SKU when store numbering systems overlap (BC vs AB, the Sierra
Springs / Wine and Beyond `id:104xxxx` overlap, or one store re-using a sku). Listings aggregate by
sku, so they merge with no link to remove. The fix re-keys one side to a synthetic sku.

- **`data/sku_collisions.json`** (data branch, curated, 24 entries): each entry has `sku`, `products`,
  `keep`, and `split[]` = `{key: "c:<normSku>:<tag>", listings: [{storeId[, url]}]}`. `storeId` is the
  db-file prefix. A `url` matcher is only for one store carrying both products. List only collisions
  whose products belong in DIFFERENT groups (`876891`, a Springbank bundle vs Springbank 10, is benign
  and must not be listed).
- **Resolved where a `data/db` row is read, never written into `data/db`.** `src/utils/sku_collisions.js`
  `loadCollisionSplits().resolve(storeId, sku, url)` returns its input unchanged when not split. Every
  build tool (index, sku cache, recent, common listings, email pack), the tracker's auto-link writer and
  cheapest index, and the audit tools call it. The SPA never loads the file: it sees resolved keys in
  the artifacts; only `displaySku` strips `c:…` to the bare number.
- **A missing or malformed file throws**, including at tracker startup (`src/main.js`). So run
  `bin/tracker.js` from `.worktrees/data` (or with a `DATA_DIR` that has the file).
- **Hidden entries match the RESOLVED key**: hide a split listing as `c:…`.
- **Adding/changing an entry = JSON edit + `node tools/validate_sku_collisions.js`** (run in the data
  worktree; must show 0 ERROR). The per-SKU cache rebuilds affected history by itself: it compares
  `viz/data/skus/_collisions.stamp` with the file and rebuilds those skus from git history. The
  scraper re-points `sku_links_auto.json` onto new splits but never back: removing a split or renaming
  a tag needs a hand edit of the auto links (the validator errors on an undefined `c:` key).
- `c:` keys are ordinary skus: linkable, trainable, embeddable. The old guards (applier and
  auto-classify refusals, `build_dataset` exclusion) are gone. Ignores that were aimed at a split-off
  product no longer apply to it; re-add them on the `c:` key (list in the plan's follow-ups).
- **`tools/detect_sku_collisions.mjs`** regenerates the candidate census from `index.json`. Candidates,
  not verdicts: judge on every store's listing. ~10% of candidates were real.

### Pre-apply guard: `validate_proposal_skus`

- **`node tools/validate_proposal_skus.js --proposal <file> [--fix]`** before every apply. The
  generator's listing ids/cluster keys strip `id:` while `pairs[].sku`/`vl[][0]` keep it. **Correction
  (2026-09-23): a bare ref is NOT a dead link** — every canonical loader folds `id:N` ≡ `N`. The real
  damage was ML-side: `bySku` is keyed by the prefixed form, and raw-key checks in `build_dataset`,
  `linker_eval`, `dump_features` and `featurize.linkAdj` silently dropped **4,828 of 14,442 ignores
  from training** and leaked the group split — all four fixed; see `tools/linker_ml/CLAUDE.md`
  §"2026-09-23". Keep the file in catalog form anyway; `--fix` rewrites bare refs.

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


### Human link pages removed (2026-10-12)

`#/link`, `#/link-rapid`, `#/link-review`, the `/__stviz` link/ignore/confirm/reject/review-watermark
endpoints, the localStorage pending overlay and the GitHub-issue edit flow (`stviz_apply_issue_edits.js`,
`stviz_create_pr_from_issue.yml`) are gone, and with them the `status:"pending"` field. The leftover
`stviz/issue-*` remote branches were deliberately left in place.

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
  so both write byte-identical single-line files. New links are `{fromSku,toSku,
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
- **`scores.verified[]`** = the listing's EXISTING explicit links (auto-classify
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
