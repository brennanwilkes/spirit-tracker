# Linker ML — Measured Results (prototype)

All numbers on a **held-out 25% split by canonical group** (no group spans train+val; the
embedder trains only on TRAIN-group positives + TRAIN-only hard negatives, so the embedding
lift is not leaked). Catalog: 12,624 distinct SKUs, 4,821 links + 2,030 ignores. Val pairs:
1,472 positive / 1,051 hard / 425 ignore. Reproduce with the chain in `CLAUDE.md`.

Models compared:
- **det** — the live deterministic scorer (`scorePairWithVocab`), unchanged.
- **blend (no-embed)** — logistic regression over the ~25 deterministic factors only.
- **blend + embed v1** — adds fine-tuned MiniLM cosine; in-batch negatives only.
- **blend + embed v2** — fine-tuned MiniLM with curated **ignore + hard negatives** (best overall).

## Headline — discrimination

| Metric | det | blend (no-embed) | blend + embed v1 | **blend + embed v2** |
|---|---|---|---|---|
| AUC+ (pos vs hard) | 0.809 | 0.899 | 0.912 | **0.918** |
| AUC (pos vs ignore) | 0.886 | 0.951 | 0.960 | **0.959** |

## Headline — auto-link recall at a precision target (pos vs ignore+hard)

Recall = fraction of true links auto-linkable at that precision. A wrong auto-link corrupts
a canonical group, so this — not raw AUC+ — is the operational number.

| Precision target | det | blend (no-embed) | blend + embed v1 | **blend + embed v2** |
|---|---|---|---|---|
| ≥ 99% | 3.7% | **22.6%** | 14.4% | 11.1% |
| ≥ 98% | 4.8% | 25.5% | 24.2% | **33.8%** |
| ≥ 95% | 20.8% | 36.7% | 42.8% | **49.8%** |
| ≥ 90% | 20.8% | 50.9% | 65.5% | **68.6%** |

**Read this carefully:** the embedding is a large net win — it roughly **doubles recall at
95–98% precision** and **triples it at 90%** over the deterministic algo, and lifts AUC+ by
+0.11. But at the razor **99%** point the *no-embed* blend wins (22.6% vs 11.1%): raw cosine
scores a couple of different-product near-duplicates extremely high, and those 1–2 confident
false positives cap the very top of the ranking. Two practical responses:
1. **Auto-link at 98%, not 99%** — embed v2 gives 33.8% recall there vs 4.8% deterministic (7×).
2. **Add `ignores`** for the confident-but-wrong pairs (the future bigger-dataset lever) and/or
   keep a deterministic hard-veto (size/abv/edition) gate on the top auto-links. The blend
   already carries those as features; a multiplicative veto at inference would clean the tail.

## Semantic gap — the class only the embedder can reach

256 confirmed-link pairs share ≤1 name token (the deterministic scorer is structurally blind
to them). Recovered = scored as a confident match.

| Measure | det | off-the-shelf MiniLM | fine-tuned v2 |
|---|---|---|---|
| mean cosine (256 ≤1-token positives) | — | 0.636 | **0.830** |
| recovered @ cos ≥ 0.6 (of 256) | 63 (det ≥2) | — | **243** |
| recovered @ cos ≥ 0.6 (0-token subset of 20) | — | 8 | **12** |

Fine-tuning on our labels lifts mean cosine +0.19 over the off-the-shelf model and recovers
**95%** of the ≤1-token class — confirming the equivalences live in *our* links, not general
English (off-the-shelf alone is not enough).

### Named showcase (det score → fine-tuned cosine → blend probability)

| Pair | det | cosBase | cosFt | blend | verdict |
|---|---|---|---|---|---|
| Compass Box Artist ↔ Great King Street Artist's Blend | 0.00 | 0.286 | 0.688 | 0.66 | ✅ recovered (brand synonym) |
| LINDORES … MCDXCIV ↔ Lindores 1494 | 0.03 | 0.645 | 0.70 | 0.83 | ✅ recovered (Roman numeral) |
| Tincup American Whiskey ↔ Tin Cup USA Whiskey | 0.14 | 0.873 | 0.892 | 0.87 | ✅ recovered (spacing) |
| Kilkerran 12 ↔ `784271` (name is just a SKU) | 0.00 | 0.30 | 0.53 | 0.54 | ✅ recovered (one side nameless) |
| That Boutique-y **Whisky** Co. ↔ That Boutique-Y **Gin** Co. | 0.02 | 0.428 | 0.287 | **0.00** | ✅ correctly REJECTED (different product) |

The last row is the key precision control: the off-the-shelf model thought the two TBWC
companies were similar (0.43); fine-tuning + the hard-rule features drove the blend to 0.00.

## Suspected mislabels surfaced (relabel, don't chase)

The model scores these *confirmed links* near zero — they look like data errors, not scorer
faults (flagged per the harness convention):
- **Brinley Gold Shipwreck Spiced Rum ↔ Yellow Spot Irish Whiskey** (rum vs Irish whiskey; blend 0.00)
- **Yukon Single Malt (Two Brewers) ↔ Alberta Premium 20yo** (blend 0.12)

## Learned weights (embed v2, standardized, |w| desc — top 8)

`+3.78 embedCos · −1.05 woScore · +0.90 conceptMult · +0.71 logDet · +0.69 pricePen ·
−0.59 storeShared · +0.55 jacc · −0.49 contain`

`embedCos` is the dominant feature; `logDet` (the whole deterministic algo) stays positive —
the model **augments** the current scorer rather than discarding it. (`woScore`/`contain`
flip sign as collinear corrections to `logDet`/`embedCos`; harmless — val AUC is the judge.)

## Artifacts (in `out/`, gitignored)

`blend_weights.json` (the shippable model: keys, mean, std, w, b, metrics) ·
`embeddings.json` (fine-tuned v2, 12.6k×384) · `embeddings_base.json` (off-the-shelf) ·
`embeddings_ft_v1.json` (in-batch-only ablation) · `features.jsonl` · `dataset_pairs.jsonl` ·
`semantic_gap_cases.json` · `gap_baseline.txt` / `gap_ft_v1.txt` / `gap_ft_v2.txt`.
