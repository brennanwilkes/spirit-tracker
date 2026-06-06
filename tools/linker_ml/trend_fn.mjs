#!/usr/bin/env node
/**
 * tools/linker_ml/trend_fn.mjs — bucket the SHIPPING model's held-out false-negatives (confirmed
 * links it scores low) into actionable TREND categories, so we can target whole classes rather
 * than one-off pairs. Held-out = val+test groups, noTrain excluded.
 *
 * Run:  node tools/linker_ml/trend_fn.mjs [scoreCut=0.5]
 */
import fs from "fs";
import path from "path";
import { buildEnv, OUT_DIR, readJson } from "./featurize.mjs";
import { gbtScore } from "../../viz/app/linker_page/gbt.js";
import { normSearchText } from "../../viz/app/sku.js";

const CUT = parseFloat(process.argv[2] || "0.5");
const env = buildEnv();
const model = readJson(path.join(OUT_DIR, "gbt_model.json"));
const rows = fs.readFileSync(path.join(OUT_DIR, "features.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
function hash32(s){let h=0x811c9dc5;s=String(s);for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193);}return h>>>0;}
const isTrain=(c)=>(hash32(c)%1000)/1000>=0.3;
const heldOut=(r)=>!r.noTrain && (!isTrain(r.canonA)||!isTrain(r.canonB));

function tri(s){const m=new Map();const p="  "+normSearchText(s).replace(/\s+/g," ")+"  ";for(let i=0;i+3<=p.length;i++)m.set(p.slice(i,i+3),(m.get(p.slice(i,i+3))||0)+1);return m;}
function triCos(a,b){const A=tri(a),B=tri(b);if(!A.size||!B.size)return 0;let na=0,nb=0,d=0;for(const w of A.values())na+=w*w;for(const w of B.values())nb+=w*w;const[s,l]=A.size<B.size?[A,B]:[B,A];for(const[g,w]of s){const w2=l.get(g);if(w2)d+=w*w2;}return d/(Math.sqrt(na)*Math.sqrt(nb)||1);}
const nm=(s)=>(env.bySku.get(String(s))?.name||"?");
const PACK=/\b(gift|pack|calendar|tasting|glasses|advent|miniature|gift\s?set|sampler)\b/i;

function bucket(r){
	const nA=nm(r.a),nB=nm(r.b),ct=triCos(nA,nB);
	if((r.sizePen??1)<0.5) return "size_variant";
	if((r.abvMult??1)<0.5) return "abv_strength_variant";
	if((r.edMult??1)<0.5) return "edition_batch_variant";
	if(PACK.test(nA)||PACK.test(nB)) return "gift_pack_format";
	if((r.sharedTok||0)<=1 && ct>=0.5) return "spelling_spacing";
	if((r.sharedTok||0)<=1 && (r.embedCos||0)>=0.55) return "semantic_gap (abbrev/synonym)";
	if((r.embedCos||0)<0.55) return "embedding_failed";
	return "other";
}

const fns=rows.filter(heldOut).filter(r=>r.label===1).map(r=>({r,s:gbtScore(model,r)})).filter(x=>x.s<CUT);
const buckets=new Map();
for(const x of fns){const b=bucket(x.r);if(!buckets.has(b))buckets.set(b,[]);buckets.get(b).push(x);}
const total=fns.length;
console.log(`# FN trend analysis — ${total} held-out confirmed links scored < ${CUT} (noTrain excluded)\n`);
const ordered=[...buckets.entries()].sort((a,b)=>b[1].length-a[1].length);
for(const [b,list] of ordered){
	console.log(`## ${b}: ${list.length} (${(100*list.length/total).toFixed(0)}%)`);
	for(const x of list.sort((p,q)=>p.s-q.s).slice(0,6))
		console.log(`   ${x.s.toFixed(3)} emb=${(x.r.embedCos||0).toFixed(2)} | ${nm(x.r.a).slice(0,40)}  ‖  ${nm(x.r.b).slice(0,40)}`);
	console.log();
}
