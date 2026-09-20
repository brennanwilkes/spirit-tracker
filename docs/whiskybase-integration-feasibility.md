# WhiskyBase Integration — Feasibility Report (v5)

**Date:** 2026-07-16
**Status:** Deep-dive review complete. Verdict changed vs. prior drafts. Implementation not started.
**Method:** Every claim below was re-checked against the actual codebase (`file:line` cited) or
against primary external sources (ToS pages, EU Database Directive, Parse Bot's own materials).
Claims that could not be verified are labeled as such rather than asserted.

> ### Verdict at a glance
>
> | Track | Verdict | Why |
> |---|---|---|
> | **Ingesting WhiskyBase data** (scrape, Parse Bot, or full-catalog mirror) | **NO-GO** | WhiskyBase ToS explicitly forbids it; EU database right makes a full-catalog mirror textbook infringement; the access channel is fragile and doesn't fit our CI; using a middleman does not cure the legality problem. |
> | **License-clean metadata enrichment** (own store data + Wikidata CC0 + static tables) | **GO** | Zero new legal exposure, fits the $0/CI model, and delivers the large majority of the coverage the WB plan was chasing. This is where all the real value is. |
> | **WhiskyBase-ID crosswalk as a scored hint** (via Wikidata `P9242`, never as a union edge) | **CONDITIONAL** | Safe only as metadata + a GBT feature routed through the existing `#/link-review` gate. Never materialize WB matches as `sku_links.json` edges. |
>
> **One-sentence recommendation:** Drop the WhiskyBase-via-Parse-Bot plan entirely; build the
> license-clean enrichment layers (which the prior drafts already identified as the highest-ROI
> work) and, if a whisky-reference crosswalk is still wanted, get distillery↔WB-ID mappings from
> **CC0 Wikidata**, not from WhiskyBase.

---

## 0. How this version differs from v1–v4 (adversarial corrections)

The prior document was two drafts concatenated (note the duplicate `## 1.` sections and two
appendix sets). It was strong on the *store-metadata* insight but had three classes of problem:
it **never analyzed legality**, it **cited mutually contradictory numbers**, and it **overstated
how easy several changes are**. Corrections, with evidence:

| # | Prior claim | Reality | Evidence |
|---|---|---|---|
| 1 | *(Legality never mentioned)* | WhiskyBase ToS **explicitly prohibits** scraping, copying "bottle information, descriptions, ratings, prices," and building a local index. EU **sui generis database right** additionally protects the catalog; mirroring "every WB bottle" is extraction of a "substantial part." **This is the decisive constraint and was entirely absent.** | whiskybase.com/page/disclaimer; EU Directive 96/9/EC |
| 2 | "Parse Bot free tier… works right now" as a foundation | Parse Bot is a real YC company, but this endpoint is an **unofficial forked scraper** of a Cloudflare-protected site. It is fragile (startup risk + generated-scraper-breaks-on-HTML-change + hostile source) and, critically, **does not cure the legal problem** — you're still building a derivative DB of WB content. Its own listing admits "This isn't an official whiskybase.com API." | parse.bot marketplace listing |
| 3 | "100 credits/month" vs "200 credits/month" | Both appear because **Parse Bot's own materials disagree** (homepage says 200, the WhiskyBase listing says 100). That volatility is itself a durability red flag. | parse.bot homepage vs. marketplace listing |
| 4 | "3,072 canonical groups" / "9,072 total groups" / "~10,750 items" / "28,347 listings" | **All wrong / stale / inconsistent.** Measured against the live `data` worktree: **7,772 canonical groups**, **30,845 listings** (24,824 live), **4,611 multi-store groups**. | `src/utils/sku_canonical.js` unioning both link files over `viz/data/index.json` |
| 5 | "33 stores" | Code registers **35 stores**. (root `CLAUDE.md` says 33, `src/CLAUDE.md` says 34 — all stale.) | `src/stores/index.js:48-90` (`createStores().length === 35`) |
| 6 | BCL metadata extraction is "the single highest-value, lowest-effort… no per-product fetch — just add fields to `bclHitToItem`" | The *extraction* is trivial, but the persisted item schema is **centrally whitelisted** — adding fields to `bclHitToItem` alone reaches disk as nothing. It's a shared-schema change across all 35 stores plus every consumer. Small-to-medium, not one-file. **And the load-bearing premise (that ES `_source` actually contains ABV/region/etc.) is unverified — no sample response exists in the repo.** | `src/stores/bcl.js:125`; `src/tracker/db.js:53`; `src/tracker/merge.js:170-173` |
| 7 | KWM "region/vintage/ABV… already in responses" | **Refuted.** KWM's scraper fetches **listing tiles only** (`name/price/url/sku/img`); the `product-meta` div and description prose live on **detail pages KWM never fetches.** This is net-new fetching+parsing, not "throwing away data in hand." | `src/stores/kwm.js:171-206,336-461` |
| 8 | Strath has "empty — no structured metadata" | **Partially refuted.** Strath's category URLs use `_sfm_product_abv` and `_sfm_product_type` facets, and names carry `Brand - Expression` structure — the data exists, it's just used for filtering, not extracted. | `src/stores/strath.js:129-133,400,436,471` |
| 9 | Lime `brand.name` from `products.json` | **Inaccurate.** `products.json` exposes `vendor`, not `brand.name`; `brand.name` is only in JSON-LD, which Lime's adapter never fetches. (`product_type`/`tags` *are* present and discarded — that part is right.) | `src/platforms/shopify_collection.js:237-296` |
| 10 | WB-ID as `sharedWbId` — implied safe to use as a match/link signal | Safe **only as a scored feature** behind the review gate. The union-find does **no validation at link-materialization** (any `{fromSku,toSku}` is an unconditional, irreversible merge), so a WB-ID-driven union edge can silently merge two hand-curated groups. WB IDs are **many-to-many** with our groups (we collapse 700≡750/350≡375; WB splits them). | `src/utils/sku_canonical.js:126-133` |

The parts of the prior draft that **survive scrutiny and are kept**: the store-metadata-extraction
thesis (Layer 2), the canonical-group-enrichment framing (a bad name is irrelevant when a better
name exists in the same group), the size-bucketing model, and the license-clean static tables.
Those were the good ideas; they just don't need WhiskyBase.

---

## 1. Verified ground truth (measured, not assumed)

Measured against the live `data` worktree (`.worktrees/data/`, `index.json` dated 2026-07-15),
by unioning `data/sku_links.json` + `data/sku_links_auto.json` through the real
`buildGroupsAndCanonicalMap` and bucketing every `index.json` item by canonical rep:

| Metric | Value |
|---|---|
| Raw store listings (incl. removed) | **30,845** |
| Live listings | **24,824** |
| Manual links (`sku_links.json`) | 5,599 (31 `status:"pending"`) |
| Auto links (`sku_links_auto.json`) | 893 |
| SKUs in the DSU (linked ≥ once) | 9,509 |
| **Distinct canonical groups** | **7,772** |
| Groups with >1 store | **4,611** |
| Registered stores | **35** (`src/stores/index.js`) |

**Every coverage percentage in this document is expressed against 7,772 canonical groups.** The
prior drafts' percentages were computed against at least three incompatible denominators and
should not be trusted.

**How canonical identity actually works** (`src/utils/sku_canonical.js`, ESM twin
`viz/app/sku_canonical.js` — kept in sync by hand, no build step):
- A textbook **union-find** with path compression + union-by-rank (`:75-115`).
- Groups are formed **purely from link edges** — `buildGroupsAndCanonicalMap` calls
  `dsu.union(a,b)` for each `{fromSku,toSku}` (`:126-133`). Only SKUs that appear in a link enter
  the DSU. (Implicit "same raw SKU at ≥2 stores" equivalence emerges later in
  `viz/app/catalog.js::aggregateBySku`, not here.)
- `status:"pending"` auto-links are **real links immediately** — consumers read only
  `fromSku`/`toSku` and ignore `status` (`:127-128`).
- Canonical rep = smallest real (non-`u:`) numeric store SKU (`compareSku`, `:49-71`).
- **No validation at union time.** Concept walls, ABV/size penalties, and the GBT classifier all
  live in the *suggestion/scoring* path (`viz/app/linker_page/*`), **not** the path that turns a
  link record into a DSU merge. This is the crux of the reconciliation risk in §2.3.

---

## 2. Constraints (the six the prior drafts under-specified)

### 2.1 Legal / ToS / licensing — **HIGH RISK, decisive**

WhiskyBase's public disclaimer (whiskybase.com/page/disclaimer) is explicit and directly on point:

- **Bot/automation ban:** "You shall not circumvent, remove, alter, deactivate, degrade or thwart
  any of the content protections, decompile, reverse engineer or disassemble the Service."
- **Data-copying ban (names the exact fields the plan wants):** prohibits "any downloading,
  duplicating, or copying, collection and use of any contents of the Services, e.g. bottle
  information, descriptions, ratings, retail and secondary market price observations, values, etc."
- **IP basis:** "The Service is protected by copyrights and database rights… for your personal use
  only and may not be shared with any third parties."
- **License scope:** members receive only a "limited, non-exclusive… revocable right to access and
  use the Service and to view its contents," explicitly **excluding** commercial use, public
  display, and creating derivative works.
- The shop T&Cs separately forbid "price scraping or price harvesting without prior written consent."

**EU database right (independent of, and additional to, the ToS).** WhiskyBase is a Netherlands
(EU) company. Under Directive 96/9/EC, the maker of a database built with "substantial investment"
can prevent "extraction and/or re-utilization of… a substantial part." A 15-year crowd-curated
catalog of ~10⁵ bottles is a strong candidate for that protection, and the prior plan's stated
goal — "a complete local index of every WB bottle" — is precisely the substantial-part extraction
the right targets. Scraping a handful of records is usually below the bar; **mirroring the whole
catalog is the worst-case profile.** The Directive's exceptions (private/non-electronic, teaching,
research, public security) do not cover a public-facing price-tracker feature.

