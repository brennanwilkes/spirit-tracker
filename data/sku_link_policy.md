# SKU Link Judgement Policy

**Owner:** the repo owner. The *content* of this file is decided by the human — an agent may
edit it only when the human explicitly asks for a change, and otherwise proposes amendments in
its audit report. An agent that quietly rewrites its own rules drifts.

**How the agent must use it (read EVERY run):**

- Read this file at the start of every audit run (via `loadSkuLinkPolicy` in
  `tools/audit_search_core.mjs`).
- Treat it as the **operational definition of "separate SKU vs link"**. Where the
  scorer/ranker is ambiguous, the rule here decides.
- Where a rule says `judgement`, the decision is yours to make on the evidence — but an
  op you cannot justify from evidence you actually looked at belongs in the proposal's
  `review[]` array, not in `ops[]`.

**Columns:**

- `class` — the product-identity class being decoded.
- `default` — `link` = same product (marry the two SKUs); `separate` = distinct SKUs;
  `judgement` = decide case by case on evidence (price / size / abv / rarity / store).
- `notes / examples` — why, plus example pairs already logged in the labels/docs.

## Seed Decision Table

| class | default | notes / examples |
|---|---|---|
| Format / year wording | link | Age spelled vs abbreviated: `X 12YO` vs `X 12 Year Old` vs `X 12yr`; `HIGHLAND PARK 15 YO` vs `Highland Park 15 Year Old 'Viking Heart'`. Marital: `GLENFARCLAS - 12 YEAR OLD` ↔ `Glenfarclas 12 Year Old`; `GRANTS 12YR` ↔ `Grant's 12 Year Old` |
| Abbreviations | link | Initialisms, possessives, concatenated forms: `TBWC` ↔ `That Boutique-y Whisky Company`, `G&M`, `Macaloney` ↔ `Macaloneys`, `Tin Cup` ↔ `Tincup`, `Revelstoke` ↔ `Revel Stoke`. **An alias may bridge a name gap; it never bridges a size, ABV or batch gap** |
| Market / import variant | link | A market tag — `(Uk)`, `(EU)`, `Export`, `Travel Retail`, `Duty Free` — is packaging, not identity: `Sailor Jerry Spiced Rum (Uk)` ↔ `Sailor Jerry Spiced Rum 750 mL`. **Unless a stated ABV or volume actually differs**, in which case the ABV and Size rows above already separate them — the tag itself is never the reason (owner ruling 2026-09-20) |
| Packaging / re-list | link | `Vintage Packaging`, `(Without Tube)`, `PET` vs glass at the same volume, re-brands / re-labels are the same spirit. Marital: `Compass Box Artist` ↔ `Great King Street Artist's Blend` |
| Size | separate | `375ml` / `700ml` / `1.14L` / `1.75L` are distinct SKUs. **Tolerance: treat near-identical volumes as the SAME size** — 700 ≡ 750, 375 ≡ 350, 1.0L ≡ 1.14L is NOT within tolerance. See "Inferring an unstated size" below |
| ABV / proof | separate | A stated ABV or proof difference beyond rounding means a different bottling: `Macallan Sherry Oak 12` vs `… 12 110 Proof`; a standard bottling vs its Cask Strength sibling. `40%` vs `40.0%`, or an ABV stated on one side only, is NOT evidence of difference |
| Vintage year | separate | Distinct vintage releases are different SKUs: `Glenfarclas 2001` vs `Family Cask 2002`; `Glenfarclas FC 1979` is its own release, not the 12yo |
| Batch / cask | separate | Batch/cask codes are distinct SKUs: `Tamdhu Batch Strength 007` vs `008`; `SMWS 8.47` ≠ `8.46`. **But a code that MATCHES on both sides is positive evidence they ARE the same bottling** — `GlenDronach 1993 28YO Cask 4193` ↔ `GLENDRONACH 28YO 1993 CASK 4193` links |
| Independent bottler | **separate** | **The bottler is part of the product identity.** An IB release (Adelphi, Gordon & MacPhail / G&M CC, Signatory, Càrn Mòr, Single Cask Nation, Old Malt Cask, Douglas Laing…) is its own SKU and never links to the distillery's OFFICIAL bottling of the same age — `Aultmore 18 Year Old` ≠ `Adelphi Aultmore Selection 18 yr`; `G&M CC Bruichladdich 1988` ≠ `Bruichladdich Rare Cask 1988 / 30 YO`. Two listings of the SAME IB release of course still link (`GLENLIVET 2006 18 YEAR OLD SIGNATORY` ↔ `GLENLIVET 18YO 2006 SIGNATORY`). Mechanically screenable: an IB marker on exactly one side ⇒ separate (owner ruling 2026-09-20) |
| Limited / annual edition | separate | A named annual or limited release is its own SKU even with no year in the title: `Drumshanbo Gunpowder Year of the Dragon` ≠ plain `Gunpowder`; `Laphroaig Cairdeas 2026` ≠ `Cairdeas 2025`. **Year-less on both sides:** judge it, do not default. Evidence that they differ (different price rung, different ABV, one side names an edition) ⇒ separate; nothing suggesting a difference ⇒ link; genuinely no data either way ⇒ make the best call you can and say so in `why` (owner ruling 2026-09-20) |
| Store / exclusive cask | **separate** | **A store's own name or abbreviation inside the product title almost always marks that store's exclusive single cask** — `Glenfarclas Coop 15yr`, `Old Pulteney Coop 2006`, `Plantation Rum Coop 2011`. Treat it as a different bottling from the standard expression, even when the price sits inside the normal range for the standard one (confirmed by the owner 2026-09-19: Co-op carries `Glenfarclas Coop 15yr` $119.99 AND `Glenfarclas 15 yr` $129.99 — the $10 gap is not the signal, the name is) |
| Gift / sampler / tasting set | separate | Multi-bottle sampler and tasting sets are their own SKU, never a single expression. **Also separate when it holds only ONE bottle** — a `Gift Pack` / tin / glass set is priced and stocked as its own purchase unit: `Jura 10 Year Old Gift Pack 700ml` ≠ `Jura 10 Year Old` (owner ruling 2026-09-20). Contrast the packaging row above: `Vintage Packaging` / `(Without Tube)` describe the SAME purchase unit and do link |
| Bundle / multipack | judgement | See "Bundles" below |
| Bonus / on-pack item | separate | `X 750ml + 50ml mini`, `with Bonus Copper Pot`, a bottle packed with a glass or a second product is its own purchase unit, never the plain bottle — and never the rider's product either (owner ruling 2026-09-23) |
| Gift box at the plain bottle's price | link | A `Gift Box` / `Tin` listed at the plain bottle's price is packaging, like `Vintage Packaging`. Priced as its own rung ⇒ the Gift row above applies (owner ruling 2026-09-23) |
| RTD / canned spin-off | separate | A ready-to-drink can or cocktail carrying a spirit brand (`Crown Royal Whisky & Cola`) never links to the spirit (owner ruling 2026-09-23) |
| Single-barrel ordinal | separate | `Barrel #N`, `Cask No. N`, per-barrel pick numbers are distinct releases, like Batch / cask. Matching numbers on both sides link (owner ruling 2026-09-23) |
| Artist / collab / special-label bottle | separate | `Bombay Sapphire × Basquiat`, a designer or collaboration label, a commemorative bottle: a different product gets a different sku, even when the liquid is the same. Contrast `Vintage Packaging` (a re-list of the same unit, which links) (owner ruling 2026-09-23) |
| Title that is only a product code | link | A title that is just a code equal to another store's sku (Co-op `u:b70e5e0a` titled `876891` = Springbank 10) is identity evidence, exactly like a shared raw sku (owner ruling 2026-09-23) |

