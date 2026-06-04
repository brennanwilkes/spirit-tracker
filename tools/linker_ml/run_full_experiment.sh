#!/usr/bin/env bash
# Clean retrain (hidden + noTrain excluded everywhere) + feature-experiment battery.
# Writes one consolidated out/FULL_EXPERIMENT.md. ~20-30 min. Background-friendly.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ML=tools/linker_ml; OUT=$ML/out; PY=$ML/.venv/bin/python; R=$OUT/FULL_EXPERIMENT.md
: > "$R"; sec(){ echo -e "\n## $*\n" | tee -a "$R"; }
echo "# Full experiment ($(date -u +%FT%TZ))" | tee -a "$R"

sec "Clean dataset (hidden + noTrain excluded)"
node $ML/build_dataset.mjs > $OUT/x_build.log 2>&1; grep -E "dataset_pairs|sku_texts|groups" $OUT/x_build.log | tee -a "$R"

sec "Re-fine-tune embedder (clean)"
HF_HOME="$PWD/$ML/.hf_cache" $PY $ML/train_embed.py --epochs 6 --scale 30 --skip-base > $OUT/x_embed.log 2>&1
grep -E "noTrain pairs held|train:|wrote .*embeddings.json" $OUT/x_embed.log | tee -a "$R"
node $ML/dump_features.mjs > $OUT/x_dump.log 2>&1; tail -1 $OUT/x_dump.log | tee -a "$R"

sec "BASELINE GBT (clean, shipping) — TEST metrics"
$PY $ML/export_gbt.py > $OUT/x_gbt_base.log 2>&1; grep -E "VAL|TEST|exported" $OUT/x_gbt_base.log | tee -a "$R"

sec "Permutation importance (cheap ablation over all features)"
FEATURES=features.jsonl $PY $ML/perm_importance.py > $OUT/x_perm.log 2>&1; cat $OUT/x_perm.log >> "$R"

sec "Candidate features: char-trigram cosine + learned alias-PMI"
node $ML/feat_experiments.mjs > $OUT/x_feat.log 2>&1; cat $OUT/x_feat.log >> "$R"

sec "A/B: GBT TEST with each candidate feature (compare to BASELINE TEST above)"
for f in chartri alias both; do
  echo "--- + $f ---" | tee -a "$R"
  FEATURES_PATH=$OUT/features_$f.jsonl GBT_OUT=$OUT/gbt_$f.json $PY $ML/export_gbt.py > $OUT/x_gbt_$f.log 2>&1
  grep -E "TEST" $OUT/x_gbt_$f.log | tee -a "$R"
done

sec "Isotonic calibration check (does it sharpen rec@99?)"
$PY - <<'PY' > $OUT/x_calib.log 2>&1
import json, os, numpy as np
OUT=os.path.join("tools/linker_ml","out")
rows=[json.loads(l) for l in open(os.path.join(OUT,"features.jsonl")) if l.strip()]
SKIP={"a","b","label","kind","canonA","canonB","detScore"}; KEYS=[k for k in rows[0] if k not in SKIP]
X=np.array([[float(r.get(k,0) or 0) for k in KEYS] for r in rows]); y=np.array([int(r["label"]) for r in rows])
def fnv(s):
 h=0x811C9DC5
 for c in str(s): h^=ord(c)&0xFF; h=(h*0x01000193)&0xFFFFFFFF
 return h
b=np.array([(fnv(r["canonA"])%1000)/1000 for r in rows]); kind=np.array([r["kind"] for r in rows]); nt=np.array([bool(r.get("noTrain")) for r in rows])
tr=(~nt)&(b>=0.30); va=(~nt)&(b>=0.15)&(b<0.30); te=(~nt)&(b<0.15)
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
m=HistGradientBoostingClassifier(max_iter=800,max_depth=4,learning_rate=0.04,l2_regularization=1.0,early_stopping=True,validation_fraction=0.15,random_state=0).fit(X[tr],y[tr])
def recat(s,pos,opneg,t):
 mm=pos|opneg; sv=s[mm]; lab=pos[mm].astype(int); o=np.argsort(-sv); lab=lab[o]
 tp=np.cumsum(lab); fp=np.cumsum(1-lab); prec=tp/np.maximum(tp+fp,1); rec=tp/pos.sum(); ok=prec>=t
 return float(rec[ok].max()) if ok.any() else 0.0
sv=m.predict_proba(X[va])[:,1]; st=m.predict_proba(X[te])[:,1]
iso=IsotonicRegression(out_of_bounds="clip").fit(sv,y[va])
stc=iso.transform(st)
posT=y[te]==1; opT=(kind[te]=="hard")|(kind[te]=="ignore")
print("TEST rec@99 raw  :",round(recat(st,posT,opT,.99)*100,1),"% | rec@95",round(recat(st,posT,opT,.95)*100,1),"%")
print("TEST rec@99 isotonic:",round(recat(stc,posT,opT,.99)*100,1),"% | rec@95",round(recat(stc,posT,opT,.95)*100,1),"%")
print("(isotonic fit on VAL; monotone calibration cannot change AUC, only the threshold mapping)")
PY
cat $OUT/x_calib.log >> "$R"

sec "Supporting: LR, eval_gap, linker_eval, offenders (clean)"
node $ML/train_blend.mjs > $OUT/x_blend.log 2>&1; grep -E "AUC\+|test recall" $OUT/x_blend.log | tee -a "$R"
node $ML/make_blend_weights.mjs > $OUT/x_weights.log 2>&1; tail -1 $OUT/x_weights.log | tee -a "$R"
node $ML/eval_gap.mjs > $OUT/x_gap.log 2>&1; grep -E "mean detScore|mean cosBase|mean cosFt|recovered" $OUT/x_gap.log | tee -a "$R"
node tools/linker_eval.mjs > $OUT/x_eval.log 2>&1; grep -iE "AUC\+|auc vs|trivial" $OUT/x_eval.log | head -4 | tee -a "$R"
node $ML/report_offenders.mjs $OUT/gbt_model.json > $OUT/x_off.log 2>&1; cat $OUT/x_off.log >> "$R"

echo -e "\nDONE — $R" | tee -a "$R"