**There is no official public API.** WhiskyBase Premium grants a human enhanced *viewing*; it
confers no export/redistribution/API rights. The only sanctioned access is a person browsing under
the personal-use license.

**Caveat:** this is a risk assessment, not legal advice. The ToS quotes are verbatim from the live
page; whether a court would find the DB qualifies for sui-generis protection and whether a given
extraction is "substantial" are legal judgments. A lawyer should confirm before *any* ingestion —
but the directional risk (full-catalog mirror = high exposure on two independent grounds) is
well-supported and sufficient to say **do not proceed as designed.**

### 2.2 Access method / rate limits / CI fit — **does not fit our model**

Two candidate channels, both dead ends for our automation:

**Direct scraping — CF-blocked, the plan concedes it.** The prior draft's own testing found
**HTTP 403 on every URL including `/robots.txt`** from the CI IP — the signature of Cloudflare
IP-reputation/edge blocking (not a solvable JS challenge). This is the **identical failure mode**
already documented for five of our own stores (liberty, highlander, coop, colordevino,
maltsandgrains) from the GitHub Azure runner IP, and our own WireGuard mitigation for that exact
problem is **disabled and unfixed** (CLAUDE.md §"Datacenter-IP Blocking"; `cron_tracker.yaml:160-180`).
`curl_cffi` fixes TLS fingerprint but not IP reputation. Residential proxies might pass layer 1 but
would mean *deliberately circumventing a content protection* — which §2.1's ToS clause specifically
forbids, worsening the legal posture.

