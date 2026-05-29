# SKU-Matching Algorithm — Technical Report

This document is the formal description of the SKU-matching algorithm that powers
both the `#/link` curation page and the `#/link-rapid` keyboard tool. It covers
the pipeline (preprocessing → vocabulary → per-pair scoring), the formulas
behind the score, the full list of tuned constants, and the named hard cases the
eval harness re-checks on every change.

Single source of truth for scoring lives in
`viz/app/linker_page/suggestions.js::scorePairWithVocab` (called from the live
ranker `recommendSimilar` and from `tools/linker_eval.mjs`).

---

## 1. Pipeline overview

```
  raw item name
        │
  ┌─────▼─────┐
  │ normalise │  lowercase, strip punctuation        (sku.js::normSearchText)
  └─────┬─────┘
  ┌─────▼──────────────────┐
  │ brand-alias detection  │  inject __bnd_X synth tokens for known
  └─────┬──────────────────┘  abbreviations (TBWC, BNS, OMC, G&M, BWE, SCN, …)
  ┌─────▼────────────────────┐
  │ glued-numeric expansion  │  letter↔digit boundary inserts a space
  └─────┬────────────────────┘  e.g. "blairathol11yo" → "blairathol 11 yo"
  ┌─────▼─────────────────┐
  │ tokenizeQuery + filter │  filterSimTokens drops stop words, equivalence
  └─────┬─────────────────┘  map, volume/ABV inline patterns
  ┌─────▼──────────────┐
  │ possessive repair   │  "macaloney" + "s" → "macaloneys"
  └─────┬──────────────┘
  ┌─────▼────────────────────────┐
  │ number/age-token filtering   │  drop 1–2 digit numbers and ABV decimals;
  └─────┬────────────────────────┘  drop glued age tokens ("10yr", "18yo")
  ┌─────▼─────────────────────────────┐
  │ compound-split (catalog-derived)  │  if a glued token ≥6 chars segments
  └─────┬─────────────────────────────┘  into dict words whose adjacent
                                         BIGRAM exists in the catalog →
                                         replace with pieces ("tincup" → tin+cup;
                                         "bridgeland" stays put because
                                         "bridge land" never appears spaced)
        │
   unigram list
        │
        ▼
  add unordered adjacent bigrams  →  TERM SET for this listing
```

The same pipeline runs over every catalog listing to build the vocabulary, then
again at scoring time per item being compared.

---

## 2. Vocabulary & IDF

Let `I = { items in the catalog }`, `N = |I|`. For each item `i ∈ I`:

- `unigrams(i)` = ordered list produced by the pipeline above.
- `bigrams(i)` = `{ "b:" + sort(a,b).join("~") : (a,b) adjacent in unigrams(i), a,b alphabetic }`.
- `terms(i)` = `unigrams(i) ∪ bigrams(i)`.

Document frequency and IDF:

```
df(t)  = |{ i ∈ I : t ∈ terms(i) }|
idf(t) = ln( (N + 1) / (df(t) + 1) )
```

Distinctive term predicate:

```
distinctive(t)  ⇔  idf(t) ≥ ι           (ι = 4.6)
D(i)            =  { t ∈ unigrams(i) : distinctive(t) }
```

Co-occurrence (built once over all items, only over distinctive unigrams):

```
cooc(t) = { t' : ∃ i ∈ I such that {t, t'} ⊆ D(i),  t' ≠ t }
```

---

## 3. Per-pair scoring formula

For a target item `T` and a candidate item `C`, the final score is the product
of one base term and a sequence of multiplicative modifiers.

### 3.1 Base term

Two ingredients, both order-independent over the term sets.

**Token-containment F1** (uses filtered unigrams from `filterSimTokens`):

```
A = filterSimTokens(T),  B = filterSimTokens(C)
inter   = |A ∩ B|
recall  = inter / min(|A|, |B|)
prec    = inter / max(|A|, |B|)
contain(T,C) = 2·prec·recall / (prec + recall)        (F1)
```

**Directional IDF-weighted overlap** (asymmetric Jaccard with extras discount and
redundant-bigram discount):

```
A = terms(T),  B = terms(C)
shared      = A ∩ B
aOnly       = A \ B            ( = target-only terms — full weight )
bOnly       = B \ A            ( = candidate-only terms — discounted )

For a bigram term t = "b:x~y" and reference set S:
   redundant(t, S)  ⇔  x ∈ S  ∧  y ∈ S

w(t, S) = ρ · idf(t)    if redundant(t, S)
        = idf(t)        otherwise                     (ρ = BIGRAM_REDUNDANT_WEIGHT = 0.2)

interW  = Σ_{t ∈ shared}  idf(t)
aOnlyW  = Σ_{t ∈ aOnly}   w(t, B)
bOnlyW  = Σ_{t ∈ bOnly}   w(t, A)

wo(T,C) = interW / ( interW + aOnlyW + α · bOnlyW )    (α = EXTRA_TERM_WEIGHT = 0.4)
```

**Base score:**

```
s_base(T,C) = ( φ_base + contain(T,C) ) · ( 1 + wo(T,C) ) ^ p_wo
              φ_base = 0.05   (BASE_FLOOR)
              p_wo   = 3.0    (WO_POW)
```

### 3.2 Top-term bonus

Let `t*(i) = argmax_{t ∈ unigrams(i)} idf(t)`.

```
bonus_top(T,C) = ( 1 + τ )    if idf(t*(T)) ≥ ι  ∧  t*(T) ∈ terms(C)
               = 1            otherwise            (τ = TOP_TERM_BONUS = 0.6)
```

