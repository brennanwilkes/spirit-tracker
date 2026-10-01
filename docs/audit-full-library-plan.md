# Full-library agentic audit — plan + hand-off

**Rewritten 2026-09-28** to show only what is actually left. Companion to `docs/audit-runbook.md` (the
agent's operating manual) and `.worktrees/data/data/sku_link_policy.md` (the human-owned judgement
rules). The per-run narrative of 2026-09-20 → 09-24 is in this file's git history and in
`audit/audit-full-library-plan.pre-compaction-2026-09-23.md` (git-ignored).

"Left" means big picture: the listings CI scraped since the last pass are the recurring job (§5), not
backlog.

## 1. State in one paragraph

The library-wide pass is **done except for one small coverage gap and one optional recall sweep.**
Precision is closed: every existing link was re-judged, group by group, in bands `< 0.30`,
`0.30–0.95`, `0.95–0.99` and `≥ 0.99`. Every cheap recall surface (near-miss, want-links, 3,061
orphans) is adjudicated. So are two full-catalog sweeps with the retrained 2026-09-24 model, the
collision census, and every `review[]` / `dataQuality[]` queue. The 2026-09-24 retrain shipped on
those labels (TEST rec@99 95.2%).

**Labels (2026-09-28):**

| label | count |
|---|---|
| links | 5,942 |
| ignores | 16,176 |
| auto edges | 899 |
| verified collisions | 22 |
| hidden | 571 |
| canonical link groups | 3,257 |

## 2. Status against the definition of done (owner, 2026-09-20)

| criterion | status |
|---|---|
| 1. **Recall** — every link that should exist, does | **Cheap surfaces done.** After the retrain: a full-catalog `auto_link_classify` dry-run found 15 links / 6 ignores, and the 0.5–0.95 unlinked band found 7 links / 42 ignores. A 40-day CI dry-run found 0. **Open:** the ~29,000 listing rows no funnel surfaces (§4.4). |
| 2. **Precision** — every link is correct and required | **Done** (the 222 unscored groups closed 2026-09-29, §4.1). The error rate fell as the band rose (`< 0.30` 23%, `0.30–0.95` 13.8%, `0.95–0.99` 10.5%, `≥ 0.99` 1.6% = 92 of 5,632 edges). |
| 3. **Hard negatives** | **16,176.** Ignore screen tier A (near-identical names) was 0.43% wrong (3 of 694). The owner stopped tiers B–D (§4.5). |
| 4. **Training data is not corrupted** | **Done for now.** Collided skus are excluded from training (126 pairs). The real fix is the per-listing split (§4.2), after which they rejoin training. |

Closed by ruling, **not** left:
- Implicit links (same raw sku at ≥ 2 stores are one product) are out of scope. The exceptions are
  the verified collisions.
- The collision census is complete: 87 candidates, 22 real, 65 benign. The last 2 unadjudicated,
  `001453` / `096263`, are Tanqueray 1.14 L / 1.75 L plus a Tudor typo, so benign.
- Links to nameless vanished `u:` listings stay.
- Collided skus stay in their groups (2026-09-24): no containment unlinks.
- Multi-dram sets (advent calendars, tasting sets) are hidden, not linked (2026-09-28). They stay
  manual for now; there is no name-pattern rule.

## 3. What is left, in order

| # | item | size | cost (est.) | expected yield | gate |
|---|---|---|---|---|---|
| 4.1 | ~~Unscored-group sweep~~ DONE 2026-09-29 | 222 groups | 1 agent, 174K | 4 wrong edges (1.6%) | closed |
| 4.2 | Collision split ships, then link the `c:` keys | 22 entries → ~31 split rows | code + 1 small proposal | ~20–30 links restored | implementation of `docs/sku-collision-split-plan.md` |
| 4.3 | Two parked per-store cases | 2 skus | owner call | 2 splits | 4.2 shipped |
| 4.4 | `--only all` recall backfill | ~29,000 rows | pilot 1 agent; full ~30–40 agents, ~12–15M tokens | probably low | pilot result |
| 4.5 | Ignore screen tiers B–D | ~8 agents, ~4M tokens | — | ≤ 0.3% | only if a retrain's worst-FN list points at ignores |
| 4.6 | Retrain | — | ~1 h CPU | un-excludes collided skus | after 4.2 (+4.1/4.4 if run) |

### 4.1 Unscored-group sweep — the one real coverage gap

