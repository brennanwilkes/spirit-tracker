#!/usr/bin/env python3
"""Permutation importance of every GBT feature on the held-out (val+test) set — cheap ablation
to find dead weight + load-bearing features. Trains the metric model on TRAIN groups, permutes
each feature on held-out, reports the drop in AUC+ (pos vs hard+ignore). Run in venv."""
import json, os, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
SKIP = {"a", "b", "label", "kind", "canonA", "canonB", "detScore"}
rows = [json.loads(l) for l in open(os.path.join(OUT, os.environ.get("FEATURES", "features.jsonl"))) if l.strip()]
KEYS = [k for k in rows[0] if k not in SKIP]
X = np.array([[float(r.get(k, 0) or 0) for k in KEYS] for r in rows]); y = np.array([int(r["label"]) for r in rows])
def fnv(s):
    h = 0x811C9DC5
    for c in str(s): h ^= ord(c) & 0xFF; h = (h * 0x01000193) & 0xFFFFFFFF
    return h
bucket = np.array([(fnv(r["canonA"]) % 1000) / 1000.0 for r in rows])
kind = np.array([r["kind"] for r in rows]); no_train = np.array([bool(r.get("noTrain")) for r in rows])
is_train = (~no_train) & (bucket >= 0.30); held = (~no_train) & (bucket < 0.30)  # val+test, drop noTrain
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
m = HistGradientBoostingClassifier(max_iter=800, max_depth=4, learning_rate=0.04, l2_regularization=1.0,
    early_stopping=True, validation_fraction=0.15, random_state=0).fit(X[is_train], y[is_train])
Xh, yh, kh = X[held], y[held], kind[held]
pos = yh == 1; opneg = (kh == "hard") | (kh == "ignore")
mm = pos | opneg
def auc_of(Xeval):
    s = m.predict_proba(Xeval)[:, 1]
    return roc_auc_score(yh[mm].astype(int), s[mm])
base = auc_of(Xh)
rng = np.random.RandomState(0); res = []
for i, k in enumerate(KEYS):
    drops = []
    for _ in range(5):
        Xp = Xh.copy(); Xp[:, i] = rng.permutation(Xp[:, i]); drops.append(base - auc_of(Xp))
    res.append((k, float(np.mean(drops))))
res.sort(key=lambda t: -t[1])
print(f"held-out AUC+ (pos vs hard+ignore) base = {base:.4f}   (held rows: pos {int(pos.sum())} / neg {int(opneg.sum())})")
print("\n## Permutation importance (mean AUC+ drop when feature is shuffled; 5 reps):")
print("rank\timportance\tfeature")
for i, (k, v) in enumerate(res): print(f"{i+1}\t{v:+.4f}\t{k}")