## Inferring an unstated size

**Assume the title does NOT state a size — that is the normal case, not the exception.** Measured
2026-09-19: BCL and Vine Arts state a volume in 0% of titles, Co-op and Silver Springs 1%,
Kensington 3%, Tudor House 9%. So the size rule above is almost always applied to inferred sizes,
and the inference has to come from somewhere other than the name.

In priority order:

1. **A confidently-linked sibling** — another listing of the same sku, or an existing link, that
   does state a volume.
2. **The URL slug.** It routinely encodes the size or the GTIN/EAN when the title does not.
   `audit_search --grep` prints every matching listing's url for exactly this reason.
3. **The store's own price ladder.** If a store lists a 375 at $20 and a 1.14L at $60, a sizeless
   listing at $40 is almost certainly the 700/750.

Only link on an inferred size when the inference is unambiguous; otherwise it goes in `review[]`.

### Tudor House — read the slug, not the title

Tudor needs extra indicators and has a trap:

- The slug ends `-ml-<n>` or `-l-<n>`. **The `ml` / `l` marker is the usable signal** — `ml` means
  sub-litre (50/200/375/750), `l` means litre-plus (1.14 L / 1.75 L). Measured: 1,013 `ml` vs 80
  `l` across 1,099 listings. The trailing number is NOT the size.
