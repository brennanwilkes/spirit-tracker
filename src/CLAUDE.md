# Tracker / Scraper (`src/`)

Node.js web scraper. CommonJS throughout. No dependencies beyond Node.js 18+ stdlib + global `fetch`.

## Entry Point

`src/main.js` — exports `main()` and is called by `bin/tracker.js`. Handles CLI arg parsing, config, HTTP client creation, store filtering, and final report writing.

## Store Adapter Pattern

Each store is a file in `src/stores/` that exports a plain object with:

```js
{
  key: "storename",          // used for --stores filter and DB file naming
  name: "Display Name",
  host: "example.com",
  categories: [
    { key: "whisky", label: "Whisky", url: "https://..." },
    ...
  ],
  // async function — the main scrape function for one category
  scanCategory: async (category, config, logger, http) => [ ...items ]
}
```

`src/stores/index.js` exports `createStores()` which instantiates all 34 adapters.

## Tudor House multi-size variants (`src/stores/tudor.js`)

One Tudor product page can expose several sizes via a `<select>`, each a GQL variant
with its **own real CSPC SKU, price, and `shortName`** (e.g. `"375ML"`). The bulk
`products` listing query carries `shortName`/`fullName` per variant, so size + price +
SKU come for free — **no detail fetch needed** for multi-size products.

- `tudorItemsFromProduct()` returns an **array**: one listing per in-stock variant for
  multi-variant products (`variants.length >= 2`), or a single listing (unchanged
  behavior, bare URL, name untouched) for single-variant products.
- Multi-size listings get a stable discriminator URL `…/<slug>?variant=<rawSku>` (the
  page ignores the param) so the two sizes are distinct keys in the URL-keyed merge.
  Single-size listings keep the bare URL — no identity churn.
