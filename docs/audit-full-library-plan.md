# Full-library agentic audit — handoff

**Compacted 2026-09-23.** Companion to `docs/audit-runbook.md` (the agent's operating manual) and
`.worktrees/data/data/sku_link_policy.md` (the human-owned judgement rules). The pre-compaction
version, with every run's narrative from 2026-09-20 → 09-23, is archived at
`audit/audit-full-library-plan.pre-compaction-2026-09-23.md` (git-ignored) and in git history.

## State in one paragraph

Every **cheap** surface has been adjudicated over the whole history (34,368 listing units): near-miss,
want-links (incl. the v5 residual), orphans, every existing link below the 0.95 bar, all ignore↔link
contradictions, a screen of name-identical ignores, and the **whole review backlog (102 + 33 → 0 open)**. The **pilot of
the expensive pass** (existing links 0.95–0.99, 622 pairs) found **10.5% wrong** and is applied.
**Links 6,014 · ignores 16,008 · verified collisions 21.** What remains is the rest of the expensive
pass — **2,743 groups holding every link ≥ 0.99, sliced group-major into 16 batches** — which is a
go/no-go decision for the owner.

## Goal and definition of done (owner, 2026-09-20)

Produce a trustworthy labeled set over the whole catalog — links = positives, ignores = curated hard
negatives — so the auto-linker's failures can be characterised and fixed at the source. Coverage
beats speed; an ignore is worth as much as a link.

1. **Recall** — every link that should exist, does.
2. **Precision** — every link in the file is correct and required.
3. **Hard negatives** — many ignores over pairs the classical tooling finds plausible.
4. **Training data is not corrupted** (added 2026-09-22).

Out of scope by owner ruling: implicit links (same raw SKU at ≥ 2 stores are one product by
default; verified collisions are logged exceptions).

## Status against the definition of done

| criterion | status |
|---|---|
| 1. recall | **Cheap surfaces done.** Residual after all applies (v5): near-miss 164 rows, want-links 38 — optional, ~1 run. A 40-day CI dry-run finds 0 new above-bar links. Unmeasured: the ~29,000 rows no funnel surfaces (a pilot `--only all` batch would price it). Recall is now lost to unparseable titles and unstated sizes, not retrieval: ~30% of orphan links came from a catalog census, 0 from `no-embedding` or title-twin pairs |
| 2. precision | **Below the bar: done** — `< 0.30`: 23% wrong; `0.30–0.95`: 13.8% wrong; 38 ignore↔link contradictions resolved (the last 2, Glengoyne Legacy and Havana Club Especial "Dom", resolved in review round 2). **0.95–0.99 pilot: done — 65 of 622 wrong (10.5%; 9.8 / 10.4 / 11.2% per batch)**, 98 unlinks + 28 compensating links. **≥ 0.99: 5,138 edges in 2,743 groups, NOT audited** |
| 3. hard negatives | **15,970.** 29 wrong legacy ignores removed on 09-23, plus 9 `noTrain` Liberty/Sierra ignores overturned by the owner's Liberty ruling. ≈ 8% of name-identical ignores were wrong (6 of 73 on a fair screen). Ignores suppress candidates permanently, so emission stays strict |
| 4. training data | **Largely fixed.** 22 collisions excluded (126 pairs) — now also from `groups.json`, which feeds the embedder's contrastive positives and had leaked 11 collided groups. Bare-form `id:` labels had kept 4,828 ignores out of training and leaked the group split — fixed; `find_mislabels.mjs` / `size_unlink_audit.mjs` fixed the same way. **Next retrain must re-baseline** (`tools/linker_ml/CLAUDE.md` §"2026-09-23") |

## The expensive pass — existing links ≥ 0.99 (group-major)

**Pilot result (0.95–0.99, applied 2026-09-23): 10.5% wrong** — at the "≳ 5% → run the rest" end of
the decision rule. Error classes: transitive bridges (a gift pack, an age-less or edition-less listing
joining two products — Aberlour A'bunadh/Alba/Sherry Cask, Kirk & Sweeney Reserva/Gran Reserva,
Westland Sherry Wood/Flagship, Kilchoman Machir Bay gift pack, Shelter Point 10/Single Malt), then
edition/batch/ABV, gift/bundle packs, size, independent bottler. Known-wrong pairs can survive a cut:
`Barrell Gold/Gray Dovetail` was still linked through a second edge after its first was cut on 09-22.

**Slicing changed after the pilot** (bug-hunt finding #1). A pair-major band slice shows only its
in-band edges, but 299 of the pilot's 517 groups also had edges ≥ 0.99. So a split decided from the
slice was often incomplete, and the ≥ 0.99 runs would have re-read the same groups. The rest is
therefore sliced **group-major** by `tools/audit_link_group_slice.js`:
- each group ships whole, with every member's listings (from the current `index.json`);
- each group carries every edge holding it together (current `sku_links.json` + `sku_links_auto.json`,
  with prob from the rich file);
- batches never straddle a group.

**Ready to launch:** `audit/v5-groups/g099-b01..b16.json`
- **Size:** 2,743 groups; 5,138 edges ≥ 0.99; 6,229 edges in total, of which 699 are `merge-auto`,
  764 have a null prob and 2 are pins.
- **Per batch:** ~237 KB.
- **Prompt:** `audit/agent-prompts-2026-09-23/groups-template.md`. Substitute `__NN__` before launching;
  sending the raw template once cost a correction round-trip.

| plan | runs | waves of 4 | wall | end context / run (est.) | expected yield |
|---|---|---|---|---|---|
| all 16 batches | **16** | 4 | ~80–100 min | ~260–340K (26–34%) | ~500 wrong edges at the pilot rate; likely lower, since ≥ 0.99 should be cleaner |

The account's session limit was hit with 6 agents running (2026-09-23 ~00:20), so 16 runs will
probably span at least one limit reset. Agents resume in place with `SendMessage` and keep their
context — prefer that over relaunching.

**After the runs:**
1. `tools/merge_audit_proposals.js --out <merged> <all 16>` — it exits 1 on a cross-batch same-pair conflict.
2. Validate the merged file with `--fix`.
3. Dry-run it.
4. Apply it once.
5. Verify every split with `loadSkuMap().canonicalSku()`.

## Other remaining work, cheapest first

1. **Owner decisions — resolved 2026-09-23.** They are written into `sku_link_policy.md`, tagged
   `owner ruling 2026-09-23`:
   - The `(storeId, sku)` split is **deferred until the full-library audit is done** and the labels
     are trusted.
   - Links to nameless vanished `u:` listings **stay**.
   - Liberty `8289xxx` is judged per listing: a modern name links; an old "dusty" bottling stays
     separate; price is not evidence there.
   - Code-only titles count as identity; url slug and price ladder count as evidence.
   - On-pack/mini bonus, RTD spin-offs and single-barrel ordinals stay separate.
   - A gift box at the bottle's price links.
   - Artist/collab bottles are **separate**: a different product gets a different sku.
   - **Still open:** Lever 4 (pre-grouped size ladders): flagged, not built.
2. **`merge-auto` edges — fixed 2026-09-23.** The applier's `unlink-auto` op removes a wrong in-place
   upgrade edge from `sku_links_auto.json` and writes an ignore. The scraper's merge now skips ignored
   pairs and throws on an unparseable file; before, a corrupt file was read as empty and rewritten.
   The artist/collab-bottle question is also resolved: **separate**.
3. **`review[]` backlog — cleared 2026-09-23.** Round 1 (Sonnet) decided 44 of 102. Round 2 (2 Opus
   agents, `audit/agent-prompts-2026-09-23/review-round2-*.md`) decided all 93 that were left, with
   the mandate "make the best call, ask the owner only on a coin-flip". Result: 0 owner questions; the
   one it raised had already been decided in the other batch. That was 69 ops + 6 follow-up links. The
   only items left undecided are the 5 waiting on the deferred per-store split. About 44
   `dataQuality[]` notes are left: Sierra reusing skus across casks, price errors at BSW/Liberty,
   store mistitles.
4. **Retrain** — per `tools/linker_ml/CLAUDE.md`; run `find_mislabels.mjs` first (fixed 09-23 to see
   the bare-form labels).
5. **The ≥ 0.99 pass** (above).
6. **`--only all` backfill** — last, and only if a pilot batch shows that the ~29,000 un-surfaced rows
   hold enough to buy.

## Measured agent cost (current model, 2026-09-23)

`subagent_tokens` in a completion notification is the agent's **end-of-run context** (it cannot be
cumulative: an earlier run reported 564K over 47 calls). Hold it against the **50% ceiling**.

| run | input | shape | end context | calls | wall |
|---|---|---|---|---|---|
| collision verify | 74 skus / 52 KB | per-sku | 116K (12%) | 8 | 2.3 min |
| contradictions | 38 items / 102 KB | group + edges | 179K (18%) | 15 | 6.5 min |
| suspect ignores | 73 items / 81 KB | pair + listings | 198K (20%) | 27 | 6.5 min |
| want-links + near-miss | 428 rows / 243 KB → 143 pairs | pair-major | 230K (23%) | 21 | 6 min |
| below-bar band | 196 pairs / 246 KB | pair-major + groups | 264K (26%) | 18 | 10 min |
| orphans ×4 | ~250 KB each | row-major | 325–494K (33–49%) | 37–43 | 14–17 min |
| pilot 0.95–0.99 ×3 | 204–212 pairs / ~247 KB each | pair-major + groups | 244K / 282K / 341K (24–34%) | 5–11 † | 3–4.5 min † |
| residual wl + nm | 202 rows / 117 KB → 82 pairs | pair-major | 232K (23%) | 6 † | 2 min † |
| review backlog (Sonnet) | 102 items / 37 KB | item + census | 296K (30%) | 24 † | 8 min † |
| **group-major calibration** ×2 | 121 KB (86 groups) / 237 KB (171 groups) | group-major | **153K (15%) / 208K (21%)** → fit **96K + 0.47 tok/byte** | 23 / 3 † | 4 / 1.5 min † |
| review round 2 ×2 (Opus) | 46–47 items / ~13 KB each | item + census | 258K / 279K (26–28%) | 44–54 | 11–16 min |
| pipeline bug-hunt | code | read + synthetic tests | 187K (19%) | 25 † | 5 min † |

- End context ≈ **90–100K fixed** (runbook, policy, first reads) **+ ~0.7 tokens/byte** for pair-major
  slices, **+ ~1.0–1.5 tokens/byte** for census-heavy row-major orphan slices.
- **Cap orphan batches at ~200 KB** (a 251 KB batch hit 49%). Pair-major slices are safe at ~250 KB
  and plausible at ~350 KB.
- **Dedupe to pairs before handing a slice over** — 2.4–4.3x fewer decisions, and ~25% cheaper per KB.
- Four concurrent agents are fine; wall time is the slowest batch, not the sum.
- Per decision: ~1.35K tokens per precision pair, ~1.6K per recall pair, ~0.45K per orphan row.
- † These runs were cut off by the account session limit and resumed with `SendMessage`, so calls and
  wall count only the resumed segment. End context is the whole run's, because a resumed agent keeps its
  context.
- The review backlog on Sonnet ended at 30% on only 37 KB of input: judgement items that need census
  queries cost ~2.9K each regardless of model.

## Operating rules (hard-won — follow them)

**Inputs.** `index.json`, `viz/data/skus/**` and `sku_embeddings.json` are **Release assets**; pulling
`data` refreshes none of them (v3 silently ran on a 4-day-old catalog). Refresh all three before
every generate — runbook §Setup. When `featurize.mjs` has changed and is not yet committed, re-encode
locally (`build_dataset.mjs` → `encode.py`) instead of downloading the asset.

**Generate.** Always pass `--since 1970-01-01` (the default window is 12.7% of the library):
`node scripts/audit_new_listings.js --root .worktrees/data --since 1970-01-01 --format jsonl --out audit/rich-fh-vN.jsonl`
(~10 min, ~720 MB). Views: `--from <rich> --only <funnel> --ultra-compact`. Precision slices:
`tools/audit_link_group_slice.js` (group-major — use this); the pair-major `audit_link_band_slice.js`
hides out-of-band edges, so use it only to count a band.

**Before applying any proposal:**
1. `node tools/validate_proposal_skus.js --proposal <f> --fix` — keep refs in catalog form.
2. **Merge concurrent proposals** with `tools/merge_audit_proposals.js` — each agent's dry-run saw only
   its own ops; 16 cross-batch contradictions appeared only after merging.
3. Dry-run `tools/apply_audit_proposal.js`. It compares normalized keys, unions `sku_links_auto.json`
   into its component checks, **refuses any link touching a collision sku**, throws on an unparseable
   links file (it used to read one as empty and write back only the proposal), and **refuses
   `--apply`** if the new links would transitively group an ignored pair. Resolve by removing the wrong ignore or
   dropping the link. A remove-ignore and a link on the SAME pair conflict — put the link in a
   one-op follow-up proposal.
4. Review is load-bearing, not ceremonial. Today it dropped 33 worthless ignores (coincidental
   cross-brand overlap, bottler-only overlap below prob 0.2) and withheld 3 links that contradicted a
   human `noTrain` ignore.
5. After `--apply`, verify splits and merges with `loadSkuMap().canonicalSku()`; re-dry-running the
   proposal should show net effect 0.

**Judgement rules the agents need restated every time:**
- An **ignore** must be a pair a classical tool finds plausible (same brand/distillery/family,
  differing on size/age/edition/ABV/bottler). A shared generic word is a no-op, not an ignore.
- **Never link to or from a verified collision sku** (`data/sku_collisions.json`). CI and the applier
  both refuse it now.
- `prob` does not rank wrongness inside a band — read every row of the chosen band.
- Links found in orphans / below the bar are **under-scored**, not wrong: every orphan link was below
  0.95. Do not dismiss a candidate for low `prob`.
- An `unlink` writes a hard negative; pass `"ignore": false` only when severing to contain collision
  damage between genuinely identical products.
- A human `noTrain` ignore is judgement — override only on clear evidence.

## Findings that should shape future work

- **Legacy ignores are the least trustworthy labels.** Bare-form, no `source`, mostly Wine and
  Beyond, from the June 2026 bulk import. Wrong-rate: 9/16 and 14/38 where a link contradicted them
  (biased), 6/73 on a fair name+price screen. Ignored pairs never re-enter any pool, so these block
  correct links silently.
- **Transitive bridges are the dominant precision failure.** One edge from an age-less or
  edition-less listing joins two products' whole groups (Heigold/Cavehill ~20 listings; Edradour 10
  standard/PX/46%; Kilbeggan/Kilbeggan Black via an auto-linked Liberty row). Look at the whole
  group, not the pair.