**Parse Bot — arithmetically incompatible with the cron.** Our pipeline runs **~8×/day** (big:
all-stores 2×/day ~1h; small: 4 stores 6×/day ~12min; `cron_tracker.yaml:8-9`). Against Parse Bot's
free tier (5 req/min, 100–200 credits/mo):
- **Rate vs runtime:** at 5 req/min, even 60 lookups take 12 min — the *entire* small-run budget.
- **Credits vs frequency:** 200 credits/mo ÷ ~240 runs/mo ≈ **<1 credit per run.** No meaningful
  per-run budget exists. The plan itself pegs 100 credits as "~0.5% of our catalog."
- **Full-catalog timeline:** the plan's own figure is **~14 months** on the free tier, possibly
  2–5× worse with pagination.

**Conclusion:** any actual WB access can only be a **hand-run, out-of-band batch** producing a
static artifact — never a step inside `run_daily.sh`. The prior "Phase 5: incremental WB updates,
match new items as they appear" is the part that fundamentally cannot be wired into CI. (This is
moot given §2.1, but documents *why* even the technical design was unsound.)

### 2.3 SKU identity reconciliation — **WB ID is a hint, never an identity**

This is the constraint most likely to cause silent damage, so it is spelled out precisely.

- **The mechanism to fear:** any `{fromSku,toSku}` record — from any source — is an unconditional
  `dsu.union` (`src/utils/sku_canonical.js:126-133`). There is **no gating** on confidence, ABV,
  size, or category at union time, and union-find is transitive and irreversible within a build.
