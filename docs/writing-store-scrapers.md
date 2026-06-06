# Writing Store Scrapers — Field Guide

A practical guide to adding a new liquor-store scraper to the Spirit Tracker.
Written for someone who has never touched this codebase. It covers the
architecture, the three reusable platform adapters, how SKUs work, the
step-by-step process for adding a store, and — most importantly — the long
list of gotchas that will bite you if you trust a store's data at face value.

If you read nothing else, read **§7 Gotchas**. Most of the time spent adding
the 17 stores in this codebase went into discovering those, not writing code.

---

## 1. What a scraper does

Each store is one file in `src/stores/{key}.js` that exports
`createStore(defaultUa)` returning a plain object:

```js
{
  key: "clbspirits",        // unique id; used for --stores filter + DB filenames
  region: "AB",             // "AB" or "BC" (drives SKU-space expectations)
  name: "CLB Spirits",      // display name
  host: "clbspirits.com",   // bare host; the tracker serializes requests per host
  ua: defaultUa,
  shopId: "96",             // only for Barnet stores
  scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
  categories: [
    { key: "whisky", label: "Whisky", _scan: <adapter scan fn>, startUrl?, ... },
    ...
  ],
}
```

The tracker calls `scanCategory(ctx, prevDb, report)` **once per (store,
category)**. The near-universal pattern is to build one adapter scan function
per category (closure) and store it on `_scan`, then dispatch with
`scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep)`.

Register the store in `src/stores/index.js`: add a `require` and one
`createX(defaultUa)` line inside `createStores()`. Nothing else.

### The item shape

A scan ultimately fills a `Map<url, item>` where each item is:

```js
{ name, price, url, sku, img }
```

- `price` is a display string like `"$83.70"` (empty string if unknown).
- `url` is the canonical product URL AND the Map key AND the seed for the
  `u:` synthetic SKU hash — so it must be **stable across runs** for the same
  product.
- `sku` is the normalized SKU (see §3).

Platform adapters produce this for you. Bespoke stores build it by hand and
call `finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages })`.

### What the framework gives you for free

- `src/core/http.js` — retries, timeouts, and a **2.5s minimum per-host
  interval with single-inflight** (deliberately slow to avoid blocks). You
  cannot hammer a host faster than this; design around it.
- `src/tracker/finalize.js::finalizeCategoryScan` — diffs vs the previous DB,
  writes the JSON file, updates the report.
- Mass-removal protection: if a scan returns <60% of the previous item count,
  removed items are restored (guards against a partial scrape wiping history).
- DB files: `data/db/{store}__{category}__{urlhash8}.json`.

### Scope: what we track

Only **whisky (all types incl. scotch/bourbon/rye/Irish/Japanese/world),
rum, and gin**. We keep **in-stock items only** (out-of-stock items are
dropped, not recorded). One aggregate availability per (store, SKU) — never
per-location (roll up inside the adapter if a store exposes locations).

---

## 2. The three platform adapters

Before writing bespoke code, check if one of these fits. They live in
`src/platforms/`.

### 2a. Shopify — `createShopifyCollectionAdapter(opts)`

For any store on Shopify (look for `cdn.shopify.com`, a working
`/products.json`). Options:

| opt | meaning |
|---|---|
| `collectionHandle` | the collection slug, e.g. `"whisky-1"` |
| `skuFallback` | `"none"` \| `"product-page"` \| `"product.js"` — hydrate synthetic SKUs by fetching detail pages. Usually `"none"`. |
| `allowProduct` | `(product) => boolean` post-fetch filter (location tags, case-only, etc.) |
| `useGlobalProductsJson` + `classify` | scan `/products.json` and classify each product, instead of a collection |
| `perPageDelayMs`, `jsonPageLimit` | pacing / page size (default 250) |

Endpoint walked: `/collections/{handle}/products.json?limit=250&page=N`.
SKU/price/image/availability handled for you. Drops OOS automatically.

### 2b. WooCommerce — `createWooStoreApiAdapter(opts)`

For WordPress/WooCommerce stores (`/wp-json/wc/store/v1/products` returns
JSON). Options:

| opt | meaning |
|---|---|
| `wooCategoryId` | numeric term id (skip discovery) |
| `categorySlug` | passed straight to the `category` param. Accepts a **comma-separated list** (`"113,120,121"`) which the API ORs + dedups. Also works for slug-based stores. |
| `categoryUrl` | category page URL; the adapter discovers the term id from its body class |
| `allowProduct` | `(item) => boolean` filter (runs on the parsed item, which has `url`) |
| `stockStatusFilter` | default `"instock"` |
| `htmlFallback`, `ogMetaFallback` | fallbacks if the JSON API is blocked |

The WC Store API **requires** `Accept: application/json` (the adapter sends
it). A plain browser request gets a Cloudflare HTML page.

