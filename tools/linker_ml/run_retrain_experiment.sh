#!/usr/bin/env bash
# Full retrain + analysis orchestration. Assumes train_embed.py already produced out/embeddings.json.
# Writes everything to out/*.log and a consolidated out/RETRAIN_REPORT.md.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ML=tools/linker_ml
OUT=$ML/out
PY=$ML/.venv/bin/python
REPORT=$OUT/RETRAIN_REPORT.md
: > "$REPORT"
log() { echo "$@" | tee -a "$REPORT"; }
sec() { echo -e "\n## $*\n" | tee -a "$REPORT"; }

log "# Retrain report ($(date -u +%FT%TZ))"

# 1. fold the freshly-trained embeddings into features
sec "Step: dump_features (fold new embeddings)"
node $ML/dump_features.mjs > $OUT/step_dump.log 2>&1
tail -1 $OUT/step_dump.log | tee -a "$REPORT"

# 2. SHIPPING GBT (baseline feature set)
sec "Step: export_gbt — SHIPPING model (held-out metrics)"
$PY $ML/export_gbt.py > $OUT/step_gbt.log 2>&1
grep -E "VAL|TEST|exported" $OUT/step_gbt.log | tee -a "$REPORT"

# 3. CO-OCCURRENCE A/B — augment features, retrain GBT to a side path, compare TEST
sec "Step: co-occurrence A/B (add necessity columns, retrain GBT)"
node $ML/cooccur_augment.mjs > $OUT/step_cooccur.log 2>&1
tail -1 $OUT/step_cooccur.log | tee -a "$REPORT"
FEATURES_PATH=$OUT/features_cooccur.jsonl GBT_OUT=$OUT/gbt_cooccur.json \
  $PY $ML/export_gbt.py > $OUT/step_gbt_cooccur.log 2>&1
echo "--- WITH co-occurrence features: ---" | tee -a "$REPORT"
grep -E "VAL|TEST" $OUT/step_gbt_cooccur.log | tee -a "$REPORT"
echo "(compare TEST line above to the SHIPPING TEST line in the previous section)" | tee -a "$REPORT"

# 4. LR fallback + sanity
sec "Step: train_blend (LR fallback) — TEST metrics"
node $ML/train_blend.mjs > $OUT/step_blend.log 2>&1
grep -E "AUC\+|TEST|test recall|val pairs|embeddings present" $OUT/step_blend.log | tee -a "$REPORT"
node $ML/make_blend_weights.mjs > $OUT/step_weights.log 2>&1
tail -1 $OUT/step_weights.log | tee -a "$REPORT"

# 5. semantic-gap before/after
sec "Step: eval_gap (semantic-gap recovery)"
node $ML/eval_gap.mjs > $OUT/step_gap.log 2>&1
grep -E "mean detScore|mean cosBase|mean cosFt|mean blendProb|recovered|0-token recovered|harvested" $OUT/step_gap.log | tee -a "$REPORT"

# 6. deterministic reference
sec "Step: linker_eval (deterministic scorer reference)"
node tools/linker_eval.mjs > $OUT/step_eval.log 2>&1
grep -iE "AUC\+|auc vs|trivial|precision|recall|threshold|95%|99%" $OUT/step_eval.log | head -30 | tee -a "$REPORT"

# 7. worst offenders for the SHIPPING gbt
sec "Step: worst offenders (shipping GBT, held-out)"
node $ML/report_offenders.mjs $OUT/gbt_model.json > $OUT/step_offenders.log 2>&1
cat $OUT/step_offenders.log >> "$REPORT"

# 8. G&M fragmentation probe — do bottler surface-forms fragment the token signal?
sec "Step: G&M / bottler fragmentation probe"
node --input-type=module -e '
import { buildEnv } from "./tools/linker_ml/featurize.mjs";
import { normSearchText } from "./viz/app/sku.js";
const env = buildEnv();
const forms = { "gordon":0, "macphail":0, "connoisseurs":0, "cc":0, "gm":0, "cadenhead":0 };
let gAndM = 0, gmGlued = 0, total = 0;
for (const it of env.allAgg) {
  total++;
  const raw = (it.name||"").toLowerCase();
  const n = normSearchText(it.name||"");
  if (/\bg\s*&\s*m\b/.test(raw)) gAndM++;
  if (/\bg&m\b|\bgm\b/.test(raw)) gmGlued++;
  for (const k of Object.keys(forms)) if (new RegExp("\\b"+k+"\\b").test(n)) forms[k]++;
}
console.log("listings:", total);
console.log("contain \"g & m\" (raw):", gAndM, " | \"g&m\"/\"gm\":", gmGlued);
console.log("token counts (post-normSearchText):", JSON.stringify(forms));
console.log("→ note: normSearchText turns \"g&m\" into \"g m\" (both dropped as 1-char by filterSimTokens);");
console.log("  so a \"G&M X\"↔\"Gordon & MacPhail X\" match shares NEITHER gordon nor macphail → drags necessity down.");
' > $OUT/step_gm_probe.log 2>&1
cat $OUT/step_gm_probe.log | tee -a "$REPORT"

sec "DONE"
log "Full per-step logs in $OUT/step_*.log. Shipping artifacts: out/gbt_model.json, out/embeddings.json."
echo "REPORT WRITTEN: $REPORT"
