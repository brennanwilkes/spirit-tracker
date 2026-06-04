#!/usr/bin/env bash
# Ablation: does the ENRICHED embedder text (name + size/abv/year/cat) help or hurt vs the
# BARE normalized name? Trains a second embedder on bare names and compares cosine on the
# confirmed-link semantic-gap pairs + the worst false-negatives. Answers the "is the embedding
# confused by non-normalized / appended data" question with data. ~6 min, background.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
ML=tools/linker_ml; OUT=$ML/out; PY=$ML/.venv/bin/python
REPORT=$OUT/EMBED_ABLATION.md
: > "$REPORT"

# 1. bare-name texts (skuToText, no enrichment), keeping canon for the same train split
node --input-type=module -e '
import fs from "fs"; import path from "path";
import { buildEnv, skuToText, OUT_DIR } from "./tools/linker_ml/featurize.mjs";
import { normSearchText } from "./viz/app/sku.js";
const env = buildEnv();
const enriched = fs.readFileSync(path.join(OUT_DIR,"sku_texts.jsonl"),"utf8").trim().split("\n").map(l=>JSON.parse(l));
const canon = new Map(enriched.map(r=>[r.sku, r.canon]));
const out=[];
for (const it of env.allAgg){ const text = normSearchText(it.name||""); if(!text||text.length<2) continue;
  out.push(JSON.stringify({sku: it.sku, text, canon: canon.get(it.sku) ?? it.sku})); }
fs.writeFileSync(path.join(OUT_DIR,"sku_texts_bare.jsonl"), out.join("\n")+"\n");
console.log("sku_texts_bare.jsonl:", out.length, "SKUs (bare name only)");
' | tee -a "$REPORT"

# 2. train bare-name embedder (same recipe), write embeddings_barename.json
echo "training bare-name embedder ..." | tee -a "$REPORT"
HF_HOME="$PWD/$ML/.hf_cache" $PY $ML/train_embed.py --epochs 6 --scale 30 --skip-base \
  --texts sku_texts_bare.jsonl --tag barename > $OUT/embed_ablation_train.log 2>&1
tail -2 $OUT/embed_ablation_train.log | tee -a "$REPORT"

# 3. compare cosine: enriched (embeddings.json) vs bare (embeddings_barename.json)
node --input-type=module -e '
import fs from "fs"; import path from "path";
import { buildEnv, OUT_DIR } from "./tools/linker_ml/featurize.mjs";
const env = buildEnv();
const E = JSON.parse(fs.readFileSync(path.join(OUT_DIR,"embeddings.json"),"utf8"));
const B = JSON.parse(fs.readFileSync(path.join(OUT_DIR,"embeddings_barename.json"),"utf8"));
const cos=(u,v)=>{ if(!u||!v) return null; let d=0; for(let i=0;i<u.length;i++) d+=u[i]*v[i]; return d; };
const gap = JSON.parse(fs.readFileSync(path.join(OUT_DIR,"semantic_gap_cases.json"),"utf8"));
const nm=s=>(env.bySku.get(String(s))?.name||"?").slice(0,40);
let se=0,sb=0,n=0,worse=0,better=0;
for(const p of gap.harvested){ const e=cos(E[p.a],E[p.b]), b=cos(B[p.a],B[p.b]); if(e==null||b==null) continue;
  se+=e; sb+=b; n++; if(e<b-0.03) worse++; if(e>b+0.03) better++; }
console.log("\n## Enriched vs bare on "+n+" confirmed-link gap pairs");
console.log("mean cosine  enriched="+(se/n).toFixed(3)+"  bare="+(sb/n).toFixed(3));
console.log("enriched notably WORSE (<bare-0.03): "+worse+"   notably BETTER: "+better+"   (rest ~equal)");
// per-pair on the largest enriched-vs-bare gaps (where enrichment changed the score most)
const rows=gap.harvested.map(p=>({p,e:cos(E[p.a],E[p.b]),b:cos(B[p.a],B[p.b])})).filter(x=>x.e!=null&&x.b!=null);
rows.sort((x,y)=>(x.e-x.b)-(y.e-y.b));
console.log("\n### 12 pairs where ENRICHMENT hurt cosine most (enriched ≪ bare)");
console.log("enriched\tbare\tnameA\tnameB");
for(const x of rows.slice(0,12)) console.log(x.e.toFixed(3)+"\t"+x.b.toFixed(3)+"\t"+nm(x.p.a)+"\t"+nm(x.p.b));
' | tee -a "$REPORT"
echo "ABLATION REPORT: $REPORT"
