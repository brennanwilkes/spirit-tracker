# Search aliasing: Gordon & MacPhail first, then other bottlers and distilleries

Status: **G&M built 2026-10-12** (approach A + the one-letter-token fix). Table:
`viz/app/search_aliases.js`; acceptance check: `node tools/check_search_aliases.mjs [--index <file>] [--list]`.
On the 2026-10-12 index every spelling returns the same 202 groups (198 explicit + the 4 marker-less
ones), with no Gordon's Gin, Invergordon or Benromach. Other bottlers and distillery aliases (below)
remain future scope. The measurements below were taken 2026-10-09 (34,800 listings, 8,434 canonical
groups), before the build.

## The ask

Any way a person might type the bottler's name (`g&m`, `G & M`, `gm`, `g and m`, `gordon macphail`,
`Gordon & MacPhail`, `gordon and macphail`, `g+m` …) should return the same result set: every G&M
SKU in the catalog and nothing else. This should work on the search page (`#/`), store page and
shortlist page, which all share one matcher.

## How search works today

- `viz/app/sku.js::normSearchText` lowercases, folds diacritics, turns every non-alphanumeric run
  into a space. `tokenizeQuery` splits the result on spaces.
- `matchesAllTokens` requires every token to be a **substring** of the item's `searchText`.
- `searchText` is built per canonical group in `viz/app/catalog.js` from every listing's sku, name,
  **url** and store label. Names from every store in the group are included, so a group is findable
  by any store's spelling. `store_page.js:381` adds names from other stores the same way.

Consumers of `matchesAllTokens`: `search_page.js`, `store_page.js`, `shortlist_page.js`, plus the
linker pages (being deleted, see `link-pages-removal-plan.md`).

## What each spelling returns today

"Explicit G&M group" = a canonical group where at least one listing's name carries a G&M marker
(`Gordon & MacPhail`, `Gordon and MacPhail`, `G&M`, `G & M`, `G AND M`, `Gm`, `MacPhails`).
There are **197** such groups (149 live). That label is the yardstick below. It is not ground truth,
because it misses unmarked G&M bottles (see the next section).

| Query | Tokens after normalising | Groups hit | G&M groups hit | Non-G&M hit | Recall |
|---|---|---|---|---|---|
| `g&m` / `g & m` | `g`, `m` | **6,950** | 197 | 6,753 | 100% |
| `gm` | `gm` | 57 | 29 | 28 | 15% |
| `g and m` | `g`, `and`, `m` | 2,673 | 47 | 2,626 | 24% |
| `gordon` | `gordon` | 178 | 156 | 22 | 79% |
| `macphail` | `macphail` | 160 | 156 | 4 | 79% |
| `gordon macphail` / `gordon & macphail` | `gordon`, `macphail` | 159 | 156 | 3 | 79% |
| `gordon and macphail` | `gordon`, `and`, `macphail` | 37 | 37 | 0 | 19% |
| `g&m macallan` | `g`, `m`, `macallan` | 45 | 5 | 40 | 3% |
| `connoisseurs choice` | `connoisseurs`, `choice` | 63 | 62 | 1 | 31% |
| `cc` | `cc` | 162 | 62 | 100 | 31% |

So every spelling fails, each in its own way:

1. **`g&m` is the worst.** `&` becomes a space, leaving two one-letter tokens, and a one-letter
   substring matches almost anything. It returns 82% of the catalog.
2. **`gordon` / `macphail` miss the abbreviated listings.** 45 G&M groups (32 live) are spelled only
   as `G&M` in every listing, mostly Kensington Wine Market (`G&M CC Glentauchers 2000 KWM Cask`),
   Legacy, Malts & Grains and Co-op (`Gm Macphails Pulteney`). They are the KWM/club casks, which
   are the bottles people search for.
3. **Substring matching gives false positives.** `gordon` hits Gordon's London Dry Gin (BCL, ARC)
   and `Invergordon`. `macphail` hits Moonbroch "Spaceman Macphail". `cc` hits any word containing
   "cc".
4. **`and` is a real token.** `gordon and macphail` requires the literal word `and`, so it drops the
   `&` spellings and reaches only 19%.