- **One slug serves several sizes** via `?variant=`. `canadian-club-ml-380` is the 750 mL ($23.99),
  the 375 mL ($12.99) AND the 200 mL ($7.99); `canadian-club-l-380` is both the 1.14 L and the
  1.75 L. So the slug narrows the size CLASS and the price ladder picks the rung — neither alone
  is enough.
- Tudor also double-lists: sku `000570` appears twice, "BEEFEATER LONDON DRY GIN 750ML" at $27.99
  and a sizeless row at $15.79 — and sku `007369` is the 375 mL at that same $15.79. Treat a
  sizeless Tudor row priced at a smaller rung as the smaller bottle, not as the flagship.

## A title with no expression name

A listing titled only brand + category (`PENDERYN WELSH SINGLE MALT`, `Gordons Gin`) is missing
data, not evidence for the core bottling. **Resolve it from the store's own price ladder**, the
same way an unstated size is inferred (owner ruling 2026-09-20):

- If that store ALREADY lists the expression you are about to link to, the generic row is a
  different product by construction. Worked example: Kegn'Cork lists `PENDERYN MYTH` at $68.96 AND
  a bare `PENDERYN WELSH SINGLE MALT` at $77.96 — so the generic one is not Myth. Placing $77.96 on
  the market-wide Penderyn ladder puts it at Madeira Finish ($68.81–$82), well above Myth ($60–66).
- If the store lists nothing else from that brand and the price sits squarely on one rung, link it
  to that rung and say so in `why`.
- If the ladder is ambiguous, it goes in `review[]`.

## Bundles

A bundle pairs two or more different products in one SKU. It is a judgement call, but the
governing rule is:

- **If a rare item is involved, treat the bundle as that rare item** and link it into the rare
  item's group. Accept that the bundle's price will be far above the group — that is expected,
  not evidence against. Examples: a Springbank 10 + Ledaig 10 bundle links to Springbank 10;
  a Michter's Single Barrel + Michter's Sour Mash bundle links to the Single Barrel.
- **"Rare" means allocated** — Weller 107, Springbank, Blanton's and the like. Judge it from the
  title first; `rar:"rare"` on the row (from `viz/data/rarity.json`, top ~10%) is corroborating
  evidence, not the definition.
- **Two RARE items ⇒ link to the rarer / more allocated of the two.** Judge which is harder to get; the other one simply goes unrepresented. Say which you picked and why in the op's `why` (owner ruling 2026-09-20).
- **Two common items ⇒ do not link.** Picking an arbitrary "primary" is worse than leaving it
  unlinked.
- **A multipack of ONE product** (`Weller Antique 107 Basket 2x750`, `Blanton's Collectors 8x750`)
  is a different purchase unit and stays **separate** from the single bottle — but two listings
  of the SAME multipack are of course the same SKU.

## Same store on both sides — a guide, not a rule

`pairs[].same:1` means the anchor's store also carries the candidate. It raises the evidence bar;
it never decides alone.

