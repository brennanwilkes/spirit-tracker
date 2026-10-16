# Flip-flop handling and the three fake-flip-flop root causes

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

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

## Three fake-flip-flop ROOT CAUSES fixed (2026-09-04)

An audit of 35 days of `data` history found that most observed "flip-flops" were not market
behaviour at all. Three distinct scraper defects, all fixed; each was verified against production
data before and after. **Diagnostic method worth reusing:** walk `git log` on `data/db/*.json` and
compute the ACTIVE (non-`removed`) count per commit — a drop that recovers is the signature. Then
identity-test it (did the SAME urls come back?), then confirm against the live store.

1. **Orphan-DB detector flipped whole categories to `removed:true`.** `orphan_dbs.js` derived a
   category's expected DB filename from the RAW `cat.startUrl`, while `category_scan.js` derived
   the actual filename from `normalizeBaseUrl(cat.startUrl)`. `normalizeBaseUrl` inserts a `/`
   before a query string (`/products?x` → `/products/?x`) and returns `undefined` for a missing
   `startUrl` (hashing to the shared `d5d4cd07`), so **88 of 117 categories were never in the
   "expected" set** and were spared only by the `scannedDbFiles` belt-and-suspenders. Since
   `report.categories.push()` only runs after a SUCCESSFUL scan, any category that FAILED — in a
   store where at least one sibling succeeded — had its entire DB flipped to removed: a store-wide
   fake sellout that "restocked" on the next run. Confirmed: Co-op 2026-09-03 (4 categories, 416
   items, restored 8 min later by the retry) and Vessel 2026-09-03 (202 items).
   **Fix:** one shared `db.js::dbFileForCategory()` used by BOTH sites, so they can never drift.
   Verified: all 117 scan paths byte-identical to before (no store starts writing a new file), and
   117/117 expected paths now resolve (was 29/117). The 11 genuine orphans still detected are all
   already 100% removed, so nothing new is flipped.
   - A store whose categories ALL fail is absent from `ranStoreKeys` and was never affected —
     which is why Elbow Liquor (fails every run) never showed this, but Co-op did.

2. **SKU-collision annihilation in `merge.js`.** The skuKey-rematch branch exists to follow a
   product that MOVED url, and on a match it does `merged.delete(oldUrl)` — a HARD delete. When
   two genuinely DIFFERENT products are concurrently live under one normalized SKU, they
   annihilated each other every run, so the DB kept one record whose price alternated forever.
   Four such pairs found (≈614 fabricated price-change events, which also fired email alerts and
   `recent.json`): BSW `795231` (pendleton-directors-reserve $230 vs …-whisky-2018 $350, sku
   `795231-2` normalizes to the same key), BSW `798880` ($15,000 single vs $19,400 bundle, 235
   events), BSW `845142` (glengoyne-30-year-old-1 vs -3), Sierra Springs `001222`
   (j-p-wisers-special-blend-750ml $28.99 vs …-750ml-40 $24.99).
   **Fix:** only treat a skuKey match as a migration when the old url is NOT also in `discovered`
   this run (`!discovered.has(hit.url)`). Both URLs live ⇒ distinct products ⇒ keep both.
   - **Does NOT break Tudor's `?variant=` re-SKU flow** — `tudor.js` MUTATES `it.url` in place, so
     the bare url is never in `discovered` and the guard cannot fire. Verified by unit test.
   - Known trade-offs: those SKUs now show TWO same-store rows (accurate — they are different
     products), and the first run after shipping emits a one-time `new_item` burst for the
     resurrected twins. A genuine slug migration where the store serves both urls for one run now
     yields `new_item` + `removed` instead of a silent move; history survives (the per-SKU cache is
     sku-keyed), only the events feed is noisier. Unavoidable at scan time.

3. **ARC page-boundary skip (upstream pagination bug).** The Barnet API pages via LIMIT/OFFSET and
   re-runs its ORDER BY per request, so rows TIED on the sort key swap between requests: one is
   served on both neighbouring pages while its partner is served on NEITHER and silently skipped.
   Measured: `rowsFetched === paginator.items_count` and `duplicateRows === shortfall` in every
   category — the API always hands over exactly `items_count` rows, just with one repeated in place
   of another. Under the old `sortBy: "price_desc"` Rum served 101/102 and Whiskey 159/160; the
   Rum victims were 478594 and 265031, both $87.99, straddling the page-1/page-2 boundary, exactly
   one vanishing per run (they never both dropped — the mutual exclusion is the tell).
   **Fix:** ARC categories now use `sortBy: "name_asc"`, which is tie-free in this catalog and
   returns 160/160, 227/227, 102/102, 83/83. A completeness check (`rawIds.size < items_count`,
   counting RAW pre-stock-filter row ids) re-sweeps with a DIFFERENT sort as a self-healing net for
   a future tie — re-sweeping the SAME order is useless because the skip is deterministic (5/5
   identical sweeps repeated row 410603 and dropped the same partner).
   - **Deliberately NO "preserve unseen listings" fallback.** A genuine sellout also lowers
     `items_count`, so a leftover gap cannot be distinguished from one; preserving would pin a real
     sellout live forever. (An earlier attempt did preserve, on the mistaken belief that 287777
     STILLHEAD PX CASK RYE was genuinely OOS because it never appeared under `price_desc` and its
     product page matched an out-of-stock regex — a false positive. It was the straddle victim;
     `name_asc` returns it and it stays live. Don't reintroduce the fallback on that evidence.)
   - Other Barnet stores (`highpointbws`, `newdistrict`, `vintage`) still default to `price_desc`
     via `barnet_network.js` and were NOT audited — likely carry the same latent straddle.

**NOT bugs (verified against the live stores — leave alone):** Liberty's mass drops are REAL
(its Woo API sets `stockStatusFilter: "instock"` AND hides out-of-stock products from the catalog
entirely, so disappearance is the only OOS signal; of 203 items dropped 2026-09-02, the 39 that
never returned are absent from the live catalog and the 164 that returned are all live now).
Liquorama's toggles are a genuine `current_stock` signal (two back-to-back sweeps were identical,
245/245). Malts & Grains' apparent flapping was onboarding (0 → 538 over 2026-08-07→13).
