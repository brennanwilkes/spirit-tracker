# Item chart "Summary" mode: feasibility

**Date:** 2026-10-10
**Status:** Implemented 2026-10-12 (medians + bands + 90-day moving Target, 7-day hold). Where the
build departs from this doc (owner rulings 2026-10-12):
- **Toggle** is a `Stores | Summary` pill in the topbar, left of Share, on every surface.
- **Default Summary** when the item has ≥ 10 stores in its history, OR is rarity tier `staple` with
  ≥ 8 (was ≥ 8 / any staple until 2026-10-12; owner wanted mid-sized items to open on Stores).
- **A province line starts at ONE store** (`SUMMARY_MEDIAN_MIN_STORES = 1`, was 3; owner 2026-10-12:
  draw a market as soon as it gets the bottle; above-chart outliers are still excluded). **Line width
  shows breadth:** linear in the smoothed count of that province's stores carrying it, 1 px at one
  store to 4 px at 10, capped there. An absolute count, not a share of tracked stores, so onboarding
  stores never thins existing lines. Stores mode's BC/AB marker lines still need 3 stores.
- **Locked to Stores** (pill shown disabled, reason in its `title`) when the item is tier `rare`, has
  < 3 stores in its history, or (now near-unreachable) no province median on any day.
- **Not persisted:** each visit opens on the item's own default.
- **Stores view drops the BC / AB / Target marker lines on items that default to Summary** (Summary
  carries that context). Items that default to Stores, including the locked rare / few-store ones,
  keep them: there Stores is the only or main view.
- **"Good price" is labelled "Target"** and drawn in the grey of the Stores-mode marker lines.
- **The band is median ± one standard deviation, not p25–p75** (owner: the 5-store band cut in and
  out). Deviations from each day's own median are pooled over a centred 15-day window, so the band
  exists wherever the median line does.
- **Tooltip shows only the line nearest the finger** (custom `nearestLine` interaction mode that
  skips band datasets), in the Stores format `Label: $Price`.
- **Lines are smoothed trends, not stepped levels** (owner: steps read as blocky). Medians, band
  spread and the Target go through a centred 7-day rolling median (drops 1–3 day flips) and then a
  centred 15-day rolling mean (turns steps into ramps), drawn with monotone curves.
- **Target always uses a full 90-day window.** Until the item has 90 days of data, every day uses
  the item's FIRST 90 days (a shrinking window started the line high on a few early prices).
- **Stores drawn "above the chart"** (`computeHighOutlierCap`) are left out of the province medians,
  both Summary's lines and Stores mode's BC/AB markers.
- Summary uses the same collapsible `#chartLegend` panel as Stores mode ("Lines (3)"; a band toggles
  with its median), not a separate key.
- `animation: false` shipped with it (a mode switch would otherwise replay the entrance animation).
**Method:** Read `viz/app/item_page.js` (`loadSkuHistory`, dataset build, markers) and
`viz/app/item_page/item_chart.js`. Measured against the local `.worktrees/data` index (index.json
2026-10-09, 6,735 live canonical groups) and the per-SKU caches, grouped by canonical sku via
`src/utils/sku_map.js`. Scripts were throwaway and are not in the repo. Each claim is tagged
**verified** (measured) or **inferred** (reasoned, not tested).

> ### Verdict
>
> **It makes sense, and it is cheap.** The problem is real: on a popular item every store draws its
> own line and the chart becomes a solid block of colour, which is worst on a phone, where most
> people use the site. A summary view fixes that by drawing **three lines that change over time
> plus two shaded bands**: the BC median and the Alberta median, each with its middle 50% band, and a
> 90-day moving "good price" Target (§2). The 90-day target is calmer than a cheapest-price line
> and never snaps back.
>
> - Everything it needs is already on the page. No new data, no build-step change, no Release
>   asset. It is roughly 150–250 lines in `item_page.js`, plus a toggle and some CSS. **(inferred)**
> - **One trap must be handled:** about two thirds of median moves come from stores entering or
>   leaving the set, not from price changes. Holding each store's last price through out-of-stock
>   gaps of up to 7 days removes most of that. **(verified, §3)**
> - It should be the **default only for busy items** (≥ 8 stores, 746 items). Smaller items keep
>   the per-store view, which is already readable.

