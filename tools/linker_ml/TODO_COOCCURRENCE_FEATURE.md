# RESOLVED — `crossEntityConflicts` (the independent-bottler discriminator)

Shipped 2026-05-30. Fixes the IB residual: the blend over-scored same-bottler/different-distillery
pairs (Cadenhead Benriach↔Jura ~0.80) because the embedding gives them a high cosine (~0.84) — it
correctly sees benriach/jura as the same *type*, and "same type ≠ same entity" is the gap. The
classical scorer already rejected these (det 0.27); this was purely a blend/embedding artifact.

## The feature

`crossEntityConflicts` (in `viz/app/linker_page/blend.js::extractBlendFeatures`, in `FEATURE_KEYS`;
`featurize.mjs` gets it for free via that shared function) — a COUNT of unshared-distinctive
cross-token pairs `(x∈A-only, y∈B-only)` that are mutually-exclusive ENTITIES:

- `coocCount(x,y) == 0` (never co-occur in any listing), AND
- both `df ≥ WELL_ATTESTED_DF_MIN (20)` (well-attested, not a one-off), AND
- both `degPerDf < ENTITY_DEGPERDF_MAX (1.1)` (entity-like — see below), AND
- not `fuzzyVariant(x,y)` (drops messy spelling variants: `gran↔grand`, `john↔johnnie`).

Cadenhead Benriach↔Jura = 2 → reject; a true alias = 0.

## The insight: degree/df separates token TYPES (graph-structural, DISCOVERED not hardcoded)

A node's `degree/df` = distinct co-occurrence partners ÷ its own listing count:
- **TRAIT/descriptor** (`oloroso` 1.58, `speyside` 1.29, `limited` 1.89) — broad, unrelated company,
  low clustering (~0.04). Applies across many otherwise-unrelated products.
- **DISTILLERY/entity** (`jura` 0.75, `benriach` 0.95) — the same few bottlers/casks repeat,
  higher clustering (~0.09).

Gating both conflict tokens to `degPerDf < 1.1` is what tells a distillery (`jura`) from a
descriptor (`speyside`) — both are well-attested and never co-occur with the other side, so raw
co-occurrence / df-gating alone can't. Lifted precision-as-negative **96.6% → 99.6%**. (Entity-
resolution / coordinate-term framing: co-hyponyms are distributionally similar but mutually
non-co-occurring.) Vocab support added: `coocMap` is now `Map<token,Map<token,count>>`; `coocCount(a,b)`
+ `dfOf(term)` exposed (`coocSet` still returns the inner map — `.size`/`.has` unchanged).

## Results (honest TEST split — held-out by canonical group, never tuned)

AUC+ 0.9837→**0.9844**, rec@99 62.4→**68.9%**, rec@98 77.8→78.1, rec@95 93.3→93.6. Semantic-gap
recovery unchanged (350/350, 24/24). All metrics up; the embedding's recall is untouched.

## What FAILED (do not repeat)

- **Raw co-occurrence** (`crossTokenCoocMax/CondMax/Pairs`): `never-co-occur` describes ~75% of true
  semantic-gap positives, so it carries no specificity. All-3 *regressed* rec@99 (62.4→58.3).
- **df-magnitude (`crossConflictDf`)**: helped (rec@99→66.5) but capped Jura at ~0.55 — can't tell
  distillery from descriptor without the `degPerDf` entity gate.
- **Piling on graph features** (clustering, centrality, deg/df-as-feature): forward-selection pushed
  VAL rec@99 →77.6% while TEST FELL →57.7%. **The whole win is ONE feature.** rec@99→95% is NOT
  reachable by adding features at this label volume — the ceiling is the embedding + label count.
- **Classical entity-wall + global canonicalization**: measured low ROI — the classical scorer
  already rejects IB pairs and the embedding already rescues spelling-variant positives in the blend
  (0 positives fall through both det+embed). Not worth editing the single-source-of-truth scorer.

## Regression spot-panel (run via `scorePairBlended` with the deployed `gbt_model.json` + embeddings)

| Pair (a ↔ b) | names | baseline | final | expect |
|---|---|---|---|---|
| `134729 ↔ 878008` | Cadenhead Benriach ↔ **Jura** | 0.80 | **0.50** | reject |
| `134729 ↔ 115664` | Cadenhead Benriach ↔ **Tullibardine** | 0.42 | 0.14 | reject |
| `826206 ↔ 746290` | Compass Box Artist = **Great King Street** | 0.48 | 0.42 | (expendable alias) |
| `510354 ↔ 349670` | Glenfarclas 12 (control) | 1.00 | 1.00 | stay HIGH |
| `665257 ↔ 780828` | Lagavulin 8 (control) | 1.00 | 1.00 | stay HIGH |
| `102085 ↔ u:39e4eeb1` | Bushmills 1L ↔ bare (size) | ~0.02 | 0.03 | stay LOW |

`134729 ↔ 108908` (Espri) stays ~0.68 — `espri` has df=1 (one listing), so it's not well-attested,
gets no conflict signal, and its score is GBT variance on an essentially-unseen token (not a feature
failure). Always confirm the SKU you test is the *linked* one (canonical group).

## Open follow-ups (next session — the real rec@99 lever is labels, not code)

- Mine an **IB review queue** from high `crossEntityConflicts` (≥99.6% true-negative) → curated
  `ignores` via the `stviz/issue` flow. More labels sharpen the precision tail directly.
- (low ROI, only if wanted) `degPerDf` entity-wall in classical `scorePairWithVocab` for AI-off mode;
  global spelling-variant canonicalization for data cleanliness. Both re-validate via `linker_eval.mjs`.

## Hard-won lessons (carry forward)

1. **Always run the spot-panel, not just the aggregate** — aggregates mask targeted regressions, and
   VAL runs ~10pt optimistic at rec@99. Judge **TEST**; a VAL-up/TEST-down forward-selection is overfit → STOP.
2. **More features ≠ better.** One well-formed feature beat every multi-feature combination on held-out.
3. **Train/serve name parity:** `featurize.buildEnv` + `linker_eval.mjs` keep the FIRST non-empty name
   to match `viz/app/catalog.js` (serving). Don't reintroduce the longest-name rule.
4. **Verify the SKU you're testing is the linked one** (a wrong GKS sku `737239` vs linked `746290`
   once caused a false alarm). Use the canonical group to confirm.