- **Both-directions collision with WB IDs:**
  - *One WB ID → many of our groups:* WB assigns distinct IDs to packaging/label re-releases and
    yearly sub-releases we (correctly) keep as one group; a mis-match also manufactures a false
    union.
  - *Many WB IDs → one of our groups:* we deliberately collapse 700≡750 and 350≡375 size variants
    (`viz/app/linker_page/size.js`), which WB lists as **separate** bottle IDs.
  - So WB ID is a **many-to-many** relation with our groups — not a partition. "Union on shared WB
    ID" is unsafe.
- **Safe design:** store WB ID as a **metadata attribute** on the canonical group / per-SKU (the
  prior draft's own `sku_metadata.json` shape) and, if used for matching, expose it only as a
  **scored GBT feature** (`sharedWbId`) routed through the existing `status:"pending"` →
  `#/link-review` human gate. In the scored path the existing precision guards
  (`grpAbvDiff`, `grpSizeConflict`, `grpYearDiff`, `crossEntityConflicts` in
  `viz/app/linker_page/blend.js:283-315` and `tools/linker_ml/featurize.mjs:319-373`) can veto a
  bad merge; in the raw-union path nothing can. **Never emit WB matches directly into
  `sku_links.json`/`_auto.json`.**
- **Existing safeguards to lean on:** `status:"pending"` + `#/link-review`; `ignores` keyed over
  canonical groups (`viz/app/mapping.js:55-73`); the `noTrain` flag for human-unverifiable links.

### 2.4 Data quality & freshness — **stale by construction, and unmaintainable at the cadence we'd need**

- WB is crowd-sourced: coverage and field completeness vary widely by region — strong on Scotch,
  weak on Canadian whisky (the prior draft's own estimate: ~35% Canadian coverage) and on craft/
  store-exclusive bottlings (~30%/0%). Our catalog is ~1,700 Canadian items, our single largest
  category — the exact region WB is weakest.
- A one-time mirror (the only technically-viable shape, per §2.2) is **stale the day it lands** and
  cannot track new WB entries without re-running the (illegal) bulk pull.
- Our *own* store data, by contrast, is refreshed every scrape and is data we already legitimately
  hold. For the fields that actually matter (ABV, size, type, region), store data is both fresher
  and license-clean.

### 2.5 Maintenance burden & failure modes

- **Generated-scraper rot:** a Parse Bot fork breaks whenever WB changes HTML/anti-bot posture —
  an unowned, unpredictable external dependency. (The doc even pins a scraper UUID
  `1fa3ba9e-…` that already differs from the current marketplace listing `c0c1cb47-…` — i.e. it's
  pinned to a possibly-stale fork.)
- **Two-file sync tax:** any new linker feature must be added to **both** `viz/app/linker_page/blend.js`
  (`FEATURE_KEYS`, `:37-79`) and `tools/linker_ml/featurize.mjs` — the prior draft framed feature
  work as a one-file change.
- **Schema ripple:** persisted item fields are whitelisted centrally in
  `src/tracker/db.js:53`; any new metadata field is a schema change touching all 35 stores plus
  `catalog.js`, `build_viz_index.js`, the email pack, and the item-page UI.
- **Legal exposure is ongoing, not one-time:** as long as WB-derived data ships in the public SPA,
  the ToS/DB-right exposure persists.

### 2.6 Cost — **breaks the $0 ethos; paid tiers buy speed, not capability**

The project's identity is $0 running cost (no npm deps, free Actions/Pages; the entire LFS removal
was done specifically to get metered spend to zero). Parse Bot **Hobby $30/mo** / **Developer
$100/mo** would convert a free hobby pipeline into a subscription — and $100/mo is a large multiple
of the project's entire current running cost. To the prior draft's credit, its final recommendation
already rejects paid bulk ("What NOT to Build — paid API subscriptions"). The honest framing: the
paid tiers only compress the ~14-month free-tier timeline; they don't unlock anything the
license-clean layers can't. Any paid access, if ever pursued, must be an explicit, human-authorized,
one-time out-of-band spend — never a standing subscription, never wired into the cron.

---

## 3. What IS feasible and worth building (license-clean, $0, CI-compatible)

This is the whole real plan. None of it touches WhiskyBase content.

### Layer 1 — Static lookup tables (facts aren't copyrightable; hand-authored)
| Table | Entries | Value | Storage |
|---|---|---|---|
| `data/smws_codes.json` — SMWS code → distillery | ~168 | Decodes ~400 SMWS items | plain git (tiny, static) |
| `data/wb_distilleries.json` — **Wikidata** distillery gazetteer via SPARQL on `P9242` | ~217–360 | Distillery↔country/region **and a CC0 WB-distillery-ID crosswalk without touching WB** | plain git |
| `data/wb_canadian_seed.json` — Canadian brand→distillery seed | ~15–20 | Fills WB's weakest region | plain git |

**Wikidata is the clean substitute for the one genuinely WB-specific thing worth having** — the
distillery↔WB-ID crosswalk — because Wikidata's `P9242` ("Whiskybase distillery ID") is **CC0
public domain**. It gives distillery-level metadata and the ID mapping with no ToS/DB-right
exposure. It does **not** give bottle-level data; that's fine (see Layer 2).

### Layer 2 — Store-metadata extraction (highest ROI; data we already legitimately hold)
Pull structured fields from stores whose responses already carry them. Output a per-canonical-SKU
`data/sku_metadata.json` (regenerated each scrape, plain git like `rarity.json`).

| Store | Fields | Effort (corrected) |
|---|---|---|
| **BCL** | ABV, volume, country, region, sub-region, type, tasting notes, UPC, rating — **IF present in ES `_source`** | Extraction ~trivial; **but** requires a central schema change (`db.js`) + consumers. **Verify `_source` first** (§4). |
| **KWM** | region, vintage, ABV, age, cask (in `product-meta` div + description) | **Net-new detail-page fetch + parse** — not "already in hand." Medium. |
| **Strath** | ABV + type (from `_sfm_*` facets), distillery/expression (name split) | Data already fetched; small parse. |
| **Sherbrooke** | Country (WooCommerce Store API `attributes[]`) | Plausible; parser currently discards it. Small. |
| **Lime** | `product_type`, `tags` (from `products.json`; **not** `brand.name`) | Small; correct the field name. |

Why this matters even with zero WB: it improves the linker (ABV/size group features already exist
in `featurize.mjs:319-373` — feed them real ABV instead of name-parsed), enables filter-by-region
search, and adds user-facing metadata — all license-clean.

### Layer 3 — Linker integration (when metadata exists)
Add `abvAgreement` / `distilleryOverlap` (and, if the Wikidata crosswalk yields it, a **scored,
review-gated** `sharedWbDistilleryId`) as GBT features. Two-file change (`blend.js` +
`featurize.mjs`), then retrain per `tools/linker_ml/CLAUDE.md`. **No WB bottle IDs as union edges.**

### Corrected coverage expectation
The prior "path to 75%" was built on incompatible denominators and on WB matching that is now
off the table. A defensible, license-clean expectation (against **7,772 groups**, to be measured,
not asserted): store-metadata + static tables realistically deliver the bulk of the *metadata
enrichment* the plan wanted (ABV/region/type/distillery on a large fraction of multi-store groups),
which is the part that actually feeds the linker and the UI. **The specific "X% matched to WB at
95% confidence" targets should be dropped** — they measured a capability we're not building.

---

## 4. The BCL "quick win" — verify before scoping

Before treating BCL enrichment as a quick win, **capture one live `/ajax/browse` response** and
confirm the field names (`alcoholPercentage`, `region`, `class.description`, `upc`, …) actually
exist in `_source`. The repo has no sample/fixture and the persisted DB stores only the 5 extracted
fields, so the premise is currently **unverified**. If confirmed, the change set is:
1. `bclHitToItem` — add fields (~10 lines, localized).
2. `src/tracker/db.js:53` `buildDbObject` — widen the whitelist (**schema change for all 35 stores**).
3. `src/tracker/merge.js:170-173` — decide whether metadata changes should register as changes.
4. Consumers: `catalog.js` aggregation, `build_viz_index.js`, email pack, item-page UI.

Small-to-medium, not a one-file edit — but genuinely worthwhile and 100% license-clean.

---

## 5. Revised phased plan (all $0, all license-clean)

| Phase | Work | Cost | Fits CI? |
|---|---|---|---|
| **0. Verify** | Capture a live BCL `/ajax/browse` response; confirm `_source` fields | $0 | one-off |
| **1. Static tables** | SMWS codes; Wikidata `P9242` SPARQL → `wb_distilleries.json`; Canadian seed | $0, 0 API | plain git |
| **2. Store metadata** | BCL (schema change) + Strath/Sherbrooke/Lime (small) + KWM (new detail fetch); write `sku_metadata.json` | $0 | best-effort step in `run_daily.sh` beside `auto_link_classify.mjs`, staged into commit **and** `pages.yaml` |
| **3. Linker features** | `abvAgreement`/`distilleryOverlap` (+ optional review-gated Wikidata distillery-ID feature); retrain | $0 | offline retrain |
| **4. UI** | Show distillery/region/ABV/type on item pages | $0 | — |

**Explicitly NOT building:** WhiskyBase scraping (ToS + CF-blocked), Parse Bot dependency (illegal-
by-ToS via middleman, fragile, doesn't fit cron), any full WB catalog mirror (EU database right),
any paid API subscription (breaks $0 ethos).

**If bottle-level reference data is still wanted later:** evaluate **BottleDB** (bottledb.org) or
**WHISKY:EDITION** (thewhiskyedition.com/developer, requires attribution) under their *actual*
published licenses — not WhiskyBase. Confirm redistribution terms before shipping any of their data.

### Storage strategy (per the LFS lesson)
The killer was LFS **bandwidth** (every CI checkout re-smudged ~60 MB), not storage. Rule: plain
git only for files that are small or delta-compress well; anything large + rewritten-wholesale
goes to a **GitHub Release asset** (the `sku_embeddings.json` / `embeddings-latest` pattern).
- `smws_codes.json`, `wb_distilleries.json`, `wb_canadian_seed.json`, `sku_metadata.json` →
  **plain git** (small/static, or regenerated-but-delta-friendly like `rarity.json`).
- A full WB catalog index (~15–50 MB) → would have to be a **Release asset** — but we're not
  building it (§2.1), so this is moot.

---

## 6. Key files (corrected & verified)

| Layer | File | Note |
|---|---|---|
| BCL extraction | `src/stores/bcl.js` (`bclHitToItem`, `:86-126`) | Verified: outputs 5 fields only. |
| **Persisted schema (whitelist)** | `src/tracker/db.js:53` | **The real gate** — new fields must be added here, not just in the store adapter. |
| Merge change-detection | `src/tracker/merge.js:170-173` | Only name/price/sku/img trigger a change today. |
| Strath | `src/stores/strath.js:129-133,400,436,471` | `_sfm_*` facets + name split — not "empty." |
| Sherbrooke / Woo | `src/utils/woocommerce.js:99-113` | Discards `attributes[]`. |
| Lime / Shopify | `src/platforms/shopify_collection.js:237-296` | `product_type`/`tags` present; `brand.name` is **not** (it's `vendor`). |
| KWM | `src/stores/kwm.js:171-206,336-461` | Listing tiles only; detail pages not fetched. |
| Canonical map | `src/utils/sku_canonical.js` (+ ESM twin `viz/app/sku_canonical.js`) | Union-find; **no validation at union time** (`:126-133`). |
| Link loaders | `src/utils/sku_map.js:78-86`; `viz/app/mapping.js:22-90` | Union both link files. |
| Aggregation | `viz/app/catalog.js` (`aggregateBySku`, `:60-157`) | Carries **no** structured metadata today — would need plumbing. |
| Linker features | `viz/app/linker_page/blend.js` (`FEATURE_KEYS` `:37-79`) **and** `tools/linker_ml/featurize.mjs:319-373` | Two-file sync; group ABV/size/year features already exist. |
| Static tables | New: `data/smws_codes.json`, `data/wb_distilleries.json`, `data/wb_canadian_seed.json` | Plain git. |
| Store metadata | New: `tools/extract_store_metadata.js` → `data/sku_metadata.json` | Best-effort step in `run_daily.sh`; stage into commit + `pages.yaml`. |
| UI | `viz/app/item_page.js` | Display distillery/region/ABV/type. |
| Registry | `src/stores/index.js:48-90` | **35** stores. |

---

## Appendix A — Size bucketing (kept; used for our own grouping, not WB)
| Bucket | Sizes | Notes |
|---|---|---|
| Standard | 700ml, 750ml | Same product, different markets → same canonical group |
| Half | 350ml, 375ml | Half bottles |
| Mini | 50ml, 100ml, 200ml | Miniatures |
| Large | 1L, 1.14L, 1.75L | Magnums |

Within-bucket = same canonical group; across-bucket = distinct groups. (WhiskyBase, by contrast,
assigns separate bottle IDs per size — one reason WB ID is many-to-many with our groups; §2.3.)

## Appendix B — License-clean alternatives (ranked)
| Source | Gives | License | Verdict |
|---|---|---|---|
| **Wikidata `P9242`** | distillery ↔ WB-distillery-ID, country, region, parent | **CC0** | **Best clean option** for the crosswalk; distillery-level only. |
| **Own store data** (BCL/KWM/Strath/Sherbrooke/Lime) | ABV, region, type, UPC, ratings | data we already ingest | **Highest ROI, zero new exposure.** |
| Static/manual tables (SMWS, Canadian seed, brand aliases) | code→distillery, brand normalization | facts / self-authored | Clean, durable. |
| WHISKY:EDITION API | bottle metadata | free-ish, **attribution required** | Evaluate under actual terms if bottle-level data is needed. |
| BottleDB | open whisky-bottle dataset | positioned open; **verify** | Evaluate as open substitute. |
| Whisky Hunter API | distillery + auction stats | **license unpublished**; CF-fronted | Confirm terms before any reuse. |

## Appendix C — WhiskyBase / Parse Bot reference (for the record; NOT to be built)
Retained only to document what was evaluated and rejected. **Using these violates WhiskyBase ToS
(§2.1) and does not fit our CI (§2.2).** Parse Bot base
`https://api.parse.bot/scraper/1fa3ba9e-…/` (UUID differs from the current marketplace listing —
already possibly stale). Endpoints (`search_whiskies`, `get_distilleries`,
`get_distillery_whiskies`, `get_new_releases`, `get_top_1000_whiskies`, `get_marketplace_listings`).
Free tier per Parse Bot's own (self-contradictory) materials: 100–200 credits/mo, 5 req/min. Paid:
Hobby $30/mo (1,000 credits), Developer $100/mo (5,000 credits).

---

*Primary sources for the legal/access findings: whiskybase.com/page/disclaimer;
shop.whiskybase.com general T&Cs; EU Directive 96/9/EC (eur-lex); parse.bot homepage + marketplace
listing; wikidata.org/wiki/Property:P9242. Legal analysis is a risk assessment, not legal advice —
confirm with counsel before any WhiskyBase ingestion.*
