#!/usr/bin/env python3
# throwaway — eval each embeddings_<tag>.json with the GBT blend. delete after.
import sys, json, os, numpy as np
HERE=os.path.dirname(os.path.abspath(__file__)); OUT=os.path.join(HERE,"out")
tags=sys.argv[1:]
SKIP={"a","b","label","kind","canonA","canonB","detScore","embedCos"}
def fnv(s):
    h=0x811C9DC5
    for c in str(s): h^=ord(c)&0xFF; h=(h*0x01000193)&0xFFFFFFFF
    return h
is_val=lambda c:(fnv(c)%1000)/1000.0<0.25
rows=[json.loads(l) for l in open(os.path.join(OUT,"features.jsonl")) if l.strip()]
BASE=[k for k in rows[0] if k not in SKIP]
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score
def cos(emb,a,b):
    x=emb.get(a); y=emb.get(b)
    if not x or not y: return 0.0
    x=np.array(x); y=np.array(y)
    n=np.linalg.norm(x)*np.linalg.norm(y)
    return float(x@y/n) if n else 0.0
print(f"{'tag':10}{'AUC+':>9}{'rec@99':>9}{'rec@98':>9}{'rec@95':>9}")
for tag in tags:
    p=os.path.join(OUT,"embeddings.json" if tag=="ft" else f"embeddings_{tag}.json")
    if not os.path.exists(p): print(f"{tag:10}  MISSING"); continue
    emb=json.load(open(p))
    Xtr,ytr,Xva,yva,kva=[],[],[],[],[]
    for r in rows:
        base=[float(r.get(k,0) or 0) for k in BASE]
        v=base+[cos(emb,r["a"],r["b"])]
        if is_val(r["canonA"]): Xva.append(v); yva.append(int(r["label"])); kva.append(r["kind"])
        else: Xtr.append(v); ytr.append(int(r["label"]))
    Xtr,ytr,Xva,yva=map(np.array,(Xtr,ytr,Xva,yva)); kva=np.array(kva)
    pos=yva==1; hard=kva=="hard"; opneg=(kva=="hard")|(kva=="ignore")
    m=HistGradientBoostingClassifier(max_iter=800,max_depth=4,learning_rate=0.04,l2_regularization=1.0,early_stopping=True,validation_fraction=0.15,random_state=0).fit(Xtr,ytr)
    s=m.predict_proba(Xva)[:,1]
    auc=roc_auc_score(np.r_[np.ones(pos.sum()),np.zeros(hard.sum())],np.r_[s[pos],s[hard]])
    def rp(t):
        mm=pos|opneg; sv=s[mm]; lab=pos[mm].astype(int); o=np.argsort(-sv); lab=lab[o]
        tp=np.cumsum(lab); fp=np.cumsum(1-lab); prec=tp/np.maximum(tp+fp,1); rec=tp/pos.sum()
        ok=prec>=t; return float(rec[ok].max()) if ok.any() else 0.0
    print(f"{tag:10}{auc:9.4f}{rp(.99)*100:8.1f}%{rp(.98)*100:8.1f}%{rp(.95)*100:8.1f}%",flush=True)