Some results are right for an accidental reason. Elbow Liquor's `GLEN GRANT MR. GEORGE LEGACY 2ND ED
1957` and `PRIVATE COLLECTION MILTON 1949` carry no G&M marker in the name. They match `gordon`
only because the url slug is `gordon-macphail-…` and urls are in `searchText`.

## What "all G&M SKUs" means: the membership question

Fixing the spellings is easy. Deciding what counts as a G&M product is not, because many G&M
bottles don't name the bottler. These are the categories, with today's counts:

| Signal | Example | Groups with no explicit marker | G&M? |
|---|---|---|---|
| Name sub-range, G&M only | `Braes of Glenlivet 1975 31 Year Old Connoisseurs Choice` (Liberty) | 1 | Yes. Connoisseurs Choice, Speymalt, Mr George Legacy, Distillery Labels and Generations are all G&M-only ranges |
| Url slug | Elbow's Mr George / Private Collection bottles | 3 | Yes, and already found through the url |
| Generic range word | `Private Collection`, `Discovery` | Discovery: 11, **none of them G&M** (Pokeno, Nikka, Two Stacks …) | Only when a G&M marker is also present. Unsafe alone |
| Abbreviation | `G&M CC …`, `Gm Cc D Miltonduff 10` | n/a (that is the marker) | Yes |
| G&M-owned distillery | Benromach (46 groups) | 46 | **No.** Benromach distillery bottlings are not G&M products. A G&M-branded bottle distilled at Benromach (`GORDON AND MACPHAIL - BENROMACH LIMITED EDITION 50YO`) already carries a marker and is in |
| Name collision | Gordon's Gin, Invergordon, Moonbroch "Spaceman Macphail" | n/a | No |

So the target set is the 197 explicit groups, plus the few with an unambiguous sub-range or url
signal. The word `benromach` is never a signal.

## Approaches

### A. Brand-alias token (recommended, small)

Add one alias table for multi-spelling brands, used on both sides of the match:

- **Index side** (`catalog.js`, and `store_page.js`'s supplement): before `normSearchText`
  removes the `&`, run the raw name and url through the alias patterns. On a match, append a
  synthetic token such as `gordonmacphail` to `searchText`. Detection needs the raw text, because
  `G&M` and `G M` look identical once normalised.
- **Query side** (`tokenizeQuery`): apply the same patterns to the raw query first. Replace any
  match with the synthetic token, then tokenize the rest as before. `g&m macallan` becomes
  `["gordonmacphail", "macallan"]`.

Patterns (case-insensitive, word-bounded), drawn from the spellings in the catalog:
`gordon\s*(&|and|\+|/)?\s*mac\s*phail`, `g\s*(&|\+|/|and)\s*m`, `\bgm\b` (query side, and on the
index side only next to `macphails`/`cc`), the slug forms `gordon-macphail` and `g-m-`, and the
G&M-only range names (`connoisseurs? choice`, `speymalt`, `mr\.? george`, `distillery labels`,
`generations`). There is no bare `macphail` pattern: every `MacPhails` listing in the catalog
already carries `G&M`/`Gm`. Leaving it out also keeps Moonbroch "Spaceman Macphail" out, though the
owner considers that case unimportant either way.

Group aggregation spreads the token automatically. If any listing in a canonical group is tagged,
the whole group matches, whichever spelling the other stores used.

Cost: one shared module (`viz/app/search_aliases.js`) imported by `sku.js` and `catalog.js`, about
50 to 80 lines. To follow the "one source of truth" rule, both sides must use the same pattern list.
Add a node check that runs every spelling in the table above against `index.json` and asserts they
all return the same set. Estimate: half a day to a day, most of it spent reviewing the member list.

Two side effects:
- **Bare words stay plain search (decided).** `gordon` alone keeps its ordinary substring behaviour
  and still returns Gordon's Gin. Only a full bottler spelling (`g&m`, `gordon macphail`, `gordon &
  macphail` …) collapses to the alias, and the alias returns G&M products only. So `gordon` and
  `gordon macphail` legitimately give different results.
- **Fixing one-letter tokens in general.** Problem 1 is not specific to G&M. Any `x&y` query
  (`a&w`, `b&b`) breaks the same way. A general rule would help every query: a 1-character token
  must match a whole word, not a substring. It is about 5 lines in `matchesAllTokens` and needs a
  word-split `searchText` or a regex.

### B. Precomputed `bottler` field (larger, more accurate)

Tag each canonical group with `bottler: "gordon-macphail"` at build time (`build_viz_index.js`,
CJS, so the patterns would need a CJS twin, like `sku_canonical.js`). Search would map the alias
query onto that field, and it would also enable a bottler filter chip and a bottler page. That is
the right home if more bottlers follow (Signatory, Cadenhead, SMWS already has `smws.js`, A.D.
Rattray, Douglas Laing / `DL`, `TBWC`). A sub-case: the audit policy already treats "independent
bottler" as part of product identity (`data/sku_link_policy.md`, ruling 2026-09-20), so the same
classifier could serve both. The cost is more files touched, plus a CJS/ESM pair to keep in sync.
Estimate: 2 to 3 days.

### C. Reuse the linker's mined aliases: no

`viz/app/linker_page/sku_aliases.js` is mined from link labels for **blocking only**, and nothing in
the scorer may treat it as a verdict. It is also being reshaped by the audit work. Search should not
depend on it.

## Recommendation

Do **A**, together with the general one-letter-token fix, and design the alias table so it can grow
into B's bottler list later.

## Decisions (owner, 2026-10-10)

1. **Benromach is out**, unless the bottle is G&M-branded and merely distilled at Benromach. Those
   bottles already name G&M, so no Benromach rule is needed.
2. **A bare `gordon` stays a plain substring search** and should still find Gordon's Gin. A G&M
   search (any full spelling of the bottler) must not.
3. **Moonbroch "Spaceman Macphail" is not a concern.** No explicit exclusion needed. Dropping the bare
   `macphail` pattern happens to keep it out anyway.
4. **Scope is G&M only.** Other independent bottlers (Signatory, Cadenhead, Douglas Laing, TBWC …)
   are a later, bigger question. The alias table should be shaped so they can be added, but they
   are not part of this change.

## Acceptance check (for the implementation)

Run against the live `index.json`:
- `g&m`, `G & M`, `gm`, `g and m`, `g+m`, `gordon macphail`, `Gordon & MacPhail`,
  `gordon and macphail` all return the **same** group set.
- That set contains all 197 explicit groups plus the 4 marker-less ones (Elbow's two Mr George
  Legacy bottles and the Milton 1949 Private Collection, and Liberty's Braes of Glenlivet
  Connoisseurs Choice).
- It contains no Gordon's Gin, no Invergordon, and no Benromach distillery bottling.
- `gordon` alone still returns Gordon's Gin.
- `g&m macallan` returns only the G&M Macallan bottles (Speymalt), not the 40 unrelated hits it
  returns today.

## Reproducing the numbers

The measurement was a throwaway scratch script. It loads `viz/data/index.json` from
`.worktrees/data`, canonicalises skus with `src/utils/sku_map.js::loadSkuMap`, builds `searchText`
per group the way `catalog.js` does (sku + name + url + store label), and runs each query through
the real `tokenizeQuery` / `matchesAllTokens` from `viz/app/sku.js`. Hidden listings were not
filtered, so counts can be slightly high (by a few groups at most).

## Extending to other independent bottlers (future scope)

G&M is the only one in the first change (decision 4). This section sizes the rest, so the alias
table can be built in a shape that takes them later. Measured 2026-10-10 on the same `index.json`.
"Groups" means canonical groups where some listing's name carries the bottler's name, an
abbreviation, or one of its range names. Like the G&M yardstick, this is a floor, not ground truth.

### How bad search is today, per bottler

| Bottler | Groups | Today's best full-name query | Why it falls short |
|---|---|---|---|
| **Hunter Laing** | 132 | `hunter laing` 19% | Most bottles carry only a range name: Old Malt Cask / `OMC`, First Editions, Hepburn's Choice, Old & Rare, Kill Devil (rum). `hl` hits 1,233 groups |
| **Douglas Laing** | 112 | `douglas laing` 38% | Range names alone: Old Particular, XOP, Provenance, plus the house blended malts (Big Peat, Timorous Beastie, Scallywag, Rock Island, Epicurean, King of Scots). `dl` finds 0 of them and 60 other groups |
| **That Boutique-y Whisky Co.** | 103 | `tbwc` 43%, `boutique-y` 79% | Three spellings, `TBWC` / `Boutique-y` / `That Boutique-y Whisky Company`. `boutiquey` (no hyphen) finds 2% |
| **Berry Bros & Rudd** | 41 | `berrys` 63%, `berry bros` 44% | KWM writes `Berrys …`, others write `Berry Bros. & Rudd`. `bbr` finds nothing |
| **Elixir Distillers / Single Malts of Scotland** | 29 | `smos` 66%, full name 48% | KWM writes `SMOS`, BCL writes the full name. `elixir` finds 0 |
| **Single Cask Nation** | 41 | `scn` 80%, full name 76% | CLB writes `Scn …`, others write the full name. Neither finds both |
| **Signatory** | 127 | `signatory` 100% | Fine, except `signatory vintage` 54%, and Malts & Grains writes `SV …` (7 groups, invisible to `signatory`). `sv` hits 29 other groups |
| **Duncan Taylor** | 41 | `duncan taylor` 98% | Mostly fine. A few `DT …` listings, and The Octave range |
| **Cadenhead** | 91 | `cadenhead` 100% | Fine. `cadenheads` / `cadenhead's` (the brand's own spelling) finds 9% |
| **A.D. Rattray** | 10 | `rattray` 100% | `ad rattray` 50%, because `A.D.` normalises to `a d` |

