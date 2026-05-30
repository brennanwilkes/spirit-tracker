# Linker ML — Learned Classifier + Attention Embedder

This folder augments the deterministic SKU matcher with a **learned blend** over its
existing factors **plus a fine-tuned attention embedding**, to drive up AUC+ / precision-
recall on the labeled set. **It augments the current scorer — it does not replace it**
(the full deterministic score is one of the blend's features). Dev/analysis tooling only:
nothing here runs in `run_daily.sh`. Sibling of `tools/linker_eval/` (the eval harness);
read that folder's `CLAUDE.md` + `TECHNICAL_REPORT.md` for the deterministic scorer.

## Why this exists

The deterministic scorer (`viz/app/linker_page/suggestions.js::scorePairWithVocab`) is
bag-of-tokens: names that share no tokens are unreachable at any constant setting
(`TBWC` ↔ `That Boutique-y Whisky Company`, `Compass Box Artist` ↔ `Great King Street
Artist's Blend`, `LINDORES MCDXCIV` ↔ `Lindores 1494`). Those equivalences live only in
our labels, so the fix is a transformer encoder **fine-tuned contrastively on
`data/sku_links.json`**. See `../linker_eval/CLASSIFIER_PLAN.md` for the original roadmap.

## ⭐ How to RE-TRAIN (new session, bigger dataset)

Everything keys off `data/sku_links.json` (+ `_auto`) in the `.worktrees/data` worktree, so
a bigger labeled set just means re-running the same chain. Two prerequisites, then 6 steps.

**Prereqs (once per machine):** the Python venv must exist with CPU torch + sentence-
transformers + sklearn. If `tools/linker_ml/.venv/` is missing:
```bash
sudo apt install -y python3-pip python3-venv          # needs root — ASK the user
python3 -m venv tools/linker_ml/.venv
source tools/linker_ml/.venv/bin/activate
pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r tools/linker_ml/requirements.txt
```
Node 18+ (repo default). The eval/build scripts are ESM `.mjs` importing the live viz
modules directly (so they never drift from the ranker).

**The shipping classifier is now a GRADIENT-BOOSTED TREE (`export_gbt.py` → `out/gbt_model.json`),
not the logistic blend.** The LR (`train_blend.mjs` → `blend_weights.js`) is kept only as a
graceful fallback if `gbt_model.json` fails to load. The GBT runs live via a vanilla-JS tree
evaluator (`viz/app/linker_page/gbt.js`). It beats the LR decisively (held-out rec@99% 17.6% →
~69%) because the LR has **suppressor-weight pathologies at the tail** — e.g. `woScore` learned a
negative weight, so a zero-name-overlap pair (rum-18 vs whisky-18) got *pushed up* to 0.9; and the
LR under-scored real matches when an embedding vector was missing. Trees don't extrapolate and
route missing values natively, fixing both.

**Re-train chain (2026-05-29 architecture — GBT + 13 group features + enriched embeddings):**
```bash
# 1. mine the dataset — pure Node. sku_texts.jsonl uses skuToTextEnriched (NAME + group-resolved
#    size/abv/year/category tokens). 13 grp* features are computed per pair in featurizePair.
node tools/linker_ml/build_dataset.mjs

# 2. feature columns per pair (det score + sub-factors + 13 grp* + embed_cosine slot) — pure Node
node tools/linker_ml/dump_features.mjs          # embed_cosine = 0 until embeddings exist

# 3. fine-tune the encoder on the ENRICHED text (CPU, ~5 min). e6·s30 is the tuned sweet spot.
HF_HOME="$PWD/tools/linker_ml/.hf_cache" \
  tools/linker_ml/.venv/bin/python tools/linker_ml/train_embed.py --epochs 6 --scale 30 --skip-base
#   --epochs/--scale/--lr/--tag are tunable. SWEEP RESULT: 3–6 epochs best, scale 30 ≳ 20;
#   16 epochs OVERFITS (lowest train loss, WORST held-out rec@99). Judge held-out, never train loss.

# 4. fold embed_cosine in
node tools/linker_ml/dump_features.mjs          # now fills embed_cosine from embeddings.json

# 5. THE SHIPPING MODEL — gradient-boosted-tree blend (Python venv, sklearn HistGBT)
tools/linker_ml/.venv/bin/python tools/linker_ml/export_gbt.py   # → out/gbt_model.json (trees + missing-routing)

# 6. LR FALLBACK (group-aware) + sanity metrics
node tools/linker_ml/train_blend.mjs            # LR held-out metrics
node tools/linker_ml/make_blend_weights.mjs     # → viz/app/linker_page/blend_weights.js (commit on main)
node tools/linker_ml/eval_gap.mjs               # semantic-gap before/after

# 7. SHIP: code on main (gbt.js, group_features.js, blend_weights.js, suggestions/page wiring);
#    artifacts to the worktree (LFS, data branch):
cp tools/linker_ml/out/embeddings.json .worktrees/data/viz/data/sku_embeddings.json
cp tools/linker_ml/out/gbt_model.json  .worktrees/data/viz/data/gbt_model.json
```

**The 13 group↔group features** (canonical-GROUP level, the dimension neither the token scorer
nor the bi-encoder can see): `grpStoreOverlap/CollideCount/Jaccard/SameSkuShare`,
`grpSizeConflict/Jaccard`, `grpAbvDiff/Both`, `grpYearDiff/Both`, `grpPriceRatio`, `grpCountA/B`.
Computed in `featurize.mjs::groupPairFeatures` (offline, **edge-cuts** the scored pair so positives
use PRE-merge groups — no leakage) and `viz/app/linker_page/group_features.js` (live, full groups —
identical to the trainer for cross-group pairs, which is all the live ranker scores since
same-group candidates are filtered). **Keep these two parallel implementations in sync.**
`grpStoreOverlap` is upgrade-discounted (same-store near-identical-name SKUs = a re-list, not a
collision). Feature importances: after `embedCos`/`logDet`, the grp* features dominate.

**Embedding now carries per-SKU group-resolved attributes** (`skuToTextEnriched`): the bi-encoder
gets size/abv/year/category as text tokens (their meaning ALIGNS with cosine — same size → closer).
PAIRWISE relations like store-overlap can't go in the text (a shared token raises cosine, but
shared-store means *less* likely same product) — those stay blend features. No raw store names.

