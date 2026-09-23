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

**Status 2026-09-22: the trap is closed for the work done so far.** Every run in the 2026-09-22
session used `--since 1970-01-01` (34,247 listing units). Coverage is now limited by SURFACE — which
funnels have been adjudicated — not by time. See "What is now covered, and what is NOT". The
default is still a trap for the NEXT run: pass `--since` explicitly, always.

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

## Session log — 2026-09-22 (autonomous run)

### Inputs refreshed first (do this every time)
The data worktree was 2 days behind (`42fefe94a8`, links 5,975 / ignores 13,540) and the local
`sku_embeddings.json` was stale against the Release asset. Both refreshed (13,779 vectors) BEFORE
generating, then a full-history rich file rebuilt:

```
node scripts/audit_new_listings.js --root .worktrees/data --since 1970-01-01 \
     --format jsonl --out audit/rich-fh-v3.jsonl
```
**9m52s · 717 MB · 34,247 listings · 32,954 scored · 163,991 candidates · 38,213 verified pairs ·
31,193 (91.1%) linked · 3,054 orphans · 1,535 near-miss.** `audit/rich-fh-v3.jsonl` supersedes v2
and the original; delete the older two when convenient.

Funnels off it: need-unlinks 1,217 rows (1,312 flagged links), near-miss 1,535, want-links 194
(**159 of them above the auto-link bar**), orphans 3,054.

### Springbank bundles — RESOLVED and verified
`id:8768911` and `id:8768913` (Sierra Springs Springbank 10 + Raasay duos, both delisted, first
seen 2026-05-27 so invisible to every default-window funnel) are now linked to canonical `711620`.
Policy §Bundles names this exact shape — its worked example is literally a Springbank 10 + Ledaig
10 duo, and Springbank is listed as allocated while Isle of Raasay is in general distribution
(`124215` sits at 5 stores). Applied via `audit/proposal-springbank-2026-09-22.json`; verified with
`loadSkuMap().canonicalSku()` — all of `id:8768911`, `id:8768913`, `711620`, `876891` now resolve
to `711620`. Links 5,975 → 5,977.

### `876891` is a BENIGN SKU collision — and that distinction matters generally

Sierra Springs `876891` = "Springbank 10 Year & Glen Scotia 12 Year Combo" ($185.99); ZYN `876891`
= "Springbank 10 Year Old - 700 ml" ($105.00). Two different listings sharing one numeric SKU, so
mechanically it is the same class as the documented collisions. **But it is not a defect** (owner
ruling 2026-09-22): by §Bundles the Springbank+Glen Scotia combo links to the Springbank 10 group
anyway, and the ZYN side IS Springbank 10 — so both belong in one canonical group. The collision
produces the correct grouping by accident. No action, no `dataQuality` entry warranted.

**The general rule this establishes, which the policy file should absorb:**

> A cross-store SKU collision is a DEFECT only when the two products belong in DIFFERENT canonical
> groups. When policy would link them anyway — a rare-item bundle colliding with that same rare
> item, a size variant within tolerance, a market variant — the free merge is simply correct, and
> reporting it as a collision is a false positive.

So the collision census must be filtered by "would policy separate these?", not merely by "do the
two titles differ?". Applying that filter to this session's finds: `876891` is benign; the other
five below all pair products policy separates (different distillery, different vintage+ABV,
different expression entirely) and remain real defects.

### Two applier defects found and fixed (`tools/apply_audit_proposal.js`)
1. **Ineffective unlinks were reported as `ok`.** Removing A–B does nothing if A–C–B still connects
   them. Now re-checked against the FINAL link set: `WARN` + `ineffectiveUnlinks[]` in the report.
2. **Worse — those unlinks still wrote their automatic hard negative.** `normalizeOp` defaults
   `unlink` to `ignore: true`, so an ineffective unlink recorded "these differ" for a pair the link
   file still groups as ONE product — incoherent training data, and unrecoverable because ignored
   pairs never re-enter the candidate pool. The ignore is now withheld in exactly that case; a
   pre-existing ignore is never touched.

