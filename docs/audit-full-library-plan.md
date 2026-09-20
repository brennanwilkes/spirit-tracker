# Full-library agentic audit — handoff

**Written 2026-09-20.** Companion to `docs/audit-runbook.md` (the agent's operating manual).
This file answers: how big is the library, what has already been audited, and how to finish it.

## Goal

Audit **the entire library and its entire history** — every listing ever seen, not just recent
ones. The output is a trustworthy labeled set (links = positives, ignores = curated hard
negatives) so the auto-linker's failures can be characterised and its accuracy raised at the
source. See CLAUDE.md §"Strategic direction". Coverage beats speed; ignores are worth as much as
links.

### Definition of done (owner, 2026-09-20)

1. **Recall** — ~100% confidence that every SKU link that should exist, does.
2. **Precision** — every link in the file is correct AND required.
3. **Hard negatives** — a large body of ignores over pairs the classical tooling finds plausible
   but agentic review rejects.

**Trust nothing.** The first full pass reviews essentially every SKU in BOTH directions — is it
correctly linked, does it need new links, does it need links removed — rather than sampling
funnels. Nothing produced before that pass is treated as verified, including the 2026-09-20 runs
below; those findings are sound but they are inputs, not guarantees.

**Implicit links are explicitly OUT of scope** (owner ruling 2026-09-20): two listings under the
same raw SKU are the same product by default. The 4 known cross-store collisions are logged
exceptions, not a population to review. Do not spend agent budget on the 5,444 implicitly
multi-store SKUs.

### The `need-unlinks` gate — a real defect, found 2026-09-20

`scripts/audit_new_listings.js:1986` reads:

    l.needUnlink = l.wasAutoLinked && (res.verified || []).some(...)

**A manual link can never enter the `need-unlinks` funnel, however badly it re-scores.** 5,622 of
5,922 link entries (95%) carry no `source` — manual/legacy — so the funnel has been blind to 95%
of the link file. `need-unlinks: 0` was read as "no bad links"; it meant "no bad auto-classify
links that the model also changed its mind about".

The data was never missing — `scores.verified[]` already re-scores EVERY explicit link, manual
included. Only the filter was narrow. Measured on the 2026-09-20 window (5,422 verified pairs,
52 pins excluded):

| | |
|---|---|
| re-score below the 0.95 bar | **182** (the funnel surfaced 2) |
| re-score below 0.50 | **31** |

Worst: `108763` "2007 Aultmore 57.1% Signatory" 0.0006, `743193` Signatory Glentauchers 0.0007,
`239114` Bruichladdich Octomore 15.3 0.0020. Fix is one clause: drop the `wasAutoLinked` gate,
keep the pin exclusion, surface any existing link re-scoring below bar regardless of source.

## Size and shape of the library

Measured 2026-09-20 from `.worktrees/data`:

| quantity | value |
|---|---|
| **listing units `(dbFile, normalizedSku)` — the audit's unit, whole history** | **34,247** |
| distinct SKUs in the per-SKU cache (incl. delisted) | 14,978 |
| distinct SKUs currently in `data/db` | 14,109 |
| SKUs in an explicit link group | 8,992 |
| explicit groups (size > 1) | 3,164 (largest 21 members) |
| SKUs implicitly multi-store (same raw sku at ≥2 stores) | 5,444 |
| **orphans (no explicit link AND single store)** | **3,277 (23.2%)** |
| link entries / ignore entries in `data/sku_links.json` | 5,922 / 13,207 |
| db files / stores | 136 / 36 |

~870 SKUs exist only in history (in the cache, gone from `data/db`). They are part of the job:
delisted listings still carry price history and still belong in the right canonical group.

Listing units by first-seen quarter — **note this is NOT a product-launch curve**, Q1/Q2 is
dominated by onboarding bulk (everything already on the shelves when tracking began 2026-01-19):

| quarter | listing units | share |
|---|---|---|
| 2026-Q1 | 15,829 | 46% |
| 2026-Q2 | 15,418 | 45% |
| 2026-Q3 | 3,000 | 9% |

## THE WINDOW TRAP — read this before quoting any coverage number

`scripts/audit_new_listings.js` defaults to listings **first seen since 2026-06-12T18:47:49Z**
(the first `source:"auto-classify"` commit). That default window holds **4,344 listing units —
12.7% of the library.** Every "full-library" number produced on 2026-09-20 is really a
3-month-window number.

How this was found: the owner knew `id:8768911` and `id:8768913` (Springbank 10 + Raasay bundles
at Sierra Springs, both delisted) should link to the Springbank 10 group, and the audit had never
proposed it. Both were first seen **2026-05-27**, 16 days before the window opens. Not a scoring
miss, not a `removed` filter — just out of scope.

**Delisted listings ARE in scope** and are not filtered: the default-window rich file holds 660
`current.removed:true` listings out of 4,344. (An earlier claim in this session that the audit was
blind to removed listings was WRONG — it came from testing a top-level `removed` field that only
exists in the `--compact` projection; the rich file carries `current.removed`.)

Run with **no `--since`** for whole-history coverage. Nothing else needs to change.

## Why the pre-June population is the interesting part

`tools/auto_link_classify.mjs` only ever anchors *recently first-seen* SKUs — `--since 2` in CI,
and the one hand-run backlog sweep reached `--since 40`. **Nothing first seen before 2026-06-12
has ever been an anchor.** So ~31,000 of the 34,247 listing units have never been through the
auto-linker as an anchor at all. Expect that population to be link-poorer and orphan-richer than
anything measured so far, and expect the funnel-rows-per-listing ratio to be HIGHER there than the
26% observed in the 3-month window.

## What has already been audited

All of it is inside the default 3-month window (2026-06-12 → 2026-09-20).

### Run 0 — backlog sweep (not an agent; hand-triaged)
`auto_link_classify --top 10 --since 40`, recovering the month the embeddings were stale.
66 above-bar pairs over 1,498 anchors → **46 links accepted, 17 rejected to ignores, 3 escalated**.
16 of the 66 were false positives; it was NOT applied blind. Proposal:
`audit/proposal-backlog-sweep-2026-09-20.json`.

### Run 1 — want-links + need-unlinks + near-misses (subagent, Opus)
Input 469 funnel rows / 299 KB. **Peak context 302,741 tokens ≈ 30% of 1M**, 26 tool calls, 14 min.
Output **618 ops: 39 link / 1 unlink / 578 ignore**, plus 9 `review[]` and 5 `dataQuality[]`.
Coverage verified independently: 0 funnel rows unadjudicated, 0 invented, every op carries a
substantive `why` (p10 length 158 chars). Applied, plus a 4-op supplement resolving the balanced
review items. Proposals: `audit/proposal-full-library-2026-09-20.json`,
`audit/proposal-review-supplement-2026-09-20.json`.

**Calibration finding — the headline ratio flatters itself.** 1:14.8 link:ignore looks strong, but
by the model's own score: 67% of the ignores sit at `prob < 0.01`, 87% below 0.1, and only **27 of
578 at `prob >= 0.5`**. Correct labels, but a negative the model already rejects teaches a
classifier very little. Report ignores BY PROB BAND, never as a raw count.

The 39 links were mostly spelling/format variants, sizeless listings needing a price-ladder
inference, and product-name knowledge (`The Spaniard` ↔ `The Story of the Spaniard`) — not
retrieval failures. Only **one** link was removed (`152234 ↔ 1003085`, Knut Hansen matched on a
surname), because the `need-unlinks` funnel only catches auto-classify links that fell BELOW bar;
a bad link the model still scores highly is invisible to it, and manual links are never re-checked.

### Run 2 — orphans + residual near-misses (subagent, Opus)
Input 702 rows / 265 KB (647 orphans, 54 near-misses, 1 want-link). **Peak ~30% of 1M**,
313,630 tokens, 39 tool calls, 19 min. Coverage 702/702, verified mechanically.
Output 547 ops (50 link / 497 ignore / 0 unlink), 11 `review[]`, 7 `dataQuality[]`, 3 policy
amendments. Proposal: `audit/proposal-orphans-2026-09-20.json`.

**Applied as `audit/proposal-orphans-2026-09-20.filtered.json` — 383 of 547 ops** (50 links + 333
ignores). 164 ignores were dropped: the agent disclosed that 177 came from a bulk second sweep
gated only on a shared non-stopword token, producing pairs like `West Cork Original` vs
`High West Bourbon` ("west") and `Leiper's Fork Bottled in Bond` vs `Rebecca Creek Bottled in Bond`
("in bond"). Different brands sharing a generic word: correct rejections, worthless labels, 105 of
them below `prob 0.01`. The 13 that cleared `prob >= 0.1` were kept. **This caused the ignore rule
in the runbook to be rewritten** — retrieval does NOT imply plausibility, because the blocker
retrieves on token overlap and tokens collide by coincidence.

Ignores by prob were materially better than Run 1 even so: 68% below 0.1 (vs 87%), **156 at
`prob >= 0.1` and 41 at `>= 0.5`** (vs ~27). Orphans supply hard negatives the near-miss funnel
structurally cannot, since near-misses are by definition pairs with shared overlap evidence.

Notable: **`743304` Blanton's Original Single Barrel <-> `id:7433051` Blanton's Special Reserve at
prob 0.995, `flag:hit`** — 46.5% single barrel vs the 40% green label. A live auto-classify false
positive that would fire today. Also two links the ranker never offered as candidates, found only
via a grep census (Wiser's One Fifty / 150 Commemorative at an identical $299.99; King George V
"Bin End" vs standard).

Its own verdict on the orphan funnel: 50 links from 647 rows (7.7%) is low yield, and **zero
above-bar pairs** — every link it found was BELOW bar (median ~0.6, several under 0.1). Retrieval
is no longer the bottleneck; the scorer retrieves these and then under-ranks them on typos,
truncated titles and one-sided ABV/size statements. **That is a calibration gap, not a blocking
gap** — which is the single most useful finding for improving the auto-linker.

### Springbank — resolved, and it exposed the window trap
The owner's hunch was right in substance. `id:8768911` / `id:8768913` (Springbank 10 + Raasay duos
at Sierra Springs) should link to the Springbank 10 group under the bundle rule. Both were first
seen 2026-05-27, **16 days before the window opens**, so no funnel could ever surface them. The
Longrow / Kilkerran / Springbank 10 families that *look* scattered in a grep census are already
correctly grouped. One real in-window miss was found and proposed: `146233` Sierra "Hazelburn 10 +
Kilkerran 12 Combo" -> `226613` Liberty "Hazelburn 10 Year Old" (two-rare bundle -> the rarer).

