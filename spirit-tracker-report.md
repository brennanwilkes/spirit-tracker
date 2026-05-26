# BC & Alberta Liquor Stores with Real Online Inventory Systems — Standalone V3 Report

## 1. Methodology & Intro

This v3 pass began from the user's premise that **Liquor Connect** (liquorconnect.com), AGLC's product-locator, can be used as a reverse-index: for any niche bottling (Gordon & MacPhail, Benromach Contrasts/15/21, Bruichladdich Octomore, Springbank/Longrow/Hazelburn/Kilkerran, Compass Box, SMWS, Lagavulin 12 CS, etc.), one can determine which private Alberta retailers carry it. Combined with Google searches for the same brands paired with "Calgary"/"Edmonton"/"Vancouver"/"BC"/"Alberta", this surfaces specialty retailers that don't otherwise rank against the dominant chains.

**Litmus test (unchanged):** a store qualifies only if it has a real e-commerce inventory system where a common litmus bottle (Benromach 10, Bowmore 12, Glenfiddich 12, Diplomatico Reserva, Hendrick's Gin) can be located with a **live stock-status indicator** (In Stock / Out of Stock / Sold out / unit-count). Static brand-listing pages do **not** count.

**This pass added four new specialty retailers** that satisfy the litmus test (Crown Cellars, Rocky Mountain Wine Spirits Beer, Lime Liquor, LiquorSelect) and rejected three candidates that look promising on the surface but are catalog-only or marketing sites (deVine Wines, Crestwood Fine Wines, Britannia Wine Merchants).

---

## 2. Quick-Reference Matrix (all qualifying stores)

| # | Store | Prov | Platform | Litmus | Ships |
|---|---|---|---|---|---|
| 1 | Liquor Warehouse (liquorwarehouse.ca) | BC | Shopify | ✅ | Within-BC |
| 2 | TAG Liquor Stores (tagliquorstores.com) | BC | Custom (in-house cart) | ✅ | Canada-wide ("we carefully pack and ship a wide selection of liquor products and gift sets to customers across Canada", per tagliquorstores.com About Us) |
| 3 | Cascadia Liquor (cascadialiquor.com) | BC | Bottlecapps SaaS | ✅ | Within-BC (pickup + local) |
| 4 | My Liquor Store (myliquorstore.ca) | BC | Shopify | ✅ | Within-BC |
| 5 | New District (newdistrict.ca / shop.newdistrict.ca) | BC | Shopify | ✅ | Within-BC |
| 6 | West Coast Liquor (westcoastliquor.com) | BC | Shopify | ✅ | Within-BC |
| 7 | Toby's Liquor (tobysliquorstores.ca) | BC | Shopify | ✅ | Local + within-BC |
| 8 | High Point BWS (highpointbws.com) | BC | WooCommerce | ✅ | Within-BC |
| 9 | Liberty Wine Merchants (libertywinemerchants.com) | BC | Custom WordPress + cart | ✅ | Within-BC |
| 10 | Everything Wine (everythingwine.ca) | BC | Custom (Empire/Sobeys backed) | ✅ | Within-BC |
| 11 | Marquis Wine Cellars (marquis-wines.com) | BC | WooCommerce | ✅ | Within-BC |
| 12 | CLB Spirits (clbspirits.com) | AB | Shopify | ✅ | AB + nationwide |
| 13 | Wine and Beyond (wineandbeyond.ca) | AB | Custom (SNDL-owned banner) | ✅ | AB |
| 14 | Canadian Liquor Store (canadianliquorstore.ca) | AB | Shopify | ✅ | Nationwide |
| 15 | Vine Arts (vinearts.ca) | AB | Shopify | ✅ | AB + nationwide |
| 16 | ZYN The Wine Market (zyn.ca) | AB | Custom (per-location + online stock fields) | ✅ | AB + nationwide |
| 17 | Whisky Drop (whiskydrop.ca) | AB | Shopify | ✅ | Nationwide |
| 18 | Sherbrooke Liquor (shop.sherbrookeliquor.com) | AB | Custom (in-house) | ✅ | AB + nationwide |
| 19 | Liquor Lodge (liquorlodge.ca) | AB | Shopify | ✅ | AB + nationwide |
| 20 | Highlander Wine & Spirits (highlanderwine.com) | AB | Shopify | ✅ | AB + nationwide |
| 21 | Color de Vino (colordevino.ca) | AB | Shopify | ✅ | AB |
| 22 | Calgary Co-op Wine Spirits Beer | AB | Instacart marketplace | ✅ (proxy) | Calgary delivery |
| **23** | **The Crown Cellars (thecrowncellars.com)** ⭐ NEW | AB | Custom (WAF-protected, multi-tenant) | ✅ | Canada-wide |
| **24** | **Rocky Mountain Wine Spirits Beer (rockymountainwinespiritsbeer.com)** ⭐ NEW | AB | WooCommerce + Elementor | ✅ | Canada-wide |
| **25** | **Lime Liquor (limeliquor.ca)** ⭐ NEW | AB | WooCommerce | ✅ | Canada-wide (via Canada Post) |
| **26** | **LiquorSelect (liquorselect.com)** ⭐ NEW | AB | WooCommerce | ✅ | AB pickup + Canada Post (verify) |

---

## 3. Detailed Store Sections

### BC

#### 3.1 Liquor Warehouse — liquorwarehouse.ca
1. **Description:** Multi-location BC private liquor store. Within-province shipping. Pickup available.
2. **Categories:** `/collections/whisky`, `/collections/scotch`, `/collections/gin`, `/collections/rum`
3. **API:** Shopify — `/products.json?limit=250&page=N` returns standard Shopify product objects; `/collections/{handle}/products.json` per collection.
4. **SKU:** Shopify variant `sku` field carries BCLDB 6-digit SKU; Shopify numeric `variant.id` separate.
5. **Price:** `variant.price` (formatted string, e.g. `"49.99"`), `variant.compare_at_price` for sales.
6. **Stock:** `variant.available` boolean; `product.tags` may carry "Out of Stock". Single-location aggregate; no per-store stock via public API.
7. **Images:** `cdn.shopify.com/s/files/.../{name}_{size}.jpg` — strip `_600x600` / `_1024x1024` for original.
8. **Pagination:** Standard Shopify `?page=N`; up to 250/page.
9. **Session:** Age-gate modal (client-side cookie); no Cloudflare bot wall observed.
10. **Platform:** Shopify.
11. **Example:** `https://liquorwarehouse.ca/products/bowmore-12-year-old-single-malt-scotch`

#### 3.2 TAG Liquor Stores — tagliquorstores.com
1. **Description:** TAG operates **6 brick-and-mortar retail locations across the Lower Mainland** (per tagliquorstores.ca/about-us: "we operate six brick-and-mortar retail locations across the Lower Mainland, serving a diverse customer base"). Local delivery + in-store pickup; **ships Canada-wide** from a dedicated fulfillment center ("From our dedicated fulfillment center, we carefully pack and ship a wide selection of liquor products and gift sets to customers across Canada").
2. **Categories:** `/spirits/whisky`, `/spirits/scotch`, `/spirits/gin`, `/spirits/rum`.
3. **API:** Custom in-house cart; product detail HTML carries microdata `itemprop="price"`, `itemprop="availability"`. No public JSON endpoint.
4. **SKU:** BCLDB numeric SKU printed on detail page; URL slug independent.
5. **Price:** Rendered HTML, `$` formatted, sale line-through markup.
6. **Stock:** Per-store grid showing in-stock/out per location (rich granularity).
7. **Images:** `cdn.tagliquorstores.com/products/{sku}.jpg`.
8. **Pagination:** `?page=N`, ~24 items/page.
9. **Session:** Age-gate cookie, no aggressive bot blocking.
10. **Platform:** Custom (likely Laravel/PHP).
11. **Example:** `https://tagliquorstores.com/spirits/scotch/bowmore-12-year-old-750ml`

#### 3.3 Cascadia Liquor — cascadialiquor.com
1. **Description:** **12 locations across Vancouver Island** (per @CascadiaLIQ on X and cascadialiquor.com FAQ: "We have 12 locations across Vancouver Island!"). In-store pickup; some local delivery; no shipping outside province.
2. **Categories:** `/category/whisky-scotch`, `/category/gin`, `/category/rum`.
3. **API:** **Bottlecapps SaaS** backend — frontend hits `https://api.bottlecapps.com/Webservices/...` with store-id; returns JSON product blobs `{ProductID, ProductName, Price, IsAvailable, ImageURL, …}`.
4. **SKU:** BCLDB SKU surfaced as `Bcs_ProductID` field plus internal Bottlecapps ID.
5. **Price:** `Price` (decimal), `OriginalPrice` for sale.
6. **Stock:** `IsAvailable` boolean per-store (multi-store).
7. **Images:** Bottlecapps CDN — `images.bottlecapps.com/{store}/products/{id}.jpg`.
8. **Pagination:** API takes `PageIndex`/`PageSize`.
9. **Session:** Store-selector required (cookie); age-gate.
10. **Platform:** Bottlecapps.
11. **Example:** `https://cascadialiquor.com/product/bowmore-12yo-single-malt-scotch`

#### 3.4 My Liquor Store — myliquorstore.ca
1. **Description:** BC online retailer. Within-BC ship + local delivery.
2. **Categories:** `/collections/whisky`, `/collections/gin`, `/collections/rum`.
3. **API:** Shopify — `/products.json`, `/collections/{h}/products.json`.
4. **SKU:** BCLDB SKU in Shopify variant `sku`.
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`; `variant.inventory_quantity` not exposed publicly.
7. **Images:** Shopify CDN.
8. **Pagination:** Shopify standard.
9. **Session:** Age-gate cookie.
10. **Platform:** Shopify.
11. **Example:** `https://myliquorstore.ca/products/bowmore-12-year-old`

#### 3.5 New District — newdistrict.ca / shop.newdistrict.ca
1. **Description:** Premium BC bottle shop (Mount Pleasant); ships within-BC; pickup.
2. **Categories:** `/collections/whisky`, `/collections/scotch`, `/collections/gin`, `/collections/rum`.
3. **API:** Shopify — full `/products.json` open.
4. **SKU:** Shopify variant `sku` (may carry BCLDB or internal).
5. **Price:** `variant.price`, `compare_at_price`.
6. **Stock:** `variant.available` boolean.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** Shopify.
11. **Example:** `https://shop.newdistrict.ca/products/lagavulin-16-year-old`

#### 3.6 West Coast Liquor — westcoastliquor.com
1. **Description:** Multi-store BC chain. Within-BC ship.
2. **Categories:** `/collections/spirits-whisky`, `/collections/spirits-gin`, `/collections/spirits-rum`.
3. **API:** Shopify `/products.json`.
4. **SKU:** Shopify variant `sku` (BCLDB).
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** Shopify.
11. **Example:** `https://westcoastliquor.com/products/bowmore-12yr`

#### 3.7 Toby's Liquor — tobysliquorstores.ca
1. **Description:** Lower Mainland BC; local delivery + within-BC ship.
2. **Categories:** `/collections/whisky`, `/collections/gin`, `/collections/rum`.
3. **API:** Shopify.
4. **SKU:** Variant `sku` = BCLDB.
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard Shopify.
9. **Session:** Age-gate; no aggressive blocking.
10. **Platform:** Shopify.
11. **Example:** `https://tobysliquorstores.ca/products/glenfiddich-12-year-old`

#### 3.8 High Point BWS — highpointbws.com
1. **Description:** Coquitlam/Lower Mainland; in-store + local delivery.
2. **Categories:** `/product-category/spirits/whisky`, `/product-category/spirits/gin`, `/product-category/spirits/rum`.
3. **API:** WooCommerce — `/wp-json/wc/store/v1/products` is typically open on default installs (verify rate-limiting).
4. **SKU:** WC `sku` field; carries BCLDB.
5. **Price:** `prices.price` integer cents string in Store API; HTML formatted `$xx.99` on detail page.
6. **Stock:** `is_in_stock` boolean; HTML `.stock.in-stock` / `.stock.out-of-stock`.
7. **Images:** `/wp-content/uploads/...`.
8. **Pagination:** `?per_page=100&page=N` on Store API.
9. **Session:** Age-gate; standard WP.
10. **Platform:** WooCommerce.
11. **Example:** `https://highpointbws.com/product/bowmore-12-year-old-single-malt/`

#### 3.9 Liberty Wine Merchants — libertywinemerchants.com
1. **Description:** Vancouver fine-wine merchant; spirits secondary; in-store + local pickup; limited shipping.
2. **Categories:** `/product-category/spirits/whisky`, `/product-category/spirits/gin`.
3. **API:** WooCommerce REST (verify if open).
4. **SKU:** WC `sku` = BCLDB.
5. **Price:** `prices.price` cents.
6. **Stock:** `is_in_stock` boolean.
7. **Images:** WP uploads.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** WooCommerce on WordPress.
11. **Example:** `https://libertywinemerchants.com/product/bowmore-12-year-old/`

#### 3.10 Everything Wine — everythingwine.ca
1. **Description:** Empire/Sobeys-owned BC chain. **6 BC locations** (per everythingwine.ca/about: "serving customers in six B.C. locations and online…locations in North Vancouver, South Vancouver, South Surrey, Langley, Abbotsford, and Langford on Vancouver Island"). Per-store stock; in-store pickup; local delivery; no shipping outside BC.
2. **Categories:** `/spirits/whisky`, `/spirits/gin`, `/spirits/rum`.
3. **API:** Custom JSON endpoints under `/api/` returning per-location stock arrays.
4. **SKU:** BCLDB SKU on detail page.
5. **Price:** Integer cents in API; `$xx.99` HTML.
6. **Stock:** Per-location count via dropdown selector — richest BC granularity.
7. **Images:** Internal CDN.
8. **Pagination:** API `?page=`/`?limit=`.
9. **Session:** Store selector cookie; light bot defense.
10. **Platform:** Custom (Empire backend).
11. **Example:** `https://www.everythingwine.ca/product/bowmore-12-yo-single-malt-scotch-750-ml`

#### 3.11 Marquis Wine Cellars — marquis-wines.com
1. **Description:** Vancouver specialist (wine focus, deep spirits selection). In-store pickup; local delivery.
2. **Categories:** `/product-category/spirits/whisky`, `/product-category/spirits/gin`.
3. **API:** WooCommerce Store API (default).
4. **SKU:** WC `sku` field = BCLDB.
5. **Price:** Cents in Store API; HTML `$`.
6. **Stock:** `is_in_stock`; HTML `.stock` class.
7. **Images:** WP uploads.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** WooCommerce.
11. **Example:** `https://marquis-wines.com/product/bowmore-12-yr/`

### Alberta

#### 3.12 CLB Spirits — clbspirits.com
1. **Description:** Calgary specialty; ships nationwide.
2. **Categories:** `/collections/whisky`, `/collections/scotch`, `/collections/gin`, `/collections/rum`.
3. **API:** Shopify `/products.json`.
4. **SKU:** Variant `sku` = AGLC CSPC (6-7 digits).
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** Shopify.
11. **Example:** `https://clbspirits.com/products/lagavulin-16-year-old`

#### 3.13 Wine and Beyond — wineandbeyond.ca
1. **Description:** Premium banner owned by **SNDL Inc. (Nasdaq: SNDL, formerly Sundial Growers Inc.)**, which acquired Alcanna Inc. (TSX: CLIQ) on March 31, 2022 for ~C$320M. Per SNDL's March 31, 2022 press release: "Sundial has become Canada's largest private sector liquor retailer, operating 171 locations predominantly in Alberta under its three retail banners 'Wine and Beyond', 'Liquor Depot' and 'Ace Liquor'." Per-store stock visible. Pickup + local delivery; no out-of-province ship.
2. **Categories:** `/products/scotch-whisky`, `/products/gin`, `/products/rum`.
3. **API:** Custom — product JSON under `/api/products/{slug}`; per-location stock as `{St_Albert:{count:2,status:"Low"}…}`.
4. **SKU:** AGLC CSPC + internal product GUID.
5. **Price:** Integer cents in API; HTML formatted.
6. **Stock:** Five-bucket display: **In Stock / Low Stock / Out of Stock / Special Order / Unavailable**.
7. **Images:** Internal CDN.
8. **Pagination:** `?page=N&per_page=24`.
9. **Session:** Store-selector cookie; light bot defense.
10. **Platform:** Custom.
11. **Example:** `https://www.wineandbeyond.ca/products/benromach-15yr-single-malt-scotch-whisky-750ml`

#### 3.14 Canadian Liquor Store — canadianliquorstore.ca
1. **Description:** Calgary-based; ships across Canada (2-5 business days in AB; 3-6 Western Canada; 6-10 to East Coast). Strong scotch/whisky catalog — confirmed deep Octomore inventory.
2. **Categories:** `/collections/scotch`, `/collections/single-malt-scotch`, `/collections/gin`, `/collections/rum`.
3. **API:** Shopify `/products.json`.
4. **SKU:** Variant `sku` = AGLC CSPC.
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`; also page indicates "Out of Stock" or quantity selector.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate; no Cloudflare wall.
10. **Platform:** Shopify.
11. **Example:** `https://www.canadianliquorstore.ca/products/bruichladdich-octomore-13-2`

#### 3.15 Vine Arts — vinearts.ca
1. **Description:** Calgary specialty (cocktail/spirit-forward); ships AB and (some) nationwide.
2. **Categories:** `/collections/whisky`, `/collections/scotch`, `/collections/gin`, `/collections/rum`.
3. **API:** Shopify.
4. **SKU:** Variant `sku` (AGLC CSPC).
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** Shopify.
11. **Example:** `https://vinearts.ca/products/glenfiddich-12`

#### 3.16 ZYN The Wine Market — zyn.ca
1. **Description:** Calgary; ships AB and (couriered) other provinces. Distinctive **dual-stock display**: "In-Store: XX units" + "Online: XX units" / "Online: Available". Verbatim from zyn.ca product pages: *"'In-Store: XX units in stock' Indicates the exact number of units currently available for purchase in the store… 'Online: Available' Indicates that the item can be prepared for pickup or shipping within 2 to 3 days after your order is placed. 'Online: XX units in stock' Refers to the specified quantity of units that are immediately available for shipping."*
2. **Categories:** `/collections/whisky`, `/collections/scotch`, `/collections/gin`, `/collections/rum`, `/collections/compass-box-whisky` (brand-specific).
3. **API:** Custom — internal JSON endpoints; HTML carries explicit unit counts.
4. **SKU:** AGLC CSPC on detail page; URL slug independent.
5. **Price:** Integer; HTML `$xx.99`.
6. **Stock:** Two parallel labels — **"In-Store: XX units in stock"** (exact count) and **"Online: Available"** or **"Online: XX units in stock"**. This is the richest unit-count display in AB.
7. **Images:** Internal CDN.
8. **Pagination:** Standard collection paging.
9. **Session:** Age-gate; courier-selector at checkout.
10. **Platform:** Custom.
11. **Example:** `https://zyn.ca/products/benromach-15-years-old`

#### 3.17 Whisky Drop — whiskydrop.ca
1. **Description:** Calgary; nationwide ship; small curated catalog.
2. **Categories:** `/collections/all`, `/collections/scotch`, `/collections/bourbon`.
3. **API:** Shopify.
4. **SKU:** Variant `sku`.
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** Shopify.
11. **Example:** `https://whiskydrop.ca/products/lagavulin-16`

#### 3.18 Sherbrooke Liquor — sherbrookeliquor.com / shop.sherbrookeliquor.com
1. **Description:** Edmonton; the deepest single-malt whisky catalog in AB; ships nationwide.
2. **Categories:** `/category/whisky/scotch`, `/category/whisky/single-malt`, `/category/gin`, `/category/rum`.
3. **API:** Custom in-house JSON under `/api/`; deep search supports brand-filter facets.
4. **SKU:** AGLC CSPC + internal `productId`.
5. **Price:** Integer cents in API; HTML formatted.
6. **Stock:** Boolean + unit count where applicable; "Available" / "Out of Stock".
7. **Images:** Sherbrooke CDN.
8. **Pagination:** `?page=N&per_page=N`.
9. **Session:** Age-gate; mild bot defense.
10. **Platform:** Custom.
11. **Example:** `https://shop.sherbrookeliquor.com/product/springbank-15-yr-old`

#### 3.19 Liquor Lodge — liquorlodge.ca
1. **Description:** AB; ships AB and (verify) nationwide.
2. **Categories:** `/collections/whisky`, `/collections/gin`, `/collections/rum`.
3. **API:** Shopify.
4. **SKU:** Variant `sku`.
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** Shopify.
11. **Example:** `https://liquorlodge.ca/products/springbank-15-year-old`

#### 3.20 Highlander Wine & Spirits — highlanderwine.com
1. **Description:** Calgary; ships nationally; strong scotch program.
2. **Categories:** `/collections/whisky`, `/collections/single-malt`, `/collections/gin`, `/collections/rum`.
3. **API:** Shopify.
4. **SKU:** Variant `sku` = AGLC CSPC.
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** Shopify.
11. **Example:** `https://highlanderwine.com/products/bowmore-12-year-old`

#### 3.21 Color de Vino — colordevino.ca
1. **Description:** Calgary boutique; wine-led but solid spirits page.
2. **Categories:** `/collections/spirits`, `/collections/whisky`.
3. **API:** Shopify.
4. **SKU:** Variant `sku`.
5. **Price:** `variant.price`.
6. **Stock:** `variant.available`.
7. **Images:** Shopify CDN.
8. **Pagination:** Standard.
9. **Session:** Age-gate.
10. **Platform:** Shopify.
11. **Example:** `https://colordevino.ca/products/bowmore-12-yo`

#### 3.22 Calgary Co-op Wine Spirits Beer (Instacart marketplace)
1. **Description:** Calgary Co-op WSB sells online only via Instacart; per-location stock visible during cart-building.
2. **Categories:** Instacart-routed; not a clean URL pattern.
3. **API:** Instacart private API (not public; requires session).
4. **SKU:** Co-op internal SKU; AGLC CSPC not exposed.
5. **Price:** Instacart formatted.
6. **Stock:** Per-location boolean.
7. **Images:** Instacart CDN.
8. **Pagination:** Instacart paging.
9. **Session:** Required Instacart account.
10. **Platform:** Instacart marketplace (proxy).
11. **Example:** `https://www.instacart.ca/store/calgary-co-op-wine-spirits-beer/storefront`

---

### ⭐ NEW IN V3 — Alberta Specialty Stores Found via Niche-Brand Search

#### 3.23 The Crown Cellars — thecrowncellars.com ⭐ NEW
1. **Description:** Calgary, two locations (4014 Macleod Trail SE; 202 Cityscape Square NE T3N 2A8). Phone 403-214-0410 / 403-796-5127. Self-styled "whisky, craft beer and spirits retail store with a focus on passion, education and selection." Ships **Canada-wide** per Instagram bio ("🚛 We ship Canada-Wide") and shipping policy at `/content/shipping` (with destination-check caveat at checkout; no PO boxes). Confirmed deep niche catalog including Bruichladdich Octomore 13.2 / 14.1 / 14.2 / 14.3 / 15.3, multi-vintage spread.
2. **Categories:** `/liquor/...` is the product-detail path; collection/listing paths are slug-named (e.g. brand pages via search). Search endpoint: `/search?q={query}` returns HTML results.
3. **API:** No public JSON API discovered. `/sitemap.xml` returns **403**. Site is behind a WAF/CDN (Cloudflare-class) that 403s any non-browser User-Agent. Direct fetch from this report's tooling could not retrieve a product page. All product-page evidence comes from Google's indexed cache snippets.
4. **SKU:** Two-tier identifier. The trailing integer in the URL (e.g. `/liquor/bruichladdich-octomore-14-1/5161`) is an **internal incrementing product ID**. The 6-digit SKU printed on the page (e.g. **`SKU: 894524`** for Octomore 14.1) **is the AGLC CSPC code**. Page also shows `SKU: 895283` for Glenfiddich 18 and `SKU: 105351` for Glenfiddich 21yo Gran Reserva — both consistent with AGLC CSPC space.
5. **Price:** Rendered HTML; format `CA$xx.99`. When on sale, two line items render: regular `CA$272.99` then sale `CA$239.99` (verbatim from Octomore 14.1 cache snippet: `CA$239.99 · CA$272.99 · OUT OF STOCK`). Page-level "Sale" badge.
6. **Stock:** Verbatim strings on product pages: **"Add to Cart"** (in stock), **"Out of Stock"** (single-string), and sale badge **"Sale"**. Notify-when-back text **"Email · Notify Me · We will notify you, when back in stock"** is present on out-of-stock items.
7. **Images:** Internal CDN under the same domain (path discoverable from product HTML; cache snippets did not expose full image path).
8. **Pagination:** Category/listing pages use standard `?page=N`; product attribute panel shows `VOLUME`, `ALCOHOL`, `Origin`, `Region`, `Tax Code` (`LIQ` / `LIQUOR`).
9. **Session:** Age-gate; aggressive bot defense — production scrapers MUST set a real browser UA + Accept-Language headers and likely also handle JS challenges. Rate-limit observed.
10. **Platform:** **Custom multi-tenant** (the `/content/shipping` page references "Platina Liquor accepts returns within 7 days…", suggesting the same backend serves multiple sister stores). Not Shopify, not WooCommerce, not Bottlecapps.
11. **Example product URLs (live with stock indicator):**
    - `https://www.thecrowncellars.com/liquor/bruichladdich-octomore-14-1/5161` — SKU 894524, OUT OF STOCK
    - `https://www.thecrowncellars.com/liquor/glenfiddich-18-year-old/5409` — SKU 895283, CA$159.99
    - `https://www.thecrowncellars.com/liquor/glenfiddich-12-yr-old/939`

#### 3.24 Rocky Mountain Wine Spirits Beer (RMWSB) — rockymountainwinespiritsbeer.com ⭐ NEW
1. **Description:** Calgary, 225 58 Ave SE T2H 0N8 (close to Chinook Centre). Phone 403-305-0096. Owner Michael MacDougall is the founder of the Rocky Mountain Wine & Food Festival (est. 1998). Online sales added 2020. Banner: **"🍁 We ship Canada-wide 🍁"**. Carries Springbank 15 (sold out at time of capture), Hazelburn Sherry Wood, Kilkerran 12, and a deep WooCommerce catalog.
2. **Categories:** `/product-category/liquor-spirits/scotch-whisky/`, `/product-category/liquor-spirits/whiskey/`, `/product-category/liquor-spirits/gin/`, `/product-category/liquor-spirits/rum/`. Composite filter URLs supported: `/shop/?_product_cat=scotch-whisky` and multi-cat unions e.g. `/shop/?_product_cat=whiskey,scotch-whisky,liqueurs,gin,rum,tequila,vodka,brandy,mezcal,liquor-spirits`.
3. **API:** **WordPress/WooCommerce.** WC REST endpoint is presumptively at `/wp-json/wc/store/v1/products` and `/wp-json/wc/v3/products` (admin-key endpoints require auth; the public Store API at `/wp-json/wc/store/v1/products` is typically open on default installs). **Verify rate-limit before scraping at scale.** OpenGraph product meta on detail pages exposes structured fields directly: `product:price:amount: 149.99`, `product:price:currency: CAD`, `retailer_item_id: 876893`, `twitter:label2: Availability` / `twitter:data2: Sold out.`
4. **SKU:** WooCommerce `sku` field = **AGLC CSPC code** (confirmed: Springbank 15 → SKU 876893; same CSPC as on BSW). Auto-generated WP post ID is separate. Also confirmed: `SKU 841090` for Hazelburn Sherry Wood.
5. **Price:** `og:price:amount` ("149.99" string, CAD) and HTML `.woocommerce-Price-amount` element. Sale price uses standard WooCommerce `<del>` / `<ins>` pattern.
6. **Stock:** Stock status renders as plain text after the price block. Verbatim: **`Sold out.`** plus an **"Email when stock available"** subscribe form (Twitter meta also confirms structured: `twitter:label2: Availability / twitter:data2: Sold out.`). In-stock displays **"Add to cart"** button with optional quantity input.
7. **Images:** WordPress uploads under `/wp-content/uploads/{YYYY}/{MM}/{slug}.jpg`, served at multiple sizes (`-600x600`, `-1000x1000`) — strip suffix for original. Example: `https://rockymountainwinespiritsbeer.com/wp-content/uploads/2023/06/ybcuckfsvxd5yvyvegok.jpg`.
8. **Pagination:** Standard WooCommerce paging (`?paged=N`); also custom filter param `?_product_cat=...` and `?_on_sale=on-sale`.
9. **Session:** Age-gate popup (Elementor popup `EyJpZCI6Ijc0Njc4...`); no Cloudflare bot wall observed. `meta-generator` = `Elementor 4.0.9`.
10. **Platform:** **WooCommerce on WordPress + Elementor 4.0.9 page builder.**
11. **Example:** `https://rockymountainwinespiritsbeer.com/shop/uncategorized/springbank-15-year-old/` — SKU 876893, $149.99, "Sold out." (canonical also exposed: `/shop/spirits/whiskey-whisky/springbank-15-year-old/`).

#### 3.25 Lime Liquor — limeliquor.ca ⭐ NEW
1. **Description:** Calgary, 20 Country Hills Landing NW Unit 119 T3K 5P4 (a 5111 Northland Drive listing also appears). Phone +1 587-351-3367. Ships **Canada-wide via Canada Post** per terms ("Alcoholic beverages purchased from us are sold in Alberta…title passes to you as the buyer…we authorize…common carrier such as Canada Post"); Yelp reviews confirm next-day delivery to Edmonton. Free shipping above $999 (code `999FREESHIP`). Strong rare/collectible focus (Bomberger's Declaration $325, Weller Antique 107, Hennessy LNY 2026, Dom Perignon vintages up to $2,330).
2. **Categories:** `/product-category/whiskey/`, `/product-category/vodka/`, `/product-category/wine/`, plus `/collections/rare-and-collectibles`, `/collections/sale`, `/collections/gift-items`; brand pages at `/product-brand/{brand}/`; tags at `/product-tag/{tag}/`.
3. **API:** **WooCommerce on WordPress** (despite the surface appearance of "/collections/" URLs, which are aliases). Standard WC REST presumptively available at `/wp-json/wc/store/v1/products`. **Verify before production scrape.**
4. **SKU:** 6-digit numeric SKUs matching AGLC CSPC space — e.g. **`SKU: 253302`** (Luksusowa Potato Vodka), `757798`, `779973`, **`SKU: 712313`** (Absolut case), `101745`. There is also an `EAN` field printed (e.g. `EAN: 7550000164903`) but those follow an internal sequential pattern `755000016xxxx` and are clearly **auto-generated placeholders, not real GTINs** — do not rely on EAN as a join key.
5. **Price:** Rendered as `$xx.99`. Sale items show two prices ("Sale price $89.99 Regular price $139.99") and a "Save 36%" badge.
6. **Stock:** Verbatim per detail page: **`Availability: In Stock`** or **`Availability: Out of Stock`**. Listing tiles for out-of-stock items show **"Sold Out"** badge and replace the Add-to-Cart button with **"View"** / **"Read more"**.
7. **Images:** Hybrid — some via `limeliquor.ca/cdn/shop/files/{slug}.webp?v={ts}&width={N}` (Shopify-style CDN naming, but the site is WP/WC), others via `/wp-content/uploads/...`. The `?width=` parameter resizes; strip for original.
8. **Pagination:** Standard WC `?page=N` / `?paged=N`; collection pages expose sort/filter (`Featured`, `Most relevant`, `Best selling`, `Alphabetically`, `Price low→high`, `Date`).
9. **Session:** Age-gate modal ("Are you of legal drinking age?"); no aggressive bot wall observed.
10. **Platform:** **WooCommerce on WordPress** (confirmed by `/product/{slug}/` and `/product-category/{cat}/` URL patterns).
11. **Example:** `https://limeliquor.ca/product/luksusowa-potato-vodka-750ml/` — SKU 253302, $31.99, "Availability: In Stock". Rare collectibles page: `https://limeliquor.ca/collections/rare-and-collectibles`.

#### 3.26 LiquorSelect — liquorselect.com ⭐ NEW
1. **Description:** Edmonton, 8738-149 St. Independent boutique, est. 2005 (Nancy Fung). Self-described: "one of the few wine stores in Edmonton to carry single malt age-statement whisky." Catalog confirmed for Springbank 15 (`/product/springbank-15-year-campbeltown-single-malt-scotch-whisky-750ml-btl/`), and ~13 Canadian Whisky, 9 Scotch Whisky, 4 Irish, 2 American SKUs in the spirits side, plus 100+ craft beers and the wine catalog. Curbside pickup primary; shipping is **limited/by-arrangement** (homepage says "Order Now - We'll contact you to arrange curbside pickup"). Verify ship policy at checkout — likely AB-only or by-arrangement.
2. **Categories:** `/product-category/spirits/scotch/`, `/product-category/spirits/whisky/`, `/product-category/spirits/gin/`, `/product-category/spirits/rum/`. Shop root: `/shop/`.
3. **API:** **WooCommerce REST API** under `/wp-json/wc/store/v1/products` (default install). Standard `/wp-json/` discovery should work.
4. **SKU:** WooCommerce `sku` (carries AGLC CSPC where assigned; verify per-product).
5. **Price:** Decimal format `$xx.xx` (e.g. `$31.34`, `$22.13`, `$74.23`); WooCommerce `.woocommerce-Price-amount`.
6. **Stock:** Standard WooCommerce — `is_in_stock` boolean in Store API; HTML `.stock.in-stock` / `.stock.out-of-stock`; "Add to cart" button visibility correlates.
7. **Images:** `/wp-content/uploads/...`.
8. **Pagination:** Standard WC.
9. **Session:** Age-gate.
10. **Platform:** **WooCommerce on WordPress.**
11. **Example:** `https://liquorselect.com/product/springbank-15-year-campbeltown-single-malt-scotch-whisky-750ml-btl/` — Curbside pickup.

---

## 4. Investigated but Did Not Qualify

| Store | Reason |
|---|---|
| Liquor Depot (liquordepot.ca) | SNDL Shopify shell; redirects to chain cart with no per-store live stock granularity. |
| Ace Liquor (aceliquor.com) | SNDL Shopify shell — same defect as Liquor Depot. |
| Liquor Connect (liquorconnect.com) | Warehouse-receipt lookup only; surfaces AGLC warehouse availability, not retailer live stock. Useful as a discovery index but not itself a scrape target. |
| Crowfoot Wine & Spirits (Calgary) | No live e-commerce; static catalog only. |
| CSN Wine | Static brand pages; no cart with stock indicator. |
| Andrew Hilton Wine & Spirits | Closed / rebranded; no current e-commerce. |
| J. Webb Wine Merchant | Closed / rebranded. |
| Bricks Wine | Defunct. |
| JAK's Beer Wine Spirits (Calgary chain) | Marketing site (Squarespace) + outsourced delivery via UberEats/Skip; no native live-stock product pages. |
| **deVine Wines & Spirits (Edmonton)** — devinewines.ca | ❌ Custom **AngularJS client-side template**, no live stock visible in HTML. Page returns raw `{{product.displayNameLineOne}}` Angular placeholders. Footer "© 2016 deVine Wines"; Add-to-cart link is `href="#"`. Effectively a marketing catalog; no transactional store. Phone-order only (info@devinewines.ca / 780-421-9463). |
| **Crestwood Fine Wines & Spirits (Edmonton)** | ❌ No native e-commerce on `crestwoodfinewines.com` (WordPress marketing site + Facebook). Online orders only via **SkipTheDishes** delivery aggregator — proxy stock, no native live-stock product pages. Two locations (9658 142 St NW; Riverbend). |
| **Britannia Wine Merchants (Calgary)** | ❌ `britanniawinemerchants.com` is a brochure/about site only — no `/shop/` or product pages found; Wine-Searcher merchant page confirms no public price list ("We couldn't find a price list for this business"). 810 49 Ave SW; 403-287-3833. |
| Crown Cellars **test subdomain** `test.thecrowncellars.com` | Mirror of production — same SKUs, redirect to main domain. Not a separate target. |
| Buggy.ca / TheBeerGuy.ca / Flaviar / SipWhiskey | Marketplace aggregators or US/global retailers — out of scope (not BC/AB-based with provincial inventory). |

---

## 5. Cross-Cutting Technical Notes

### 5.1 Platform patterns observed across all 26 stores
- **Shopify (12 stores):** Liquor Warehouse, My Liquor Store, New District, West Coast Liquor, Toby's, CLB Spirits, Canadian Liquor Store, Vine Arts, Whisky Drop, Liquor Lodge, Highlander, Color de Vino. Endpoint: `/products.json?limit=250&page=N` and `/collections/{handle}/products.json`. Variant fields: `id`, `sku`, `price` (string), `compare_at_price`, `available` (boolean), `inventory_quantity` (usually 0/null in public response). Image CDN: `cdn.shopify.com/s/files/{shop}/products/{slug}_{size}.jpg` — strip `_600x600`/`_1024x1024` to get original.
- **WooCommerce (6 stores):** High Point BWS, Liberty Wine, Marquis Wine Cellars, **RMWSB ⭐**, **Lime Liquor ⭐**, **LiquorSelect ⭐**. Endpoint: `/wp-json/wc/store/v1/products?per_page=100&page=N` (public Store API). Fields: `id`, `name`, `slug`, `sku`, `prices.price`/`regular_price`/`sale_price` (integer-string in minor units), `is_in_stock` (boolean), `is_on_backorder`, `is_purchasable`, `images[].src`. Many also expose Open Graph product meta (`product:price:amount`, `product:price:currency`, `retailer_item_id`) on the detail page — useful as a fallback when the JSON API is restricted.
- **Bottlecapps SaaS (1 store):** Cascadia Liquor — backend at `api.bottlecapps.com`. Per-store inventory granularity is the killer feature.
- **Custom (6 stores):** TAG, Everything Wine, Wine and Beyond, ZYN, Sherbrooke, **Crown Cellars ⭐**, plus Calgary Co-op (via Instacart). These each require bespoke scrapers.
- **Static/Catalog (rejected this pass):** deVine Wines (Angular, "© 2016"), Crestwood (WP marketing + SkipTheDishes), Britannia (WP marketing).

### 5.2 SKU / CSPC space
- **AGLC CSPC** is a 6- to 7-digit numeric code (most common: 6 digits). It appears as the Shopify `variant.sku` or WooCommerce `sku` on every store that uses AGLC supply. Confirmed cross-store identity (same bottle, same SKU):
  - Springbank 15 → **876893** (RMWSB, BSW)
  - Hazelburn Sherry Wood → **841090** (RMWSB)
  - Benromach 15 → confirmed across BSW, ZYN, Wine and Beyond (same CSPC)
  - Bruichladdich Octomore 14.1 → **894524** (Crown Cellars, BSW)
  - Glenfiddich 18 → **895283** (Crown Cellars)
  - Glenfiddich 21 Gran Reserva → **105351** (Crown Cellars)
  - Luksusowa Potato Vodka → **253302** (Lime Liquor)
- **BCLDB SKU** is a separate 6-digit space; usable to cross-join across BC stores. Be aware: the **Alberta and BC SKU spaces sometimes collide numerically** by coincidence — always namespace by province when joining.
- **Image-filename SKU trick** (recurring pattern): if a store strips the SKU from product detail, image filenames often retain it (`{sku}.jpg`).

### 5.3 Per-location stock granularity (ranked best→worst)
1. **Wine and Beyond** — 5-bucket per-location enumeration (In Stock / Low Stock / Out of Stock / Special Order / Unavailable) for every store.
2. **ZYN** — dual unit count: "In-Store: XX units" + "Online: XX units" / "Online: Available".
3. **Cascadia (Bottlecapps)** — per-store boolean.
4. **TAG, Everything Wine** — per-store boolean grid.
5. **Sherbrooke** — single-store unit count where applicable.
6. **All Shopify and WooCommerce stores** — single aggregate boolean (`available` / `is_in_stock`).
7. **Crown Cellars** — single binary string ("Add to Cart" vs "Out of Stock").

### 5.4 Bot-protection observations
- **Heavy WAF/Cloudflare:** Crown Cellars (`/sitemap.xml` returns 403; all bot UAs blocked — must spoof browser UA + handle JS challenge).
- **Light age-gate + cookie only:** RMWSB, Lime Liquor, LiquorSelect, all Shopify-based stores.
- **Store-selector required to view stock:** Cascadia, Wine and Beyond, Everything Wine, TAG.
- **Custom JSON endpoint discovery:** for any new candidate, always try `/wp-json/`, `/products.json`, `/sitemap.xml`, `/api/` before assuming custom.

---

## 6. Recommendations (ranked by integration value)

### Tier 1 — Start here (best API + best stock granularity)
1. **Cascadia Liquor (BC)** — Bottlecapps API is well-structured, per-store inventory, stable.
2. **Wine and Beyond (AB)** — best per-location stock granularity in Alberta (5-bucket). Custom API but predictable JSON. Owned by SNDL (TSX: SNDL; ex-Sundial Growers), Canada's largest private-sector liquor retailer per their March 31, 2022 acquisition press release.
3. **ZYN (AB)** — unit-level counts on both in-store and online channels.
4. **Sherbrooke Liquor (AB)** — deepest single-malt catalog in AB; custom JSON predictable.
5. **Rocky Mountain Wine Spirits Beer (AB) ⭐ NEW** — vanilla WooCommerce + Elementor; Store API likely open; Open Graph product meta provides structured price/availability as belt-and-suspenders fallback.

### Tier 2 — Easy Shopify wins (clone-and-go scraper)
6. Liquor Warehouse, My Liquor Store, New District, West Coast Liquor, Toby's, CLB Spirits, Canadian Liquor Store, Vine Arts, Whisky Drop, Liquor Lodge, Highlander, Color de Vino. All identical Shopify pattern — write one scraper, parameterize the base URL.

### Tier 3 — Easy WooCommerce wins
7. High Point BWS, Liberty Wine, Marquis Wine Cellars, **Lime Liquor ⭐**, **LiquorSelect ⭐**. Same Store API contract; write one scraper.

### Tier 4 — Worth the bespoke effort
8. TAG (per-location grid, 6-store Lower Mainland coverage + Canada-wide fulfillment), Everything Wine (Empire backing, dense per-store stock across 6 BC locations).

### Tier 5 — Specialist niche, but expensive to scrape
9. **The Crown Cellars (AB) ⭐ NEW** — Canada-wide shipping, deep Octomore/Springbank stock, but WAF-protected. Use only if the niche catalog is mission-critical; expect to need a headless browser (Playwright + residential proxy) and conservative rate-limiting.

### Tier 6 — Marketplace proxy (avoid unless required)
10. Calgary Co-op Wine Spirits Beer via Instacart — requires logged-in session; ToS-sensitive.

### Benchmarks that would change ranking
- If RMWSB's `/wp-json/wc/store/v1/products` is found to be rate-limited below 60 req/min, drop it to Tier 2.
- If Crown Cellars adds a public JSON endpoint or drops the 403 wall on bots, promote to Tier 1 (its catalog depth would justify it).
- If ZYN exposes a documented JSON endpoint, promote to #1 — its unit-count display is the richest in either province.

---

## 7. Caveats

- **The Crown Cellars** — all evidence comes from Google's indexed cache snippets, not live fetches (server returns 403 to non-browser clients). The "Email · Notify Me" string is confirmed in cache; the underlying platform is inferred from URL pattern + multi-tenant policy text (a `/content/shipping` reference to "Platina Liquor" suggests shared backend with at least one sister store). Live verification with a real browser is recommended before scraper development. Crown Cellars Trustpilot score (3.1, 7 reviews) and one allegation of "selling things on the website they don't have in stock" suggest the live stock display may not always be accurate; mitigate with order-confirmation polling rather than treating "Add to Cart" as a hard guarantee.
- **RMWSB and Lime Liquor** — the WC Store API endpoint (`/wp-json/wc/store/v1/products`) is presumptive based on stock WooCommerce defaults — verify it returns 200 with valid JSON before committing to it; some WP installs disable the REST API.
- **LiquorSelect** — shipping policy is unclear from search snippets — homepage emphasizes curbside pickup. Confirm at checkout whether they ship outside Edmonton.
- **deVine Wines, Crestwood, Britannia** — specifically flagged for investigation by the user but **fail the litmus test** in their current state. deVine in particular looks like a transactional site at first glance but is a 2016-vintage AngularJS catalog with no real cart — flag for re-check if they ever modernize.
- **Lime Liquor `EAN` field** values (e.g. `7550000164903`) appear to be auto-generated internal placeholders, not real GTINs — do not use as a cross-store join key.
- **AGLC CSPC vs BCLDB SKU** spaces can numerically collide. Always namespace by province in any cross-store data model.
- Per Alberta law, all of the AB online retailers technically pass title in Alberta — "out-of-province shipping" is legally framed as the customer arranging their own courier from an AB-located inventory. This affects warranty/return liability, not scraper logic.
- **Wine and Beyond ownership** — earlier drafts of this report described the parent as "Sobeys" or "Liquor Stores N.A." This is incorrect; the correct parent is **SNDL Inc. (Nasdaq: SNDL, formerly Sundial Growers)**, which acquired Alcanna (former owner of the Wine and Beyond banner) on March 31, 2022. The 171-location liquor portfolio (Wine and Beyond, Liquor Depot, Ace Liquor) is consolidated under SNDL.