---

## 1. Who it is for (verified)

Live canonical groups by the number of stores carrying them today:

| Stores carrying it | Groups | Share |
|---|---|---|
| ≥ 3 | 2,760 | 41% |
| ≥ 5 | 1,520 | 23% |
| ≥ 8 | 746 | 11% |
| ≥ 10 | 521 | 8% |
| ≥ 15 | 182 | 3% |
| max | 27 | — |

| Per-province depth | Groups |
|---|---|
| BC ≥ 3 stores | 754 |
| BC ≥ 5 stores | 370 |
| AB ≥ 3 stores | 2,369 |
| AB ≥ 5 stores | 1,151 |
| Both provinces ≥ 5 | 277 |

Only 11% of items reach the "solid block" level, but they are the popular bottles, so they
probably get a much larger share of page views. **(inferred, no analytics)** Alberta has about 3×
the depth of BC. So the BC band will often be missing or thin, and the design must not look
broken when it is.

The feature is most needed exactly where it works best: busy items have the store counts that
make a median and a band meaningful.

## 2. Which lines to draw

Candidates, judged on how useful they are on a phone:

| Candidate | What it answers | Verdict |
|---|---|---|
| **Cheapest (floor)**: min across in-stock stores per day | "What is the best price I could have paid on that day?" | **Candidate for the third line.** See "Floor or a moving target?" below. |
| **BC median per day** + p25–p75 band | "What does it normally cost in BC, and how spread out are the prices?" | **Yes** |
| **AB median per day** + p25–p75 band | Same for Alberta | **Yes** |
| All-store median | One "market price" line | No. It mostly duplicates the AB median (AB has 3× the stores), and the province split is more useful. |
| Static Target (current marker) | "What is a good price, over all history?" | Keep it, unless the 90-day moving target replaces it (below). |
| Mean of the 3 cheapest prices per day | "What does a competitive price look like today?" | **No.** See below. |
| **90-day moving Target**: the current Target formula over a trailing 90 days | "What has a good price been lately?" | **Candidate for the third line.** See below. |
| Static BC / Alberta medians (current markers) | Average over all history | **Drop them in Summary mode.** The moving medians replace them. Keep them in Stores mode. |
| Min–max band | Full spread | No. One premium store stretches it, while p25–p75 ignores that store by design. |

The result is **3 lines and 2 bands**. That is the most a 360 px chart
can show and still be read.

### How jumpy is the floor? (verified)

Measured over all 746 items with ≥ 8 stores, 2026-02-01 → 10-08 (180,151 item-days), with no
out-of-stock hold:

| Measure | Value |
|---|---|
| Floor changes per item over ~8 months | median **8**, p90 18, max 48 |
| Rate | ~1.2 changes per item per month |
| Size of a change | median **6.7%**, p90 20% |
| Changes that snap back within 2 days | 843 of 7,090 (12%) |
| Distinct stores that are ever the cheapest, per item | median 4, p90 6, max 10 |
| Changes of which store is cheapest | ~1.1 per item per month |

So the floor is **calm**: about one step a month, usually a few percent. The 12% that snap back are
mostly one-day sales or one-day out-of-stock gaps at the cheapest store. They are real (you could
have bought at that price), so keep them and don't smooth them out.

**Draw it as a stepped line (`stepped: "before"`)**, not with the chart's usual `tension: 0.15`
curve. A price is a level that holds until it changes. A curved line draws a slope across the
change day, which reads as "drifting" and makes a 1-day sale look like a V. Steps make each change
read as one clean event. The medians should be stepped for the same reason.

**Don't colour the floor by store.** Chart.js can do it (`segment.borderColor` keyed on the
cheapest store per day; median 4 colours, max 10 per item), but:
- every colour then needs a store legend, which is exactly the clutter Summary mode removes;
- store colours would clash with the BC and AB line and band colours;
- on a phone, a colour change in a 2 px line is hard to see.