These already work with plain search and need no alias: Adelphi (69), Càrn Mòr (41; diacritics are
already folded), Murray McDavid (19), Whisky Sponge (48), Decadent Drams (55), The Whisky Agency
(35), Valinch & Mallet (27), Rum Nation (24), Moonbroch (37), Blackadder (10), Thompson Bros, Watt
Whisky, Wemyss, Samaroli. SMWS (248) already has its own handling in `smws.js` and its cask codes.

### Where the value is

1. **Hunter Laing and Douglas Laing, by a wide margin.** Over 60% of their bottles never name the
   bottler, so no amount of typing finds them as a set today. They need range names tagged on the
   index side, the same idea as G&M's Connoisseurs Choice and Speymalt.
2. **TBWC, Berry Bros, SMoS, Single Cask Nation.** Every bottle names the bottler, but stores split
   between an abbreviation and the full name. These are pure spelling aliases, the same shape as
   `G&M` ↔ `Gordon & MacPhail`.
3. **Signatory, Duncan Taylor, Cadenhead, A.D. Rattray.** Small gains. Two of the four are fixed by
   general normalisation rather than aliases (next section).

### General normalisation fixes (help every query, not just bottlers)

- **One-letter tokens match whole words** (already proposed above for `g&m`).
- **Join runs of single letters** on both sides: `a d rattray` → `ad rattray`, `boutique y` →
  `boutiquey`. That fixes A.D. Rattray and the TBWC hyphen without aliases.
