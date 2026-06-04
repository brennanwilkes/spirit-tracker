#!/usr/bin/env bash
# Re-run the dataset-dependent experiments on the CORRECTED (transitive-grouping-fixed) data.
# Reuses the embeddings + features.jsonl from run_ship.sh (NO embedder retrain). ~6-8 min.
# features.jsonl already CONTAINS charTriCos (blend.js emits it), so:
#   - char-tri A/B  = features_nochartri (stripped) vs features.jsonl
#   - alias / cooccur A/B = marginal value ON TOP of the shipping feature set.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ML=tools/linker_ml; OUT=$ML/out; PY=$ML/.venv/bin/python; R=$OUT/RE_EXPERIMENTS.md
: > "$R"; sec(){ echo -e "\n## $*\n" | tee -a "$R"; }
echo "# Re-experiments on corrected data ($(date -u +%FT%TZ))" | tee -a "$R"

sec "Co-occurrence necessity + G&M (RE-MEASURED on fixed groups)"
node $ML/cooccur_analysis.mjs > $OUT/r_cooccur.log 2>&1
grep -E "TRAIN pairs|cadenhead|glentauchers|gordon|macphail|smws|signatory|Standalone|detScore|embedCos|disagreeNecMax|agreeNecSum|crossEntity|disMax fires" $OUT/r_cooccur.log | tee -a "$R"

sec "Learned aliases + char-tri rescues (RE-MINED)"
node $ML/feat_experiments.mjs > $OUT/r_feat.log 2>&1
sed -n '/Top 25 LEARNED/,/RESCUES/p' $OUT/r_feat.log | head -30 | tee -a "$R"

sec "GBT A/B on corrected data (compare TEST rec@99; noTrain excluded)"
# baseline = strip char-tri
node --input-type=module -e '
import fs from "fs"; import path from "path"; import { OUT_DIR } from "./tools/linker_ml/featurize.mjs";
const rows=fs.readFileSync(path.join(OUT_DIR,"features.jsonl"),"utf8").trim().split("\n").map(l=>{const o=JSON.parse(l);delete o.charTriCos;return JSON.stringify(o);});
fs.writeFileSync(path.join(OUT_DIR,"features_nochartri.jsonl"),rows.join("\n")+"\n");'
echo "--- BASELINE (no char-tri) ---" | tee -a "$R"
FEATURES_PATH=$OUT/features_nochartri.jsonl GBT_OUT=$OUT/gbt_nc.json $PY $ML/export_gbt.py 2>&1 | grep TEST | tee -a "$R"
echo "--- SHIPPING (+ char-tri) ---" | tee -a "$R"
$PY $ML/export_gbt.py 2>&1 | grep TEST | tee -a "$R"
echo "--- + alias-PMI (on top of char-tri) ---" | tee -a "$R"
FEATURES_PATH=$OUT/features_alias.jsonl GBT_OUT=$OUT/gbt_al.json $PY $ML/export_gbt.py 2>&1 | grep TEST | tee -a "$R"
echo "--- + co-occurrence necessity (on top of char-tri) ---" | tee -a "$R"
node $ML/cooccur_augment.mjs > $OUT/r_coaug.log 2>&1
FEATURES_PATH=$OUT/features_cooccur.jsonl GBT_OUT=$OUT/gbt_co.json $PY $ML/export_gbt.py 2>&1 | grep TEST | tee -a "$R"

sec "Permutation importance (corrected data, top/bottom)"
FEATURES=features.jsonl $PY $ML/perm_importance.py > $OUT/r_perm.log 2>&1
grep -E "base =|^[0-9]" $OUT/r_perm.log | head -12 | tee -a "$R"
echo "..." | tee -a "$R"; grep -E "^[0-9]" $OUT/r_perm.log | tail -6 | tee -a "$R"
echo -e "\nDONE — $R" | tee -a "$R"