### 3.3 Target distinctive coverage (binary)

Strong demote when the candidate lacks one of the target's distinctive (edition-marker)
unigrams.

```
M = |{ t ∈ D(T) : t ∈ terms(C) }|
K = |D(T)|
coverage_T(T,C) = M / K                        (if K = 0, coverage_T = 1)

pen_T(T,C) = 1                                  if coverage_T = 1
           = max( φ_T,  coverage_T ^ ε_T )      if coverage_T < 1
                                                (φ_T = 0.2, ε_T = 1.5)
```

### 3.4 Graded coverage (only when pen_T fires no penalty)

IDF-weighted coverage over ALL target unigrams — catches moderate-IDF terms the
candidate lacks (e.g. `sherry` for Bridgeland Innisfail Sherry Cask) without
double-counting when binary coverage already fired.

```
Q = unigrams(T)
covIdf(T,C) = ( Σ_{t ∈ Q ∩ terms(C)} idf(t) ) / ( Σ_{t ∈ Q} idf(t) )

pen_G(T,C) = 1                                  if coverage_T < 1   (skip)
           = 1                                  if covIdf = 1
           = max( φ_G,  covIdf ^ ε_G )           otherwise
                                                (φ_G = 0.4, ε_G = 1.5)
```

### 3.5 Candidate distinctive coverage (cooc brand-descriptor filtered)

Penalize when the candidate carries its OWN distinctive edition the target lacks —
but EXCLUDE brand-boilerplate words that broadly co-occur with the brand context.

```
S_shared = D(T) ∩ terms(C)                     (shared distinctive on target side)

For t ∈ D(C):
   brandDescriptor(t)
     ⇔  |cooc(t)| ≥ β
        ∧  ∃ s ∈ S_shared : s ∈ cooc(t)         (β = BRAND_DESCRIPTOR_BROADNESS_MIN = 5)

K' = |{ t ∈ D(C) :  t ∈ terms(T)  ∨  ¬brandDescriptor(t) }|
M' = |{ t ∈ D(C) :  t ∈ terms(T) }|

coverage_C(T,C) = M' / K'                       (if K' = 0, coverage_C = 1)

pen_C(T,C) = 1                                  if coverage_C = 1
           = max( φ_C, coverage_C ^ ε_C )       if coverage_C < 1
                                                (φ_C = 0.2, ε_C = 1.5)
```

### 3.6 Size multiplier σ(T,C)

Sizes are extracted from name text via `parseSizesMlFromText` (units converted
to mL: 1.14L → 1140, 1.75L → 1750, etc.) and then canonicalised through
equivalence buckets so 700↔750, 350↔375, etc. are treated as the same size.

```
SIZE_BUCKETS = [ 50, 100, 200, 375, 500, 700, 1000, 1140, 1500, 1750, 3000 ]
canonSize(x) = bucket containing x  (or x if no bucket matches)

Σ(i) = { canonSize(s) : s ∈ parseSizesMlFromText(i.name) }

if Σ(T) = ∅  ∧  Σ(C) = ∅:           σ = 1
if Σ(T) ≠ ∅  ∧  Σ(C) ≠ ∅:           σ = 1.0       if Σ(T) ∩ Σ(C) ≠ ∅
                                    σ = 0.08      otherwise
if exactly one is empty:            see below     (price-ratio inference)
```

**One-sided size — price-ratio inference**: when only one side states a size, use
the cheapest-price ratio to guess the missing size. A sizeless listing priced
~2× a 375 mL is probably a 700 mL.

```
r = max(p_T, p_C) / min(p_T, p_C)
σ = 1.0   if p_T or p_C is unknown
σ = 1.0   if r ≤ 1.4
σ = 0.3   if r ≥ 1.6
σ = 0.7   otherwise
```

### 3.7 Price multiplier π(T,C)

(Legacy `buildPricePenaltyForPair` — kept unchanged from the pre-IDF era.)

```
gap = bestRelativeGap( prices(T), prices(C) )    /* over per-canonical group price sets */
π = 1.0                                   if gap ≤ 0.35
π = 1.0 - 0.25·(gap − 0.35)/0.15          if 0.35 < gap ≤ 0.50
π = 0.75 · (0.5 / gap)                    if gap > 0.50   (floored ~ 0.35)
```

### 3.8 Age multiplier α(T,C)

```
a_T = extractAge(T.norm)        /* /(\d{1,2})\s*(yr|yrs|year|years|yo)/ */
a_C = extractAge(C.norm)

if a_T  ∧  a_C:        α = 1.8   if a_T = a_C
                       α = 0.2   if a_T ≠ a_C
elif a_T ∧ ¬a_C:       α = 1.8   if a bare-numeric token equal to a_T is in C
                       α = 1     otherwise
else:                  α = 1
```

### 3.9 ABV multiplier λ(T,C)

```
b_T = extractAbv(T.norm)       /* parses "46.8 ABV", "46%", "92 proof" → 46.0 */
b_C = extractAbv(C.norm)

if b_T = ∅  ∨  b_C = ∅:        λ = 1
else:
   d = |b_T − b_C|
   λ = 1.15   if d ≤ 0.6        (rounding agreement)
   λ = 1.0    if d ≤ 1.5        (formatting noise)
   λ = 0.4    if d ≤ 3          (different bottling)
   λ = 0.12   otherwise         (clearly different strength — heavy demote)
```

### 3.10 Edition-code multiplier ψ(T,C)