- **Fold the possessive `'s`**: `cadenhead's` / `cadenheads` → `cadenhead`, `laings` → `laing`.

### Range names: tag only when the context proves it

Range names collide with other products, so each needs its own rule. All of these were checked
against the live catalog:

- **`First Edition(s)`**: every live hit is Hunter Laing, always followed by a distillery. Safe.
- **`Provenance`**: Douglas Laing when it starts the name (`PROVENANCE GLENTAUCHERS 7 YO`). Not
  Bruichladdich `Micro-Provenance` (7 groups).
- **`Octave`**: Duncan Taylor for `The Octave <distillery>`. Not `Aberlour Octave`, and not Murray
  McDavid's `Octave Finish`.
- **`Old & Rare`**: Hunter Laing, but `Glenrothes - 17 Year Old And Rare` (BSW) is a parse
  accident of "17 Year Old" + "Rare". Require `old (&|and) rare` before a distillery name, not after
  an age.
- **Abbreviations as index markers** (`SV`, `DT`, `HL`, `DL`, `OMC`, `SCN`, `SMOS`, `TBWC`):
  only as a whole word, and for the two-letter ones only at the start of the name or next to a
  range word (`… FIRST EDITION HL`). On the query side a whole-word abbreviation can map straight
  to the alias.

### The Benromach rule, applied to the others