Use one fixed colour, and name the store in the tooltip (`Cheapest $54.99 · Kensington`). If seeing
the cheapest store at a glance matters later, a desktop-only small store label at each change of
cheapest store is the cleaner option. Leave that out of v1.

### Floor or a moving target? (verified)

Three candidates for the third line, measured over the same 746 items and window:

| Line | Changes per month | Size of a change (median / p90) | Snaps back within 2 days | Distance above floor (median / p90) |
|---|---|---|---|---|
| Floor (cheapest per day) | 1.18 | 6.7% / 20.4% | 12% | 0 / 0 |
| Mean of the 3 cheapest per day | 2.44 | 2.8% / 8.4% | 11% | 4.5% / 13.3% |
| **90-day moving Target**: per store, min price over the trailing 90 days; mean of the 3 lowest | **0.78** | **2.6% / 7.8%** | **0%** | 1.0% / 8.8% |

- **Floor** shows events: rare but large steps, and 1 in 8 is a 1–2 day blip. It answers "when was
  it cheap, and where?". The store list under the chart already answers that for today.
- **Mean of the 3 cheapest** is the worst of both. It changes twice as often as the floor, still
  flaps, and sits between the floor and the medians without a clear meaning. Rejected.
- **90-day moving Target** is the calmest line by far, and it **never snaps back**. Because it is
  built from trailing lows, it drops as soon as a deal appears and rises only when that low is
  more than 90 days old. It is the existing Target idea made time-aware, so it can **replace** the
  static Target marker instead of adding another line. It reads as a two-level story against the
  medians: the median is the normal price, the target is a good price lately, and the gap between
  them is how much waiting for a deal is worth.
  - Downsides: it lags on the way up by design. The first 90 days of an item's history are a
    warm-up, built from fewer days. It needs ≥ 3 stores with a price in the window, or it isn't
    drawn.
  - Tooltip: `Good price $54.99 · lowest 3 stores, last 90 days`.
  - **The window is trailing, not centred.** Each day's value uses that day and the 89 days before
    it, which is what a shopper could have known on that day. A centred ±45-day window was
    considered and rejected. It looks smoother in the past, but it can't be computed for the most
    recent 45 days, which is the part of the chart people care about most. Those values would
    either shrink to a one-sided window or keep changing as new days arrive. A trailing value never
    changes once it is drawn.

**Recommendation:** medians + bands + the 90-day moving Target, with the static Target dropped in
Summary mode. That keeps 3 lines and 2 bands. The floor stays available as a later option; it is
the line for "where was it cheapest", which a deal-hunting view might want.

### Band rules (to avoid fake precision)

- A province's **median line** is drawn on days where that province has ≥ 3 stores.
- Its **band** is drawn on days with ≥ 5 stores. A p25–p75 range over 3–4 values is mostly just the
  min and max.
- Below these counts the line or band has a gap on that day (`spanGaps: false`, as the chart does
  today), so it never fills in data it doesn't have.
- The tooltip always shows the count: `BC median $64.99 · 6 stores · $59.99–$69.99`.

## 3. The composition trap (verified)

A median "over time" is only meaningful if the set of stores behind it is stable. It often isn't:
stores sell out, restock, and get added. Measured over the 60 busiest groups (both provinces ≥ 4
stores), 2026-02-01 → 10-08, 28,454 region-days with ≥ 3 stores:

| Out-of-stock handling | Days the store set changed | Median moves | Moves on a set-change day |
|---|---|---|---|
| None (drop the store the day it goes OOS) | 2,724 | 3,378 | **2,257 (67%)** |
| Hold the last price through gaps of up to **7 days** | 1,006 | 2,146 | 874 (41%) |
| Hold through gaps of up to 14 days | 809 | 1,994 | 706 (35%) |

Without the hold, a moving median mostly shows stores coming and going rather than price
movement. **Recommendation: a 7-day hold, applied only inside the summary statistics.** The
per-store lines keep showing out-of-stock gaps exactly as they do now. A 14-day hold gains little
over 7 days, and it keeps a store that has really sold out in the median for longer.

The **floor** line should *not* use the hold. When the cheapest store sells out, the best
available price really does go up, which is what that line exists to show.

## 4. How it fits the existing code (verified unless marked)

