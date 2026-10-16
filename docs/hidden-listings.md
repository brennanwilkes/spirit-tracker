# Hidden listings: details and sweeps

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

## Hidden Listings

`data/sku_hidden.json` curates per-`(storeId, rawSku)` listings that should never appear in the UI or fire email events (e.g. a store mis-categorized a wine under whisky). Hides apply to the specific store's record only — linked SKUs in the same canonical cluster from other stores are unaffected.

- Parallel loaders: `src/utils/sku_hidden.js` (CJS) and `viz/app/hidden.js` (ESM) — keep in sync. Both expose `loadHiddenSet()` and `isHiddenListing(set, storeId, sku)`.
- Edits via local dev only: `POST /__stviz/sku-hidden` body `{ storeId, sku, reason? }` in `viz/serve.js`. UI: a ✕ button on each store row of the item detail page, gated by `isLocalWriteMode()`.
- Enforcement: pre-aggregation filter in `viz/app/catalog.js` and at each page that loads from the index (`search_page.js`, `store_page.js`, `shortlist_page.js`, `item_page.js`); pre-emit filter in `tools/build_viz_recent.js` and `tools/build_common_listings.js`; ingest-time filter in `tools/build_email_event_pack.js::ingestDbObject` (so nothing about the hidden listing enters events/offers/cheapest).
- `tools/build_viz_sku_cache.js` and the scraper itself are intentionally NOT filtered — data preservation. Hide is a presentation/notification concern only.
- `.github/workflows/pages.yaml` stages `data/sku_hidden.json → viz/data/` parallel to `sku_links*.json` so the deployed SPA can fetch it.
- **Off-category sweep 2026-10-12** (591 → 830 entries; new entries carry a `reason`): tequila/mezcal,
  wine, cognac/brandy, liqueur/soju/vermouth, canned and bottled RTD cocktails, non-alcoholic
  "spirits", mixed-dram sets, and non-products. A chosen sku is hidden at EVERY store listing it.
  Check each expanded row by name, because the same sku can be a different product at another
  store (`130811` is an apple-brandy-CASK whiskey at KWM; Trail's End is a bourbon). Kept: single
  minis and same-product mini packs (Jameson 3×50, Drumshanbo 12-pack), Wiser's/Bulleit Old
  Fashioned (spirit-strength), Empress Cocktail Gin, Stillhead "Tequila Ca[sk]".
- **Multi-dram sets are hidden (owner ruling 2026-09-28):** advent calendars and tasting/taster/discovery/sampler sets, hidden on every store carrying the sku. Extended 2026-09-29 to every Drinks by the Dram set, Two Stacks Dram in a Can, and SMWS outturn tickets/kits. Brand gift packs of minis (Jameson 3×50ml) and packs of real bottles (Old Forester 3×375, Appleton 3×200) stay tracked. Still manual; no name-pattern rule.