Decision 1 generalises: **a bottler's alias covers products that carry its brand, never the
distillery it happens to own.** That excludes:

| Bottler | Owned distillery or brand: excluded |
|---|---|
| Signatory | Edradour |
| Cadenhead | Springbank, Longrow, Hazelburn, Kilkerran (common owner, J&A Mitchell) |
| Adelphi | Ardnamurchan |
| Hunter Laing | Ardnahoe |
| Elixir Distillers | none in the catalog yet |

**Open, for the owner** (the broader-match principle in §"Owner rulings" leans towards *include*):
house brands that are not distilleries but are the bottler's own label.
Douglas Laing's Big Peat / Timorous Beastie / Scallywag / Rock Island (57 groups, most with
"Douglas Laing" in at least one listing), and Elixir's Port Askaig and Black Tot. They are
bottler-branded, so the G&M rule ("G&M-branded counts") points to *include*. But they are not
independent bottlings of someone else's distillery.

### Suggested order, when this is picked up

1. The general normalisation fixes. No table needed, and they help everything.
2. Pure spelling aliases: TBWC, Berry Bros, SMoS, Single Cask Nation (plus G&M, already done by then).
3. Range-name tagging for Hunter Laing and Douglas Laing, each with an acceptance check like G&M's.
   The largest gain, and the most per-rule review.
4. Approach B (a `bottler` field with a filter chip) once there are about 5 bottlers in the table.
   The audit policy already treats the bottler as part of a product's identity, so one classifier
   could serve both search and linking.

## Distillery aliases (future scope, separate from bottlers)

A second kind of alias: a search for a **distillery** should also find the brands and code names it
is sold under. `springbank` should find Longrow and Hazelburn, and `highland park` should find
`Secret Orkney`. Measured 2026-10-10 on the same catalog.

### How it differs from a bottler alias

- **It is one-way.** `springbank` should find Longrow, but `longrow` should not return every
  Springbank. The bottler alias collapses equal spellings into one token. This one adds a parent
  word to the child's search text, and only on the index side. The query side changes nothing.
- **It does not conflict with the Benromach rule.** That rule is about who *bottled* a product (G&M
  did not bottle the Benromach distillery bottlings). This is about where it was *distilled*. A
  Cadenhead Longrow is a Cadenhead bottle and a Springbank-distilled bottle, and the Cadenhead
  search still excludes Springbank's own bottlings.
- **It is search-only.** Same distillery is not the same product, so this table must never feed
  linking decisions. It could, at most, widen the audit's candidate pool, because a pair like
  `SCN Williamson` ↔ a Laphroaig is invisible to token matching.

### Three classes, with catalog counts

"Groups" counts canonical groups whose names carry the alias. "Alias only" counts those where no
listing names the distillery, which a distillery search cannot find today.

