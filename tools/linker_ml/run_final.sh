#!/usr/bin/env bash
# Final ship run: rebuild features (now incl charTriCos), corrected noTrain-excluded TEST masks.
# Compares with vs without char-tri, both honest. No embedder retrain (char-tri is a blend feature).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ML=tools/linker_ml; OUT=$ML/out; PY=$ML/.venv/bin/python; R=$OUT/FINAL.md
: > "$R"; sec(){ echo -e "\n## $*\n" | tee -a "$R"; }
echo "# Final ship run ($(date -u +%FT%TZ)) — noTrain excluded from TEST, char-tri added" | tee -a "$R"

sec "Rebuild features (now with charTriCos)"
node $ML/dump_features.mjs > $OUT/f_dump.log 2>&1; tail -1 $OUT/f_dump.log | tee -a "$R"
# strip charTriCos for the honest baseline comparison
node --input-type=module -e '
import fs from "fs"; import path from "path"; import { OUT_DIR } from "./tools/linker_ml/featurize.mjs";
const p=path.join(OUT_DIR,"features.jsonl");
const rows=fs.readFileSync(p,"utf8").trim().split("\n").map(l=>{const o=JSON.parse(l); delete o.charTriCos; return JSON.stringify(o);});
fs.writeFileSync(path.join(OUT_DIR,"features_nochartri.jsonl"), rows.join("\n")+"\n");
console.log("features_nochartri.jsonl written");
' | tee -a "$R"

sec "BASELINE (corrected masks, NO char-tri)"
FEATURES_PATH=$OUT/features_nochartri.jsonl GBT_OUT=$OUT/gbt_nochartri.json $PY $ML/export_gbt.py > $OUT/f_base.log 2>&1
grep -E "VAL|TEST" $OUT/f_base.log | tee -a "$R"

sec "SHIPPING (corrected masks, WITH char-tri) → gbt_model.json"
$PY $ML/export_gbt.py > $OUT/f_ship.log 2>&1; grep -E "VAL|TEST|exported" $OUT/f_ship.log | tee -a "$R"

sec "LR fallback + weights"
node $ML/train_blend.mjs > $OUT/f_blend.log 2>&1; grep -E "AUC\+|test recall" $OUT/f_blend.log | tee -a "$R"
node $ML/make_blend_weights.mjs > $OUT/f_weights.log 2>&1; tail -1 $OUT/f_weights.log | tee -a "$R"

sec "Worst offenders (shipping model, noTrain excluded)"
node $ML/report_offenders.mjs $OUT/gbt_model.json > $OUT/f_off.log 2>&1; cat $OUT/f_off.log >> "$R"
echo -e "\nDONE — $R" | tee -a "$R"
