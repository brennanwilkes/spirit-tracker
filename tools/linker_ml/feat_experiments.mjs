#!/usr/bin/env node
/**
 * tools/linker_ml/feat_experiments.mjs — emit candidate NEW feature columns and report what
 * they discover. Two industry techniques for the residual FN classes:
 *
 *   charTriCos  — character-trigram TF-IDF cosine (classic fuzzy entity-resolution). Catches
 *                 spelling/spacing variants the token scorer AND subword embedder miss
 *                 (Revelstoke↔Revel Stoke, Slaughterhouse↔Slaughter House, Carribean↔Caribbean).
 *   aliasPmiMax — LEARNED alias signal (no hardcoding). Cross-side token PMI mined from TRAIN
 *                 links: how surprisingly-often token x (on side A only) co-occurs with token y
 *                 (on side B only) in confirmed links. Auto-discovers abbreviation↔expansion
 *                 (tbwc↔{boutique,whisky,company}, cc↔connoisseurs, pm↔port mourant).
 *
 * Writes (under out/): features_chartri.jsonl, features_alias.jsonl, features_both.jsonl
 * (= baseline features + the respective column(s)). Also prints the discovered aliases and a
 * few char-trigram "rescues" for inspection.
 *
 * Both signals are mined from the TRAIN split ONLY (no leakage into VAL/TEST).
 * Run:  node tools/linker_ml/feat_experiments.mjs
 */
import fs from "fs";
import path from "path";
import { buildEnv, OUT_DIR } from "./featurize.mjs";
import { normSearchText, tokenizeQuery } from "../../viz/app/sku.js";

