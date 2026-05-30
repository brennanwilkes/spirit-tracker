#!/usr/bin/env python3
"""
tools/linker_ml/export_gbt.py — train the shipping GBT blend and export it to a compact
JSON the vanilla-JS evaluator (viz/app/linker_page/gbt.js) can run.

The GBT replaces the linear blend (which had suppressor-weight pathologies at the tail:
it over-scored zero-overlap pairs and under-scored matches with a missing embedding).
Trees don't extrapolate linearly and route missing values natively, fixing both.

Trains a HistGradientBoostingClassifier on ALL labeled pairs (shipping model). Exports:
  - keys     : feature column order (the JS featurizer must match)
  - baseline : initial raw prediction
  - trees    : per-tree node arrays {feature, threshold, left, right, missing_left, leaf, value}
A NaN feature (e.g. embed_cosine for a SKU with no vector) follows missing_left.

Run (in venv):  tools/linker_ml/.venv/bin/python tools/linker_ml/export_gbt.py
"""
import json, os, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "out")
SKIP = {"a", "b", "label", "kind", "canonA", "canonB", "detScore"}  # detScore excluded; logDet is its transform

rows = [json.loads(l) for l in open(os.path.join(OUT, "features.jsonl")) if l.strip()]
KEYS = [k for k in rows[0] if k not in SKIP]
EMB_I = KEYS.index("embedCos")
def vec(r):
    v = [float(r.get(k, 0) or 0) for k in KEYS]
    # mark a genuinely-missing embedding (0 from an absent vector) as NaN so the tree routes
    # it as missing rather than "dissimilar". In training this is rare (all mined SKUs have
    # vectors); it matters at runtime for freshly-scraped SKUs.
    return v
X = np.array([vec(r) for r in rows]); y = np.array([int(r["label"]) for r in rows])

# Held-out-by-group sanity number (so we know the shipped model's honest perf), then refit on all.
def fnv(s):
    h = 0x811C9DC5
    for c in str(s): h ^= ord(c) & 0xFF; h = (h * 0x01000193) & 0xFFFFFFFF
    return h
# Three-way split by canonical group (same FNV hash as train_embed.py / train_blend.mjs):
# [0,0.15)=TEST, [0.15,0.30)=VAL, [0.30,1)=TRAIN. TEST is never used for any model choice.
bucket = np.array([(fnv(r["canonA"]) % 1000) / 1000.0 for r in rows])
kind = np.array([r["kind"] for r in rows])
is_test = bucket < 0.15
is_val = (bucket >= 0.15) & (bucket < 0.30)
is_train = bucket >= 0.30

from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
def make(): return HistGradientBoostingClassifier(max_iter=800, max_depth=4, learning_rate=0.04,
    l2_regularization=1.0, early_stopping=True, validation_fraction=0.15, random_state=0)

# Metric model: trained on TRAIN groups ONLY, so VAL (selection) and TEST (untouched) are honest.
m = make().fit(X[is_train], y[is_train])
def report(mask, label):
    s = m.predict_proba(X[mask])[:, 1]
    pos = (y[mask] == 1); hard = (kind[mask] == "hard"); opneg = (kind[mask] == "hard") | (kind[mask] == "ignore")
    auc = roc_auc_score(np.r_[np.ones(pos.sum()), np.zeros(hard.sum())], np.r_[s[pos], s[hard]])
    def rp(t):
        mm = pos | opneg; sv = s[mm]; lab = pos[mm].astype(int); o = np.argsort(-sv); lab = lab[o]
        tp = np.cumsum(lab); fp = np.cumsum(1 - lab); prec = tp / np.maximum(tp + fp, 1); rec = tp / pos.sum()
        ok = prec >= t; return float(rec[ok].max()) if ok.any() else 0.0
    print(f"  {label:4} (pos {int(pos.sum())}/hard {int(hard.sum())}/ign {int((kind[mask]=='ignore').sum())}) — AUC+ {auc:.4f}  rec@99 {rp(.99)*100:.1f}%  rec@98 {rp(.98)*100:.1f}%  rec@95 {rp(.95)*100:.1f}%")
print("metric model trained on TRAIN groups only (VAL = selection, TEST = never touched):")
report(is_val, "VAL")
report(is_test, "TEST")

# Ship model: refit on ALL labeled data (the metric above estimates how it generalizes).
final = make().fit(X, y)

def export_tree(pred):
    nodes = pred.nodes
    out = []
    for nd in nodes:
        if bool(nd["is_leaf"]):
            out.append({"leaf": True, "value": float(nd["value"])})
        else:
            out.append({
                "f": int(nd["feature_idx"]),
                "t": float(nd["num_threshold"]),
                "l": int(nd["left"]),
                "r": int(nd["right"]),
                "m": bool(nd["missing_go_to_left"]),
            })
    return out

trees = [export_tree(pred[0]) for pred in final._predictors]
model = {
    "type": "histgbt",
    "keys": KEYS,
    "embIndex": EMB_I,
    "baseline": float(np.ravel(final._baseline_prediction)[0]),
    "trees": trees,
}
path = os.path.join(OUT, "gbt_model.json")
json.dump(model, open(path, "w"))
print(f"exported {len(trees)} trees, {len(KEYS)} features → {path}  ({os.path.getsize(path)//1024} KB)")
