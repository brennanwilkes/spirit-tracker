#!/usr/bin/env bash
# Refresh model on the cleaned labels (NO embedder retrain — edits are tiny vs the catalog, and
# we only need fresh GBT + error analysis). Then trend-bucket the residual false-negatives.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ML=tools/linker_ml; OUT=$ML/out; PY=$ML/.venv/bin/python; R=$OUT/REFRESH.md
: > "$R"; sec(){ echo -e "\n## $*\n"|tee -a "$R"; }
echo "# Refresh on cleaned labels ($(date -u +%FT%TZ))"|tee -a "$R"
node $ML/build_dataset.mjs > $OUT/rf_build.log 2>&1; grep -E "dataset_pairs|groups" $OUT/rf_build.log|tee -a "$R"
node $ML/dump_features.mjs > $OUT/rf_dump.log 2>&1; tail -1 $OUT/rf_dump.log|tee -a "$R"
sec "GBT TEST (cleaned labels, reused embeddings)"
$PY $ML/export_gbt.py > $OUT/rf_gbt.log 2>&1; grep -E "VAL|TEST|exported" $OUT/rf_gbt.log|tee -a "$R"
sec "False-negative TRENDS"
node $ML/trend_fn.mjs 0.5 > $OUT/rf_trend.log 2>&1; cat $OUT/rf_trend.log >> "$R"
echo "DONE — $R"
