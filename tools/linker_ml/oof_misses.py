#!/usr/bin/env python3
"""
tools/linker_ml/oof_misses.py — honest per-pair scores for the WHOLE labeled set, for miss analysis.

5 folds by canonical group (same FNV bucket as export_gbt.py, so a group never straddles folds). Each
fold is scored by a GBT (same hyper-parameters as the shipping model) trained on the other four, so
every pair's score is out-of-fold. noTrain pairs are scored but never trained on. Caveat: the encoder
was fine-tuned on the TRAIN split (bucket >= 0.30), so embedCos is in-sample for ~70% of groups.

Writes out/oof_scores.jsonl: {a, b, label, kind, noTrain, fold, p}.
Run (in venv):  tools/linker_ml/.venv/bin/python tools/linker_ml/oof_misses.py
"""
import json, os, numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier

HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
SKIP = {"a", "b", "label", "kind", "canonA", "canonB", "detScore"}
rows = [json.loads(l) for l in open(os.path.join(OUT, "features.jsonl")) if l.strip()]
KEYS = [k for k in rows[0] if k not in SKIP]
X = np.array([[float(r.get(k, 0) or 0) for k in KEYS] for r in rows])
y = np.array([int(r["label"]) for r in rows])
no_train = np.array([bool(r.get("noTrain")) for r in rows])

def fnv(s):
    h = 0x811C9DC5
    for c in str(s): h ^= ord(c) & 0xFF; h = (h * 0x01000193) & 0xFFFFFFFF
    return h
fold = np.array([int((fnv(r["canonA"]) % 1000) / 200) for r in rows])

p = np.zeros(len(rows))
for k in range(5):
    tr = (fold != k) & ~no_train
    m = HistGradientBoostingClassifier(max_iter=800, max_depth=4, learning_rate=0.04, l2_regularization=1.0,
        early_stopping=True, validation_fraction=0.15, random_state=0).fit(X[tr], y[tr])
    p[fold == k] = m.predict_proba(X[fold == k])[:, 1]
    print(f"fold {k}: scored {int((fold == k).sum())}")

with open(os.path.join(OUT, "oof_scores.jsonl"), "w") as f:
    for r, pk, fk in zip(rows, p, fold):
        f.write(json.dumps({"a": r["a"], "b": r["b"], "label": int(r["label"]), "kind": r["kind"],
            "noTrain": bool(r.get("noTrain")), "fold": int(fk), "p": round(float(pk), 5)}) + "\n")
print(f"wrote {len(rows)} → out/oof_scores.jsonl")
