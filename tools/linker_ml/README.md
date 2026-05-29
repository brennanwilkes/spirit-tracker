# Linker ML — learned classifier + attention embedder (prototype)

Augments the deterministic SKU matcher (`viz/app/linker_page/suggestions.js`) with a
**learned blend** over its existing factors **plus a fine-tuned attention-embedding**
similarity, to drive up AUC+ / precision-recall in the eval harness. The deterministic
algo is **kept as a feature** — this augments, it does not replace.

This folder is dev/analysis tooling. Nothing here runs in `run_daily.sh`. It reads the
`.worktrees/data` worktree (override with `DATA_WORKTREE=...`). All artifacts land in
`out/` (gitignored); the Python venv lives in `.venv/` (gitignored).

## Why

The scorer is bag-of-tokens, so it structurally cannot connect names that share no tokens
(`TBWC` ↔ `That Boutique-y Whisky Company`, `Compass Box Artist` ↔ `Great King Street
Artist's Blend`, `LINDORES MCDXCIV` ↔ `Lindores 1494`). Those equivalences live only in
our labels (`data/sku_links.json`), so the fix is a transformer encoder **fine-tuned
contrastively on our links**. See `../linker_eval/CLASSIFIER_PLAN.md`.

## Pipeline

```
                         ┌──────────────── pure Node, zero deps ───────────────┐
build_dataset.mjs  →  dataset_pairs.jsonl  ─┐
  (mine pos/ignore/      sku_texts.jsonl     │
   hard/random,          groups.json         │
   same as linker_eval)  semantic_gap_cases.json
                                             │
dump_features.mjs  ────────────────────────►│  features.jsonl   (≈25 factor columns + label)
  (featurizePair per pair; fills embed_cosine if embeddings.json exists)
                                             │
train_blend.mjs   ──────────────────────────┘  logistic regression over the factors
  (group-split train/val, balanced, L2)  →  blend_weights.json + AUC+ / threshold tables
                         └─────────────────────────────────────────────────────┘

                         ┌──────────── Python venv (torch CPU) ────────────────┐
train_embed.py     →  embeddings.json       fine-tuned MiniLM (trained on TRAIN groups only)
  (MultipleNegatives-   embeddings_base.json off-the-shelf MiniLM (ablation)
   RankingLoss)
                         └─────────────────────────────────────────────────────┘

eval_gap.mjs       →  before/after on the 4 named pairs + harvested ≤1-token positives
```

`featurize.mjs` is the shared core: `buildEnv()` (catalog + vocab + size/price closures,
identical to `linker_eval.mjs`), `featurizeSku()` / `skuToText()` (SKU → shape / embedder
text), `featurizePair()` (the feature vector — the full `scorePairWithVocab` as one
feature plus the decomposed sub-factors plus `embed_cosine`).

## Run order

```bash
# 1. Substrate + blend (no deps — runs immediately)
node tools/linker_ml/build_dataset.mjs
node tools/linker_ml/dump_features.mjs
node tools/linker_ml/train_blend.mjs        # AUC+ / threshold tables, blend_weights.json
node tools/linker_ml/eval_gap.mjs           # pre-embedding baseline

# 2. Attention embedder (needs the venv: torch CPU + sentence-transformers + sklearn)
HF_HOME="$PWD/tools/linker_ml/.hf_cache" \
  tools/linker_ml/.venv/bin/python tools/linker_ml/train_embed.py --epochs 3

# 3. Fold the semantic feature in and re-measure
node tools/linker_ml/dump_features.mjs      # now fills embed_cosine from embeddings.json
node tools/linker_ml/train_blend.mjs        # blend WITH the semantic feature
node tools/linker_ml/eval_gap.mjs           # after — named cases + harvested set
```

## Train/val honesty

Both the blend and the embedder split by **canonical group** using the same FNV hash
(`hash32` in `train_blend.mjs` == `fnv1a32` in `train_embed.py`), 25% held out. A whole
group is on exactly one side, and the embedder trains only on TRAIN-group positives — so
the `embed_cosine` on val pairs (and the reported AUC+ lift) is not leaked.

## Key metric

A wrong auto-link corrupts a canonical group, so the headline is **recall at ≥99%
precision** (positives vs ignores+hard), not raw AUC+. `blend_weights.json` carries the
standardized `mean`/`std`/`w`/`b` and the val metrics.

## Not done here (future)

GitHub-Action auto-triage (retrieve via `recommendSimilar` → classify → auto-link ≥T_auto
/ queue `stviz/issue-*` / else "new"), ONNX export for CI, group-profile features with
leave-one-out. The substrate (featurizer + labeled exporter + feature dump) is built to
make those incremental.
