# New-store discovery notes

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

## New-store discovery (research closed 2026-10-10)

Four rounds of multi-agent research (2026-10-09/10) measured ~180 untracked BC/AB catalogs. What's left is owner
decisions, implementation and a few multi-day rechecks. **`STORE_HUNT_HANDOFF.md`** (repo root) is the decision
document: ranked candidates by adapter cost, pending owner calls, rechecks due, blocked stores. Working data lives in
`audit/store_hunt/` (gitignored); `round4-strict-counts.md` holds the authoritative counts.
Durable facts:
- **Bar = ≥ ~50 in-stock whisky+rum+gin DISTINCT products** (owner ruling 2026-10-10: a product's sizes count once;
  minis, packs, liqueurs, RTDs and fee/deposit rows don't count). Raw listing counts run ~1.34× high. The hunt's
  raw fetch matched the tracker's live counts within 0–1% on 11 tracked stores, so the gap is definitional.
- Every Barnet shop can be listed by number: `barnetnetwork.com/api/shop/<N>/products` (ids 1–2,499, all crawled).
  `available_for_sale` is a per-store sales switch, separate from `on_hand` (LightHouse Bay: stock on hand, switch off).
- Each gulp.tech client has its own GraphQL host with the same schema as `legacyliquor.js`. Some gulp feeds are
  frozen (0 quantity changes overnight), so verify movement before adding one.
- AB is enumerable via Liquor Connect: AGLC licensees, which stores stock a SKU, and `AgentName` (importer) per
  product. BC has no equivalent.
- An all-"available" Shopify/Woo catalog proves nothing; diff it over days. Shopify `updated_at` is often bulk-stamped.
- BottleCapps tenants sit behind DataDome; scripted hits from the home IP get captcha-walled. Wine-Searcher is
  PerimeterX-walled.
