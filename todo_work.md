# Future Refactoring Work

Tracking shared/duplicated logic in the scraper that should eventually be
consolidated. None of this is urgent — the stores work as-is — but pulling
common code into the `src/platforms/` adapter layer (as done for Shopify,
WooCommerce, and Barnet) would cut duplication and make future stores faster.

## Barnet Network adapter migration

`src/platforms/barnet_network.js` now exists (`createBarnetAdapter`) and backs
the new `highpointbws` and `newdistrict` stores. The two **older** Barnet
stores still carry their own hand-rolled copies of the same pagination loop:

- `src/stores/arc.js::scanCategoryArcApi` — near-identical to the adapter.
- `src/stores/vintagespirits.js::scanCategoryVintageApi` — parallel impl with
  its own concurrency/stagger handling.

**Action:** migrate both onto `createBarnetAdapter`. arc maps cleanly
(server-side sub_category). vintagespirits uses parallel page fetches — decide
whether to keep that optimization in the adapter (add a `concurrency` opt) or
accept sequential. Verify cross-store SKU stability before/after.

## Shopify stores predating `shopify_collection.js`

These were written before the `createShopifyCollectionAdapter` platform
existed and each re-implement `/products.json` (or GraphQL) walking, variant
selection, price/SKU normalization, and image picking:

- `src/stores/craftcellars.js` — Shopify `/products.json` + HTML fallback.
- `src/stores/vessel.js` — Shopify HTML `<product-card>` parsing.
- `src/stores/legacyliquor.js` — Shopify GraphQL Storefront cursor pagination.
- `src/stores/tudor.js` — Shopify GraphQL + budgeted detail fetches.
- `src/stores/willowpark.js` — Shopify HTML + GQL SKU repair pass.

**Action:** evaluate which can move onto `createShopifyCollectionAdapter`.
craftcellars/vessel are likely straightforward. The GraphQL ones
(legacyliquor, tudor) would need a GraphQL mode added to the adapter — bigger
job, maybe not worth it.

## WooCommerce stores predating `woocommerce_store_api.js`

Each re-implements WC listing/parsing in its own way:

- `src/stores/sierrasprings.js` — WC Store API + HTML TMB blocks.
- `src/stores/strath.js` — Divi Ajax Filter + WC Store API.
- `src/stores/gull.js` — WooCommerce HTML (12s throttle).
- `src/stores/kegncork.js` — WooCommerce HTML.
- `src/stores/maltsandgrains.js` — WooCommerce HTML.

**Action:** gull/kegncork/maltsandgrains are HTML-listing Woo stores that
could likely use `createWooStoreApiAdapter` with `htmlFallback: true`. Check
whether their WC Store API endpoints are actually available (they may have
been written as HTML scrapers because the API was blocked — verify before
migrating). sierrasprings/strath have bespoke Divi/TMB handling that may not
fit the generic adapter.

## Cross-cutting helpers worth checking for duplication

- SKU normalization: `src/utils/sku.js` is shared, but several stores
  (bcl, coop, kwm) build `id:`/`upc:` SKUs inline — confirm they all route
  through `normalizeSkuKey` consistently.
- Price extraction: confirm all stores use `src/utils/price.js` /
  `src/utils/woocommerce.js` helpers rather than hand-parsing.
- `avoidMassRemoval` + `finalizeCategoryScan` are already shared (good).

## Bespoke API stores (no obvious shared target — leave as-is)

- `src/stores/bcl.js` (Elasticsearch Ajax), `src/stores/bsw.js` (Algolia),
  `src/stores/coop.js` (custom session API), `src/stores/kwm.js` (custom
  session + binary-search pagination). These are genuinely store-specific;
  no shared adapter makes sense.