### New guard: `tools/validate_proposal_skus.js` — run it on EVERY proposal before applying
```
node tools/validate_proposal_skus.js --proposal <file> [--root .worktrees/data]
```
**Why it exists.** The rich file is inconsistent about the `id:` prefix. The catalog index and
`sku_links.json` key that listing as `id:8768911`; the per-SKU cache file is `8768911.json` (a
filesystem-safe name — colons stripped); and the audit's **cluster/member structures use the
stripped form too**, while `pairs[].sku` and `vl[][0]` use the correct prefixed form. An op written
from the stripped form validates, applies, and silently creates a link to a SKU that does not
exist. The validator resolves every op's `a`/`b` against the real catalog (15,579 known keys) and
suggests the prefixed form when it finds one. Exit 1 on any unknown ref.

**This is a latent bug in `scripts/audit_new_listings.js`, not just a documentation gap** — the
listing-unit id and cluster keys should use the normalized key. Not fixed here because three agent
runs were live against the current file. Fix before the next generate.

### Run 3 (criterion 2, `prob < 0.30`) — COMPLETE and APPLIED

135 rows / 148 `adj` occurrences, which collapse to **26 distinct undirected pairs** (the slice is
heavily redundant — `111168↔239114` recurs on 8 store rows). Coverage verified independently by me,
not taken on trust: 0 missing, 0 extra. 176K tokens, 16 tool calls, 11 min.

Applied: **6 unlinks, 2 links** → links 5,977 → 5,973, ignores 13,540 → 13,546. No
`ineffectiveUnlinks` warning fired, so all six genuinely split their groups. I independently
re-verified the two highest-stakes unlinks against the catalog before applying:
`743193` is Signatory **Glentauchers** 16yo 2009 while `108763` is Signatory **Aultmore** — different
distilleries; and Bowmore Aston Martin Masters' Selection **Ed. 2** ($609.99) vs **Ed. 3** ($913.57),
with `410988` correctly left joined to `879741` (Ed. 2, $689.30).

The other unlinks: TBWC Canadian Corn 10YO vs 8YO; The Irishman NAS vs 12 Year Old (both BCL and
CLB stock the two side by side — two independent price ladders agreeing); and a two-op SET splitting
Laws San Luis Valley Straight Rye from Laws Bottled-in-Bond, plus a compensating link so the two BiB
listings did not orphan. That set is the pattern the new `ineffectiveUnlinks` check exists for.

#### Finding 1 — `prob` carries NO signal inside the below-bar band
Of the 26 pairs, **18 were correct links (69%) and only 6 were wrong (23%)**. The distribution by
minimum `prob`:

| band | KEPT | UNLINKED |
|---|---|---|
| < 0.01 | 9 | 4 |
| 0.01–0.05 | 3 | 1 |
| 0.05–0.10 | 3 | 1 |
| 0.10–0.20 | 1 | 0 |
| 0.20–0.30 | 2 | 0 |

The two LOWEST-scoring pairs in the entire slice (Alberta Premium at 0.0005, Octomore 15.3 at 0.002)
are both **correct**, while the wrongest link found (Aultmore↔Glentauchers at 0.0006) is
indistinguishable from them by score. **Consequence for the plan: do not sub-prioritise the
remaining below-bar backlog by `prob`** — it does not rank wrongness. The band choice still mattered
(23% wrong here vs an expected far lower rate in the 0.80–0.95 band), but within a band the score is
noise. Also note: **zero `no-embedding` hints appeared anywhere in the slice** — with a fresh
embeddings file these low scores are name-level, not vector-level.

#### Finding 2 — cross-store SKU collisions are ~2.5x more common than the policy file records
This is the run's most consequential result and it **challenges an owner ruling**. Six of the 18
correct-but-low-scoring links score near zero for one reason: **the aggregate's name was taken by a
DIFFERENT product colliding on the same SKU at another store**, so the scorer compares the right
listing against the wrong name. Five were previously unknown:

| sku | collision |
|---|---|
| `111168` | Octomore 15.3 vs Highlander "L'Eroe Negroni" — already in the policy table |
| `105751` | BCL "Alberta Premium 20 Year Old" vs CLB "Two Brewers Release 43" — **new** |
| `1049487` | Sierra Springs Octomore 11.1 vs Wine&Beyond "Clynelish 10yr 2023 SR" — **new** |
| `1049495` | Sierra Springs Laphroaig Cairdeas vs Wine&Beyond "Roseisle 12yr SR" — **new** |
| `121105` | KWM 8yr rye (delisted) vs Sherbrooke "20yr Canadian Whisky" — **new** |
| `108763` | BSW "2007 Aultmore 57.1%" vs Craft Cellars "Aultmore 16yo 2009 100 Proof" — **new**, within-brand |