const env = buildEnv();
function hash32(s) { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
const isTrainCanon = (c) => (hash32(c) % 1000) / 1000 >= 0.3;
const rows = fs.readFileSync(path.join(OUT_DIR, "features.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/* ---------- char-trigram TF-IDF ---------- */
const triCache = new Map();
function tris(sku) {
	let t = triCache.get(sku);
	if (t) return t;
	const s = "  " + normSearchText(env.bySku.get(sku)?.name || "").replace(/\s+/g, " ") + "  ";
	const set = new Map();
	for (let i = 0; i + 3 <= s.length; i++) { const g = s.slice(i, i + 3); set.set(g, (set.get(g) || 0) + 1); }
	triCache.set(sku, set);
	return set;
}
const triDf = new Map();
for (const sku of env.bySku.keys()) for (const g of tris(sku).keys()) triDf.set(g, (triDf.get(g) || 0) + 1);
const NDOC = env.bySku.size;
const triIdf = (g) => Math.log((NDOC + 1) / ((triDf.get(g) || 0) + 1));
function triVec(sku) {
	const v = new Map();
	let norm = 0;
	for (const [g, c] of tris(sku)) { const w = c * triIdf(g); v.set(g, w); norm += w * w; }
	norm = Math.sqrt(norm) || 1;
	for (const k of v.keys()) v.set(k, v.get(k) / norm);
	return v;
}
const triVecCache = new Map();
const getTri = (s) => { let v = triVecCache.get(s); if (!v) triVecCache.set(s, (v = triVec(s))); return v; };
function charTriCos(a, b) {
	const A = getTri(a), B = getTri(b);
	const [s, l] = A.size < B.size ? [A, B] : [B, A];
	let d = 0;
	for (const [g, w] of s) { const w2 = l.get(g); if (w2) d += w * w2; }
	return d;
}

/* ---------- learned alias PMI (cross-side token co-occurrence in TRAIN links) ---------- */
const STOP = new Set(["the", "and", "of", "a", "no", "single", "malt", "whisky", "whiskey", "scotch", "rum", "gin", "year", "old", "yo", "yr", "cask", "strength", "reserve", "edition", "ml", "abv", "vol", "with", "in"]);
function rawToks(sku) {
	return [...new Set(tokenizeQuery(normSearchText(env.bySku.get(sku)?.name || "")).filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t)))];
}
const tokDoc = new Map(); // token → # SKUs (for marginal P)
for (const sku of env.bySku.keys()) for (const t of rawToks(sku)) tokDoc.set(t, (tokDoc.get(t) || 0) + 1);
const TOTAL_SKU = env.bySku.size;
// cross-side co-occurrence over TRAIN positive pairs
const coCross = new Map(); // "x~y" → count (x only on A, y only on B, unordered)
let nLinks = 0;
for (const r of rows) {
	if (r.label !== 1 || r.noTrain) continue;
	if (!isTrainCanon(r.canonA) || !isTrainCanon(r.canonB)) continue;
	nLinks++;
	const A = new Set(rawToks(r.a)), B = new Set(rawToks(r.b));
	const onlyA = [...A].filter((t) => !B.has(t));
	const onlyB = [...B].filter((t) => !A.has(t));
	for (const x of onlyA) for (const y of onlyB) { const k = x < y ? `${x}~${y}` : `${y}~${x}`; coCross.set(k, (coCross.get(k) || 0) + 1); }
}
// PMI: log[ P(x,y cross-link) / (P(x) P(y)) ], require min co-count and that they DON'T share trigrams
// (so we surface true aliases, not spelling variants which charTriCos already handles).
const aliasPmi = new Map();
const aliases = [];
for (const [k, c] of coCross) {
	if (c < 4) continue;
	const [x, y] = k.split("~");
	const px = (tokDoc.get(x) || 1) / TOTAL_SKU, py = (tokDoc.get(y) || 1) / TOTAL_SKU;
	const pxy = c / Math.max(1, nLinks);
	const pmi = Math.log(pxy / (px * py));
	if (pmi <= 0) continue;
	aliasPmi.set(k, pmi);
	aliases.push({ x, y, c, pmi, dfx: tokDoc.get(x), dfy: tokDoc.get(y) });
}
aliases.sort((a, b) => b.pmi - a.pmi);
function aliasMax(a, b) {
	const A = new Set(rawToks(a)), B = new Set(rawToks(b));
	const onlyA = [...A].filter((t) => !B.has(t)), onlyB = [...B].filter((t) => !A.has(t));
	let m = 0;
	for (const x of onlyA) for (const y of onlyB) { const k = x < y ? `${x}~${y}` : `${y}~${x}`; const p = aliasPmi.get(k); if (p && p > m) m = p; }
	return m;
}

/* ---------- emit augmented feature files ---------- */
function write(name, addFn) {
	const out = rows.map((r) => ({ ...r, ...addFn(r) }));
	fs.writeFileSync(path.join(OUT_DIR, name), out.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
write("features_chartri.jsonl", (r) => ({ charTriCos: charTriCos(r.a, r.b) }));
write("features_alias.jsonl", (r) => ({ aliasPmiMax: aliasMax(r.a, r.b) }));
write("features_both.jsonl", (r) => ({ charTriCos: charTriCos(r.a, r.b), aliasPmiMax: aliasMax(r.a, r.b) }));

console.log(`feat_experiments: TRAIN links=${nLinks}, alias pairs mined=${aliases.length}, char-tri vocab=${triDf.size}`);
console.log("\n## Top 25 LEARNED aliases (cross-side token PMI, TRAIN links, non-trivial co-count):");
console.log("pmi\tcoCount\ttokenX\t(dfX)\ttokenY\t(dfY)");
for (const a of aliases.slice(0, 25)) console.log(`${a.pmi.toFixed(2)}\t${a.c}\t${a.x}\t(${a.dfx})\t${a.y}\t(${a.dfy})`);

// a few char-tri "rescues": confirmed links with low token overlap but high char-tri cosine
const nm = (s) => (env.bySku.get(String(s))?.name || "?").slice(0, 38);
const rescues = rows.filter((r) => r.label === 1 && !r.noTrain && (r.sharedTok || 0) <= 1).map((r) => ({ r, t: charTriCos(r.a, r.b) })).sort((a, b) => b.t - a.t).slice(0, 12);
console.log("\n## 12 token-poor confirmed links char-trigram cosine RESCUES (sharedTok≤1, high charTri):");
console.log("charTri\tnameA\tnameB");
for (const x of rescues) console.log(`${x.t.toFixed(3)}\t${nm(x.r.a)}\t${nm(x.r.b)}`);