## ⭐ Live integration (wired into `#/link` and `#/link-rapid`)

The prototype is wired into the live ranker — **augmenting, not replacing** the
deterministic scorer:

- **`viz/app/linker_page/blend.js`** — shared `extractBlendFeatures()` + `blendScore()`.
  `featurize.mjs` imports these too, so the live ranker and the eval can't drift.
- **`viz/app/linker_page/blend_weights.js`** — committed weights (`BLEND_WEIGHTS_EMBED` /
  `BLEND_WEIGHTS_NOEMBED`), generated by `make_blend_weights.mjs`. Regenerate after every
  retrain.
- **`viz/app/linker_page/embeddings.js`** — fetches `viz/data/sku_embeddings.json` (the LFS
  vectors file). **Optional**: if absent (e.g. on deployed Pages until shipped), it returns
  null and the pages use `BLEND_WEIGHTS_NOEMBED` — no error, graceful fallback.
- **`recommendSimilar(..., { blend })`** in `suggestions.js` retrieves with the deterministic
  score, then re-ranks the top candidates. `blend` now carries `{ gbt, groupIndex, embedCosFn,
  weights, weightsNoEmbed }`. Per candidate it: `extractBlendFeatures` → `Object.assign` the live
  group features (`blend.groupIndex.features(a,b)`) → score with **`gbtScore` (gbt.js)** when a
  GBT model is loaded, else the linear `blendScore`. SMWS pins stay on top. The pages
  (`linker_page.js` / `linker_rapid_page.js`) build the blend, `loadGbtModel()`, and
  `buildGroupIndex(allAgg, rules.canonicalSku)` (rebuilt on every rules reload). "Strong" cutoffs
  use the probability scale (`isStrongProb`, `STRONG_*_PROB`).
- **`viz/app/linker_page/gbt.js`** — vanilla-JS tree inference for `out/gbt_model.json` (deployed
  to `viz/data/gbt_model.json` on the data branch). Routes a MISSING embed_cosine via the tree's
  missing branch (mark it NaN, NOT 0 — 0 means "dissimilar" and wrongly crushed real matches).
- **`viz/app/linker_page/group_features.js`** — live `buildGroupIndex()` + `.features(a,b)`; the
  parallel of `featurize.mjs::groupPairFeatures` (keep in sync).
- **Missing embedding vectors are normal in prod** (SKUs scraped after the last encode). The GBT
  routes them natively; the LR path falls back to no-embed weights per-pair. So a fresh SKU works
  via deterministic + group features until its next encode. See `[[project_linker_encode_pipeline_todo]]`
  — the per-build re-encode (~15 s) is NOT yet wired into `run_daily.sh` (deferred).