(`876891`, found by hand this session, was initially counted here and is NOT a defect — see the
benign-collision rule above.) **Known harmful collisions: 4 documented → 9 actual**, and five of
those came out of a single 135-row slice. **Sierra Springs and Wine and Beyond share a `104xxxx`
numeric-id namespace** — a mechanically detectable family that produced two of the new cases.

The standing ruling ("0.09% of multi-store numeric SKUs, does not justify the split mechanism") rests
on a measurement of 4 real collisions in 4,445 multi-store numeric SKUs, made with a name-overlap
test. That test evidently has poor recall. **The rate should be re-measured before the ruling is
relied on again** — and note the damage is not only display: a poisoned aggregate name degrades every
name feature and every blocking channel for that SKU, which is why these links score 0.0005 instead
of 0.9. This is a RECALL problem for the linker, not just a cosmetic one. Owner decision needed.

#### Follow-ups the run surfaced
- 3 `review[]` items left deliberately linked: Saint James Rhum generic title (ladder ambiguous),
  High Coast `7921046` (one sku carrying two conflicting names at a placeholder-looking $81.80), and
  `379055 ↔ 895812` (both read as TBWC Canadian Corn 8YO but 2x apart on price).
- **Six link partners have EMPTY names and null scores** (`u:0479483d`, `u:2b06dbd7`, `u:7c2d25ea`,
  `u:63bba38f`, `u:9e87d0f1`, `u:4a6448e2`) — synthetic delisted listings whose name was never
  captured. They are structurally un-adjudicable from the report. A policy decision is needed on
  whether a link to a nameless vanished listing should survive at all.
- Tooling asks from the agent: `--pair` prints `found: 0` for a pair that never entered the pool,
  which reads as "no data" rather than "not scored"; and a `pol`-style mechanical flag for "this
  sku's listings have materially different names across stores" would surface the collision family
  without needing brand greps.

### Run 4 (want-links) — COMPLETE and APPLIED

194 rows (184 distinct listing units), 244K tokens, 23 tool calls, 14 min. Coverage verified
independently: 194/194, 0 missing, 0 extra. Applied **28 links + 49 ignores** (19 further links
skipped as normal in-proposal transitive redundancy) → links 5,973 → 6,001, ignores 13,546 → 13,595.
**link:ignore = 49:49** — a genuine 1:1, and not padded: the ignores are the direct product of a
large false-positive cluster, with zero coincidental-token ignores emitted.

#### The headline: 36% of above-bar pairs were WRONG
Of 77 distinct pairs scoring `>= 0.95`, the agent accepted 49 and **rejected 28**. 46 of the 194
rows had every one of their above-bar pairs rejected.

**Caveat that must travel with this number:** the audit's union blocker is wider than
`auto_link_classify.mjs`'s own dist+SMWS blocker, so not all 77 are pairs CI would actually have
written. 36% is the false-positive rate of *the audit pool's* above-bar set — an **upper bound** on
CI's true rate, not a measurement of it. Measuring CI's own rate needs the same adjudication run
against the CI blocker's candidate set.

Failure patterns, by blast radius:

| pattern | n | note |
|---|---|---|
| One mistitled listing | **5** | Sierra Springs `id:1049964` titled "Kilchoman 100% islay 50%" but its url slug says `the-4th-edition`. Kilchoman 100% Islay is an annual edition and the catalog holds the 4th, 11th, 13th, 14th, 15th. Fixing the title at source kills all five FPs |
| Edition / batch / vintage mismatch | 9 | Adelphi Batch 2 vs 5; Macduff `2011` vs `2011A`; two different Glenfarclas Family Casks; Signatory Caol Ila 2013/12yo/#65 vs 2015/9yo/#26 |
| Same distillery, different expression, ~zero token evidence | 6 | includes the known Macaloney's An Aba ↔ W&B Single Barrel at **prob 0.9996 with det 0.00** |
| Bonus/on-pack item matched on the rider's name | 4 | "Forty Creek Barrel Select **with Bonus Copper Pot** 750ml + 50ml" scored above bar against three real Copper Pot SKUs |
| Gift pack | 1 | |
| Independent bottler | 1 | ARC "Balmenach **Old Malt Cask** 14yo" vs a **First Editions** Balmenach — two different IBs at near-identical $190, invisible from the titles |