- **The inputs already exist.** `storeSeriesSorted[i].merged.points` holds a per-store, per-calendar-day
  price, with the min across variants and out-of-stock days as `null`. `labels` is one entry per
  calendar day. Hidden listings are already filtered out in `loadSkuHistory`. The region comes from
  `isBcStoreLabel()`, which reads `stores.js` `region`. The summary is a pure function from those
  inputs to arrays of `labels.length` length.
- **Cost:** about 270 days × ≤ 27 stores, one sort per day per province, so well under 1 ms.
  **(inferred)** It also renders far faster than per-store mode (5 datasets instead of up to ~40),
  so it doubles as a performance fix for exactly the items that lag.
- **Bands:** Chart.js 4.4.1 UMD (`viz/index.html`) includes the Filler plugin. Two datasets (p25,
  p75) with `fill: "-1"` on the upper one. Alpha around 0.15, so where the BC and AB bands overlap
  you still get a readable darker region. Hide p25/p75 from the tooltip and the legend.
- **Markers:** `StaticMarkerLinesPlugin` already takes a `markers` list. Summary mode passes only
  Target.
- **Outlier clamp** (`computeHighOutlierCap`): not needed in Summary mode, because medians and the
  p25–p75 band ignore the far-above store by design. Base the y-range on floor, p25 and p75 values.
- **Flip-flops:** the floor inherits any flapping store, such as Craft Cellars' oscillation, when
  that store is the cheapest. Leave days in a store's `_flapSet` out of the floor. Flapping inside
  the median is mostly absorbed. **(inferred)**
- **Precedent:** `#/stats` already draws a market median and floor that change over time
  (`stats_page.js` `marketMedianSeries`/`marketFloorSeries`). The same idea works there, though the
  code is different and not reusable as is.

## 5. UI

- A segmented toggle **`Stores | Summary`** above the chart. The default is **Summary when the item
  has ≥ 8 stores in its history**, otherwise Stores. An explicit choice is remembered per viewer in
  `localStorage`, wrapped in try/catch so the page still renders without it.
- Summary mode replaces the store legend panel (`#chartLegend`) with a fixed 3-entry key
  (Good price / BC / Alberta). A store-coloured legend has nothing to label in this view.
- Line colours: two distinct province hues for BC and AB, and a strong neutral or green for
  the Good price line. This needs one line in `viz/style.css` tokens for light and dark. Keep strokes thicker
  than the per-store lines (they are now the whole chart).
- Hide the toggle when the item has fewer than 3 stores. There is nothing to summarise.
- The default and the stored choice are the same on every surface. A viewer shouldn't have to
  learn a different chart per device.

### Per surface

All three surfaces must look good. Summary mode is designed phone-first, and desktop is the
roomier version of the same thing.

