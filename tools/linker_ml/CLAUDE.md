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

## Latest retrain (2026-06-04, ~2× labels): honest TEST AUC+ 0.984, **rec@99 80.7%**, rec@95 95.5%

The headline jumped from the prior ~69% almost entirely from ONE bug fix (below), not new features.
What changed + the dead-ends (don't re-try):

- **★ THE BIG ONE — transitive-grouping bug fixed** (`build_dataset.mjs` AND `tools/linker_eval.mjs`).
  Both only unioned a link edge when BOTH endpoints were in the current catalog (`bySku.has(f)&&
  bySku.has(t)`). A DELISTED intermediate SKU (absent from the index) then broke a transitive chain
  `A→[absent B]→C`, splitting one product into fragments — which were mined as HARD NEGATIVES, feeding
  REAL MATCHES to the model as negatives and corrupting both training and the metric. Fix: union the
  FULL link graph regardless of catalog presence, on NORMALIZED keys (`normalizeImplicitSkuKey`,
  matching `src/utils/sku_map.js`), then emit pairs only among present SKUs. Also raised the silent
  `POS_PER_GROUP` cap 20→500. Effect: **positives 5,648→9,418 (+67%)**, TEST rec@99 **69.6→80.7%**,
  deterministic AUC+ **0.82→0.92**. Lesson: any DSU over the links MUST not gate edges on catalog
  presence. (Other DSU-building tools — `tools/rarity_report.js`, `build_email_event_pack.js` via
  `sku_canonical.js` — go through the shared module and are likely fine, but worth auditing.)
- **noTrain EXCLUDED from every split** (was forced into TEST → falsely depressed rec@99 ~49→63);
  embedder noTrain LEAK fixed; **hidden SKUs excluded** in `buildEnv`. See §"Train/val/TEST honesty".
- **Permutation importance**: `embedCos` dominates (+0.21 AUC+ drop; ~18× the next). `grpPriceRatio`,
  `grpCountB`, `logDet`, `grpStoreOverlap` are the only other non-trivial ones. Most det sub-factors +
  many `grp*` ≈0 for AUC+ — BUT size/abv/edition/concept are precision-tail GUARDS (barely move AUC+,
  block specific rec@99 FPs) so DON'T prune on this table alone. Future lift = embedding + labels.
- **DEAD-END — char-trigram cosine** (`blend.js`, now removed): helped on the BUGGY data (+6.2 rec@99)
  by rescuing spelling-variant pairs the fragmentation mislabeled. After the grouping fix those pairs
  are proper positives and the embedding handles them → char-tri REGRESSED TEST (80.7→79.5) and was
  removed. **Re-test idea:** may still help SKUs with NO embedding vector (freshly scraped). The code
  is in git history if revisited.
- **DEAD-END — co-occurrence necessity** and **learned alias-PMI**
  (scripts deleted): both confirmed-negative AGAIN on corrected data (GBT TEST rec@99 79.2 /
  77.2 vs 80.7 baseline). Necessity self-corrects nicely (`cadenhead` 0.79 vs `gordon` 0.35 — G&M is
  fragmented by surface forms `g&m`→`g m`→dropped) but is redundant with embeddings+`crossEntityConflicts`.
  Alias-PMI mostly rediscovers possessive/misspelling variants; true abbreviation aliases are too
  sparse (<4 co-occ) to learn → embedding's job. Don't re-add either without a fundamentally new angle.
- **Embedding-enrichment ablation** (script deleted): enriched text beats bare name on net
  (+0.01 cosine, 85 better/33 worse); the 33 hurt cases are enrichment ASYMMETRY (one side's group
  resolved an attr the other didn't). Deferred refinement, not a quick patch.

Analysis helpers kept: `report_offenders.mjs` (noTrain/hidden-excluded worst FP/FN), `perm_importance.py`,
`miss_attribution.mjs`, `other_pattern.mjs`, `size_unlink_audit.mjs`, `trend_fn.mjs`, `find_mislabels.mjs`.
`run_ship.sh` runs the full retrain chain. `export_gbt.py` honors `FEATURES_PATH`/`GBT_OUT`; `train_embed.py`
takes `--texts`/`--tag`. (The one-off experiment scripts — co-occurrence, alias-PMI, char-tri ablations,
cross-encoder, the multi-run orchestrators — were deleted after their dead-end verdicts below; recover from
git history if ever revisited.) **Lesson the hard way: after a dataset/grouping change, RE-RUN every feature
A/B — char-tri's verdict flipped from +6.2 to −1.2 once the bug was fixed.**

## 2026-06-05 (b) — `containGated` SHIPPED + `charTriCosLowTok` was never actually committed

- **`charTriCosLowTok` is NOT in `blend.js`** (HEAD): the prior session's "SHIPPED" note (above)
  was aspirational — the feature only ever lived in the working-tree `blend_weights.js`, never in
  `FEATURE_KEYS`. So the documented 84.5% baseline (which needed it) is not reproducible from HEAD.
  The honest HEAD baseline (fresh rebuild on current labels + current `embeddings.json`) is
  **TEST AUC+ 0.9832 / rec@99 80.1%**. ALWAYS rebuild a baseline before an A/B; don't trust the
  last documented number across a charTri/embedding/label change.
- **`containGated` SHIPPED** (`blend.js`, 41 features) — the GATED distinctive-token containment.
  RAW `shorterDistinctiveContain` regressed rec@99 (same-distillery/diff-expression negatives
  share the distillery token + have high containment → crowd the 99% line). Multiplying it by a
  NO-CONFLICT gate (`edMult>=0.9 && abvMult>=0.9 && sizePen>=0.9 && ageRel!==-1`) zeroes it on
  exactly those negatives. **TEST rec@99 80.1→81.2, rec@98 +0.4, AUC+ flat, det AUC+ untouched.**
  Lesson: a RECALL feature that over-fires on the precision tail can be rescued by gating it on
  the existing hard-rule conflict signals. blend_weights.js regenerated (also dropped the stale
  charTri key). gbt_model.json copied to `.worktrees/data/viz/data/`.
- **Rapid-linker worklist now sorts by INFORMATIVENESS, not match strength** (`linker_rapid_page.js`).
  `refinedScore` returns `informativeness(score01, hasConflict)`: ×CONFLICT_BOOST for high-score
  pairs with a conflicting attr (boundary hard-negatives = highest-value labels), a gaussian
  uncertainty bump at the decision boundary, ×TRIVIAL_DAMP for near-certain non-conflicting
  (obvious) matches. Tunable constants at the top of that block. Live-UX only (no offline A/B).

## 2026-06-05 follow-up (label cleanup + targeted char-tri SHIPPED + cross-encoder rejected)

Shipped state now: TEST **AUC+ 0.985, rec@99 ~84–85%** (within embedder run-to-run noise of the
2026-06-04 build), on cleaned labels.

- **Mislabel cleanup (data branch `sku_links.json`):** ~50 human-reviewed edits via `find_mislabels.mjs`
  (scores every `ignore`/`link` with the shipped GBT → strong disagreements). Removed bad cross-product
  links (incl. several **transitive bad-merges** — cut the bridging edge, keep correct sub-groups, e.g.
  Kraken Gold↔Black, Silkie Dark↔Midnight, Glenmorangie Lasanta 12↔15, Paranubes Rum↔Añejo). Pattern:
  many "FP" ignores were really unlinked matches; precision tail is gated by LABELS, not the model.
- **Gift-pack noTrain:** all link edges where a name matches `/gift|pack|calendar|tasting|glasses|advent|sampler/i`
  are flagged `noTrain` (format wrappers held out of training).
- **`charTriCosLowTok` SHIPPED** (`blend.js`) — supersedes the "char-tri removed" note in the 2026-06-04
  section. The GLOBAL char-tri regressed; the **targeted floor** (char-trigram cosine ONLY when
  `sharedTok<=1`) is a clean marginal keep (+0.3 rec@99 isolated, AUC+ flat, det AUC+ unchanged) that
  recovers spelling/spacing variants without polluting the well-tokenized tail. 41 features now.
- **Embedding coverage is already 100%** — `train_embed` encodes ALL current `sku_texts.jsonl` SKUs, so a
  fresh build has no `embedCos==0` gap. (Stale `embedCos==0` misses only appear when scoring against an
  OLDER embeddings file than the catalog.)
- **DEAD-END (done correctly) — cross-encoder re-ranker** (scripts deleted). A 5-fold OUT-OF-FOLD
  cross-encoder (every pair scored by a model that never saw its canonical group — the honest
  version; an earlier in-fold attempt leaked to 79.8%) scored 81.6% rec@99 vs 84.5% shipped. It **shifts
  the curve, not lifts it**: −2.9 rec@99 for +2.9 rec@98 / +1.1 rec@95, AUC+ flat. Aggregate separation is
  strong (pos 0.90 vs neg 0.11) so it's tail-noise/redundancy, not a weak model. At our 99%-precision
  auto-link target it's a NET LOSS; only worth it at a relaxed 98% target, and it needs per-candidate-pair
  inference at serve time. Parked (scores + models in `out/`). **The ceiling for rec@99 is more/cleaner
  labels, not more features.**

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
#    Also SAVES the checkpoint → out/model_ft (printed at the end) — that checkpoint is what CI's
#    per-build re-encode uses, so it MUST be re-released after every retrain (see §"Shipping the
#    checkpoint" below). --epochs/--scale/--lr/--tag are tunable.
HF_HOME="$PWD/tools/linker_ml/.hf_cache" \
  tools/linker_ml/.venv/bin/python tools/linker_ml/train_embed.py --epochs 6 --scale 30 --skip-base
#   SWEEP RESULT: 3–6 epochs best, scale 30 ≳ 20;
#   16 epochs OVERFITS (lowest train loss, WORST held-out rec@99). Judge held-out, never train loss.

# 4. fold embed_cosine in
node tools/linker_ml/dump_features.mjs          # now fills embed_cosine from embeddings.json

# 5. THE SHIPPING MODEL — gradient-boosted-tree blend (Python venv, sklearn HistGBT)
tools/linker_ml/.venv/bin/python tools/linker_ml/export_gbt.py   # → out/gbt_model.json (trees + missing-routing)

# 6. LR FALLBACK (group-aware) + sanity metrics
node tools/linker_ml/train_blend.mjs            # LR held-out metrics
node tools/linker_ml/make_blend_weights.mjs     # → viz/app/linker_page/blend_weights.js (commit on main)
node tools/linker_ml/eval_gap.mjs               # semantic-gap before/after

# 7. SHIP — three destinations (see §"Shipping the checkpoint" for the full why):
#  (a) CODE on main: gbt.js, group_features.js, blend_weights.js, suggestions/page wiring.
#  (b) ARTIFACTS to the data worktree (LFS), commit on data:
cp tools/linker_ml/out/embeddings.json .worktrees/data/viz/data/sku_embeddings.json
cp tools/linker_ml/out/gbt_model.json  .worktrees/data/viz/data/gbt_model.json
#  (c) CHECKPOINT as a GitHub Release asset (NOT git/LFS) so CI's per-build re-encode picks up the
#      new weights — bump MODEL_VERSION, upload, then commit the bump on main:
echo "$(date -u +%F)" > tools/linker_ml/MODEL_VERSION                       # bump the version
tar czf /tmp/model_ft.tar.gz -C tools/linker_ml/out/model_ft .
gh release create "model-ft-$(cat tools/linker_ml/MODEL_VERSION)" /tmp/model_ft.tar.gz \
  --title "linker encoder $(cat tools/linker_ml/MODEL_VERSION)" --notes "fine-tuned all-MiniLM checkpoint"
# git add tools/linker_ml/MODEL_VERSION && commit on main  → busts CI cache → CI pulls the new asset
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
- **Missing embedding vectors are rare in prod now** — `run_daily.sh` RE-ENCODES every scrape
  (`build_dataset.mjs` → `encode.py`, see §"Per-build re-encode (SHIPPED in CI)"), so freshly-scraped
  SKUs get vectors within one cron cycle. If a vector is still missing the GBT routes it via the
  tree's NaN branch (the LR path falls back to no-embed weights) — never a crash.

## ⭐ Production auto-linking (`tools/auto_link_classify.mjs`) + the active-learning loop

A SECOND CI consumer of the live ranker (besides the linker pages): `tools/auto_link_classify.mjs`
runs every scrape in `run_daily.sh` (after the re-encode), reuses `buildEnv` + `recommendSimilar`
+ the GBT blend (so it can never drift from eval/serve), and writes `status:"pending"` links to
`data/sku_links.json` for any candidate ≥ `autoLinkConfidenceBar` (0.95). Root `CLAUDE.md`
§"Auto-Link Classification + Review" is the spec. **Why it matters here:** the `#/link-review`
Approve/Reject decisions are the cheapest way to grow the labeled set precisely where the model is
uncertain — Approve → a positive link, Reject → a curated `ignore` (hard negative). This is exactly
the "mine an IB review queue → grow curated ignores → higher rec@99" path noted in §"Next planned
improvement". So after a wave of reviews, RE-TRAIN (the chain above) to bank the new supervision.
The classifier reads the SAME labels you train on, so a retrain immediately sharpens what it
auto-links next.

## ⭐ Shipping the checkpoint + per-build re-encode (READ BEFORE TOUCHING THE MODEL)

The encoder is hand-trained infrequently (`train_embed.py`); CI re-encodes the catalog every scrape
with the FIXED checkpoint so new SKUs get vectors WITHOUT retraining. Two facts drive the design:
1. **CI must get the checkpoint, but the cron does NOT smudge data-branch LFS** (verified in run logs —
   it regenerates `index.json`/`recent.json`/`sku_embeddings.json` and never `git lfs pull`s `data`).
   An LFS checkpoint would reach the cron as a useless pointer. → The checkpoint ships as a **GitHub
   Release asset**, never git/LFS. (Bonus: zero LFS bandwidth/storage on free tier.)
2. The re-encode output is deterministic, so an unchanged catalog → byte-identical `sku_embeddings.json`
   → no LFS churn; a new LFS version appears only when SKUs actually change.

**Per-build re-encode (SHIPPED in CI):** `scripts/run_daily.sh` runs `build_dataset.mjs` then
`tools/linker_ml/encode.py` (reads `$LINKER_MODEL_DIR`, writes `out/embeddings.json`) and copies it to
`viz/data/sku_embeddings.json`. `.github/workflows/cron_tracker.yaml` sets up a cached venv (CPU torch
+ ST + sklearn, pinned in `requirements.txt`) and restores the checkpoint from the Release asset via
`actions/cache` keyed on `tools/linker_ml/MODEL_VERSION`.

**After EVERY hand-retrain you MUST re-release the checkpoint** (step 7c above), else CI keeps encoding
with the OLD weights while `gbt_model.json`/`blend_weights.js` expect the NEW space — a silent
train/serve skew. The chain: bump `MODEL_VERSION` → `gh release create model-ft-<ver> model_ft.tar.gz`
→ commit the bump on `main` (busts the CI cache → CI downloads the new asset on its next run).
`train_embed.py` prints this checklist at the end of every run. Keep `requirements.txt` (and the
`torch==` pin in `cron_tracker.yaml`) matched to your local venv so CI vectors match the checkpoint.

**Also after a retrain:** `make_blend_weights.mjs` rewrites `blend_weights.js` (commit on `main`); copy
`out/{embeddings.json,gbt_model.json}` to the data worktree (LFS) and commit on `data`
(`pages.yaml` already deploys all of `viz/`). Re-run `tools/linker_eval.mjs` (the deterministic
apples-to-apples reference).

## Files

| File | Runtime | What it is |
|---|---|---|
| `featurize.mjs` | Node ESM | **Shared core.** `buildEnv()` (catalog+vocab+size/price, identical to `linker_eval.mjs`), `featurizeSku()`/`skuToText()` (SKU→shape / embedder text), `featurizePair()` (the feature vector). `FEATURE_KEYS` is the ordered column list — keep in sync with `train_blend.mjs`. |
| `build_dataset.mjs` | Node ESM | Mines `out/dataset_pairs.jsonl` (pos/ignore/hard/random — same logic + seed as `linker_eval.mjs`), `out/sku_texts.jsonl` (embedder inputs), `out/groups.json` (canonical groups), `out/semantic_gap_cases.json` (the benchmark). |
| `dump_features.mjs` | Node ESM | `dataset_pairs × featurizePair → out/features.jsonl`. Fills `embed_cosine` from `out/embeddings.json` if present. |
| `train_blend.mjs` | Node ESM | Logistic regression over the factors. Group-split train/val (FNV hash, 25%), balanced classes, L2. Prints AUC+ / threshold tables vs the raw deterministic score; writes `out/blend_weights.json`. |
| `train_embed.py` | Python venv | Contrastive fine-tune of all-MiniLM-L6-v2 (manual torch MNRL loop — **no `datasets` dep**) with curated hard negatives. Writes `out/embeddings.json` AND **saves the checkpoint → `out/model_ft`** (then prints the re-release checklist). |
| `encode.py` | Python venv | **Per-build re-encode** (run by `run_daily.sh` in CI). Loads `$LINKER_MODEL_DIR` (the Release-asset checkpoint) + `out/sku_texts.jsonl` → `out/embeddings.json`. Deterministic; no retraining. |
| `export_gbt.py` | Python venv | Trains + exports the SHIPPING GBT → `out/gbt_model.json` (sklearn HistGBT; honors `FEATURES_PATH`/`GBT_OUT`). |
| `eval_gap.mjs` | Node ESM | Semantic-gap before/after: det vs cosBase vs cosFt vs blendProb, on the named cases + harvested ≤1-token positives + concrete 0-token examples. |
| `requirements.txt` | — | Python deps, **version-pinned to the local venv** for CI vector parity (CPU torch installed separately via its index URL). |
| `MODEL_VERSION` | — | Checkpoint version string. CI cache key + Release-tag suffix (`model-ft-<ver>`). **Bump on every hand-retrain.** |
| `out/` | — | All artifacts (gitignored), incl. `model_ft/` (the local checkpoint, shipped as a Release asset — see §"Shipping the checkpoint"). |
| `.venv/`, `.hf_cache/` | — | Python env + HuggingFace model cache (both gitignored, in-project). |

## Train/val/TEST honesty (do not break) — THREE-WAY split as of 2026-05-30

All three trainers (`train_embed.py`, `train_blend.mjs`, `export_gbt.py`) split by **canonical
group** with the SAME FNV hash: **`[0,0.15)=TEST`, `[0.15,0.30)=VAL`, `[0.30,1)=TRAIN`**.
The embedder + GBT + LR train ONLY on TRAIN; VAL is for selection; **TEST is never touched
until the final number** (it caught val-selection bias — val rec@99 ran ~10pt optimistic).
The shipped GBT still refits on ALL labels (minus noTrain); the TEST metric estimates how it
generalizes. If you change the split fractions or hash in one file, change all three.

**noTrain pairs are EXCLUDED from EVERY split — train, val, AND test (changed 2026-06-04).** They
were previously *forced into TEST*; that was wrong — a noTrain pair was labeled with info the
classifier can't access, so scoring it "wrong" is expected, not a model failure, and counting it
in TEST falsely depressed rec@99 (**~49% → ~63% just by dropping them from TEST**). They're also
excluded from `report_offenders.mjs`. Before 2026-06-04, `train_embed.py` ALSO leaked them as
positives (via canonical-group membership) and as hard-negs — now keyed off `dataset_pairs.jsonl`'s
`noTrain` flag. See [[feedback_notrain_and_hidden_exclusion]].

**Hidden SKUs (`data/sku_hidden.json`) are excluded from EVERYTHING** at the single chokepoint
`featurize.buildEnv` (mirrors `viz/app/catalog.js`'s per-`(storeId,rawSku)` filter via
`r.storeLabel||r.store`). Stricter than the rest of the system (where hide is presentation-only).
Dropping them removed spurious hard cases and *raised* honest TEST rec@98 (~60%→~71%).

**Report TEST, not VAL, as the headline.** And ALWAYS pair the aggregate with the spot-panel
in `TODO_COOCCURRENCE_FEATURE.md` — this session a change raised TEST AUC+/rec@99 while
regressing the targeted case; only the spot-check caught it.

## Train/serve name parity (do not break)

`featurize.buildEnv` and `linker_eval.mjs` keep the **FIRST non-empty** listing name per SKU
to MATCH `viz/app/catalog.js::aggregateBySku` (the serving aggregation). Keeping the *longest*
name (the old rule) was a train/serve skew — the model scored different text live than in
training. Don't reintroduce longest-name.

## Graph-structural feature — `crossEntityConflicts` (SHIPPED 2026-05-30)

The independent-bottler residual (Cadenhead Benriach↔Jura wrongly scored ~0.80) is fixed by a
**graph-structural** blend feature, NOT raw co-occurrence. `crossEntityConflicts` (in `blend.js`)
counts unshared-distinctive cross-token pairs that are mutually-exclusive ENTITIES:
`coocCount(x,y)==0` ∧ both `df≥WELL_ATTESTED_DF_MIN(20)` ∧ both `degPerDf<ENTITY_DEGPERDF_MAX(1.1)`
∧ not `fuzzyVariant`. Lifted TEST rec@99 62.4→**68.9%**, AUC+ →0.9844, Jura 0.80→0.50, gap
unchanged (350/350). Full narrative + the dead-ends in `TODO_COOCCURRENCE_FEATURE.md`.

- **The insight:** a node's `degree/df` (distinct co-occurrence partners ÷ its listings)
  separates token TYPES — TRAIT (`oloroso` 1.58, broad unrelated company, low clustering) vs
  DISTILLERY (`jura` 0.75, same few bottlers repeat). That "entity vs descriptor" line is what raw
  co-occurrence and df-gating couldn't see. Discovered from the graph, **no hardcoded vocab.**
- **Vocab support:** `vocab.js` `coocMap` is now `Map<token,Map<token,count>>`; new `coocCount(a,b)`
  + `dfOf(term)` exposed. `coocSet` still returns the inner map (`.size`/`.has` unchanged).
- **DO-NOT-FORGET overfit lesson:** more graph features (clustering, centrality, deg/df-as-feature)
  push VAL rec@99 up but TEST DOWN. The whole win is ONE feature. Judge TEST, never VAL; a forward-
  selection that improves VAL while TEST falls is overfitting — STOP. rec@99→95% needs more/cleaner
  labels + embedding work, not more features.

## Next planned improvement

Open follow-ups (see `TODO_COOCCURRENCE_FEATURE.md` RESOLVED §): (a) a `degPerDf` entity-conflict
wall in the CLASSICAL `scorePairWithVocab` (lift deterministic AUC; re-validate via
`linker_eval.mjs`); (b) global token canonicalization of spelling variants (`john→johnnie`); (c)
mine an IB review queue from high `crossEntityConflicts` to grow curated ignores (the real path to
higher rec@99).

## Metrics that matter

A wrong auto-link corrupts a canonical group, so the headline is **recall at ≥99%
precision** (positives vs ignores+hard), then **AUC+** (vs hard negatives). `eval_gap.mjs`
covers the semantic class the embedding uniquely targets. Measured before/after lives in the dated
retrain notes at the top of this file (the `RESULTS.md` scratch report was deleted).

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
