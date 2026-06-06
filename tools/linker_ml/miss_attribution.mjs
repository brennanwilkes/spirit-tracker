#!/usr/bin/env node
/**
 * tools/linker_ml/miss_attribution.mjs — drill into the SHIPPING GBT's misses at the 99%-precision
 * auto-link threshold, bucket them, and attribute EACH miss to the feature(s) holding it down.
 *
 * Attribution = per-feature COUNTERFACTUAL: for a missed positive, replace one feature with the
 * median-of-confirmed-matches value and re-score. The feature whose substitution most RAISES the
 * GBT score is "what's keeping this pair below the line." (Not exact SHAP — ignores interactions —
 * but directly answers "which signal looks wrong vs a normal match".)
 *
 * Held-out = val+test groups, noTrain excluded. Run:  node tools/linker_ml/miss_attribution.mjs
 */
import fs from "fs";
import path from "path";
import { buildEnv, OUT_DIR, readJson } from "./featurize.mjs";
import { gbtScore } from "../../viz/app/linker_page/gbt.js";
import { normSearchText } from "../../viz/app/sku.js";

const env = buildEnv();
const model = readJson(path.join(OUT_DIR, "gbt_model.json"));
const KEYS = model.keys;
const rows = fs.readFileSync(path.join(OUT_DIR, "features.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const h32 = (s) => { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const isTrain = (c) => (h32(c) % 1000) / 1000 >= 0.3;
const held = (r) => !r.noTrain && (!isTrain(r.canonA) || !isTrain(r.canonB));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const nm = (s) => (env.bySku.get(String(s))?.name || "?");

// median-of-confirmed-matches per feature (the "what a real match looks like" reference)
const pos = rows.filter((r) => r.label === 1 && !r.noTrain);
const med = {};
for (const k of KEYS) {
	const vals = pos.map((r) => num(r[k])).filter(Number.isFinite).sort((a, b) => a - b);
	med[k] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
}

// 99%-precision threshold on held-out (pos vs ignore+hard), same logic as export_gbt
const ev = rows.filter(held).filter((r) => r.label === 1 || r.kind === "ignore" || r.kind === "hard").map((r) => ({ r, s: gbtScore(model, r) }));
ev.sort((a, b) => b.s - a.s);
let tp = 0, fp = 0, thr = 1, nPos = ev.filter((x) => x.r.label === 1).length, bestRec = 0;
for (const x of ev) { if (x.r.label === 1) tp++; else fp++; const prec = tp / (tp + fp); const rec = tp / nPos; if (prec >= 0.99 && rec > bestRec) { bestRec = rec; thr = x.s; } }
console.log(`# Miss attribution — 99%-precision auto-link threshold = ${thr.toFixed(4)} (held-out rec@99 = ${(100 * bestRec).toFixed(1)}%, ${nPos} positives)`);

const misses = ev.filter((x) => x.r.label === 1 && x.s < thr);
console.log(`Missed confirmed links (below threshold): ${misses.length}\n`);

// bucket
const PACK = /\b(gift|pack|calendar|tasting|glasses|advent|sampler)\b/i;
function tri(s){const m=new Map();const p="  "+normSearchText(s).replace(/\s+/g," ")+"  ";for(let i=0;i+3<=p.length;i++)m.set(p.slice(i,i+3),(m.get(p.slice(i,i+3))||0)+1);return m;}
function triCos(a,b){const A=tri(a),B=tri(b);if(!A.size||!B.size)return 0;let na=0,nb=0,d=0;for(const w of A.values())na+=w*w;for(const w of B.values())nb+=w*w;const[s,l]=A.size<B.size?[A,B]:[B,A];for(const[g,w]of s){const w2=l.get(g);if(w2)d+=w*w2;}return d/(Math.sqrt(na)*Math.sqrt(nb)||1);}
function bucket(r){const a=nm(r.a),b=nm(r.b),ct=triCos(a,b);
	if((r.sizePen??1)<0.5)return"size_variant";
	if((r.abvMult??1)<0.5)return"abv_strength";
	if((r.edMult??1)<0.5)return"edition_batch";
	if(PACK.test(a)||PACK.test(b))return"gift_pack";
	if((r.sharedTok||0)<=1&&ct>=0.5)return"spelling_spacing";
	if((r.sharedTok||0)<=1&&(r.embedCos||0)>=0.55)return"semantic_gap";
	if((r.embedCos||0)<0.55)return"embedding_weak";
	return"other";}

// per-miss attribution
function attribute(x){
	const base=x.s, deltas=[];
	for(const k of KEYS){
		const cf={...x.r,[k]:med[k]};
		const d=gbtScore(model,cf)-base;
		if(d>0.01)deltas.push([k,d]);
	}
	deltas.sort((a,b)=>b[1]-a[1]);
	return deltas.slice(0,3);
}

const byBucket=new Map(); const culprit=new Map();
for(const x of misses){const b=bucket(x.r);if(!byBucket.has(b))byBucket.set(b,[]);byBucket.get(b).push(x);
	const att=attribute(x);x._att=att;if(att[0])culprit.set(att[0][0],(culprit.get(att[0][0])||0)+1);}

console.log("## Misses by category");
for(const[b,l]of[...byBucket.entries()].sort((a,b)=>b[1].length-a[1].length))console.log(`  ${b.padEnd(16)} ${l.length}  (${(100*l.length/misses.length).toFixed(0)}%)`);

console.log("\n## Top culprit feature (which single feature, if normalized to a typical match, most often rescues the miss)");
for(const[k,c]of[...culprit.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12))console.log(`  ${k.padEnd(20)} ${c}`);

console.log("\n## Per-example detail (grouped by category)");
for(const[b,l]of[...byBucket.entries()].sort((a,b)=>b[1].length-a[1].length)){
	console.log(`\n### ${b} (${l.length})`);
	for(const x of l.sort((p,q)=>p.s-q.s).slice(0,8)){
		const r=x.r;
		const att=x._att.map(([k,d])=>`${k} +${d.toFixed(2)}`).join(", ")||"(no single feature; needs combination)";
		console.log(`  score=${x.s.toFixed(3)} | ${nm(r.a).slice(0,38)}  ‖  ${nm(r.b).slice(0,38)}`);
		console.log(`     raw: emb=${(r.embedCos||0).toFixed(2)} det=${(r.detScore||0).toFixed(1)} sharedTok=${r.sharedTok||0} sizePen=${(r.sizePen??1).toFixed(2)} abvMult=${(r.abvMult??1).toFixed(2)} edMult=${(r.edMult??1).toFixed(2)} grpStoreOverlap=${(r.grpStoreOverlap||0).toFixed(2)} charTri=${(r.charTriCosLowTok||0).toFixed(2)}`);
		console.log(`     culprit→ ${att}`);
	}
}