### 2c. Barnet Network — `createBarnetAdapter(opts)`

For stores whose JS loads from `s.barnetnetwork.com` (look for
`Api.init({ shop_id: '...' })`). The store config needs `shopId`. Options:

| opt | meaning |
|---|---|
| `category` | Barnet `category` param, e.g. `"SPIRITS"` |
| `subCategory` | `sub_category` param, **case-sensitive** (`"WHISKEY"` not `"Whiskey"`) — server-side filter |
| `allowItem` | `(rawItem) => boolean` — client-side classify mode; fetches the broad `category` once (shared per-run cache) and filters. Use only if `sub_category` can't partition. |
| `sortBy` | default `"price_desc"` |

Endpoint: `/api/shop/{shopId}/products?category=...&sub_category=...&p=N`.
Uses the shared `src/utils/barnet.js` helpers for SKU/price/stock/image.

> Note: `arc.js` and `vintagespirits.js` predate this adapter and carry their
> own copies of the loop. Migrating them is tracked in `todo_work.md`.

### 2d. Bespoke

If none fit (custom REST API, inline-JS scraping), write `scanCategory`
directly. Examples: `liquorama.js` (clean REST), `marquis.js` (regex over an
inline analytics array), `wineandbeyond.js` (faceted-HTML availability).
Still produce the `{name,price,url,sku,img}` item shape and call
`finalizeCategoryScan`.

---

## 3. SKUs — the heart of cross-store value

The whole point of the tracker is comparing the same bottle across stores, so
SKU normalization matters more than anything.

`src/utils/sku.js::normalizeSkuKey(raw, {storeLabel, url})` resolves, in
priority order:

1. **6-digit CSPC** (AB = AGLC, BC = BCLDB) — e.g. `"837223"`. The gold
   standard; bottles with the same CSPC auto-canonicalize across stores.
2. **`id:NNN`** — a numeric id. `idToCspc6` **zero-pads ids of ≤6 digits**
   to a CSPC (`id:331` → `"000331"`). Ids of 7+ digits stay `id:NNNNNNN`.
3. **`upc:NNNNNNNNNNNN`** — a 12-14 digit barcode.
4. **`u:HASH`** — synthetic fallback, hashed from `storeLabel|url`. Means "no
   real SKU." Stable as long as the url is stable.

### The single most important SKU rule

**A raw numeric SKU that isn't exactly 6 digits will fall to `u:` synthetic
unless you prefix it with `id:`.** Many stores use short (3-5 digit) legacy
BCLDB stock ids (`331` = Beefeater) or long (7-digit) internal ids. Wrap them:

```js
const skuInput = /^\d+$/.test(sku) && !/^\d{6}$/.test(sku) ? `id:${sku}` : sku;
```

Then `id:331` zero-pads to `"000331"` — which **matches** the BCL store's
`"000331"` for the same Beefeater, giving automatic cross-store linking with
zero manual work. The Shopify adapter does this internally; bespoke stores
(liquorama, wineandbeyond) do it inline.

**Exception — don't `id:`-promote IDs that aren't real product codes.**
Marquis uses BigCommerce-internal 7-digit ids that are NOT BCLDB. Promoting
them to `id:` would risk **false merges** with W&B's 7-digit `id:` SNDL ids
(different bottles, same number). Marquis is deliberately left `u:` synthetic
(~100% u:) and linked manually by name. The test: is the number a real
provincial code (CSPC/BCLDB)? If yes, `id:`-prefix. If it's a store-internal
id, leave it `u:` unless it's already 6-digit.

### Same bottle, different CSPCs

Even legitimate CSPCs disagree across stores (Benromach 10YR = `837223` at
some AB stores, `074548` at others — different bottle sizes / re-registration).
That's why `data/sku_links.json` (manual) + `data/sku_links_auto.json` (auto)
exist. Don't expect 100% auto-linking; the manual link page handles the rest.

---

## 4. Step-by-step: adding a store

1. **Probe the platform.** `curl` the homepage / `/products.json` /
   `/wp-json/wc/store/v1/products` / look for `s.barnetnetwork.com`.
2. **Liveness check (do this early — it has killed two stores).**
   ```bash
   curl -s "https://{host}/products.json?limit=10" | python3 -c "
   import sys,json; d=json.load(sys.stdin)
   for p in d['products'][:10]: print(p.get('created_at','?')[:10], p['title'][:50])"
   ```
   Reject if the newest `created_at` is >6 months old, or if the in-stock
   ratio on the main collection is <5%. (See liquorlodge / cascadia in §8.)
