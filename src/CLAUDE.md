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

`src/stores/index.js` exports `createStores()` which instantiates all 16 adapters.

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

| Key | Store | Scrape Method | Categories |
|-----|-------|---------------|------------|
| `arc` | ARC / Armstrong Coop | Barnet network API | Spirits-Rum, Spirits-Scotch, Spirits-Whiskey |
| `bcl` | BC Liquor Stores | Elasticsearch Ajax browse | Whisky/Whiskey, Rum |
| `bsw` | BSW Liquor | Algolia API | Scotch Whisky, Rum, Whisky |
| `coop` | Co-op World of Whisky | Custom session API (POST /api/v2/products/category) | Canadian Whisky, Bourbon, Scottish Single Malts, Scottish Blends, American Whiskey, World Whisky, Rum |
| `craftcellars` | Craft Cellars | Shopify `/products.json` + HTML fallback | Whisky, Rum |
| `gull` | Gull Liquor Store | WooCommerce HTML (12 s throttle) | Whisky, Rum |
| `kegncork` | Keg N Cork | WooCommerce HTML | Whisky, Rum |
| `kwm` | Kensington Wine Market | Custom session + binary-search pagination | Scotch, Rum |
| `legacyliquor` | Legacy Liquor | Shopify GraphQL Storefront cursor pagination | Whisky, Rum |
| `maltsandgrains` | Malts & Grains | WooCommerce HTML (excludes Gin, Tequila, Mezcal) | All spirits minus gin/tequila/mezcal |
| `sierrasprings` | Sierra Springs | WooCommerce Store API + HTML TMB blocks | Whisky, Fine & Rare, Spirits/Liquor, Spirits |
| `strath` | Strath Liquor | Divi Ajax Filter + WooCommerce Store API | Whisky, Spirits-Rum |
| `tudor` | Tudor House | Shopify GraphQL Storefront (cursor paging, budgeted detail fetches) | Rum, Whiskey/Scotch, Scotch Selections |
| `vessel` | Vessel Liquor | Shopify HTML `<product-card>` tags | Whisky, Rum/Cane Spirit |
| `vintagespirits` | Vintage Spirits | Barnet network API | Whisky & Whiskey, Single Malt Whisky, Rum |
| `willowpark` | Willow Park | Shopify HTML + GQL SKU repair pass | Scotch, Rum |