Hard if/else on structured codes that uniquely identify a cask/release/batch.
**Codes are extracted from a period-preserving normalization** (`normForEditionCodes`,
not `i.norm`) so decimal codes survive — `normSearchText` strips the `.` and would
fuse `15.1` into the noise tokens `15`/`1`.

```
ε(i) = { kind:code : code ∈ extractEditionCodes(i.name) }

KINDS:
   smws    /\b\d{1,3}\.\d{1,4}\b/        53.471, 1.234   (gated on the "smws" word —
                                                          a bare \d.\d otherwise eats
                                                          ABV values like 59.1)
   smws    /\b[a-z]\d{1,3}\b/            R4, G1   (single letter + digits)
   roman   /\b(ix|iv|v?i{2,3}|x{2,3}|vi{1,3}|xi{1,3})\b/    II/III/IV/V/…
   season  /\b[sw]\d{2,4}\b/             S22, S24, S2023, W21
   release /\brelease\s+(\d{1,3})\b/, /\b(\d{1,3})(?:st|nd|rd|th)\s+release\b/   Release 42 / 46th Release
   year    /\b(?:1[89]|20)\d{2}\b/      1800–2099 vintage/annual (Black Tot 2024 vs 2025); 17xx excluded (1750 mL)
   series  /\bseries\s+(\d{1,3})\b/      Bootleg Series 3
   recipe  /\brecipe\s+(\d{1,3})\b/      Masahiro Recipe 01   (leading zeros normalized: 01≡1)
   chapter /\bchapter\s+(\d{1,3})\b/     Little Book Chapter 8
   batch   /\bbatch\s+(?:no\.?|#)?\s*(\d{1,3})\b/   Ardbeg Traigh Bhan Batch 7
   no      /\bno\.?\s*(\d{1,3})\b/, /\bn\.\s*(\d{1,2})\b/   Reserve No. 6, Satvrnal N.4
   ver     /\b(\d{1,2})\.(\d{1,2})\b/    Octomore 15.1   (guarded: skip if followed by
                                                          %/abv/proof, or value ∈ [20,75]
                                                          — those are ABVs, not versions)

Group ε(T) and ε(C) by kind. For each kind present on both sides:
   shared = ε(T)_kind ∩ ε(C)_kind
   If shared ≠ ∅ → mark sharedAny.
   Else            → mark conflictAny.

ψ = 1.15   if sharedAny
ψ = 0.1    if conflictAny (and not sharedAny)     — heavy demote
ψ = 1      otherwise
```

The numbered-edition / `ver` kinds encode the rule "same brand and line, but an
edition number present on BOTH sides that doesn't match ⇒ not a pair." Each keyword
is its own kind so a release number never conflicts with a series number. Validated
against the labels: `release`/`series`/`recipe`/`season`/`roman`/`smws` break **0**
confirmed groups; `chapter`/`ver` break 1; `batch`/`no` break 2 each — and those few
are debatable batch-to-batch merges (Bulleit Barrel Strength Batch 7↔8) or mislabels
(Alberta Rare Batch No.1 23yo ↔ No.2 21yo), demoted to ~`base·0.1` (≈1, still
reviewable) rather than deleted.

### 3.10b Concept-conflict multiplier κ(T,C)

Structured **mutually-exclusive concept** walls — the categorical complement to the
bag-of-tokens name score, which cannot see that "gin" and "whiskey" are not a
missing-token nuance but a hard wall. Detectors run on the **raw display name**
(so `0.0%` survives) and each group demotes when the two sides assert *disjoint*
nonempty member sets. Implemented in `concepts.js::conceptConflictMultiplier`.

```
category   gin | rum | vodka | tequila | mezcal | brandy | whisky
           (whisky = whisky|whiskey|bourbon|scotch|rye|malt). A name asserting >1
           category is ambiguous → asserts nothing. Cask/finish contexts are
           stripped first (ex-bourbon, rum cask, sherry butt …) so a finish word
           is not read as the spirit. Conflict → ×0.1   (0 confirmed-link breaks)

substyle   singlemalt | grain | potstill | bourbon | rye | corn
           RELIABLE distillation types only. "blend"/"blended malt" are NOT members:
           the catalog labels them interchangeably (same bottling tagged "Blended
           Malt" / "Blended Scotch" / even "Single Malt"), so they can't separate
           products. Only when category did NOT already conflict and both sides are
           (or could be) whisky. Conflict → ×0.25  (mislabels like rye↔bourbon)

batching   single (single barrel/cask) vs smallbatch.  Conflict → ×0.15   (0 breaks)

non-alc    0.0% / alcohol-free / zero-proof present on exactly one side → ×0.1
           (the "0.0%" needs the raw name; normSearchText drops the % and period)

markers    presence/absence nudges (NOT categorical — a store routinely drops the
           qualifier for the SAME product, so they break 20–30 confirmed links):
             cask strength present on one side only → ×0.7   (CASK_STRENGTH_MARKER)
             sherry        present on one side only → ×0.75  (SHERRY_MARKER)
           Set the constant to 1 to disable. Simulation showed the measurable
           AUC/PR effect is small (they help curated cases like Bridgeland Sherry
           but barely move labeled-pair recall); they do NOT "solve" cask-strength
           variants — ABV (λ) is the real lever when both sides state a strength.

κ(T,C) = product of the firing factors above (1 when none fire).
```

### 3.10c Store-exclusivity penalty χ(T,C)

A single store almost never lists the SAME product under two **distinct real**
SKUs. So if the candidate's canonical group already covers one of the target's
stores — and both SKUs are real — they are very likely DIFFERENT products the
store stocks side-by-side (most often two sizes whose size isn't written in the
name, e.g. Chivas Regal 12 at BCL as both a 750 mL and a 1.75 L).