**1. Distillery-owned brand families** (the distillery's own second label). Safe to tag.

| Search for | Should also find | Groups | Alias only |
|---|---|---|---|
| Springbank | Longrow, Hazelburn, Kilkerran | 8 + 2 + 11 | 6 + 2 + 11 |
| Bruichladdich | Port Charlotte, Octomore | 10 + 20 | 2 + 2 |
| Tobermory | Ledaig | 28 | **25** |
| Loch Lomond | Inchmoan, Inchmurrin, Croftengea | 17 | 13 |
| Knockdhu | anCnoc | 10 | 8 |
| Macduff | Glen Deveron, The Deveron | 4 | 4 |
| Edradour | Ballechin | 8 | 0 |
| Ardmore | Ardlair | 2 | 2 |
| GlenAllachie | Meikle Tòr | 0 | 0 (not stocked today, add anyway) |

**Kilkerran is included** (owner ruling 2026-10-10), even though it is distilled at Glengyle, a
separate distillery with the same owner (J&A Mitchell). **Brora** is a separate distillery from
Clynelish, so it is not an alias.

**2. Undisclosed or code names used by independent bottlers.** Tag only where the industry
mapping is firm.

| Code name | Distillery | Groups | Alias only | Confidence |
|---|---|---|---|---|
| `Orkney` (any form) | Highland Park | 38 | **34** | Owner ruling 2026-10-10: tag every `orkney`. Scapa is also on Orkney, so `highland park` may return the odd Scapa, which is accepted |
| `Williamson` | Laphroaig | 8 | 4 | High |
| `Burnside` | Balvenie (teaspooned) | 5 | 3 | High |
| `Westport` | Glenmorangie (teaspooned) | 3 | 1 | High |
| `Glenlitigious` | Glenfarclas (community identification) | 4 | 2 | Included (owner ruling 2026-10-10) |
| `Speymalt from Macallan` | Macallan | 5 | 0 | Already names Macallan |

Not to tag: `Secret Speyside` (4: Longmorn, Tamdhu "(Tam)" and others, so no single distillery),
`Kildalton` (3: a region or blended malt), bare `Islay` / `Speyside` / `Highland` undisclosed malts.

**3. Spelling variants of the distillery name.** These belong with the general normalisation, not
the alias table: `Glengarioch` ↔ `Glen Garioch`, `Glen Allachie` ↔ `GlenAllachie`, `Bunnahabhian`,
`Coal Ila` / `Call Ila`, `Ben Riach` ↔ `BenRiach`. Store typos are open-ended. A general
space-insensitive match (join `glen <x>` ↔ `glen<x>`) catches the most common class. A small
misspelling table catches the rest as they turn up.

### Owner rulings (2026-10-10)

- **Orkney:** any `orkney` in a name tags it as Highland Park. A Highland Park search that returns an
  occasional Scapa, and an `orkney` search that returns both distilleries, are both acceptable.
- **Kilkerran:** included under `springbank`.

- **`springbank 10` also returns Longrow 10 (and Hazelburn/Kilkerran 10).** Plain index-side
  tagging is enough. No ranking or special query token is needed.
- **Community identifications count.** Code names that are firm in practice but never printed on the
  label (`Glenlitigious` → Glenfarclas) are tagged.
- **Guiding principle: prefer a broader match over a tighter one.** A few extra results are fine. A
  missing one is not. When a rule is borderline, tag it. Skip only names that point to no single
  distillery (`Secret Speyside`, `Kildalton`, bare region names), because there is nothing to tag
  them with.

### Size

The same shape as approach A, plus a one-way `parent` field per table entry. The table is about 25
rows to start with. The real cost is curating the code names (class 2), which needs the same
per-rule live-catalog check as the bottler range names.


---

# Archive: search matching + brand aliases summary (from CLAUDE.md)

> Moved verbatim from the root `CLAUDE.md` on 2026-10-14 to keep that file small. CLAUDE.md keeps a condensed summary and a pointer here. Section cross-references (§"…") refer to the old CLAUDE.md layout; most of those sections now live in docs/ files named in CLAUDE.md.

Search (`viz/app/sku.js` `normSearchText`/`tokenizeQuery`/`matchesAllTokens`) strips punctuation
and matches every token as a SUBSTRING of a group's `searchText` (from `catalog.js`: every listing's
sku, name, **url** and store label; `store_page.js` adds other stores' names). Two exceptions:
- **A one-character token must be a whole word** (else `g&m` → `g`+`m` hit 82% of the catalog).
  So `tokenizeQuery` drops possessives (`gordon's` → `gordon`); a lone `s` would miss `GORDONS`.
- **Brand aliases** (`viz/app/search_aliases.js`, one table for both sides): detection runs on
  RAW text, before `&` is stripped. Index side appends a synthetic token (`gordonmacphail`) to
  `searchText` when a spelling or an index-only marker (G&M-only range names, `g-m` slugs) hits;
  query side REPLACES a full spelling with the token. Range-name markers never apply to queries,
  and a bare `gordon` stays plain search. Any edit: run `node tools/check_search_aliases.mjs`.
G&M only for now. `docs/gm-search-aliasing.md` sizes the next bottlers (Hunter/Douglas Laing gain
most: >60% of their listings show only a range name) and a one-way, search-only DISTILLERY alias
class (Springbank→Longrow, Tobermory→Ledaig, Highland Park→Orkney …). Same distillery is not the
same product, so that table must never feed linking. Owner principle: **prefer a broader match
over a tighter one**. `stats_page.js` keeps its own tokenizer and gets none of this.