| Surface | What to get right |
|---|---|
| **Mobile web (≤ 640 px)** | The main use case. The x tick cap (3) and dot suppression already apply. With 3 lines, tap-to-tooltip becomes useful again: one tap shows Good price + BC + AB together (`interaction.mode: "index"` in Summary mode instead of the current `"nearest"`, so you don't have to hit an exact line). The toggle is a full-width segmented control with ≥ 44 px tap targets, placed above the chart and never over it. The 3-entry key is a single row under the chart, not the collapsible `<details>` panel. Keep the tooltip short: `BC $64.99 · 6 stores`, with the p25–p75 range on a second line only when a band is drawn. |
| **PWA (standalone)** | The same layout as mobile web, plus two checks. (1) Pull-to-refresh (`components/pull_to_refresh.js`) already ignores touches that start on a `canvas`, so dragging across the chart to scrub doesn't reload. Verify the new toggle sits outside the gesture area or is excluded the same way. (2) Offline: the summary is computed in the browser from the per-SKU files `loadSkuHistory` already fetches, so it works from the service-worker cache with no new request and no new precache entry. **(inferred, verify on a device)** |
| **Desktop (> 640 px)** | More room, so the key can sit inline to the right of the toggle, and hover tooltips work without changes. Keep the `index`-mode tooltip for consistency. Desktop is also where the current lag shows. Summary mode draws 5 datasets instead of ~27 (later ~50), which fixes that lag on busy items without any further dot or line tuning. |

Light and dark themes apply on every surface: the band alpha (~0.15) must be checked on both
backgrounds, because a fill that reads well on white can disappear on the dark theme.

### Load lurch (applies to both modes; fix applied 2026-10-10, not yet checked in a browser)

The jerky first load is not caused by the number of points alone. Two Chart.js animations run back
to back. **(verified in code; the cause of the lurch is inferred, not profiled)**

1. `new Chart(...)` uses Chart.js's default entrance animation, because no `animation` option is
   set anywhere in `viz/app/`. It lasts 1,000 ms and every point of every dataset rises from the
   baseline. Each frame redraws every line segment and re-runs the per-point callbacks
   (`pointRadius`, `pointHoverRadius`, `segment.borderDash`). With 27 stores × ~265 days, that is
   ~7,000 points per frame.
2. Right after that, `item_page.js` (`if (tickCount >= 2) { … CHART.update(); }`) changes the
   y-axis min/max and calls `CHART.update()` with the default mode. That starts a **second**
   animation while the first is still running, so every line flies up and then all of them shift
   again as the axis changes. That double move is the lurch.

Fix, about 2 lines:
- Set `animation: false` in the chart options. A price-history chart gains nothing from an
  entrance animation, and dropping it removes all of the per-frame work.
- Use `CHART.update("none")` for the y-axis fix-up, so the axis settles without animating.

That gives one draw at the final scale. It is independent of Summary mode and worth shipping first:
Stores mode keeps existing for items with few stores, and Summary mode would hit the same
animation code. If the first draw is still slow after that on the biggest items, profile it before
reaching for `parsing: false` / `normalized: true` or the decimation plugin. Decimation only works
on linear or time x-axes, and this chart uses a category axis.

## 6. Doubling the store count makes this more urgent

The store hunt (`STORE_HUNT_HANDOFF.md`) plans to roughly double the store count. **(inferred,
nothing measured below)**

- **Per-store mode gets worse in step with the store count.** Today the busiest item has 27
  stores. After doubling, the top items could reach ~50 lines, and the colour palette can't keep
  that many stores distinguishable. The ≥ 8 bucket (746 items today) will grow by much more than
  its share, because popular bottles are the ones every new store carries.
- **Summary mode doesn't grow at all.** It stays 3 lines and 2 bands at any store count. More stores
  make it *better*: a median over 20 stores is steadier than one over 5, and the bands become
  meaningful for more items.
- **BC benefits most** if the new stores lean BC. Today only 370 items have ≥ 5 BC stores, so many
  BC bands are missing.
- Rendering cost scales the same way: per-store datasets grow with the number of stores, while
  Summary stays at 5 datasets.
- Re-measure §1 after the onboarding wave and revisit the auto-default threshold. A fixed "≥ 8
  stores" may become "nearly every item", at which point Summary should just be the default, with
  Stores as the option.

## 7. Alternatives considered

| Option | Why not (or not first) |
|---|---|
| **Top-K cheapest stores**: draw only the K stores cheapest today, fade the rest | Still a store-per-line chart, and it hides the market context. A reasonable *third* mode later. |
| Tap a legend entry to highlight one store | Helps someone who already knows which store they care about; doesn't answer "is this a good price?" |
| Province small multiples (two stacked charts) | Halves the height of each chart on a phone. The bands already separate the provinces. |
| Pre-compute the summary in a build tool | Not needed. The browser already has every input, and it is cheap. |

## 8. Open questions for the owner

1. Is ≥ 8 stores the right threshold for auto-defaulting to Summary? (746 items. ≥ 10 is 521 items.)
2. Should Summary mode list per-store prices anywhere? The store quick-links list below the chart
   already does this, so probably no.
3. (Only if the floor line is added later.) Should its tooltip also show the runner-up store? It's useful when the cheapest store is a
   delivery-only shop, but it adds noise.
4. Is 90 days the right window for the moving Target? A shorter window recovers sooner after a
   one-off sale. A longer one holds the "good price" bar lower for longer. Only 90 was measured.