```
realStores(C) = stores covered by C's canonical group (the aggregate's store set)

χ(T,C) = 0.35   if  ¬isBadSku(T) ∧ ¬isBadSku(C)
                 ∧  stores(T) ∩ realStores(C) ≠ ∅
       = 1      otherwise                       (STORE_EXCLUSIVITY_PENALTY = 0.35)
```

Gated to real↔real because a synthetic `u:`/`upc:`/`id:` SKU that shares a store
is almost always that store's own id-upgrade of the SAME listing (a true link),
not a distinct product — so it must NOT be penalized. Measured on the labeled
set, this gate fires on **56% of ignores but only ~4.5% of links**; at 0.35 it
correctly pushes ~215 more ignores below the auto-link line for a cost of ~45
demoted true links (a real-but-rare case: a store genuinely carrying one product
under two SKUs). This is the structured form of the entity-resolution
"uniqueness / one-to-one" constraint — a product maps to ≤1 SKU per store.

### 3.11 Bad-SKU boost β(T,C)

```
isBadSku(i.sku)  ⇔  sku is prefixed `u:` / `id:` / `upc:` or "unknown"
β(T,C) = 1.2     if isBadSku(T)  ∨  isBadSku(C)
        = 1      otherwise
```

### 3.12 Final formula

```
score(T,C) =
    s_base(T,C)
  · bonus_top(T,C)
  · pen_T(T,C)
  · pen_G(T,C)
  · pen_C(T,C)
  · σ(T,C)
  · π(T,C)
  · α(T,C)
  · λ(T,C)
  · ψ(T,C)
  · κ(T,C)
  · χ(T,C)
  · β(T,C)
```

If any factor is zero (e.g. `coverage_T = 0` and `φ_T = 0`), the score is zero;
all multipliers are floored above zero by construction.

---

## 4. Constants — full table

All constants live as `export const` in `viz/app/linker_page/vocab.js` and as
inline tuning knobs in `similarity.js` / `size.js`. They're tuned to maximise
fixture margins and minimise precision ceilings.

| name | symbol | value | where |
|---|---|---|---|
| Distinctive IDF threshold | ι | **4.6** | vocab.js |
| Base floor | φ_base | **0.05** | vocab.js |
| Weighted-overlap exponent | p_wo | **3.0** | vocab.js |
| Top-term bonus | τ | **0.6** | vocab.js |
| Extra-term weight (candidate-only) | α | **0.4** | vocab.js |
| Redundant-bigram weight | ρ | **0.2** | vocab.js |
| Target coverage floor | φ_T | **0.2** | vocab.js |
| Target coverage exponent | ε_T | **1.5** | vocab.js |
| Candidate coverage floor | φ_C | **0.2** | vocab.js |
| Candidate coverage exponent | ε_C | **1.5** | vocab.js |
| Brand-descriptor broadness min | β | **5** | vocab.js |
| Graded-coverage floor | φ_G | **0.4** | vocab.js |
| Graded-coverage exponent | ε_G | **1.5** | vocab.js |
| Compound min token length | — | **6** | vocab.js |
| Compound piece min length | — | **3** | vocab.js |
| Size buckets (mL) | — | 50, 100, 200, 375, 500, 700, 1000, 1140, 1500, 1750, 3000 | size.js |
| Size match (same bucket) | — | **1.0** | size.js |
| Size mismatch (different bucket) | — | **0.08** | size.js |
| One-sided size, ≤1.4× price | — | **1.0** | size.js |
| One-sided size, ≥1.6× price | — | **0.3** | size.js |
| One-sided size, in between | — | **0.7** | size.js |
| Age match | — | **1.8** | suggestions.js |
| Age mismatch | — | **0.2** | suggestions.js |
| Bare-numeric age match | — | **1.8** | suggestions.js |
| ABV agreement ≤0.6 | — | **1.15** | similarity.js::abvMultiplier |
| ABV neutral ≤1.5 | — | **1.0** | similarity.js::abvMultiplier |
| ABV ≤3.0 | — | **0.4** | similarity.js::abvMultiplier |
| ABV >3.0 | — | **0.12** | similarity.js::abvMultiplier |
| Edition-code shared | — | **1.15** | similarity.js::editionCodeMultiplier |
| Edition-code conflict | — | **0.1** | similarity.js::editionCodeMultiplier |
| Category conflict | — | **0.1** | concepts.js (CATEGORY_CONFLICT) |
| Substyle conflict | — | **0.25** | concepts.js (SUBSTYLE_CONFLICT) |
| Batching conflict (single barrel ↔ small batch) | — | **0.15** | concepts.js (BATCHING_CONFLICT) |
| Non-alcoholic conflict (0.0% ↔ real) | — | **0.1** | concepts.js (NON_ALC_CONFLICT) |
| Cask-strength marker (presence/absence) | — | **0.7** | concepts.js (CASK_STRENGTH_MARKER) |
| Sherry marker (presence/absence) | — | **0.75** | concepts.js (SHERRY_MARKER) |
| Store-exclusivity penalty (real↔real, shared store) | χ | **0.35** | suggestions.js (STORE_EXCLUSIVITY_PENALTY) |
| Flavor-variant conflict (cream/spiced/fruit/… differs) | — | **0.15** | concepts.js (FLAVOR_CONFLICT) |
| Shared SMWS cask-code floor (applied last) | — | **12** | suggestions.js (SMWS_SHARED_FLOOR) |
| Identical spaceless-core floor (before size) | — | **12** | suggestions.js (SPACELESS_CORE_FLOOR) |
| Bad-SKU boost | — | **1.2** | suggestions.js |