**Only ONE of the 28 carried a `pol` marker.** The mechanical screen caught essentially none of
this. The decisive evidence was the **url slug** in 6 cases and the store's own price ladder in 4 —
neither of which is on the row. That is a concrete argument for surfacing the slug on candidate
rows, and it independently confirms the standing decision to keep judgement in the agent rather
than adding mechanical screens.

#### I withheld 2 of the agent's links — collision contamination
The agent proposed linking the real 8-listing Roseisle 12 group to `id:1049495`. Deep-dive confirms
that SKU holds **two products**: Sierra Springs "laphroaig cairdeas (port and wine cask)" $177.04 AND
Wine and Beyond "Roseisle 12yr Special Release" $179.95. The link is right for the Roseisle side and
wrong for the Laphroaig side, so applying it would have merged Laphroaig Cairdeas into the Roseisle
group. Moved to `review[]` + `dataQuality[]`.

**This is a new, generalisable hazard: linking TO a collided SKU spreads the contamination into a
clean group.** The agent could not have known — the collision was found by the concurrent
criterion-2 run. Two consequences: (a) the collision census should be built ONCE and handed to every
agent as an input, not rediscovered per run; (b) the runbook's "one sku, two products ⇒ do not link"
rule needs to be checked against the *partner* SKU too, not only the anchor.

#### Confirmed minor bug: `prob` can exceed 1
The agent flagged a pair reporting `prob: 4.2`. Verified across the whole 717 MB file: **3
occurrences** (two at 4.2, one at 6.91) out of ~200,000 scored pairs — a deterministic floor-pin raw
score leaking into the calibrated `prob` field, carrying `flag:"hit"` instead of a pin marker. Real
but negligible in volume; root-cause when convenient, not blocking.

### Runs 5 & 6 (near-miss, batches A and B) — COMPLETE and APPLIED

The 1,535-row near-miss funnel, split in two and run concurrently. Both hit full coverage
(768/768 and 767/767, verified independently, no early stop).

| | batch A | batch B |
|---|---|---|
| ops | 14 link / 565 ignore | 11 link / 358 ignore |
| applied | +6 link / +551 ignore | +3 link / +288 ignore |
| review / dataQuality | 17 / 8 | 4 / 3 |
| tokens | 564K, 47 calls, 23 min | 200K, 22 calls, 7 min |