**DONE 2026-09-29** (`audit/proposal-v6-unscored-2026-09-29.json`, applied): 222 groups, 244 edges, 212 clean,
3 split, 7 to review. 4 edges wrong (1.6%), all CI or agent links, none `merge-auto`: a DBTD sampler bundle
(2 edges), SMWS Aug vs Sep outturn tickets, Cù Bòcan Creation #1 vs #4. Links 5,944 → 5,940, ignores 16,176 → 16,180.
Owner rulings on its 7 review items (`proposal-v6-unscored-rulings-2026-09-29.json`): Two Stacks Dram in a Can,
every Drinks by the Dram set and SMWS outturn tickets are hidden; Adelphi Brisbane split; Benromach Whisky Rant =
cask #306 (link kept, ignore vs #305 Caledonian); Odd Society Wallflower 750/375, MMcD Ledaig and BSW Ardnamurchan
10 E&S left linked. Now links 5,939, ignores 16,182, hidden 592. The history below is kept for the method.

`tools/audit_link_group_slice.js` selects a group only when it has a **scored, non-auto, non-pin** edge
in the band (`inBand`). Every slice so far went through it, so a group is invisible when its only edges
are:
- `sku_links_auto.json` in-place upgrades: **153 edges**, in groups with no `sku_links.json` edge;
- link edges with `prob: null` in `rich-fh-v5` (the link was added after v5, or a partner was absent
  from its window): **90 edges, 61 with both sides still live**.

Measured over the current link files against `audit/rich-fh-v5.jsonl` (2026-09-28): **221 of 3,257
groups** (another 11 are pin-only, i.e. SMWS cask codes, correct by construction). The sample includes
Keg N Cork ↔ BSW advent calendars (now hidden anyway), `Two Stacks Dram In A Can`, and a CI edge
`OLE SMOKY APPLE PIE 750ML 20%` ↔ `750ML`.

Yield should be low: auto edges follow one listing's own url, and the only known failure class (Tudor
`-l-NNN` multi-size urls) was fixed at the source on 2026-05-28. But it is the only part of the existing
link set no agent has read, and it costs one batch.

How:
1. DONE 2026-09-29: `--unscored` on `audit_link_group_slice.js` selects groups where no edge satisfies
   `e.src !== "merge-auto" && !e.pin && e.prob !== null` and at least one edge is not a pin, ignoring
   `--min`/`--max`. It cut 222 groups / 244 edges / 130 KB (one more than the census, which skipped any
   group with a pin).
2. Refresh `index.json`, `skus`, embeddings (runbook §Setup). The v5 rich file is fine for probs,
   since these groups have none by definition.
3. `node tools/audit_link_group_slice.js --from audit/rich-fh-v5.jsonl --unscored --batch-bytes 650000 --out-prefix audit/v6-unscored`
4. One agent with `audit/agent-prompts-2026-09-23/groups-template.md`, with `__NN__` substituted. Tell it
   that `prob: null` is expected on every edge and is not evidence.
5. Validate `--fix` → dry-run → apply → verify with `loadSkuMap().canonicalSku()`.

### 4.2 Collision split, then link the new keys

Implementation plan: `docs/sku-collision-split-plan.md` (every reader audited, including
`~/spirit-tracker-api`). Once it ships, each split listing gets its own key (`c:<sku>:<tag>`), which
is an orphan at birth. The audit follow-up is that plan's §3.13:
- dry-run `auto_link_classify.mjs` anchored on the `c:` keys;
- have one agent judge the output, plus the known partners in the plan's §4 evidence table;
- apply as one proposal.

The applier's collision refusal and the `build_dataset` filter retire in the same change, so the
collided skus' labels flow back into training (4.6).

### 4.3 Two per-store cases parked on the split (owner call)

Both were deferred by the 2026-09-23 ruling and are **not** in `sku_collisions.json` or the split plan:

| sku | case | proposed handling |
|---|---|---|
| `879160` | CLB "Kavalan Solist Ex-Bourbon 53.20" $170.54 shares the AB CSPC with BSW's 57.1% Sierra Springs cask ($220) and Lime ($199.99) | add a `split` entry `{storeId: "clbspirits"}` once 4.2 ships. This is the first same-numbering-system collision; the census rule that all real ones cross systems gets its first exception |
| `809905` | M&G has carried two Singleton Glen Ord 14 releases on one sku over time (57.6% removed, 54.7% live) | same store, different times. A `{storeId, url}` split works only if the two urls differ; if they do not, the history is mixed at the source and stays as-is |