**Refreshing the two artifacts after a retrain:** (1) `make_blend_weights.mjs` rewrites
`blend_weights.js` (commit on `main`); (2) copy `out/embeddings.json` →
`.worktrees/data/viz/data/sku_embeddings.json` (LFS, on the `data` branch). The embeddings
file only covers SKUs present at build time — newly-scraped SKUs get `embedCos=0` (blend
still works via the other factors) until the next re-embed. To deploy the vectors to the
public Pages site, also stage `viz/data/sku_embeddings.json` in `.github/workflows/pages.yaml`
(parallel to `sku_links*.json`); left undone intentionally while the file is uncommitted.
Always re-run `tools/linker_eval.mjs` too — it scores the *deterministic* algo on the same
labels and is the apples-to-apples reference.

## Files

| File | Runtime | What it is |
|---|---|---|
| `featurize.mjs` | Node ESM | **Shared core.** `buildEnv()` (catalog+vocab+size/price, identical to `linker_eval.mjs`), `featurizeSku()`/`skuToText()` (SKU→shape / embedder text), `featurizePair()` (the feature vector). `FEATURE_KEYS` is the ordered column list — keep in sync with `train_blend.mjs`. |
| `build_dataset.mjs` | Node ESM | Mines `out/dataset_pairs.jsonl` (pos/ignore/hard/random — same logic + seed as `linker_eval.mjs`), `out/sku_texts.jsonl` (embedder inputs), `out/groups.json` (canonical groups), `out/semantic_gap_cases.json` (the benchmark). |
| `dump_features.mjs` | Node ESM | `dataset_pairs × featurizePair → out/features.jsonl`. Fills `embed_cosine` from `out/embeddings.json` if present. |
| `train_blend.mjs` | Node ESM | Logistic regression over the factors. Group-split train/val (FNV hash, 25%), balanced classes, L2. Prints AUC+ / threshold tables vs the raw deterministic score; writes `out/blend_weights.json`. |
| `train_embed.py` | Python venv | Contrastive fine-tune of all-MiniLM-L6-v2 (manual torch MNRL loop — **no `datasets` dep**) with curated hard negatives. Writes `out/embeddings.json` + `out/embeddings_base.json`. |
| `eval_gap.mjs` | Node ESM | Semantic-gap before/after: det vs cosBase vs cosFt vs blendProb, on the named cases + harvested ≤1-token positives + concrete 0-token examples. |
| `requirements.txt` | — | Python deps (CPU torch installed separately via its index URL). |
| `out/` | — | All artifacts (gitignored). `blend_weights.json` is the shippable model. |
| `.venv/`, `.hf_cache/` | — | Python env + HuggingFace model cache (both gitignored, in-project). |

## Train/val honesty (do not break)

Both the blend and the embedder split by **canonical group** with the SAME FNV hash
(`hash32` in `train_blend.mjs` ≡ `fnv1a32` in `train_embed.py`), 25% held out. A whole
group lands on one side, and the embedder trains only on TRAIN-group positives + TRAIN-only
hard negatives — so `embed_cosine` on val pairs (and the reported AUC+ lift) is not leaked.
If you change the split in one file, change it in both.

## Metrics that matter

A wrong auto-link corrupts a canonical group, so the headline is **recall at ≥99%
precision** (positives vs ignores+hard), then **AUC+** (vs hard negatives). `eval_gap.mjs`
covers the semantic class the embedding uniquely targets. See `RESULTS.md` for the measured
before/after of this prototype.

## Hard-won notes

- **No `datasets` / no root mid-session.** sentence-transformers 5.x `.fit()` needs the
  `datasets` pip package; we can't install mid-session, so training uses a **manual torch
  MNRL loop** (`train_embed.py`). Keep it that way unless deps are pre-installed.
- **The embedding is the strongest single feature** but raw cosine over-links a few
  near-duplicate editions/sizes → it can hurt the ≥99%-precision tail. Two defenses, both
  in place: (1) the blend keeps the deterministic hard-rule features (size/abv/edition/
  concept), (2) `train_embed.py` trains against curated ignores + mined hard negatives
  (`--no-hard-negs` to ablate). When adding more labels, prefer adding `ignores` for the
  confident-but-wrong pairs — they sharpen the precision tail most.
- **embeddings.json is ~39 MB** (12.6k × 384, gitignored). For a much larger catalog,
  consider float16 or a binary sidecar.
- **`skuToText()` feeds the NAME only.** Size/ABV/edition stay as deterministic vetoes
  (embedding raises recall, hard rules protect precision — `CLASSIFIER_PLAN §5`). If you
  want the embedding to disambiguate size/strength too, change `skuToText()` and re-train.