**The ~1:40 link:ignore ratio is correct here, not the trial-1 defect inverted.** This funnel is
dominated by one population: mass-market brands listed in five to eight bottle sizes (Captain
Morgan 50ml→1.75L, Crown Royal 50ml→3L, Jameson, Bacardi, Fireball, Lamb's). Same brand, same
expression, one token of difference — the single most confusable class in the catalog, and exactly
what the size rule makes a clean hard negative. Batch A pruned 3 formulaic cross-brand ignores; B
deliberately left 29 coincidental-token pairs as no-ops (`Crown Royal` ↔ `Royal Reserve`,
`Lambs White Rum` ↔ `Corsairs White Rum`). That is the rule working as intended.

**Both named blind spots cost ZERO recall in this funnel.** All 25 links came from ordinary `t:"c"`
candidates: 0 from `no-embedding` pairs (batch B had 0 of 1,584 — the embeddings asset is healthy)
and 0 from `t:"w"` title-twins. Every twin in both batches was the same title at a different size,
so the twin channel surfaced 643 pairs and produced no links. **The recall actually lost was lost to
unstated sizes** — the links found all needed the store's price ladder to resolve a sizeless title.
That is a concrete redirection of where to spend effort next.

Further live auto-linker false positives found: Bowmore 30 2023 vs 2020 Release (0.9759), Millstone
PX Peated vs 5yr Lightly Peated (0.9813), Gibson's Finest Rare 12 vs a Sterling 1.14L + Rare 50ml
on-pack (0.9559). Batch A also flagged four **existing** links that look wrong via `vl[]` (Barrell
Craft Gold vs Gray Label Dovetail 0.9495; Kraken Black vs Gold Spiced 1.14L 0.9502; Keg N Cork Old
Grand Dad 40%/50% appear swapped between the standard and Bonded groups; Bombarda Culverin sitting
in the Falconet group) — recorded, not actioned, since that was a recall pass.

### THE STRUCTURAL BUG THIS SESSION FOUND: collided SKUs are trainable

Escalated by the owner from a one-line observation ("sounds like a bug in the way we evaluate",
"individual links can be faulty even if the group as a whole has some valid ones"). Both halves are
correct and the second is the sharper one.

`tools/linker_ml/build_dataset.mjs` generates positives as the **full transitive closure** of each
canonical group, and asserts the reason in a comment: *"if A,B,C,D are one canonical group via any
mix of manual/auto/shared-SKU links, every pairing is a valid positive."* That assumption fails two
ways:

1. **One faulty member contaminates a clique, not a pair.** A wrong member of an N-member group
   becomes a positive against all N−1 others, so a single bad edge multiplies.
2. **A collided SKU is itself a group member.** The trainer was being taught
   *"Roseisle 12yr Special Release ≡ Laphroaig Càirdeas 2023"* as a **positive** — and unlinking
   cannot fix it, because no link created that merge.

Measured over the live catalog: **45 of 3,039 multi-member groups** contain a collision candidate.
Over the 82 *heuristic* candidates that is 117 of 11,210 positive pairs (1.04%); over the **11
verified** collisions the shipped exclusion blocks **46 pair insertions** (the dataset shrinks by
only 28 — the random/hard-negative samplers backfill the freed slots). Quote 46 blocked as the
measured figure and 117 as the upper bound pending verification of the remaining candidates.

**Fix shipped**, following the existing precedent (`featurize.mjs` already excludes
`sku_hidden.json` listings; `build_dataset.mjs` already honours `noTrain`):
- **`data/sku_collisions.json`** (data branch, new) — curated, human/agent VERIFIED collisions only.
  11 entries, each with the two conflicting product titles. A collision is recorded only when the
  two products belong in DIFFERENT canonical groups; benign ones (`876891`) are deliberately absent.
- **`build_dataset.mjs`** drops any pair touching a listed sku, inside `add()` so positives,
  ignores and `noTrain` pairs are filtered uniformly, and **prints the count** — a silent filter is
  how the stale-embeddings incident happened. Missing file throws rather than silently disabling.
- **`tools/detect_sku_collisions.mjs`** (new) — regenerates the candidate census from
  `index.json` (5,441 multi-store skus → 82 zero-shared-brand-token candidates). Candidates, not
  verdicts: promotion into the curated file requires the "would policy separate these?" judgement.

**This reopens the standing "0.09%, not worth fixing" ruling.** That rate came from a name-overlap
test finding 4 collisions in 4,445 multi-store skus; we are now at 11 verified with 82 candidates
outstanding, and the harm is not cosmetic — a poisoned aggregate name degrades every name feature
and every blocking channel for that sku (measured: correct links scoring 0.0005), AND the pair
enters training as a positive. It is a recall and a training-data problem, not a display problem.

### One live mislink severed (owner-escalated)
`1049495 ↔ upc:501001900002` removed. It joined the collided sku `id:1049495` to Co-op's live
"Laphroaig Càirdeas White Port & Madeira Cask 2023" — correct for the Laphroaig side, but it also
grouped the **live** Wine and Beyond "Roseisle 12yr" with a **live** Laphroaig, so the Roseisle item
offered Co-op's Laphroaig as a cheaper store for the same product. Severing costs only a delisted
Sierra Springs listing's association. Applied with **`"ignore": false`** — the two products really
are the same, so the default hard negative would have been false training data. **That exception is
now a rule: when you unlink to contain collision damage rather than because the products differ,
suppress the ignore.**

### Session tally — 2026-09-22

Six proposals applied. **Links 5,975 → 6,009 (+41 added, −7 removed). Ignores 13,540 → 14,434
(+894).** Every proposal passed `tools/validate_proposal_skus.js` before apply, and every row of
every slice is accounted for in a `decisions.jsonl` I diffed myself rather than trusting the
agent's own count.

| run | surface | rows | coverage | applied |
|---|---|---|---|---|
| Springbank (by hand) | owner-identified, out of window | 2 | n/a | +2 link |
| 3 — criterion 2 | existing links, `prob < 0.30` | 135 (26 pairs) | 148/148 | +2 link / −6 link |
| 4 — want-links | above-bar not yet linked | 194 | 194/194 | +28 link / +49 ignore |
| Càirdeas (by hand) | owner-escalated live mislink | 1 | n/a | −1 link |
| 5 — near-miss A | rows 1–768 | 768 | 768/768 | +6 link / +551 ignore |
| 6 — near-miss B | rows 769–1535 | 767 (403 pairs) | 767/767 | +3 link / +288 ignore |

Agent cost: ~1.18M subagent tokens, 108 tool calls, ~62 min wall clock across four runs (three
concurrent). None came close to filling its context.

**Three things I withheld or corrected rather than applying as-received** — worth knowing that
review is load-bearing, not ceremonial:
1. **2 links dropped** from run 4 (Roseisle → `id:1049495`) because the partner sku is collided;
   linking TO a collided sku spreads contamination into a clean group. New hazard, now in the
   runbook.
2. **3 SKU refs repaired** in run 4 and **12 in run 6** where an op used the bare `1000541` form
   instead of the catalog's `id:1000541`. These would have applied cleanly as dead links. The
   validator caught every one; run 6's agent self-repaired using it.
3. **`876891` reclassified** from "fifth collision" to benign, on the owner's ruling.

### What is now covered, and what is NOT

**The library is fully covered by TIME.** Every run this session was against a full-history
generate (`--since 1970-01-01`, 34,247 listing units). There is no "next time slice" — the window
trap is closed. What remains is coverage by **SURFACE**:

| surface | size | status |
|---|---|---|
| near-miss | 1,535 | **DONE** |
| want-links | 194 | **DONE** |
| existing links, `prob < 0.30` | 26 pairs | **DONE** |
| existing links, `prob 0.30–0.95` | ~1,160 | **NOT STARTED** — ~2 runs |
| orphans | 3,054 rows (2,707 with candidates) | **NOT STARTED** — ~2 runs, slice built at `audit/v3-orphans.jsonl` |
| everything else (`--only all`) | ~29,000 rows | not attempted; the funnels are the affordable proxy |

### Immediate next steps, in order

1. **Regenerate the rich file** — six applies have made `audit/rich-fh-v3.jsonl` stale. ~10 min.
   Refresh `sku_embeddings.json` from the Release asset and pull the data worktree first.
2. **Orphans** (3,054 rows, 2 runs). Highest remaining recall value: these have no links at all.
3. **Below-bar band 0.30–0.95** (~1,160 links, 2 runs). Run 3 measured that `prob` does not rank
   wrongness inside a band, so do NOT sub-prioritise within it — but the band choice still matters
   (23% wrong at `<0.30`; expect much lower here).
4. **Verify the 71 outstanding collision candidates** in `audit/sku-collisions.json` and promote the
   real ones into `data/sku_collisions.json`. Cheap, and it is now a training-data fix, not cosmetic.
5. **Work the `review[]` backlog**: 30 (run 4) + 17 (run 5) + 4 (run 6) + 3 (run 3) = **54 items**,
   including four existing links that look wrong (Barrell Gold/Gray, Kraken Black/Gold, Old Grand
   Dad swap, Bombarda Culverin) and the six nameless `u:` partners.
6. **Policy amendments proposed by four agents, none applied** (the policy file is human-owned):
   on-pack / "bottle + mini" bundles as a distinct class from bundles; PET/plastic with no stated
   volume; the url slug as a first-class identity source for EDITION, not just size; RTD spin-offs;
   per-barrel ordinals; cross-category brand collisions; gift box at the same price as the plain
   bottle. Also: add the five new collisions and the benign-collision rule to the policy file.

## Open items

- **`pol` does not protect the CI writer.** Computed in the audit report only;
  `auto_link_classify.mjs` never sees it. Whether CI should veto mechanically is an open decision.
  Run 4 is evidence AGAINST relying on it: only 1 of its 28 above-bar rejections carried a `pol`
  marker, so a mechanical screen would have caught almost none of them.
- **Cross-store SKU collisions: the "0.09%, not worth fixing" ruling should be revisited.** Now 11
  verified (was 4) with 71 unverified candidates in `audit/sku-collisions.json`. The harm is a
  recall and training-data problem, not display: a poisoned aggregate name drives correct links to
  `prob 0.0005`, and the pair enters training as a positive. Training exclusion is now shipped
  (`data/sku_collisions.json`); the catalog-level `(storeId, sku)` split is still unbuilt.
- **`prob` can exceed 1** — 3 occurrences in 717 MB (two at 4.2, one at 6.91), a floor-pin raw
  score leaking into the calibrated field with `flag:"hit"`. Real, negligible, unfixed.
- **`scripts/audit_new_listings.js` strips the `id:` prefix** from listing-unit ids and cluster
  keys while `pairs[].sku`/`vl[][0]` keep it. Root cause of every SKU ref the validator caught this
  session. Fix at source; `tools/validate_proposal_skus.js` is the guard until then.
- **Pool truncation re-measurement** still outstanding, and the numbers moved: the v3 generate
  reports `perKey 144,311 keys / 55.1M dropped`. Prior evidence says `MAX_CHEAP_KEEP`/`MAX_FINE`
  bind first, so this is probably still not the constraint — but it has never been measured on a
  fresh-embeddings full-history run.
- **An agent asked for two cheap ergonomics fixes**: `--pair` prints `found: 0` when a pair never
  entered the pool, which reads as "scored zero" rather than "not scored"; and
  `validate_proposal_skus.js` could take a `--fix` flag to apply its own suggestions.
- **Slice views should keep `id`** (`<dbFile>|<sku>`) rather than `sku`+`store`: a store carrying
  one listing in two DB files produces indistinguishable decision lines.

## Honest status against the definition of done

Updated 2026-09-22. The 2026-09-20 version of this table is superseded — it described a 13% window.

| criterion | status |
|---|---|
| 1. recall — every needed link exists | **Full history swept by the three recall funnels** (near-miss 1,535, want-links 194, plus Run 2's orphan pass), so the window trap no longer applies. **3,054 orphans remain unexamined** — the largest known gap. Beyond the funnels, ~29,000 listings have never been read row-by-row; the funnels are an affordable proxy for that, not a substitute. Measured this session: the retrieval channels are NOT the bottleneck (0 links recovered from `no-embedding` or title-twin pairs across 1,535 rows) — **unstated bottle sizes are** |
| 2. precision — every link correct and required | **Started, not done.** The `prob < 0.30` band is fully adjudicated: 26 pairs, 6 wrong (23%). **~1,160 links in the 0.30–0.95 band are untouched.** Run 3 measured that `prob` does not rank wrongness within a band, so the remaining work cannot be triaged by score. Four more suspect existing links were spotted incidentally and not yet actioned. Implicit links stay out of scope by owner ruling |
| 3. hard negatives | **+894 this session** (13,540 → 14,434), and the quality rule held: run 5 pruned its own formulaic cross-brand ignores, run 6 left 29 coincidental-token pairs as deliberate no-ops. Bands are recorded per run. Note the ratchet — ignored pairs never re-enter the candidate pool, so these are effectively permanent |
| (new) 4. training data is not corrupted | **Newly identified and partly fixed.** Collided SKUs were entering training as positives via the group transitive closure. 11 verified collisions now excluded (46 pairs); 71 candidates await verification |

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

## Uncommitted at hand-off (2026-09-22)

`data` branch (worktree `.worktrees/data`):
- `data/sku_links.json` — links 5,975 → **6,009**, ignores 13,540 → **14,434**
- `data/sku_collisions.json` — **NEW**, 11 verified cross-store collisions, consumed by
  `build_dataset.mjs`
- `data/sku_link_policy.md` — unchanged this session; still needs the five new collisions, the
  benign-collision rule, and the seven proposed amendments (all human-owned)

`main`:
- `CLAUDE.md`, `docs/audit-runbook.md`, `docs/audit-full-library-plan.md` (this file)
- `scripts/audit_new_listings.js` — default `--limit-pairs` cap removed
- `tools/apply_audit_proposal.js` — ineffective-unlink detection + ignore withholding
- `tools/linker_ml/build_dataset.mjs` — collision exclusion + reported count
- `tools/validate_proposal_skus.js` — **NEW**
- `tools/detect_sku_collisions.mjs` — **NEW**

`audit/` is gitignored: `rich-fh-v3.jsonl` (717 MB, **stale after this session's six applies —
regenerate before the next run**), 6 proposals, 4 decisions files, the funnel slices, and
`sku-collisions.json`. The older `rich-full-history.jsonl` and `rich-full-history-v2.jsonl` can be
deleted (1.4 GB reclaimed).