Notes added this round:
- **Diacritic folding** in `normSearchText` (`Diplomático`→`diplomatico`, `Añejo`→`anejo`)
  so accented words aren't split into fragments. Spanish `años` (folded `anos`) is read
  as an age by `extractAgeFromText`.
- **SMWS edition codes** now also catch lettered casks (`R4`, `GN6.3`, `RW5.1`; gated on
  the `smws` marker, prefix-whitelisted). A **shared** SMWS code floors the score at 12
  **as the final step** (after every penalty) — a same-cask fingerprint can't be buried by
  a flavor/concept/store demote (many SMWS names are flavor tasting-notes).
- **Spaceless-core floor**: if two names share an identical distinctive "core"
  (filtered tokens minus 1–2 digit numbers, concatenated — spacing/hyphenation/
  possessive collapsed), floor the score at 12 BEFORE the size penalty. Fixes
  glue/hyphen splits (`MACALONEYS CATHNAHAVEN` ↔ `Macaloney's Cath-Na-Haven`)
  while a true size variant with an identical core is still cut by size.
- **Mid-word truncation floor**: a DB-cut title (`…LEGACY RESERV` ← `RESERVE`,
  `Straight Edge Bourbo` ← `Bourbon`) — every token matches except the shorter's
  last is an incomplete prefix of the longer's — floors at 12. Measured: 12
  confirmed-link matches, **0** ignore matches (the strict-prefix-of-last-token rule
  excludes size/expression variants, which a generic prefix check would wrongly merge).
- **In-context fuzzy distinctive match**: at scoring time, an UNSHARED distinctive
  unigram on each side (len≥5) that is a 1-edit indel or ≥80% truncation of the other
  (`saphire`↔`sapphire`, `potrero`↔`portrero`, `paddy`↔`paddys`) is treated as the same
  identity word → ×(1+0.9·matches). Pairwise + gated, so it doesn't pollute the global
  vocab the way a token-level canon did (that lowered AUC+ and was reverted). Measured:
  AUC+ and AUC-vs-ignores both up.
- **Possessive/initialism folding** in `filterSimTokens`: single-letter runs collapse
  (`j p`→`jp`, `g m`→`gm`) and a trailing possessive `s` folds in (`wiser s`→`wisers`),
  so `J.P. Wiser's` matches `JP WISERS`. NOTE (tested, NOT adopted): a catalog-derived
  token-level typo/truncation canonicalization (levenshtein≤1 / prefix) *lowered* AUC+
  — it collapses tokens the hard-negatives need — so it was reverted.
- **Maturation wall** (κ): agave/rum class blanco/reposado/añejo/joven/cristalino —
  mutually exclusive, 0 confirmed-link breaks. Spanish cognates (`reserva→reserve`,
  `exclusiva→exclusive`, `años→`age) folded in normalization.
- **Flavor wall** (κ): if two names assert different flavor/variant qualifier sets
  (`VARIANT_FLAVORS` — cream, spiced, vanilla, fruit names, …; excludes `lemon`/`peated`/
  `smoked`), demote ×0.15. Validated to break ≤2 confirmed links per flavor.
| Price gap ≤0.35 | — | **1.0** | price.js |
| Price gap 0.35–0.5 | — | linear 1.0→0.75 | price.js |
| Price gap >0.5 | — | 0.75·(0.5/gap) | price.js |

---

## 5. Evaluation methodology

Evaluated **entirely against the live labeled set** in `data/sku_links.json` —
confirmed links are positives, confirmed ignores are curated hard negatives. The
old `tools/linker_eval/fixtures.json` (a small hand-curated case set) has been
**removed**: the labeled set is now large and accurate enough to subsume it, and
the ignores already play the "precision-only / should-not-match" role the
fixtures' precision cases did. `tools/linker_eval.mjs` reports:

1. **AUC variants.** AUC against *random* negatives is uninformative — a trivial
   "do the names share any word" scorer already scores ~0.99 on it. The metric
   that matters is **AUC+** = AUC against **auto-mined hard negatives** (pairs
   sharing a distinctive bigram, idf ≥ 5, but in different canonical groups). The
   harness prints the trivial shared-word baseline alongside as the floor (it
   sits at ~0.51 on hard negatives — i.e. no signal — so AUC+ measures real
   discrimination, not vocabulary overlap).

2. **Auto-link threshold table.** For precision targets 0.90 / 0.95 / 0.98 / 0.99
   over positives vs (ignores + hard negatives), the lowest score threshold that
   reaches the target and the **recall** there. This is the operational number:
   "what cutoff auto-links at 99% precision, and what fraction does it catch?"

3. **Worst false positives / false negatives**, with SKUs, for direct lookup and
   relabeling. False negatives exclude no-name scrape gaps (a name that is just a
   bare SKU number is a data gap, not a scorer fault).

4. **Stratified band samples** + **persistence/diff** (`pairs.json`; the next run
   surfaces any pair whose score moved > 0.5).

`tools/linker_outliers.mjs` is the companion: it scores *every* link and ignore
and emits `algo_failures.md` (factor-decomposed disagreements) for analysis.

> Both eval and ranker import the same `scorePairWithVocab`, so they can never
> drift. Re-run both on every scorer change.

---

## 6. Current benchmark numbers

Run `node tools/linker_eval.mjs` for live figures (they move as the labeled set
grows). At the time of writing, on ~4.9k positives / 1.2k ignores / 4k hard
negatives:

| metric | value | note |
|---|---|---|
| AUC+ (vs hard negatives) | **~0.79** | trivial shared-word floor ~0.51 |
| AUC vs ignores | ~0.85 | |
| Auto-link T for **99%** precision | ~23.5 | recall ~4% — only the most certain links auto-link |
| Auto-link T for **95%** precision | ~16 | recall ~23% |

The dominant residual error classes (see `algo_failures.md`): cross-store **size
variants** the name omits and price can't separate (false positives), and
**possessive/abbreviated common brands** + **lost SMWS `NN.NN` codes** (false
negatives). These need new signal (size from richer sources; a shared-code
positive boost) rather than more name rules.

---

## 7. Summary of progress (techniques)

| metric | baseline | current |
|---|---|---|
| Scoring techniques | 1 (raw token overlap) | 17 (listed in §3) |
| Auto-link precision ceiling (legacy curated metric) | 5.47 | 1.84 (now superseded by the §6 big-set threshold table) |

---

## 8. Data sources & structure

This section enumerates every data asset in the repo the matcher could draw on,
with concrete file paths, top-level shapes, and per-record field lists. Fields
the current algorithm uses are marked **[used]**; the rest are signal not yet
exploited.

### 8.1 Raw per-store scraped databases — `data/db/*.json`

One file per (store, category) pair. Filename convention
`<storeId>__<category>__<hash>.json`. These are the authoritative scrape outputs
and are what `index.json` is aggregated from.

```jsonc
{
  "version": 1,                                  // schema version
  "store": "kelownaharveyave.armstrong.coop",    // raw store hostname
  "storeLabel": "ARC Liquor",                    // human-readable store name [used: storeLabel]
  "category": "spirits-gin",                     // store-side category slug
  "categoryLabel": "Spirits - Gin",              // human-readable category
  "source": "armstrong.coop",                    // scraper source tag
  "createdAt": "2026-02-10T16:43:02-08:00",      // first scrape of this file
  "updatedAt": "2026-05-26T21:14:45.439Z",       // most recent scrape
  "count": 83,                                   // items.length
  "items": [
    {
      "name": "ABLEFOTHS BATHTUB GIN",           // **[used]** display name (matcher input)
      "price": "$75.55",                         // **[used]** currency-prefixed string (parsed for matcher + rarity)
      "sku": "400733",                           // **[used]** raw store SKU
      "url": "https://…/4589154-ablefoths-bathtub-gin",   // product URL slug (NOT used by matcher)
      "img": "https://s.barnetnetwork.com/…",    // thumbnail (NOT used by matcher)
      "removed": false                           // delisted-at-store flag
    }
  ]
}
```

When the same item appears at multiple stores with the same `sku` value the
ingest treats them as the same product without a `sku_links` entry — this is
the implicit "free" labelling. Cross-store same-`sku` is how `sku_links_auto.json`
gets generated.

### 8.2 Aggregated catalog — `viz/data/index.json`

Single file the SPA fetches. Each per-store row is a separate `items` entry; the
matcher (and `aggregateBySku`) groups by SKU at runtime.

```jsonc
{
  "generatedAt": "2026-05-26T21:21:40.650Z",
  "includesRemoved": true,
  "count": 27951,
  "countLive": 24830,
  "items": [
    {
      "sku": "000042",                           // **[used]** raw store SKU
      "name": "CANADIAN CLUB 750ML",             // **[used]** display name
      "price": "$24.49",                         // **[used]** price string
      "url": "https://kelownaharveyave.armstrong.coop/products/4589408-canadian-club-750ml",   // (NOT used)
      "img": "https://s.barnetnetwork.com/…",    // (NOT used)
      "removed": false,                          // **[used implicitly]** for filtering
      "store": "kelownaharveyave.armstrong.coop",// raw hostname
      "storeLabel": "ARC Liquor",                // **[used]** for same-store gating
      "category": "spirits-whiskey",             // store category slug
      "categoryLabel": "Spirits - Whiskey",      // human-readable category
      "updatedAt": "2026-05-26T21:14:45.439Z",   // last seen
      "firstSeenAt": "2026-02-10T16:43:02-08:00" // first seen by us
    }
  ]
}
```

**Aggregated shape** (in-memory, produced by `viz/app/catalog.js::aggregateBySku`,
keyed by the canonical SKU after `sku_links*` is applied):

```jsonc
{
  "sku": "000042",                               // **[used]** canonical SKU
  "name": "CANADIAN CLUB 750ML",                 // **[used]** representative name (chosen heuristically)
  "img": "https://…",
  "cheapestPriceStr": "$19.99",
  "cheapestPriceNum": 19.99,                     // **[used]** minimum across all stores
  "cheapestStoreLabel": "Highlander Wine & Spirits",
  "stores": Set<"ARC Liquor","BCL","BSW","High Point BWS",…>,    // **[used]** live stores
  "storesEver": Set<…>,                          // includes delisted history
  "sampleUrl": "https://…",                      // representative URL
  "spiritTypes": Set<"whisky">,                  // normalized spirit type ids
  "searchText": "000042 canadian club 750ml https …",   // **[used]** for free-text search filter
  "storeCount": 11,
  "storeCountEver": 11,
  "removedEverywhere": false
}
```

### 8.3 Canonical SKU links (the labels) — `data/sku_links.json`

Manually curated cross-store equivalences. **The single most important supervision
signal** — what positives in the eval are drawn from.