3. **Enumerate categories — never trust the research/handle guess.**
   - Shopify: `curl /collections.json?limit=250` and grep for whisk/rum/gin/
     scotch/bourbon. Find the *umbrella* handle (often suffixed `-1`).
   - WooCommerce: `curl /wp-json/wp/v2/product_cat?per_page=100` (or
     `/wc/store/v1/products/categories`). **Verify the whisky umbrella
     actually contains scotch** (see §7).
   - Barnet: hit `category=SPIRITS&sub_category=` and inspect items'
     `category_name` / `sub_category`.
4. **Write `src/stores/{key}.js`** + add one line to `src/stores/index.js`.
5. **Smoke test:**
   ```bash
   node bin/tracker.js --stores={key} --maxPages 3 --debug 2>&1 | tail -20
   ```
6. **SKU quality gate** (must be ≥90% real, i.e. non-`u:`):
   ```bash
   grep -c '"sku":' data/db/{key}__*.json        # NOTE the space after the colon
   grep -c '"sku": "u:' data/db/{key}__*.json
   ```
7. **Website spot-check:** open 3 items in a browser; confirm name, price,
   in-stock match.
8. Cross-store linking is validated later in a full run, not per-store.

---

## 5. Verifying category completeness (the scotch trap)

This deserves its own section because it silently lost ~40% of whisky at four
stores. Many stores file **scotch as a sibling category, not under "whisky."**

Check overlap before trusting a single whisky category:

```bash
# WooCommerce example: is scotch inside the whisky umbrella?
python3 -c "
import urllib.request,json
H={'User-Agent':'Mozilla/5.0','Accept':'application/json'}
def skus(cat):
  s=set(); pg=1
  while True:
    u=f'https://{HOST}/wp-json/wc/store/v1/products?category={cat}&per_page=100&page={pg}'
    d=json.load(urllib.request.urlopen(urllib.request.Request(u,headers=H)))
    if not d: break
    s|={p['sku'] for p in d}; pg+=1
  return s
w=skus(WHISKY_ID); sc=skus(SCOTCH_ID)
print('scotch NOT in whisky:', len(sc-w))   # if >0, you MUST union them
"
```

If scotch is disjoint, **union the categories** rather than tracking them as
separate DB files:

- WooCommerce: pass a comma list to `categorySlug` (`"223,999"` or
  `"whisky,scotch"`). The API ORs and **dedups** server-side → one DB file, no
  double-counting.
- Bespoke: scan each slug and dedup into one `Map` (see liquorama unioning
  `["whisky","scotch","bourbon"]`).

Verify the union dedups (count should be < sum if there's overlap, = sum if
disjoint).

---

## 6. Execution order

The scheduler (`src/tracker/run_all.js`) builds its queue in
`createStores()` array order and workers pick the earliest available item.
**Put slow stores near the top** so they overlap the fast tail instead of
straggling. Current slowest: `wineandbeyond` (~9 min) and `gull` (12s/request
throttle) lead the list.

---

## 7. Gotchas (read this twice)

### Data-source / trust
- **Research files and report claims are hypotheses, not facts.** Every
  store here had at least one wrong claim (wrong platform, wrong handle,
  wrong SKU space). Always probe live.
- **The umbrella handle is rarely the obvious one.** clbspirits `whisky` is
  actually "Spanish Whisky" (5 items); the real umbrella is `whisky-1`
  (1293). Shopify suffixes `-1`/`-2` when a handle was reused.
- **Whisky categories often exclude scotch** (§5). Audited 4 WC/REST stores;
  3 needed a union (highlander, rmwsb, sherbrooke, liquorama).

### Shopify
- Probe `/collections.json?limit=250` for real handles + product counts.
- Multi-location stores replicate one catalog across stores; filter by
  `product.tags` (vinearts: keep "Calgary + Nationwide Shipping", drop
  "Edmonton"-only). Use `allowProduct`.
- "case sale only product" (and similar pack tags) price a full case, not a
  bottle — exclude via `allowProduct` (canadianliquor).
- The adapter drops OOS items (keeps `variant.available === true` only). If a
  store marks ~everything unavailable, it's likely abandoned (liquorlodge).
- Short numeric SKUs need the `id:` prefix (§3) — the adapter handles it.
- Some stores 500 at `limit=250` on certain collections (W&B gin); drop to
  `limit=150`.

### WooCommerce
- Send `Accept: application/json` (+ `Referer`); else you get Cloudflare HTML.
- `category` accepts comma-separated ids/slugs with OR + dedup — use for
  unions (§5).
- Filter `__trashed` records (`/\/__trashed/` in the permalink; they're
  numbered like `__trashed-12`) via `allowProduct` (sherbrooke).
- Term-id vs slug: some stores' permalinks/term-ids don't resolve cleanly;
  the WC API may accept the slug directly (sherbrooke `category=whisky`).
- `prices.price` is in **minor units** (`"4215"` = $42.15) — the adapter
  divides; bespoke code must too.