- Stores genuinely double-list one product (a re-list, a second category, a URL change). Identical
  or near-identical price is the tell.
- Stores also carry two real variants side by side. A material price gap is the tell — read
  `pairs[].prPct`, which places the gap in that store's own markup distribution.
- **And stores simply get it wrong.** A mispriced or mistitled listing looks exactly like a second
  product. When the evidence is genuinely balanced, prefer `review[]` over guessing.

## Price as evidence

`pairs[].pr` is the price ratio and `pairs[].prPct` places it in the dearer store's own
distribution over products it demonstrably shares. `>max` means that store has never been
observed that far above the market on anything — strong evidence of a different product.
A ratio inside the store's normal band is weak evidence either way. Never reject on price
alone when the names, size and cask codes all agree.

**Evidence the title does not carry** (owner ruling 2026-09-23): the store's **url slug** counts as
edition / size evidence (`…-cask-strength`, `…-375ml`, `…-2019`), and a size or format the title omits
(PET with no stated volume included) is resolved from the store's own price ladder, as in
"Inferring an unstated size".

**Liberty Wine Merchants `8289xxx` — judge per listing** (owner ruling 2026-09-23). These list at
2–7x market, so **price is not evidence** at Liberty in either direction. If the title reads as a
current / modern expression, link it to that expression. Liberty (like Legacy) also stocks old
"dusty" bottlings under legacy branding at collector prices — those are a different product and stay
separate. Decide from the name (old label names, discontinued age statements, `old bottling`,
defunct importer/bottler wording) and say which reading you took in `why`.

**Links to nameless delisted listings stay** (owner ruling 2026-09-23). A synthetic `u:` partner
whose name was never captured cannot be re-judged; keep the link, never propose unlinking it for
that reason alone.

## Cross-store SKU collisions — OPEN, and not fixable in this file

Two genuinely different products can share one numeric SKU across stores, because store numbering
namespaces overlap. Measured 2026-09-20 over every live listing: **4,445 numeric SKUs appear at
≥2 stores, and 4 of them are real collisions** (~0.09%). The known set:

| sku | the two products |
|---|---|
| `148534` | BCL `JOHNNIE WALKER - GAME OF THRONES A SONG OF FIRE` $60.99 vs BSW/KWM/Malts&Grains `G&M CC Highland Park 2005` ~$285–295 |
| `111168` | Highlander `L'Eroe Negroni 700ml` vs ZYN `Bruichladdich Octomore 15.3` |
| `134037` | EverythingWine/Gull `Seventh Heaven Dry Gin` vs WhiskyDrop `Watt Whisky Sherried Speyside 14` |
| `136399` | BSW/Sherbrooke `Twin Fin Coconut Lychee Rum` vs Strath `Bruichladdich Tallant #1125 Tempranillo 14yr` |

**An agent cannot fix these and must not try.** Nothing in `sku_links.json` created the merge —
listings aggregate by canonical SKU, and an unlinked numeric SKU is its own canonical, so four
stores sharing `148534` collapse into one item for free. There is no link to remove and no
`unlink` op that helps. Do not propose one; report the collision in `dataQuality[]` instead.

Resolving them needs a new mechanism (a `(storeId, sku)` split/"cuts" file that re-keys the odd
listing out of the shared aggregate, parallel to how `sku_hidden.json` is keyed). Not built yet — **deferred by the owner (2026-09-23) until the full-library audit is complete** and
the links/ignores are trusted; verified cases accumulate in `data/sku_collisions.json` (21 as of
2026-09-23; the table above is the original 2026-09-20 sample).

**Distinct from the same-STORE collision class** (`merge.js` SKU annihilation — BSW `795231`,
`798880`, `845142`, Sierra Springs `001222`), which is a scraper concern and is already fixed.
Its symptom here: one store showing two rows under the same SKU with a material price gap. Treat
those as different products and never link either side on SKU identity alone.

## Amendment protocol

- New class or changed call → propose it in the audit report with concrete `(SKU, name)` pairs.
- The human merges amendments. The agent edits this file only on explicit instruction.