- Multi-size names = `stripSizeTokens(baseName) + " " + shortName` (strips any size
  already baked into the name, e.g. `BALLANTINES 750ML` → `BALLANTINES`, then appends
  the variant's authoritative size).
- For multi (`it._multi`), GQL per-variant SKU/price/size are **authoritative**;
  `tudorRepairItem` never overrides them from the shared HTML page (which only shows
  one size) — it only fills a missing image via budgeted `productsBySku`.
- **Re-SKU / size-drop handling:** if a single-size product's tracked CSPC no longer
  matches any live variant (e.g. it dropped from two sizes to one and the old size was
  delisted), the scanner routes the live listing through a fresh `?variant=<sku>` URL so
  the stale bare-URL record retires and the correct SKU takes over. This is necessary
  because `merge.js`'s same-URL `pickBetterSku` keeps the existing value on a
  CSPC-vs-CSPC tie — so a scanner-only SKU swap can't win; the URL must change. Only
  fires for the handful of re-SKU'd singles (verified: no churn on clean singles).
- **Why it changed (2026-06-07):** the old code emitted ONE listing per product and
  `tudorPickVariant` flipped between sizes run-to-run (e.g. when the 750ML sold out it
  fell back to the in-stock 375ML), so a single listing's price bounced and registered
  as a huge fake "sale %". Per-variant emission fixes this at the root. Cutover means
  old single-listing records for these products go OOS once and the split listings
  appear fresh (the larger size keeps history via merge's skuKey-rematch); their stale
  `data/sku_links.json` entries were bulk-removed for manual relinking.

## Everything Wine (`src/stores/everythingwine.js`) — Magento gotchas

BC chain, Magento storefront, uses a **custom `scanCategory`** (not the standard probe flow)
for two reasons:

- **Pagination CLAMPS.** `?p=99999` returns page 1, not an empty grid — the standard
  binary-search discovery would never see a MISS and would hit the safety cap. Instead the
  scan reads the total product count from the `toolbar-number` markup ("1-24 of **543**")
  and computes `pages = ceil(total / itemsOnPage1)`. Page URLs via
  `makePageUrlQueryParam(baseUrl, "p", N)`. Do NOT add `?p=` to the shared
  `extractTotalPagesFromPaginationHtml` — the on-page nav only lists pages 1–5, so it would
  under-scan.
- **Real SKU = BCL CSPC, sourced from the IMAGE filename.** Listing cards expose only the
  Magento entity id (`data-product-id`), which is NOT the catalogue code. But the catalog
  image filename is prefixed with the real CSPC (`.../4/2/42_canadian_club.jpg` → `42`),
  verified to equal the detail-page SKU for every non-placeholder image. `parseProducts`
  extracts it (no fetch). 6-digit codes are CSPCs as-is; shorter ones get the liquorama-style
  `id:` zero-pad (`42` → `000042`) so they implicitly link with other BC stores (~20/24
  whisky SKUs already match strath/gull/arc/bcl/tudor/legacy). Only **placeholder-image**
  products (no number) fall through to a budgeted detail-page fetch (`"sku"` in JSON-LD,
  seeded from prevDb). Measured: ~5/24 placeholders/page.
- **Stock: treat all listed products as in-stock.** The per-card stock class
  (`stock available`/`unavailable`) is relative to the *selected* store (Vancouver), NOT a
  global signal — e.g. an item "unavailable" at Vancouver can be in stock at South Surrey.
  An audit of a full listing page found every listed product globally salable
  (`is_salable:1`), incl. all "unavailable"-at-default ones — Magento drops
  sold-out-everywhere products from category listings. The detail fetch (done anyway for
  placeholder SKUs) reads `is_salable` and drops a product only if it's explicitly `0`
  (defense-in-depth; none seen on listings).

## Keg N Cork event tickets (`src/stores/kegncork.js`)

Keg N Cork sells **in-store tasting/event tickets out of its whisky category** (SMWS monthly
outturns, one-off tastings, member events). They are not bottles, and hand-hiding each new
month's batch via `data/sku_hidden.json` was endless, so `parseProductsKegNCork` drops them at
parse time via `EVENT_LISTING_RE`. Signals: a clock time (`@7 PM`, `1-4PM`), `IN PERSON`,
`EVENT`, or `OUTTURN` (which covers both the in-person tickets and the paired monthly tasting
kit). Generic multi-bottle sample packs (`RAASAY OAK SPECIES TASTING PACK`, `DRINKS BY THE DRAM
TASTING SET`, `SHINOBU TASTING PACK`) are real products and intentionally NOT matched — verified
against all 1054 Keg N Cork names ever recorded: 44 matched, all genuine events, zero false
positives. The already-recorded tickets stay in the DB (they just go `removed`) and remain hidden
by their existing `sku_hidden.json` entries.

KWM has the same problem — 11 `PE `-prefixed listings (e.g. `PE SMWS August Virtual Outturn
Tasting`) — deliberately left unfiltered for now (some `PE ` items, like the advent-calendar
sets, are real products).

## Windowed pagination navs under-count total pages (2026-08-11)

`extractTotalPagesFromPaginationHtml` takes the **highest page number appearing in any href**
on page 1. That is exact for WooCommerce, whose nav always ends in the last page
(`1 2 3 4 … 29 30` — verified on Gull: extracts 30, correct). It is a **floor, not a total**,
for navs that render a *sliding window* with only a "next" arrow and no last-page link.

**BigCommerce Stencil (Keg N Cork) is such a nav.** Its whisky category has 7 pages, but page 1
links only `1…6`, so extraction returned 6 and `discoverTotalPagesFast` trusted it — the
`looksTruncated` guard only distrusts `extracted <= 2`. Pages 1–6 = exactly 594 products, which
is exactly what the DB held; **page 7's 40 products were never scraped and sat permanently
`removed: true`, i.e. OUT OF STOCK in the UI.** Worse, they *flip-flopped*: an item near the
600-item boundary crosses it whenever a product is added or removed higher in the sort, so it
alternated removed/restored run to run (e.g. `FIRST EDITIONS AUCHENTOSHAN KNC CASK`, page-7
position 2, while the store page showed it in stock the whole time).

**Fix:** when extraction looks trustworthy, `discoverTotalPagesFast` now **probes page
`extracted + 1`**. MISS → the count is exact, return it (Woo's fast path is preserved; costs one
extra fetch, ~0.3 s). Products found → the nav is windowed, so the extracted count is discarded
and the normal probe + `binaryFindLastOk` path runs (correctly resolves Keg N Cork to 7 / 634
products). This is generic — any future windowed-nav store self-heals rather than silently
under-scanning.

**Diagnosing this class of bug:** compare a category's DB `live` count against a hand-scrape of
every page. An exact match to `pageSize × N` is the tell. Note `avoidMassRemoval` does NOT catch
it — losing one page of many stays well above the 60% floor.

**Not this bug** (checked at the same time, both are genuine stock signals, leave them alone):
Vessel's category URLs carry `filter.v.availability=1`, so items legitimately drop out of the
listing when Shopify marks them unavailable (its 5 pages parse to 194 = its exact live count);
ARC uses a custom API scan where `barnetItemToTracked` returns null once `on_hand` hits 0.

**ARC amendment (2026-09-04).** The above is still true — ARC's `on_hand` IS a genuine stock signal
— but ARC had a SECOND, independent pagination defect on top of it. Its Barnet API pages via
LIMIT/OFFSET and re-runs its ORDER BY per request, so rows TIED on the sort key swap between
requests: one is served on two adjacent pages while its partner is served on none. Under the old
`sortBy: "price_desc"` this cost exactly one row per affected category, every run, alternating
between the two tied items — a fake sellout + restock each time. Diagnostic signature: the pair
never both dropped, and `rowsFetched === paginator.items_count` while `duplicateRows === shortfall`.

Fixed by switching the ARC categories to `sortBy: "name_asc"` (tie-free in this catalog), plus a
completeness check that re-sweeps with a DIFFERENT sort if `rawIds.size < items_count`. Note the
skip is DETERMINISTIC, so re-sweeping the same sort order is useless. Verified live after the
change: Rum 102/102, Scotch 227/227, Whiskey 160/160, Gin 83/83, `Removed=0` in all four and no
re-sweep triggered. See root `CLAUDE.md` §"Three fake-flip-flop ROOT CAUSES fixed".

**`highpointbws`, `newdistrict` and `vintage` are also Barnet stores and still default to
`price_desc`** (via `barnet_network.js`); they were not audited and likely carry the same latent
straddle. Check with: sweep every page, compare unique row ids against `paginator.items_count`.

## Category Scan Flow (`src/tracker/`)

1. `run_all.js` — schedules all stores/categories with host-level serialization (never run two categories from the same host concurrently) inside a concurrency pool.
2. `category_scan.js` — for one store+category: loads old DB, calls `store.scanCategory()`, merges results, writes updated DB.
3. `db.js` — atomic JSON I/O: writes to `.tmp` file then `rename()`. DB filename: `{store}__{category}__{urlhash8}.json`.
4. `merge.js` — diffs old vs new item lists. Detects: new / updated / removed / restored / meta-changed.
5. `report.js` — renders the final human-readable summary.

## Mass-Removal Protection

If a scan returns fewer than 60% of the previous item count, removed items are restored from the old DB. This prevents a partial scrape (network glitch, site change) from wiping out good historical data.

`merge.js::avoidMassRemoval` compares against ACTIVE (non-`removed`) previous items — `byUrl` also
holds every long-removed record ever seen, so using its raw size trips the guard on healthy
categories. It is opt-in per store (8 stores call it) and only fires below the 0.6 ratio, so it does
NOT catch losing one page of many (see §"Windowed pagination navs") or losing a single boundary row
(see the ARC amendment above).

**It also does not protect against the orphan-DB detector**, which bypasses the scan entirely and
rewrites a DB file directly — that was a separate store-wide data bug, fixed 2026-09-04 by routing
both the scanner and `orphan_dbs.js` through the single shared `db.js::dbFileForCategory()`. Any new
code that needs a category's DB path MUST use that helper; deriving it independently is exactly how
the two drifted. See root `CLAUDE.md` §"Three fake-flip-flop ROOT CAUSES fixed".

**`merge.js` skuKey rematch is for URL MIGRATIONS only.** It hard-`delete`s the old record, so it
must not fire when both URLs are live in the same scan — that means two distinct products colliding
on one normalized SKU, and deleting either makes the pair annihilate each other run after run. The
`!discovered.has(hit.url)` guard enforces this.

## HTTP Client (`src/core/http.js`)

- Retries with exponential backoff (default 6 retries)
- Timeout (default 25 000 ms)
- Configurable stagger delay between requests (default 150 ms)
- Per-store overrides: pass options when calling `http.fetch()` for stores with tight rate limits

## Utilities

| File | Purpose | When to use |
|------|---------|-------------|
| `src/utils/price.js` | Extract `$X.XX` from HTML/API | Always — don't hand-parse prices in store files |
| `src/utils/sku.js` | Normalize/classify SKUs | Always — use `normalizeSku()` for SKU extraction |
| `src/utils/html.js` | HTML parsing helpers | Extracting text/attrs from HTML strings |
| `src/utils/woocommerce.js` | WooCommerce-specific helpers | WC stores |
| `src/utils/url.js` | URL normalization | Strip noisy query params, resolve relative URLs |
| `src/utils/async.js` | `pMap`, `pLimit`, concurrency utils | Concurrent fetching |
| `src/utils/string.js` | String cleaning | Name normalization |
| `src/utils/text.js` | Text extraction | Strip HTML tags, decode entities |
| `src/utils/args.js` | CLI arg parsing + `clampInt` | Already used in main.js |
| `src/utils/time.js` | ISO timestamps | File-safe timestamp strings |
| `src/utils/sku_canonical.js` | DSU, `compareSku`, `normalizeImplicitSkuKey`, `buildGroupsAndCanonicalMap` | Shared canonical-SKU logic |

## Shared canonical-SKU logic

`src/utils/sku_canonical.js` (CJS) and `viz/app/sku_canonical.js` (ESM) are **parallel files** with identical logic. Since there is no build step, they must be kept in sync manually — if you change one, mirror the change in the other. Both are consumed by `src/utils/sku_map.js`, `viz/app/mapping.js`, and several tools.

`tools/lib/sku.js::normalizeImplicitSkuKey` is **intentionally different** (it also extracts any 6–10 digit substring, used by `build_viz_recent.js` and `rank_discrepency.js`) — do not fold it into the shared module.

## SKU Priority Order

1. 6-digit CSPC code (preferred — most stores carry these)
2. `id:NNNNN` — numeric product ID
3. `upc:XXXXX` — UPC barcode
4. `u:HASH` — URL-based fallback (synthetic, eligible for repair)

The `u:` prefix signals "I don't have a real SKU." Several stores have a second-pass "SKU hydration" step that fetches individual product pages to resolve these (budgeted to ~200 fetches per run to avoid explosion).

## Environment Variables

All optional. CLI flags take precedence over env vars.

| Variable | Default | Notes |
|----------|---------|-------|
| `STORES` | (all) | Comma-separated; same as `--stores` |
| `CONCURRENCY` | `6` | Global request worker pool (1–64) |
| `STAGGER_MS` | `150` | Delay between requests (0–5000 ms) |
| `MAX_RETRIES` | `6` | Per-request retries (0–20) |
| `TIMEOUT_MS` | `25000` | Request timeout (1000–120000 ms) |
| `DISCOVERY_GUESS` | `20` | Initial last-page probe for binary search |
| `DISCOVERY_STEP` | `5` | Step size for page discovery |
| `CATEGORY_CONCURRENCY` | `5` | Parallel category jobs |
| `DATA_DIR` | `./data/db` | DB output directory |
| `REPORT_DIR` | `./reports` | Report output directory |
| `DEBUG` / `TRACKER_DEBUG` | off | Enable verbose logging |

## Stores Reference

34 adapters (extracted from `createStores()`; categories reflect current config —
note **Gin** is now scraped across all stores, not just whisky/rum). Region: BC =
British Columbia, AB = Alberta. Many AB stores run on **Shopify**, which is why
they often share raw SKUs across stores (the implicit "free" SKU links).

| Key | Store | Region | Scrape Method | Categories |
|-----|-------|--------|---------------|------------|
| `arc` | ARC Liquor | BC | Barnet network API | Spirits - Rum / Scotch / Whiskey / Gin |
| `bcl` | BCL (BC Liquor Stores) | BC | Elasticsearch Ajax browse | Whisky/Whiskey, Rum, Gin |
| `bsw` | BSW | AB | Algolia API | Scotch Whisky, Rum, Whisky, Gin |
| `canadianliquor` | Canadian Liquor Store | AB | Shopify HTML | Whisky, Rum, Gin |
| `clbspirits` | CLB Spirits | AB | Shopify HTML | Whisky, Rum, Gin |
| `colordevino` | Color de Vino | AB | WooCommerce | Whisky/Whiskey, Whisky SC SM, Rum, Gin |
| `coop` | Co-op World of Whisky | AB | Custom session API (POST /api/v2/products/category) | Canadian Whisky, Bourbon, Scottish Single Malts, American Whiskey, Rum, Gin |
| `elbowliquor` | Elbow Liquor | AB | ASP.NET HTML grid (`?pageNumber=N`); in-stock cards' `addToCartBtn` carries `data-sku`/`data-name`/`data-price` | Whisky, Rum, Gin |
| `craftcellars` | Craft Cellars | AB | Shopify `/products.json` + HTML fallback | Whisky, Rum, Gin |
| `everythingwine` | Everything Wine | BC | Magento HTML (custom scanCategory) | Whisky, Rum, Gin |
| `gull` | Gull Liquor | BC | WooCommerce HTML (12 s throttle) | Whisky, Rum, Gin |
| `highlander` | Highlander Wine & Spirits | AB | WooCommerce | Whiskey, Rum, Gin |
| `highpointbws` | High Point BWS | BC | Barnet network API | Whiskey, Rum, Gin |
| `kegncork` | Keg N Cork | AB | WooCommerce HTML | Whisky, Rum, Gin |
| `kwm` | Kensington Wine Market | AB | Custom session + binary-search pagination | Scotch, Rum, Gin |
| `legacyliquor` | Legacy Liquor | BC | Shopify GraphQL Storefront cursor pagination | Whisky, Rum, Gin |
| `liberty` | Liberty Wine Merchants | BC | WooCommerce | Whisky, Rum, Gin |
| `lime` | Lime Liquor | AB | Shopify HTML | Whiskey, Rum, Gin |
| `liquorama` | Liquorama | AB | Shopify (API) | Whisky, Rum, Gin |
| `liquorwarehouse` | Liquor Warehouse | BC | Shopify HTML | Whiskey/Scotch, Rum, Gin |
| `maltsandgrains` | Malts & Grains | AB | WooCommerce HTML | All Spirits, Gin |
| `marquis` | Marquis Wine Cellars | BC | Shopify GraphQL | Whisky, Rum, Gin |
| `newdistrict` | New District | BC | Barnet network API | Whiskey, Rum, Gin |
| `rmwsb` | Rocky Mountain Wine Spirits Beer | AB | WooCommerce | Whiskey, Rum, Gin |
| `sherbrooke` | Sherbrooke Liquor | AB | WooCommerce | Whisky, Rum, Gin |
| `sierrasprings` | Sierra Springs | AB | WooCommerce Store API + HTML TMB blocks | Scotch/Single Malt, Canadian, Irish, American, World Whisky, Spirits, Gin |
| `strath` | Strath Liquor | BC | Divi Ajax Filter + WooCommerce Store API | Whisky, Spirits - Rum, Gin |
| `tudor` | Tudor House | BC | Shopify GraphQL Storefront (cursor paging, budgeted detail fetches) | Rum, Whiskey/Scotch, Scotch Selections, Gin |
| `vessel` | Vessel Liquor | BC | Shopify HTML `<product-card>` tags | Whisky, Rum/Cane Spirit, Gin |
| `vinearts` | Vine Arts | AB | Shopify GraphQL | Whiskey, Rum, Gin |
| `vintage` | Vintage Spirits | BC | Barnet network API | Whisky & Whiskey, Single Malt Whisky, Rum, Gin |
| `whiskydrop` | Whisky Drop | AB | Shopify HTML | Whisky, Rum, Gin |
| `willowpark` | Willow Park | AB | Shopify HTML + GQL SKU repair pass | Scotch, Rum, Gin |
| `wineandbeyond` | Wine and Beyond | AB | Shopify `/products.json` | Whiskey, Rum, Gin |
| `zyn` | ZYN The Wine Market | AB | Shopify HTML | Whisky, Rum, Gin |