```jsonc
{
  "generatedAt": "2026-05-27T15:25:34.000Z",
  "links": [                                     // **[used]** — defines canonical groups via union-find
    { "fromSku": "448826",
      "toSku":   "880542",
      "createdAt": "2026-01-20T21:55:21.620Z" }
    // … 3,116 entries
  ],
  "ignores": [                                   // **[used]** "do not suggest" pairs
    { "skuA": "281451",
      "skuB": "530871",
      "createdAt": "2026-01-20T21:53:55.137Z" }
    // … 359 entries
  ]
}
```

### 8.4 Auto-detected links — `data/sku_links_auto.json`

Generated by the tracker when `pickBetterSku()` upgrades a synthetic
`u:URL-hash` SKU into a real numeric SKU after a hydration pass. Each entry has
provenance (`url`, `dbFile`, `ts`) the matcher could leverage to verify SKU
identity history.

```jsonc
{
  "generatedAt": "…",
  "source": "auto",
  "links": [
    {
      "fromSku": "u:2b22e359",
      "toSku":   "000042",                       // **[used]** unioned with manual links
      "ts":      "2026-01-31T17:05:15-08:00",    // when the upgrade happened (NOT currently used as signal)
      "url":     "https://sierraspringsliquor.ca/shop/whisky-2/canadian-whisky/canadian-club-40-abv/",
      "dbFile":  "data/db/sierrasprings__whisky__b81923e1.json"
    }
    // … 893 entries
  ]
}
```

### 8.5 Hidden listings — `data/sku_hidden.json`

Per-(storeId, sku) suppressions for mis-categorized rows. Read by the SPA and
by `tools/build_email_event_pack.js`. The matcher could filter these out before
vocab build to avoid polluting df counts.

```jsonc
{
  "generatedAt": "…",
  "hidden": [
    { "storeId":   "sierrasprings",              // (NOT yet used by matcher)
      "sku":       "713914",
      "reason":    "…",                          // optional
      "createdAt": "2026-05-22T23:05:08.916Z" }
  ]
}
```

### 8.6 Per-canonical rarity — `viz/data/rarity.json`

Built by `tools/build_viz_rarity.js`. Per canonical SKU: an aggregate rarity
score in [0,1] and a confidence in [0,1]. Higher = rarer. **NOT** currently a
matcher input, but a candidate signal for tie-breaking.

```jsonc
{
  "generatedAt": "…",
  "version": 1,
  "thresholds": { "stapleMax": 0.178, "rareMin": 0.6 },   // dynamic percentile thresholds
  "count": 8721,
  "byCanon": {
    "100035": { "r": 0.2882, "c": 1 }            // r=rarity, c=confidence (NOT used by matcher)
    // …
  }
}
```

### 8.7 Per-SKU price + availability history (LFS) — `viz/data/skus/<sku>.json`

Rich time-series: for each canonical SKU, every observed price event per store
file, with timestamp. Built incrementally by `tools/build_viz_sku_cache.js`. This
is the richest unused data source — it could power "two SKUs that always go in
and out of stock together are the same product."

```jsonc
{
  "sku": "000042",
  "gen": "2026-05-26T21:22:49.620Z",
  "stores": {
    "data/db/arc__spirits-whiskey__9d67b1dc.json": {
      "label": "ARC Liquor",
      "events": [
        { "ts": "2026-02-10T16:43:02-08:00", "p": "$24.19" },   // price change
        { "ts": "2026-02-13T00:14:29-08:00", "p": "$22.99" },
        { "ts": "2026-04-24T19:19:55Z",      "p": "$24.49" }
        // events with no "p" mean the listing went OUT of stock at that time
      ]
    },
    "data/db/bcl__whisky__28758adc.json": { … },
    // 13 stores tracked
  }
}
```

### 8.8 Recent market events — `viz/data/recent.json`

3-day rolling window of market-wide changes (new listings, restored listings,
deletions, price drops). Useful for surfacing freshly-scraped items that may
need linking.

```jsonc
{
  "generatedAt": "…",
  "windowDays": 3,
  "since":      "2026-05-23T21:22:25.524Z",
  "headSha":    "WORKTREE",
  "count":      …,
  "items": [
    {
      "ts":            "2026-05-26T21:22:25.524Z",
      "date":          "2026-05-26",
      "fromSha":       "4a23f0322b22fedc2a6042d65ad7a69359f9e18c",   // git provenance
      "toSha":         "WORKTREE",
      "kind":          "restored",   // new | restored | removed | price_down | price_up | price_change
      "sku":           "006968",
      "name":          "EMPRESS 1908 INDIGO 750ML",
      "storeLabel":    "ARC Liquor",
      "categoryLabel": "Spirits - Gin",
      "price":         "$49.99",
      "url":           "https://…",
      "dbFile":        "data/db/arc__spirits-gin__dbf9c7f5.json"
    }
  ]
}
```

### 8.9 Static store metadata — `viz/app/stores.js`

Hand-curated per-store dictionary. The matcher uses **only `label`** today (for
same-store gating). Other fields are display metadata but `region` could matter
(BC vs AB stores price differently and stock different SKUs).

```js
{
  id:     "arc",                                 // **[used implicitly]** store identifier
  label:  "ARC Liquor",                          // **[used]** for same-store gating + display
  region: "bc",                                  // (NOT yet used by matcher) BC | AB
  color:  "#9467BD",                             // display only
  logo:   "https://…",
  url:    "",
  aliases:["arcliquor"]                          // alt spellings (used by store-id normaliser)
}
```

### 8.10 Scrape run reports — `reports/*.txt`

Plain-text logs of each tracker invocation. Per-category counts of New /
Restored / Removed / PriceChanges. Filename = ISO timestamp. Not used by the
matcher but useful for QA (was a category empty during a scrape window? May
explain a false-positive "rare" classification).