### 4.4 `--only all` recall backfill — optional, gated on a pilot

The rows no funnel surfaces: listings with no above-bar candidate, no near-miss evidence, and not
orphans. Evidence says yield is low:
- recall is now lost to unparseable titles and unstated sizes, not retrieval;
- about 30% of orphan links came from a catalog census;
- none came from `no-embedding` or title-twin pairs;
- the two post-retrain sweeps found only 22 links across the whole catalog.

**Pilot:**
1. Generate fresh (`--since 1970-01-01`, ~10 min).
2. Take one row-major `--only all` batch of ~200 KB (~600 rows), excluding rows already surfaced by
   any funnel.
3. Run one agent.

**Go/no-go:** extrapolate links per row to the ~29,000. **Go if that projects ≳ 150 correct new links**,
roughly 1 per 190 rows; ignores do not count toward the gate, since the ignore set is already large.
Below that, record the pilot's rate here and stop.

### 4.5 Ignore screen tiers B–D — stopped by the owner

Re-run with `tools/audit_ignore_slice.js` only if a retrain's OOF worst-false-negative list
(`tools/linker_ml/report_oof_misses.mjs`) is dominated by pairs a wrong ignore is blocking. Ignored
pairs never re-enter any candidate pool, so this screen is the only way to find a bad one.

### 4.6 Retrain

Per `tools/linker_ml/CLAUDE.md`, after 4.2 (and after 4.1/4.4 if they change labels). Run
`find_mislabels.mjs` first. Test GBT/feature changes with the embeddings held fixed; the encoder
fine-tune is nondeterministic.

## 5. Steady state after the backlog

The audit becomes a periodic corrector of CI output (every few months), paired with a re-embed and
retrain. Each pass covers the listings first seen since the previous one:
- want-links, near-miss and orphans over that window;
- group-major precision over every group touched by a new edge.

Use the operating rules below unchanged. Related, not audit: `docs/link-pages-removal-plan.md`
removes the human link pages and `status:"pending"`. Whether CI should get mechanical vetoes is still
open; evidence so far says they would catch few real false positives.

## 6. Measured agent cost (current model)

`subagent_tokens` in a completion notification is the agent's **end-of-run context**, not a
cumulative figure. Hold it against the **50% ceiling**, which the owner treats as soft (2026-09-24):
push slice size up run by run until agents end near it, and slightly over is fine.

| run | input | shape | end context |
|---|---|---|---|
| collision verify | 74 skus / 52 KB | per-sku | 116K (12%) |
| want-links + near-miss | 428 rows / 243 KB → 143 pairs | pair-major | 230K (23%) |
| orphans ×4 | ~250 KB each | row-major | 325–494K (33–49%) |
| pilot 0.95–0.99 ×3 | ~247 KB each | pair-major + groups | 244–341K |
| ≥ 0.99 groups ×9 | ~381 KB each | group-major | 232–330K (mean ~290K) |
| ignore tier A | 594 KB | pair + listings | 450K |
| review round 2 ×2 (Opus) | ~13 KB each | item + census | 258K / 279K |

- The fit is **~80K fixed + ~0.6 tokens/byte** for group and ignore slices. Group slices can go to
  **~650 KB** (~470K end).
- Row-major orphan slices are census-heavy (~1.0–1.5 tokens/byte), so **cap them at ~200 KB**.
- Dedupe to pairs before handing a slice over: 2.4–4.3× fewer decisions.
- Per decision: ~1.35K tokens per precision pair, ~1.6K per recall pair, ~0.45K per orphan row.
  Judgement items needing census queries cost ~2.9K each, whatever the model.
- Four concurrent agents are fine. The account session limit stops long waves, so **resume stopped
  agents in place with `SendMessage`**; never relaunch.

## 7. Operating rules (hard-won — follow them)

**Inputs.** `index.json`, `viz/data/skus/**` and `sku_embeddings.json` are **Release assets**;
pulling `data` refreshes none of them (v3 silently ran on a 4-day-old catalog). Refresh all three
before every generate (runbook §Setup), and check the embeddings asset's `updatedAt`. When
`featurize.mjs` has uncommitted changes, re-encode locally instead of downloading the asset.

**Generate.** Always pass `--since 1970-01-01`; the default window is 12.7% of the library and once
produced a false "nothing found":
`node scripts/audit_new_listings.js --root .worktrees/data --since 1970-01-01 --format jsonl --out audit/rich-fh-vN.jsonl`
(~10 min, ~720 MB). Views: `--from <rich> --only <funnel> --ultra-compact`. Precision slices go
group-major (`audit_link_group_slice.js`); a pair-major band slice hides out-of-band edges, so a split
decided from it comes out incomplete.

