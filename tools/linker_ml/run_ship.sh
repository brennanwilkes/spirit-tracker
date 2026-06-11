#!/usr/bin/env bash
# Full hand-retrain of the linker: dataset → embedder fine-tune (saves out/model_ft) → GBT →
# LR fallback → eval. ~12 min on CPU. Run from repo root. This is the canonical retrain runner;
# the per-scrape CI re-encode (encode.py) is separate and does NOT retrain.
# ⚠️ AFTER this finishes you MUST ship the artifacts AND re-release the checkpoint — see the
#    reminder printed at the end + tools/linker_ml/CLAUDE.md §"Shipping the checkpoint".
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ML=tools/linker_ml; OUT=$ML/out; PY=$ML/.venv/bin/python; R=$OUT/REPORT_FINAL2.md
: > "$R"; sec(){ echo -e "\n## $*\n" | tee -a "$R"; }
echo "# Final retrain — transitive-grouping fix ($(date -u +%FT%TZ))" | tee -a "$R"

sec "Dataset (fixed grouping)"
node $ML/build_dataset.mjs > $OUT/s_build.log 2>&1; grep -E "dataset_pairs|groups|harvested" $OUT/s_build.log | tee -a "$R"

sec "Embedder retrain (groups changed)"
HF_HOME="$PWD/$ML/.hf_cache" $PY $ML/train_embed.py --epochs 6 --scale 30 --skip-base > $OUT/s_embed.log 2>&1
grep -E "noTrain pairs held|train:|wrote .*embeddings.json" $OUT/s_embed.log | tee -a "$R"
node $ML/dump_features.mjs > $OUT/s_dump.log 2>&1; tail -1 $OUT/s_dump.log | tee -a "$R"

sec "SHIPPING GBT (char-tri, noTrain excluded from all splits)"
$PY $ML/export_gbt.py > $OUT/s_gbt.log 2>&1; grep -E "VAL|TEST|exported" $OUT/s_gbt.log | tee -a "$R"

sec "LR fallback + weights"
node $ML/train_blend.mjs > $OUT/s_blend.log 2>&1; grep -E "AUC\+|test recall" $OUT/s_blend.log | tee -a "$R"
node $ML/make_blend_weights.mjs > $OUT/s_weights.log 2>&1; tail -1 $OUT/s_weights.log | tee -a "$R"

sec "Semantic gap + deterministic reference"
node $ML/eval_gap.mjs > $OUT/s_gap.log 2>&1; grep -E "mean detScore|mean cosBase|mean cosFt|recovered|harvested" $OUT/s_gap.log | tee -a "$R"
node tools/linker_eval.mjs > $OUT/s_eval.log 2>&1; grep -iE "AUC\+|auc vs|trivial" $OUT/s_eval.log | head -4 | tee -a "$R"

sec "Worst offenders (shipping model, noTrain + hidden excluded)"
node $ML/report_offenders.mjs $OUT/gbt_model.json > $OUT/s_off.log 2>&1; cat $OUT/s_off.log >> "$R"
echo -e "\nDONE — $R" | tee -a "$R"
cat <<EOF

================ SHIP CHECKLIST (do all three, or CI runs stale weights) ================
 (a) CODE on main:   git add viz/app/linker_page/blend_weights.js && commit
 (b) ARTIFACTS on data worktree (plain git now — NOT LFS), commit on data:
       cp $OUT/gbt_model.json  .worktrees/data/viz/data/gbt_model.json
     embeddings.json is NO LONGER committed — it's a Release asset. Push it now so the linker
     page has the new vectors immediately (the next cron re-encode would also do this):
       gh release upload embeddings-latest $OUT/embeddings.json --clobber
 (c) CHECKPOINT as a GitHub Release asset (NOT git/LFS) so CI re-encode uses the new weights:
       echo "\$(date -u +%F)" > tools/linker_ml/MODEL_VERSION
       tar czf /tmp/model_ft.tar.gz -C $OUT/model_ft .
       gh release create "model-ft-\$(cat tools/linker_ml/MODEL_VERSION)" /tmp/model_ft.tar.gz \\
         --title "linker encoder \$(cat tools/linker_ml/MODEL_VERSION)" --notes "fine-tuned all-MiniLM checkpoint"
       git add tools/linker_ml/MODEL_VERSION && commit on main   # busts CI cache → CI pulls new asset
 Full rationale: tools/linker_ml/CLAUDE.md §"Shipping the checkpoint".
=========================================================================================
EOF