```
========== REPORT ==========
[OK] Totals | Stores=33 | Categories=111 | Unique=23199 | New=10049 | Restored=4 | Removed=9 | PriceChanges=1 | Runtime=747s

Per-category summary:
Store | Category                               Pages  Unique   New   Res   Rem   Upd      Sec
---------------------------------------------  -----  ------  ----  ----  ----  ----  -------
Craft Cellars | Whisky                            25     777     0     3     0     0      69s
…
```

### 8.11 Per-DB-file "epoch" timestamps

Each `data/db/*.json` carries a `createdAt` field stamped on first write,
back-filled once from git history by `tools/backfill_db_created_at.js`. Used by
the rarity scorer (`src/utils/db_epochs.js`) to know when a category started
being observed — items in a late-added DB file shouldn't be flagged "rare" just
because they sold out shortly after we started watching that page. **Not yet
used by the matcher**, but the matcher could use the cross-DB-file `createdAt`
overlap as evidence of "these items co-exist in the same observation window".

### 8.12 Common-listings / shortlists — `viz/data/common_listings_commits.json`

Top-N product lists by region (BC / AB / all) and store-count, generated by
`tools/build_common_listings.js`. Useful for "popular product" prior in the
matcher (a product appearing at many stores is probably a well-known SKU with
many variants worth scrutinising more carefully).

### 8.13 Summary of fields used vs unused by the current matcher

**Used today:**

- `name` (entire matching pipeline — vocabulary, IDF, coverage, edition codes…)
- `sku` (identity, same-store gating, canonical mapping, brand alias inputs)
- `storeLabel` (same-store gating, `cheapestStoreLabel` selection)
- `price` → `cheapestPriceNum` (price-gap penalty, one-sided size inference)
- `stores` set (live availability count, ranking proxy, **store-exclusivity penalty χ §3.10c**)
- `url` (**fallback size source** when the name states none — slug parse in size.js)
- `cheapestPriceNum` (size inference)
- `searchText` (manual search box; not in scoring)
- `sku_links.json` + `sku_links_auto.json` (canonical groups, eval positives)
- `sku_links.json::ignores` (pair-level "do not suggest")
- `removed` (filter delisted from active rankings)

**Available but NOT used today** — candidate signals for future iters:

| field | potential use |
|---|---|
| `viz/data/skus/<sku>.json` (price/availability history) | "Two SKUs whose in-stock windows correlate across stores are the same product." Hugely powerful signal — cross-store temporal correlation is independent of name. |
| `firstSeenAt` / `updatedAt` per row | "Did these items appear at the same time across stores?" Co-launch evidence. |
| `category` / `categoryLabel` / `spiritTypes` | Reject cross-category candidates (gin ↮ whisky) without needing it to be "different brand". |
| `img` URLs | Same image across stores ⇒ same product (especially when names diverge). Could match via URL slug if scrapers preserve provider IDs; heavier via perceptual hash. |
| `url` slug | Now parsed for SIZE as a fallback (size.js). Still unused: many provider URLs encode the SKU/product ID; a shared slug substring would be strong identity evidence. |
| `region` from `stores.js` | Price-gap thresholds should differ by region (BC LDB pricing differs from Alberta retail). |
| `viz/data/rarity.json` | Rarity adjacency: two items in the same rarity tier with otherwise plausible textual match is corroborating evidence. |
| `recent.json` event kinds | "Both items had a `restored` event on the same day" is co-availability evidence. |
| `data/sku_hidden.json` | Filter from vocab to avoid mis-categorised noise polluting df counts. |
| `sku_links_auto.json::dbFile` provenance | Provider URL fingerprints — same provider hash across stores = same product. |
| Per-DB-file `createdAt` | Constrain matches to listings observed in overlapping windows. |
| Number of stores ever carrying it | High store-count items deserve stricter precision (more visibility on errors). |
| Commit history (`db_commits.json`) | Time-correlation of price changes is a same-product signal. |

The most promising under-used signal is **price/availability time-series
correlation** from `viz/data/skus/<sku>.json`: when SKU A goes from $X to $Y at
store S1 on date D, does SKU B's price at store S2 move similarly? Correlated
movement across stores is independent of name text and would crack the hardest
remaining cases (Bridgeland Sherry, Confluence Detour) where the textual
discriminators are sub-distinctive.

---

## 9. Open / future work

1. **Group-based validation as secondary signal.** When a candidate links into
   an existing canonical group, check that the candidate also matches the
   group's other members (cross-group cohort score). Demote when the candidate
   matches only the one item but not the cohort.
2. **Auto-discovery of brand aliases.** A scan tool that surfaces short tokens
   whose initials spell phrases elsewhere in the catalog with overlapping
   context — output for human approval, fed back into `BRAND_ALIASES`.
3. **HMS / "ship name" type structured edition codes.** Currently caught only
   when both sides write "HMS X"; the X part isn't a structured pattern.
4. **Bridgeland Sherry style cases.** "sherry" is sub-distinctive (idf < ι).
   Graded coverage handles it but the ceiling remains at 2.44. Lowering ι risks
   broader regressions.
5. **Confluence Detour Dry vs Amethyst.** Both `dry` and `amethyst` are sub-
   distinctive. Hard case — likely needs the group validation lever.
6. **Westland Strath Cask 6265 vs 1337.** 4-digit cask numbers are correctly
   distinctive; remaining shared content (`westland`, `strath`, `seattle`,
   `from`, `via`) is large and limits how much coverage penalties can compress
   the score.