- **Every real cross-store collision crosses numbering systems** (BC vs AB, or the Sierra Springs /
  Wine and Beyond `id:104xxxx` overlap). Same-system matches in the census were all benign.
- **The auto-linker's above-bar false positives** are edition/batch/vintage, bonus on-pack items,
  independent bottlers, mistitled listings (last measured 36% of the *audit pool's* above-bar pairs —
  an upper bound on CI's rate, not a measurement of it).
- **Store-specific evidence the agents rely on:** url slugs (edition, size), a store's own price
  ladder (unstated sizes), Co-op titles that are just an AGLC product code, Liberty's `8289xxx`
  prices (not evidence), CLB `8935xx` = Auld Goonsy's bottlings.

## Known limits (accepted)

- **Ignored pairs are hard-suppressed from the candidate pool**, so a wrong ignore can only be found by
  a screen over the ignores themselves (as done today) — never by a funnel. Owner: leave as-is.
- **Pool recall is conditional:** "100% @K=100" is against a gold set that is the link file itself.
  Measured saturated; state it, don't engineer around it.
- `need-unlinks` is below-bar by construction and cannot satisfy criterion 2 alone.

## Open tooling items

- The generator's listing ids and cluster keys strip `id:` while `pairs[].sku` keeps it (the
  validator's `--fix` is the stopgap).
- `status:"pending"` and the review watermark are vestigial once the link pages are deleted — remove
  them together with the pages.
- `pol` markers are audit-only; whether CI should veto mechanically is open (evidence so far says a
  mechanical screen would catch almost none of the real false positives).
- A train/serve name skew remains (`featurize` first-live-name vs `catalog.js` display ranking).
- Slice views should carry `id` (`<dbFile>|<sku>`) rather than `store|sku` (one store can list a sku
  in two DB files).

## Uncommitted at hand-off (2026-09-23)

`data` branch (`.worktrees/data`):
- `data/sku_links.json` — links 6,008 → **6,013**, ignores 14,442 → **16,000** over the 09-23 sessions.
- `data/sku_links_auto.json` — 1 edge removed via `unlink-auto` (Crown Royal 1.75L `114694` ↔ 1.14L `010108`, from a Tudor url that covered both sizes).
- `data/sku_collisions.json` — 11 → **22** verified (`503102` Cragganmore 12 / Distillers Edition added).
- `data/sku_link_policy.md` — owner rulings 2026-09-23 added (see Other remaining work §1).

`main`:
- **Training-data fixes:**
  - `tools/linker_ml/build_dataset.mjs` (collision filter now normalized and applied to `groups.json`),
    `featurize.mjs`, `dump_features.mjs`, `find_mislabels.mjs`, `size_unlink_audit.mjs`, `tools/linker_eval.mjs`.
  - Committing `featurize.mjs` **changes CI's encoder input**. This was measured as an improvement:
    rec@99 86.7 → 87.7%, +117 TP / +1 FP at the bar, no retrain needed.
- **Fallback and collision guards:** `viz/app/linker_page/suggestions.js` (`fallback: true`),
  `tools/auto_link_classify.mjs`, `scripts/audit_new_listings.js` (fallback skip, `--pair` fixes).
- **Apply tooling:**
  - `src/utils/sku_links_file.js`: `readLinks` throws on a corrupt file.
  - `tools/apply_audit_proposal.js`: normalized conflicts, auto edges, collision refusal, transitive refusal.
  - `tools/validate_proposal_skus.js`: `--fix`, and prints its usage.
  - New: `tools/audit_link_band_slice.js`, `tools/audit_link_group_slice.js`, `tools/merge_audit_proposals.js`.
- **Docs:** `CLAUDE.md`, `tools/linker_ml/CLAUDE.md`, `docs/audit-runbook.md`, this file.

`audit/` (git-ignored):
- `rich-fh-v5.jsonl` — scores as of 2026-09-23 06:50Z. The group slicer reads current links, so it
  does not need a regenerate.
- `v5-groups/` — the 16 ready batches.
- `agent-prompts-2026-09-23/` — every prompt used, plus the group template.
- Every proposal and decisions file.
- Pre-apply link-file backups in the session scratchpad.

Deletable: `rich-full-history.jsonl`, `rich-full-history-v2.jsonl`, `rich-fh-v3.jsonl`,
`rich-fh-v4.jsonl` (~2.9 GB).

## IN FLIGHT — 2026-09-23 morning (resume here after compaction)

**Calibration done.** In the ≥ 0.99 band, 7 of 594 edges were wrong (1.2%), against 10.5% at
0.95–0.99. Errors do not cluster by group size.

The cost fit (2 points) is 96K fixed + 0.47 tokens/byte. For the remainder that gives **9 batches of
~381 KB**, at ~275K end context each (±50K), covering 2,486 groups and 5,635 edges, with ~65 wrong
edges expected.

Build the batches with:
`tools/audit_link_group_slice.js --min 0.99 --max 1.0001 --batch-bytes 390000 --exclude audit/v5-groups/g099-b01.json,audit/v5-groups/cal-half.json`
Re-run it after the pending apply below, because groups shift. Use the prompt
`agent-prompts-2026-09-23/groups-template.md`: substitute `__NN__` and "batch NN of 9".

**r01–r08 done and applied (2026-09-24)** — `audit/proposal-v5-groups-rest-merged-2026-09-24.json`,
100 ops (84 unlink, 16 link). **84 of 5,003 edges wrong (1.7%; per batch 1.0–2.8%)**, confirming the
calibration's 1.2%. Links 6,014 → 5,946, ignores 16,008 → 16,092. 46 `review[]` and 45 `dataQuality[]`
entries are open in that file. Four agents proposed collision-containment unlinks (`ignore:false`);
the coordinator dropped all of them per the owner ruling of 2026-09-24 (leave collided skus in their
groups; collisions will be handled in code). Originals are in the session scratchpad
(`br0{3,5,6,8}-orig.json`). **The review/dataQuality queues are closed (2026-09-24)**: all 91 entries went through
`proposal-rest-backlog-2026-09-24.json` (+ its `-unignore` prerequisite, applied first). That meant
44 ops, links 5,946 → 5,927, ignores → 16,119, and 63 hides into `sku_hidden.json` (27 entries plus a
sweep of Canadian Liquor Store "(Case of N)" rows). 0 escalations; per-entry log in
`resolutions-rest-backlog-2026-09-24.jsonl`. **r09 done and applied (2026-09-24): 8 of 629 wrong (1.3%). The ≥ 0.99 pass is COMPLETE: 92 of 5,632
edges wrong (1.6%).** Its 5 review entries were closed by the coordinator
(`proposal-r09-backlog-2026-09-24.json`: 2 unlinks on store price ladders, 3 kept), plus 1 hide. **Precision
is closed:** links 5,921, ignores 16,129, hidden 461.

**Ignore screen tier A done (2026-09-24):** `tools/audit_ignore_slice.js --min 0.8 --max 2`, 694 ignores
with near-identical names in 1 batch (594 KB). **3 wrong (0.43%)**, not the ~8% the earlier fair screen
suggested (that screen already fixed the worst). 436 of 689 keeps are genuine size ladders. Applied as
`proposal-ign-a-unignore` then `-links`; links 5,924, ignores 16,126. Cost: **450K end context, ~0.62
tokens/byte** (same as the group slices), so B–D would be ~700 KB slices, ~8 agents, ~4M tokens, for an
expected ≤ 0.3% yield. **Owner stopped the ignore screen here (2026-09-24).** Re-run B–D later with the
same tool if a retrain's worst-false-negative list points at bad ignores. Its slice was cut
before this apply; canon keys may have shifted, but its groups are disjoint from r01–r08.

End context at 381 KB was 232–330K (mean ~290K). The refit over 5 points is ~80K fixed +
~0.6 tokens/byte, so rows are ~75% of context at this size. Max seen: 330K (33%). Future passes: **~650 KB slices** (~470K end context, under
the 50% ceiling with room for the ±50K spread); the owner treats 50% as a SOFT limit (2026-09-24): push slice size up run by run until agents end near it, slightly over is fine.

**Done since:**
- The data-worktree merge is resolved: CI's 4 new links were kept, and every earlier proposal
  re-dry-runs to 0.
- The calibration fixes are applied (`audit/proposal-v5-groups-cal-merged-2026-09-23.json`, 11 ops):
  - b01 + bcal;
  - Grant's Triple Wood `unlink-auto`;
  - `455637` → Islay Barley 2013 group `873553`. Removed from `sku_collisions.json` (now 21), because
    Tudor's Classic Laddie title on it is a mistitle.
- **Links 6,014 · ignores 16,008 · auto edges 899.**

**Ready to launch on GO:** `audit/v5-groups/rest/r-b01..b09.json`
- 2,484 groups and 5,632 edges; each batch is ~381 KB with 276 groups.
- Prompts: `audit/agent-prompts-2026-09-23/groups-r01..r09.md`, already substituted. Launch each one
  with "Your full instructions are in <file>".
- Run in waves of 3–4, because of the session limit, and resume stopped agents in place.
- Afterwards: merge with `tools/merge_audit_proposals.js`, validate, dry-run, apply, verify.

The Tudor `-l-NNN` product urls cover several sizes. That caused both size merges in the auto file,
but it is **already fixed at the source**: both edges date from the 2026-05-21 backfill, and
`tudor.js` has keyed multi-size products by `?variant=<cspc>` (plus a re-SKU guard for singles) since
2026-05-28 / 06-07. Nothing to do.
