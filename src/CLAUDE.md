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

## Category Scan Flow (`src/tracker/`)

1. `run_all.js` — schedules all stores/categories with host-level serialization (never run two categories from the same host concurrently) inside a concurrency pool.
2. `category_scan.js` — for one store+category: loads old DB, calls `store.scanCategory()`, merges results, writes updated DB.
3. `db.js` — atomic JSON I/O: writes to `.tmp` file then `rename()`. DB filename: `{store}__{category}__{urlhash8}.json`.
4. `merge.js` — diffs old vs new item lists. Detects: new / updated / removed / restored / meta-changed.
5. `report.js` — renders the final human-readable summary.

## Mass-Removal Protection

If a scan returns fewer than 60% of the previous item count, removed items are restored from the old DB. This prevents a partial scrape (network glitch, site change) from wiping out good historical data.

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
