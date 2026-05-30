#!/bin/bash
# throwaway — embedding hyperparameter sweep, each config evaluated with the GBT blend. delete after.
cd /home/brennan/spirit-tracker || exit 1
VENV=tools/linker_ml/.venv/bin/python
export HF_HOME="$PWD/tools/linker_ml/.hf_cache"
RES=tools/linker_ml/out/_embed_sweep.log
: > "$RES"
run() { # epochs scale lr tag
  echo ">>> train tag=$4 epochs=$1 scale=$2 lr=$3 $(date +%H:%M:%S)" | tee -a "$RES"
  $VENV tools/linker_ml/train_embed.py --epochs "$1" --scale "$2" --lr "$3" --tag "$4" --skip-base 2>&1 \
    | grep -E "mean_loss|wrote" | tee -a "$RES"
}
run 3  20 2e-5 e3s20
run 6  20 2e-5 e6s20
run 10 20 2e-5 e10s20
run 16 20 2e-5 e16s20
run 6  30 2e-5 e6s30
run 6  10 2e-5 e6s10
echo ">>> EVAL (GBT depth-4, held-out by group) $(date +%H:%M:%S)" | tee -a "$RES"
$VENV tools/linker_ml/_eval_embed_sweep.py e3s20 e6s20 e10s20 e16s20 e6s30 e6s10 2>&1 | tee -a "$RES"
echo ">>> DONE $(date +%H:%M:%S)" | tee -a "$RES"
