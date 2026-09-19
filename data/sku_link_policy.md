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
| Packaging / re-list | link | `Vintage Packaging`, `(Without Tube)`, `PET` vs glass at the same volume, re-brands / re-labels are the same spirit. Marital: `Compass Box Artist` ↔ `Great King Street Artist's Blend` |
| Size | separate | `375ml` / `700ml` / `1.14L` / `1.75L` are distinct SKUs. **Tolerance: treat near-identical volumes as the SAME size** — 700 ≡ 750, 375 ≡ 350, 1.0L ≡ 1.14L is NOT within tolerance. See "Inferring an unstated size" below |
| ABV / proof | separate | A stated ABV or proof difference beyond rounding means a different bottling: `Macallan Sherry Oak 12` vs `… 12 110 Proof`; a standard bottling vs its Cask Strength sibling. `40%` vs `40.0%`, or an ABV stated on one side only, is NOT evidence of difference |
| Vintage year | separate | Distinct vintage releases are different SKUs: `Glenfarclas 2001` vs `Family Cask 2002`; `Glenfarclas FC 1979` is its own release, not the 12yo |
| Batch / cask | separate | Batch/cask codes are distinct SKUs: `Tamdhu Batch Strength 007` vs `008`; `SMWS 8.47` ≠ `8.46`. **But a code that MATCHES on both sides is positive evidence they ARE the same bottling** — `GlenDronach 1993 28YO Cask 4193` ↔ `GLENDRONACH 28YO 1993 CASK 4193` links |
| Limited / annual edition | separate | A named annual or limited release is its own SKU even with no year in the title: `Drumshanbo Gunpowder Year of the Dragon` ≠ plain `Gunpowder`; `Laphroaig Cairdeas 2026` ≠ `Cairdeas 2025` |
| Store / exclusive cask | **separate** | **A store's own name or abbreviation inside the product title almost always marks that store's exclusive single cask** — `Glenfarclas Coop 15yr`, `Old Pulteney Coop 2006`, `Plantation Rum Coop 2011`. Treat it as a different bottling from the standard expression, even when the price sits inside the normal range for the standard one (confirmed by the owner 2026-09-19: Co-op carries `Glenfarclas Coop 15yr` $119.99 AND `Glenfarclas 15 yr` $129.99 — the $10 gap is not the signal, the name is) |
| Gift / sampler / tasting set | separate | Multi-bottle sampler and tasting sets are their own SKU, never a single expression |
| Bundle / multipack | judgement | See "Bundles" below |

## Inferring an unstated size

When a title carries no volume and no confidently-linked sibling supplies one, estimate it from
the price ladder rather than assuming. If a store lists a 375 at $20 and a 1.14L at $60, a
sizeless listing at $40 is almost certainly the 700/750. Only link on an inferred size when the
ladder is unambiguous; otherwise it goes in `review[]`.

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

## Amendment protocol

- New class or changed call → propose it in the audit report with concrete `(SKU, name)` pairs.
- The human merges amendments. The agent edits this file only on explicit instruction.