- **Stateful anti-pagination WAFs.** RMWSB serves page 1 of a query fine but
  returns a ~4-byte stub for page 2+ *when the query carries
  `stock_status=instock`* (`Short HTML bytes=4` in the logs). Delays don't
  help; it's query-shape-based, not rate-based. Fix: set
  `stockStatusFilter: null` so the param is dropped —
  `parseWooStoreProductsJson` already filters `is_in_stock` client-side, so
  correctness is unchanged. Symptom to watch: a category that fails every run
  while smaller categories on the same host succeed. Debug by logging the
  per-page byte count (`--debug` shows `Short HTML bytes=N`) and checking
  whether page 1 succeeds but page 2 fails. Always reproduce the EXACT failing
  request (same params, same page) in isolation — a one-off curl of "page 2"
  succeeds because the block is triggered by having just fetched page 1.

### Barnet
- **Dedupe by url before counting.** The API repeats items across pages
  (sort instability). A naive per-page tally over-counts and will fool you
  into thinking a server filter is undercounting. The deduped count is the
  truth.
- `sub_category` is case-sensitive and is the server-side filter. `WHISKEY`
  is usually the whisky umbrella (incl. scotch). Confirm its deduped count
  matches the deduped `category_name=WHISKEY` count; if equal, server-side
  filtering is complete (and far cheaper than scanning all SPIRITS).
- Items carry `category_name` (authoritative type) and sometimes empty
  `sub_category`; the `allowItem` client-filter mode exists for shops where
  `sub_category` genuinely can't partition.

### Bespoke
- **Wine & Beyond technique:** when the bulk JSON feed only covers part of
  the catalog and prices are $0 masters, use the storefront's faceted HTML
  filter. W&B's `?filter.p.m.display.available_at={locId}` returns only
  in-stock-at-that-location items with real prices; **repeating the facet key
  ORs locations**, so all location ids in one query = every in-stock bottle
  in one paginated pass. Discover location ids dynamically from the facet
  (`available_at=(\d+)`) so new stores are picked up automatically. Join the
  HTML prices to the catalog `products.json` by handle for SKU/title/image.
- **Marquis technique:** BigCommerce renders cards client-side, so the static
  HTML has no product anchors — but a TagRocket analytics array is inline:
  `{price:..,name:"..",sku:"..",productId:..}`. Regex it out. There's no URL
  in the blob; `search.php?search_query={sku}` is a stable resolvable URL.
  Pagination **404s past the last page** (not an empty 200) — catch and break.

### Tooling (these waste real time)
- `grep '"sku":'` needs the **space after the colon** — DB JSON is
  pretty-printed as `"sku": "..."`. `'"sku":"u:'` matches nothing.
- Inline `python3 -c "json.load(...)"` on a 250 KB DB can hang a terminal;
  prefer `grep -c`.
- Bash `for f in ...; do` loops occasionally hang the Bash *tool* (not the
  user's shell). Prefer a single `grep` across files, or run the loop in the
  user's own shell.
- `urllib` from Python often gets the Cloudflare challenge HTML; `curl` with
  a browser UA + `Accept: application/json` usually doesn't. For WC/Barnet
  always send the headers.

---

## 8. Rejected stores (do NOT re-attempt without new evidence)

- **West Coast Liquor** (`gulp.tech` SaaS) — SSR-only, no client API; bundles
  searched, all API paths 404, no Wayback captures. Unreachable.
- **liquorlodge** — abandoned online store: newest product Nov 2024, 99% of
  the catalog flagged unavailable. Tracking it = noise.
- **cascadia** — Shopify is a "featured items" front-end only (9 whisky / 6
  rum / 5 gin, newest Dec 2025). Real inventory lives in an in-store/kiosk
  system. Not worth integrating for ~20 items.

If any of these later expose a real API, re-probe before reviving.

---

## 9. Quick reference — the implemented new stores

| key | platform | region | notes |
|---|---|---|---|
| clbspirits, whiskydrop, lime, vinearts, canadianliquor, zyn | Shopify | AB | vinearts location-filtered; canadianliquor case-only-filtered |
| liquorwarehouse | Shopify | BC | short BCLDB SKUs (`id:` zero-pad) |
| wineandbeyond | bespoke (faceted HTML) | AB | per-location rollup via `available_at` OR-filter; SNDL `id:` SKUs |
| highlander, rmwsb, sherbrooke | WooCommerce | AB | whisky category unioned with scotch |
| liberty, colordevino | WooCommerce | BC/AB | liberty umbrella already covers scotch |
| highpointbws, newdistrict | Barnet | BC | `sub_category=WHISKEY` umbrella |
| liquorama | bespoke REST | AB | whisky = whisky+scotch+bourbon union |
| marquis | bespoke inline-JS | BC | non-BCLDB SKUs stay `u:`; manual links by name |