### Session totals (2026-09-20, all applied, NOT committed)
links **5,845 -> 5,972** (+127), ignores **12,606 -> 13,540** (+934), 1 link removed.

## Tooling changes shipped 2026-09-20 (all in `scripts/audit_new_listings.js`)

The runbook + tools are now adequate for an agent to fully audit a slice in BOTH directions. Three
gaps were closed; before these, a slice audit could add links but could not meaningfully remove
them.

1. **`need-unlinks` no longer gated on `wasAutoLinked`.** It now surfaces ANY existing link
   re-scoring below bar, pins excluded, whatever wrote it. Measured effect: 30-day window 0 -> 64;
   3-month window 2 -> 182.
2. **New `vl` field on compact + ultra-compact rows** (`projectVerifiedLinks`) — the listing's own
   existing links, re-scored: `[partnerSku, partnerName, prob, source(m|a|g), flag(!|p)]`.
   Previously the views exposed only `links: <count>`, and nothing at all under `--ultra-compact`.
   Documented in the machine `_meta.legend` and in the runbook's field reference.
3. **Runbook: new section "Auditing a COMPLETE SLICE (the trust-nothing mode)"** — `--only all`
   instead of funnels, both questions per row (`pairs` = needs a link, `vl` = has a wrong link),
   the explicit warnings that a row with no candidates is NOT automatically a no-op and that an
   unflagged link is NOT proven correct, a per-row coverage contract, and the window trap.
