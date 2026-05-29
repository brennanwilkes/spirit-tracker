#!/usr/bin/env node
/**
 * tools/linker_ml/build_dataset.mjs — "dataset → labelled examples".
 *
 * Emits (into tools/linker_ml/out/):
 *   dataset_pairs.jsonl     {a,b,label,kind}  — labeled pairs, mined EXACTLY like
 *                            tools/linker_eval.mjs (positives within canonical groups,
 *                            curated ignores, auto-mined hard negatives, random easy
 *                            negatives) so AUC+ numbers stay directly comparable.
 *   sku_texts.jsonl         {sku,text}        — every SKU's embedder input (skuToText).
 *   groups.json             [[sku,...],...]   — canonical groups (≥2), for contrastive
 *                            training (all within-group pairs = positives) + retrieval eval.
 *   semantic_gap_cases.json — the four named pairs + all positive pairs sharing ≤1 name
 *                            token: the FN class only a semantic model can reach. The
 *                            benchmark every embedding variant is scored on before/after.
 *
 * Run:  node tools/linker_ml/build_dataset.mjs
 */

import fs from "fs";
import path from "path";
import { buildEnv, skuToText, OUT_DIR } from "./featurize.mjs";
import { normSearchText, tokenizeQuery } from "../../viz/app/sku.js";
import { filterSimTokens } from "../../viz/app/linker_page/similarity.js";

const env = buildEnv();
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------------- union-find over labeled links → canonical groups ---------------- */

const parent = new Map();
function find(x) {
	const stack = [];
	while (parent.has(x)) {
		stack.push(x);
		x = parent.get(x);
	}
	for (const p of stack) parent.set(p, x);
	return x;
}
function union(a, b) {
	const ra = find(a);
	const rb = find(b);
	if (ra !== rb) parent.set(ra, rb);
}
for (const l of env.allLinks) {
	const f = String(l.fromSku || "").trim();
	const t = String(l.toSku || "").trim();
	if (f && t && f !== t && env.bySku.has(f) && env.bySku.has(t)) union(f, t);
}
const canonOf = (s) => find(String(s));
const canonToSkus = new Map();
for (const s of env.bySku.keys()) {
	const c = canonOf(s);
	if (!canonToSkus.has(c)) canonToSkus.set(c, []);
	canonToSkus.get(c).push(s);
}

/* ---------------- deterministic PRNG (same seed as linker_eval) ---------------- */

let _seed = 0x9e3779b1 >>> 0;
function rand() {
	_seed =
		(Math.imul(_seed ^ (_seed >>> 16), 0x85ebca6b) >>> 0) ^ (Math.imul(_seed, 0xc2b2ae35) >>> 0);
	return (_seed >>> 0) / 0xffffffff;
}

/* ---------------- token cache (for hard-negative mining + gap detection) ---------------- */

const tokCache = new Map();
function toks(sku) {
	let t = tokCache.get(sku);
	if (!t) {
		t = new Set(filterSimTokens(tokenizeQuery(normSearchText(env.bySku.get(sku)?.name || ""))));
		tokCache.set(sku, t);
	}
	return t;
}
function sharedTokCount(a, b) {
	const A = toks(a);
	const B = toks(b);
	let n = 0;
	for (const x of A) if (B.has(x)) n++;
	return n;
}

/* ---------------- mine labeled pairs ---------------- */

const pairs = [];
const seen = new Set();
const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
function add(a, b, label, kind) {
	if (a === b) return false;
	const k = key(a, b);
	if (seen.has(k)) return false;
	seen.add(k);
	pairs.push({ a, b, label, kind });
	return true;
}

// Positives — within-group pairs, capped per group (matches linker_eval POS_PER_GROUP).
const POS_PER_GROUP = 20;
for (const skus of canonToSkus.values()) {
	if (skus.length < 2) continue;
	let count = 0;
	outer: for (let i = 0; i < skus.length; i++)
		for (let j = i + 1; j < skus.length; j++) {
			add(skus[i], skus[j], 1, "pos");
			if (++count >= POS_PER_GROUP) break outer;
		}
}
const posCount = pairs.filter((p) => p.label === 1).length;

// Negatives — curated ignores.
for (const ig of env.ignoreEntries) {
	const a = String(ig.skuA || ig.fromSku || "").trim();
	const b = String(ig.skuB || ig.toSku || "").trim();
	if (!a || !b || !env.bySku.has(a) || !env.bySku.has(b)) continue;
	if (canonOf(a) === canonOf(b)) continue;
	add(a, b, 0, "ignore");
}