**Before applying any proposal:**
1. `node tools/validate_proposal_skus.js --proposal <f> --fix`, to keep refs in catalog form.
2. **Merge concurrent proposals** with `tools/merge_audit_proposals.js`. Each agent's dry-run saw only
   its own ops, and 16 cross-batch contradictions once appeared only after merging.
3. Dry-run `tools/apply_audit_proposal.js`. It refuses:
   - links touching a collision sku;
   - `--apply` when new links would transitively group an ignored pair.

   It also withholds ignores on ineffective unlinks. A remove-ignore and a link on the same pair
   conflict, so put the link in a one-op follow-up.
4. Review is load-bearing. It has dropped worthless ignores (coincidental cross-brand overlap) and
   withheld links that contradicted a human `noTrain` ignore.
5. After `--apply`, verify splits and merges with `loadSkuMap().canonicalSku()`. Re-dry-running the
   proposal should show net effect 0.
6. **Commit `data/sku_links.json` before the next cron run.** CI cannot see an uncommitted ignore. The
   2026-09-24 sweeps sat unpushed for 4 days, CI auto-linked a pair one of them had rejected, and a
   plain `git pull` over the dirty file would have dropped 48 ignores. To recover, back up the file,
   pull clean, and re-apply the proposals; they are idempotent.

**Judgement rules the agents need restated every time:**
- An **ignore** must be a pair a classical tool finds plausible (same brand, distillery or family;
  differing on size, age, edition, ABV or bottler). A shared generic word is a no-op, not an ignore.
- Never link to or from a verified collision sku (until 4.2 ships).
- `prob` does not rank wrongness inside a band. Read every row of the chosen band.
- Links found in orphans or below the bar are **under-scored**, not wrong. Do not dismiss a candidate
  for low `prob`.
- An `unlink` writes a hard negative. Pass `"ignore": false` only when severing to contain damage
  between genuinely identical products.
- A human `noTrain` ignore is judgement: override it only on clear evidence.

## 8. Findings that should shape future work

- **Transitive bridges are the dominant precision failure.** One edge from an age-less or edition-less
  listing (or a gift pack) joins two products' whole groups. Look at the whole group, not the pair.
- **The auto-linker's above-bar false positives** are edition/batch/vintage, bonus on-pack items,
  independent bottlers and mistitled listings. The decisive evidence is usually the **url slug** or
  the **store's own price ladder**, neither of which is on the row. That argues against mechanical
  screens.
- **Legacy ignores are the least trustworthy labels**: bare-form, no `source`, mostly Wine and Beyond,
  from the June 2026 bulk import. Tier A found them far cleaner than feared (0.43%).
- **Real cross-store collisions cross numbering systems** (BC vs AB, or Sierra Springs / Wine and
  Beyond `id:104xxxx`). The census's same-system matches were all benign. `879160` (§4.3) is a
  same-store-system cask reuse, which is a different class.
- **Store-specific evidence the agents rely on:** url slugs (edition, size), a store's price ladder
  (unstated sizes), Co-op titles that are just an AGLC product code, Liberty `8289xxx` prices (not
  evidence), and CLB `8935xx` = Auld Goonsy's bottlings.

## 9. Known limits (accepted)

- **Ignored pairs are hard-suppressed from every candidate pool**, so a wrong ignore can only be found
  by a screen over the ignores themselves (4.5). Owner: leave as-is.
- **Pool recall is conditional.** "100% @K=100" is against a gold set that is the link file itself.
  Measured saturated; state it, don't engineer around it.
- `need-unlinks` is below-bar by construction and cannot satisfy criterion 2 alone.

## 10. Open tooling items

- The generator's listing ids and cluster keys strip `id:` while `pairs[].sku` keeps it; the
  validator's `--fix` is the stopgap.
- A train/serve name skew remains: `featurize` takes the first live name, while `catalog.js` ranks
  names for display.
- Slice views should carry `id` (`<dbFile>|<sku>`) rather than `store|sku`, since one store can list a
  sku in two DB files.
- `audit/`: `rich-full-history*.jsonl`, `rich-fh-v3.jsonl` and `rich-fh-v4.jsonl` (~2.9 GB) are
  deletable. Keep `rich-fh-v5.jsonl` until 4.1 is done.