4. **Runbook: ignore rule rewritten** around confusability rather than retrieval (see Run 2).
5. `apply_audit_proposal.js`: fixed a TDZ `ReferenceError` that crashed any proposal carrying a
   `dataQuality` array (validation pushed onto `errors` before that `const` initialised).

6. **Default `--limit-pairs` cap removed.** `--ultra-compact` used to imply 6 pairs/row, ordered
   flagged-first — the classical ranker silently choosing which candidates the agent got to judge.
   Measured on the 1,520-row near-miss funnel it dropped 8 of 3,196 pairs for 0.17% of bytes: it
   bought nothing and biased the sample. Still available explicitly; never use it on a slice audit.

**Known limits that remain — see the runbook's "What even a complete slice CANNOT see".** The
ignore file hard-suppresses pairs from the pool (~13,540 pairs invisible; a wrong ignore is
unfalsifiable — OPEN, owner's call to leave as-is), `need-unlinks` is below-bar only so it cannot
satisfy criterion 2 alone, and pool recall is "100% of what the old tools could find" rather than
100% — an accepted, measured-saturated cost/accuracy tradeoff.

Measured slice cost with all of the above: **417 B/row ultra-compact**, of which only **2% of rows
are true no-ops** (no candidates AND no existing links) — so there is little dead weight to strip.
34,247 listing units x 417 B ~= 14 MB ~= 4.8M tokens ~= 50 runs at listing granularity. The lever
is the group-major view (4.14x collapse to 8,263 groups), which is still unbuilt.

## Plan for the rest of the library

### Step 1 — one whole-history generate, and measure it
```
node scripts/audit_new_listings.js --root .worktrees/data --format jsonl \
     --out audit/rich-full-history.jsonl        # NO --since
```
Unknowns to record: wall time (4,344 listings took 80 s), output size (86 MB at 4,344), peak RSS,
and the resulting funnel row counts. If it will not complete or the file is unwieldy, fall back to
generating per date range and accept re-running the generator per batch.

### Step 2 — size the work from the real funnels
Project each funnel `--ultra-compact` and measure bytes. Budget from the two measured points:
**~700 rows / ~265–300 KB ≈ 30% of a 1M context.** Hard ceiling 50%; compaction is a failed run.
If the 26% funnel-rows-per-listing ratio held, 34,247 listings ⇒ ~9,000 funnel rows ⇒ ~12 runs.
Treat that as a FLOOR (see "pre-June population" above).

### Step 3 — build the group-major review view (NOT BUILT)

The generator is listing-major with funnels. A trust-nothing pass needs the opposite: **one row per
canonical group**, judged in both directions at once. `--cluster <canon> --compact` does a single
group and `--only all --compact` pages listings with 4.14x duplication; neither is the tool.

Emit per group, ultra-compact:
- members: sku / store / name / price / removed
- existing links **with their live re-score** (from `scores.verified[]`) and `pinned`
- top candidates not yet in the group, with `prob/det/pr/prPct/pol/hints/rar`
- a flag when any member link re-scores below bar and is not a pin

Target ≤ ~700 B/group; every 100 B saved is roughly one fewer agent run.

### Step 3b — batch the group review

**8,263 groups** (3,158 multi-SKU, 5,105 singleton). At ~700 B/group that is ~5.8 MB ≈ 1.9M tokens
of input ⇒ **~15-25 agent runs** at the proven budget (~90K tokens input, ~300K peak, 30% of 1M,
~14 min each). Order the batches so the cheapest corrections land first and shrink what follows:

1. **Groups with a below-bar non-pinned existing link** (~182 in-window; extrapolating 3.4% to the
   full link set, ~200 library-wide). Smallest, highest stakes, and the population the broken gate
   hid. Do this first, it is well under one run.
2. **Multi-SKU groups** (3,158) — precision review: is every member the same product?
3. **Singleton groups with candidates** (subset of 5,105) — recall review. Singletons with NO
   candidate above any floor are a no-op; measure that count from the full-history file and skip
   them rather than paying an agent to read them.

Apply between every batch. This is proven, not theoretical: applying Run 1 collapsed near-misses
437 -> 54 and want-links 30 -> 1, so each applied batch makes the next cheaper.

### Step 4 — per-batch recipe
Each subagent gets: the runbook, `data/sku_link_policy.md`, its funnel files, the deep-dive CLI,
and a proposal + `decisions.jsonl` path. It must NOT apply, commit or push. After each run,
independently verify before applying:
- `git status` clean in the worktree (it did not write)
- op counts, and every op has a real `why`
- coverage: diff the decisions file's ids against the funnel's — expect 0 missing, 0 extra
- reproduce the applier dry-run yourself
- sample ~10 ignores across the range, and bucket all of them by `prob` band

## Open items

- **Two Springbank bundles still unlinked** (`id:8768911`, `id:8768913` → Springbank 10 group).
  Policy's bundle rule covers them explicitly; they are out of the current window. Quick manual fix.
- **`pol` does not protect the CI writer.** It is computed in the audit report only;
  `auto_link_classify.mjs` never sees it. Whether CI should veto mechanically is an open decision.
- **Pool truncation is louder than when it was last measured** (`perKey 18,438 keys / 7.2M
  dropped`). Prior evidence says the pool is not the binding constraint (`MAX_CHEAP_KEEP`/`MAX_FINE`
  bind first), but that was measured on the stale-embeddings run. Worth one re-measurement.
- **4 cross-store SKU collisions** (`148534`, `111168`, `134037`, `136399`) are not agent-fixable;
  see `data/sku_link_policy.md`. Blocking criterion 2 — they need the `(storeId, sku)` split
  mechanism, which is deliberately unbuilt (owner's call: 0.09% of multi-store numeric SKUs).

## Honest status against the definition of done

| criterion | status |
|---|---|
| 1. recall — every needed link exists | **~13% of the library examined** (the default window). Within it, high confidence: retrieval is NOT the bottleneck — Run 2 found zero above-bar orphan pairs and every link it found was below bar, i.e. a calibration gap. Pre-June (~31,000 listing units, 87% of the library) is unexamined and has never even been an auto-link anchor |
| 2. precision — every link correct and required | **Now POSSIBLE, not yet DONE.** The `wasAutoLinked` gate and the missing `vl` field made it impossible before 2026-09-20; both fixed. ~182 below-bar links are known in-window and have not been adjudicated. Implicit links are out of scope by owner ruling. "Required" (redundancy) is handled mechanically by `writeLinks` |
| 3. hard negatives | **934 ignores added 2026-09-20.** Quality improved across the two runs (Run 1: ~27 at `prob >= 0.5`; Run 2: 41) and the rule is now confusability-based, so future runs should skew harder |

## Real sizing, from the completed full-history generate (2026-09-20)

Two ways to cover the library. Pick per your tolerance for missed links.

| approach | rows | est. input | est. agent runs |
|---|---|---|---|
| **Funnel-major** (near-miss 1,678 + orphans 3,123 + want-links + need-unlinks ~1,200) | ~6,000 | ~2.5 MB / ~830K tok | **~9-10** |
| **Slice-complete** (`--only all`, every listing unit) | 34,247 | ~14 MB / ~4.8M tok | **~50** |
| Slice-complete, group-major (4.14x collapse, view NOT built) | 8,263 | ~3.5 MB / ~1.2M tok | **~15** |

Measured constants to budget against: **417 B/row** ultra-compact with `vl`; **~90K tokens of
funnel input per run peaks at ~30% of a 1M context**; ~300K tokens and 14-19 min per run. Only 2%
of rows are true no-ops (no candidates AND no existing links), so slice-complete has little dead
weight to strip — the group-major view is the only real lever between 50 runs and 15.

Funnel-major is ~5x cheaper and catches everything the tooling can see; slice-complete is the
literal reading of "trust nothing" and additionally catches pairs the ranker never surfaced at all
(Run 2 found two such links only via a grep census). A defensible middle: funnel-major over the
whole library first, then slice-complete over the multi-SKU groups only.

## Immediate next steps, in order

1. **The full-history generate WORKS — measured 2026-09-20.** `--since 1970-01-01` completed in
   **11m54s**, output **717 MB**, 34,247 listings, 32,954 scored, **164,030 candidates, 38,047
   verified pairs**, median pool 343. Library-wide: **31,124 (90.9%) have links, 3,123 orphans,
   1,678 near-miss listings**, 1,146 title-twins, `noopVerified.unexaminedCandidates: 0`. The
   scale scars in the code are real and already handled (batched jsonl writes after `Array.join`
   overflowed V8's max string length; a streaming `--from` loader because 717 MB exceeds
   `readFileSync`).

   **`audit/rich-full-history.jsonl` (the 20:40 file) is STALE and must not be used for criterion
   2** — it was generated from the code as it stood before the same session's `needUnlink` and `vl`
   fixes, so `--only need-unlinks` returns 0 against 38,047 verified pairs and rows carry no `vl`.
   It is still valid for recall funnels. **`audit/rich-full-history-v2.jsonl` was regenerated with
   both fixes plus the Run 2 links applied, and is VERIFIED** — use this one. Regenerating costs
   12 minutes; always regenerate after applying a proposal.

### Criterion 2, measured library-wide for the first time (2026-09-20)

From the verified v2 file:

```
node scripts/audit_new_listings.js --from audit/rich-full-history-v2.jsonl \
  --only need-unlinks --ultra-compact --format jsonl --out audit/fh2-need-unlinks.jsonl
```

**1,226 listings** carry at least one existing link that re-scores below the 0.95 bar and is not a
deterministic pin — **1,321 flagged links in total, 3.5% of the 38,047 verified pairs**. Every one
of the 1,226 rows carries `vl`, so the projection is doing its job. Triage splits
`noop-verified: 1,146 / check: 78 / auto-high: 2`.

| `prob` band | flagged links | read |
|---|---|---|
| 0.80–0.95 | 853 | just under bar — mostly real links the scorer is merely unsure about; low yield, but they are the bulk |
| 0.60–0.80 | 179 | genuine judgement calls |
| 0.30–0.60 | 136 | suspicious |
| 0.10–0.30 | 35 | probably wrong |
| < 0.10 | 118 | **the high-yield set** — the scorer sees essentially nothing in common |

`prob: null` partners (synthetic `u:`-prefixed SKUs that have left the catalog) are NOT flagged and
NOT counted here; they need a separate decision about whether a link to a vanished listing should
survive at all.

**Do not adjudicate all 1,321 in one pass.** The 153 below `prob 0.30` are a single small agent run
and are where the wrong links actually live; the 853 in the top band are a much larger, much lower
yield job and should be batched separately (or sampled first to measure the base rate before
spending ~2 runs on them). The earlier "~182 in-window" figure was a window artifact — the real
number is 7x that.
2. **Adjudicate the 153 below-bar links under `prob 0.30`** (see the band table above) — one
   small agent run, highest stakes per row, the first real test of criterion 2. The 853 in the
   0.80–0.95 band are a separate, later, lower-yield batch; sample before committing runs to them.
3. **Build the group-major view** (4.14x collapse) before committing to the whole-library pass —
   it is the difference between ~50 runs and ~15.
4. **Re-run the slice protocol** over the pre-June population in batches, applying between each.
5. Two Springbank bundles (`id:8768911`, `id:8768913`) -> Springbank 10 group: quick manual fix,
   out of window.

## Uncommitted at hand-off

`data` branch: `data/sku_links.json` (+127 links, +934 ignores), `data/sku_link_policy.md`
(six owner rulings + the collision section).
`main`: `CLAUDE.md`, `docs/audit-runbook.md`, `docs/audit-full-library-plan.md` (this file),
`scripts/audit_new_listings.js`, `tools/apply_audit_proposal.js`.
`audit/` outputs are gitignored: 5 proposals + 2 decisions files from today.