// Hard negatives — share a distinctive bigram (idf ≥ 5), different canonical group.
const byBigram = new Map();
for (const it of env.allAgg) {
	if (!it.name) continue;
	for (const t of env.vocab.termsForName(it.name)) {
		if (!t.startsWith("b:") || env.vocab.idf(t) < 5) continue;
		if (!byBigram.has(t)) byBigram.set(t, []);
		byBigram.get(t).push(it.sku);
	}
}
const bigramKeys = [...byBigram.keys()];
const HARD_TARGET = Math.min(4000, posCount);
let hardAdded = 0;
let tries = 0;
while (hardAdded < HARD_TARGET && tries < HARD_TARGET * 25) {
	tries++;
	const arr = byBigram.get(bigramKeys[(rand() * bigramKeys.length) | 0]);
	if (!arr || arr.length < 2) continue;
	const a = arr[(rand() * arr.length) | 0];
	const b = arr[(rand() * arr.length) | 0];
	if (a === b || canonOf(a) === canonOf(b)) continue;
	if (add(a, b, 0, "hard")) hardAdded++;
}

// Random easy negatives.
const skuList = [...env.bySku.keys()];
let randAdded = 0;
let rtries = 0;
while (randAdded < posCount && rtries < posCount * 6) {
	rtries++;
	const a = skuList[(rand() * skuList.length) | 0];
	const b = skuList[(rand() * skuList.length) | 0];
	if (a === b || canonOf(a) === canonOf(b)) continue;
	if (add(a, b, 0, "random")) randAdded++;
}

/* ---------------- write dataset_pairs.jsonl ---------------- */

const pairsPath = path.join(OUT_DIR, "dataset_pairs.jsonl");
fs.writeFileSync(pairsPath, pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");

const counts = pairs.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {});
console.log("dataset_pairs.jsonl:", pairs.length, "pairs —", JSON.stringify(counts));

/* ---------------- write sku_texts.jsonl (embedder inputs) ---------------- */

const textsPath = path.join(OUT_DIR, "sku_texts.jsonl");
let nText = 0;
const tw = [];
for (const it of env.allAgg) {
	const text = skuToText(it);
	if (!text || text.length < 2) continue;
	tw.push(JSON.stringify({ sku: it.sku, text, canon: canonOf(it.sku) }));
	nText++;
}
fs.writeFileSync(textsPath, tw.join("\n") + "\n");
console.log("sku_texts.jsonl:", nText, "SKUs");

/* ---------------- write groups.json ---------------- */

const groups = [...canonToSkus.values()].filter((g) => g.length >= 2);
fs.writeFileSync(path.join(OUT_DIR, "groups.json"), JSON.stringify(groups));
console.log("groups.json:", groups.length, "groups (≥2 members)");

/* ---------------- semantic-gap benchmark ---------------- */

// Resolve the four named cases by fuzzy name lookup (best-effort; logged if missing).
function findSkuByName(...needles) {
	const lower = needles.map((n) => n.toLowerCase());
	for (const it of env.allAgg) {
		const n = (it.name || "").toLowerCase();
		if (lower.every((x) => n.includes(x))) return it.sku;
	}
	return null;
}
const named = [
	["PADDY / PADDY'S", findSkuByName("paddy"), findSkuByName("paddy", "s")],
	["LINDORES MCDXCIV / 1494", findSkuByName("lindores", "mcdxciv"), findSkuByName("lindores", "1494")],
	["TBWC / That Boutique-y", findSkuByName("tbwc"), findSkuByName("boutique")],
	[
		"Compass Box Artist / Great King Street",
		findSkuByName("compass box", "artist"),
		findSkuByName("great king street"),
	],
];

// Harvested: all POSITIVE pairs that share ≤1 filtered name token — the semantic gap
// the deterministic scorer structurally cannot reach.
const gapPairs = [];
for (const p of pairs) {
	if (p.label !== 1) continue;
	const st = sharedTokCount(p.a, p.b);
	if (st <= 1) gapPairs.push({ a: p.a, b: p.b, sharedTok: st });
}
const gap = {
	named: named.map(([label, a, b]) => ({
		label,
		a,
		b,
		nameA: a ? env.bySku.get(a)?.name : null,
		nameB: b ? env.bySku.get(b)?.name : null,
		resolved: !!(a && b && a !== b),
	})),
	harvested: gapPairs,
};
fs.writeFileSync(path.join(OUT_DIR, "semantic_gap_cases.json"), JSON.stringify(gap, null, 2));
console.log(
	`semantic_gap_cases.json: ${gapPairs.length} harvested ≤1-token positive pairs; named resolved: ${gap.named.filter((x) => x.resolved).length}/4`,
);
for (const n of gap.named)
	console.log(`   ${n.resolved ? "✓" : "✗"} ${n.label}  ${n.a || "?"} ‖ ${n.b || "?"}`);
