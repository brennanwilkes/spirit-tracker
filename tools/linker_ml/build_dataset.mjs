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
import { buildEnv, skuToTextEnriched, OUT_DIR, WORKTREE, readJson } from "./featurize.mjs";
import { normSearchText, tokenizeQuery } from "../../viz/app/sku.js";
import { normalizeImplicitSkuKey } from "../../viz/app/sku_canonical.js";
const normKey = (s) => normalizeImplicitSkuKey(String(s || "").trim());
import { filterSimTokens } from "../../viz/app/linker_page/similarity.js";

const env = buildEnv();
fs.mkdirSync(OUT_DIR, { recursive: true });

// Label files name `id:`-sourced listings in either form (`id:1049495` or bare `1049495`) — every
// canonical loader treats them as one sku via normalizeImplicitSkuKey — but env.bySku is keyed by
// the prefixed catalog form. A raw bySku.has() silently dropped ~1/3 of curated ignores (4,828 of
// 14,442 on 2026-09-22) from training. Resolve to the catalog key before any presence check.
const catalogKeyByNorm = new Map();
for (const k of env.bySku.keys()) {
	const n = normKey(k);
	if (!catalogKeyByNorm.has(n)) catalogKeyByNorm.set(n, k);
}
const catalogKey = (s) => {
	const raw = String(s || "").trim();
	if (!raw) return null;
	if (env.bySku.has(raw)) return raw;
	return catalogKeyByNorm.get(normKey(raw)) ?? null;
};

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
// Build set of noTrain direct pairs (canonical key → {label, a, b}).
// noTrain entries ARE real equivalences, so they still enter the union-find (canonical groups
// stay correct for featurization), but they must NOT appear in TRAIN or VAL — only TEST.
const noTrainPairKeys = new Map(); // canonicalKey → {label, a, b}
for (const l of env.manualLinks) {
	if (!l.noTrain) continue;
	const f = catalogKey(l.fromSku);
	const t = catalogKey(l.toSku);
	if (f !== null && t !== null && f !== t) {
		const k = [f, t].sort().join("|");
		noTrainPairKeys.set(k, { label: 1, a: f, b: t });
	}
}
for (const ig of env.ignoreEntries) {
	if (!ig.noTrain) continue;
	const a = catalogKey(ig.skuA || ig.fromSku);
	const b = catalogKey(ig.skuB || ig.toSku);
	if (a !== null && b !== null && a !== b) {
		const k = [a, b].sort().join("|");
		noTrainPairKeys.set(k, { label: 0, a, b });
	}
}

// Union over ALL link edges REGARDLESS of catalog presence, on NORMALIZED keys (id:NNN→padded,
// matching the live map src/utils/sku_map.js::loadSkuMap). BUG FIXED 2026-06-04: the old guard
// `bySku.has(f) && bySku.has(t)` dropped any edge whose endpoint was a delisted SKU, which broke
// transitive chains (A→[absent B]→C) and split one product into several groups — those fragments
// were then mined as HARD NEGATIVES, feeding real matches to the model as negatives and corrupting
// both training and eval. Now we union the full link graph, then emit pairs only among PRESENT
// catalog SKUs (so every pair is still trainable). See [[feedback_notrain_and_hidden_exclusion]].
for (const l of env.allLinks) {
	const f = normKey(l.fromSku);
	const t = normKey(l.toSku);
	if (f && t && f !== t) union(f, t);
}
const canonOf = (s) => find(normKey(s));
const canonToSkus = new Map(); // present catalog SKUs only, grouped by full-graph canonical root
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

// Cross-store SKU collisions: one normalized sku carrying two DIFFERENT products. Such an
// aggregate is not a product, so no pair involving it is a well-defined label — and its name
// (hence every name feature) belongs to whichever listing won the aggregate. Excluding them is
// the same principle as the sku_hidden.json exclusion in featurize.mjs.
//
// This matters more than the raw count suggests because positives are the full transitive
// CLOSURE of each canonical group: one bad member in an N-member group yields N-1 bad positives,
// not one. Measured 2026-09-22 over the live catalog: 117 of 11,210 positive pairs (1.04%) across
// 45 of 3,039 multi-member groups touched a collision candidate. A concrete example that was
// being trained as a POSITIVE: "Roseisle 12yr Special Release" ≡ "Laphroaig Cairdeas 2023".
// The pollution is NOT removable by unlinking — no link created the merge.
const COLLISION_PATH = path.join(WORKTREE, "data/sku_collisions.json");
const collisionSkus = new Set();
// Tolerate absence, but LOUDLY. run_daily.sh calls this under `set +e`, so a throw here would not
// fail the run — it would skip the re-encode and silently freeze sku_embeddings.json, which is
// precisely the 2026-08-20 stale-embeddings incident. Missing exclusions restore the previous
// behaviour (46 corrupted pairs in training); a dead nightly encode is far worse. Same shape as
// featurize.mjs's hidden-set loader.
if (fs.existsSync(COLLISION_PATH)) {
	for (const c of readJson(COLLISION_PATH).collisions || []) {
		// add() compares catalog keys, so a bare-form entry would otherwise filter nothing.
		const k = catalogKey(c.sku);
		if (k !== null) collisionSkus.add(k);
	}
} else {
	console.warn(`WARN: ${COLLISION_PATH} not found — training on ALL pairs, including any that touch a cross-store sku collision. Commit data/sku_collisions.json to the data branch.`);
}
let droppedCollisionPairs = 0;

function add(a, b, label, kind, noTrain) {
	if (a === b) return false;
	if (collisionSkus.has(a) || collisionSkus.has(b)) {
		droppedCollisionPairs++;
		return false;
	}
	const k = key(a, b);
	if (seen.has(k)) return false;
	seen.add(k);
	pairs.push({ a, b, label, kind, ...(noTrain ? { noTrain: true } : {}) });
	return true;
}

// Positives — ALL within-group pairs (the full transitive closure: if A,B,C,D are one canonical
// group via any mix of manual/auto/shared-SKU links, every pairing is a valid positive). High
// safety cap only to bound a pathological mega-group. Raised from 20 → 500 on 2026-06-04 (the old
// cap silently dropped pairs in the few large groups). noTrain link pairs are added separately.
const POS_PER_GROUP = 500;
for (const skus of canonToSkus.values()) {
	if (skus.length < 2) continue;
	let count = 0;
	outer: for (let i = 0; i < skus.length; i++)
		for (let j = i + 1; j < skus.length; j++) {
			const isNoTrain = noTrainPairKeys.has(key(skus[i], skus[j]));
			if (!isNoTrain) {
				add(skus[i], skus[j], 1, "pos");
				if (++count >= POS_PER_GROUP) break outer;
			}
		}
}
const posCount = pairs.filter((p) => p.label === 1).length;

// Negatives — curated ignores (excluding noTrain entries; those are added below).
for (const ig of env.ignoreEntries) {
	if (ig.noTrain) continue;
	const a = catalogKey(ig.skuA || ig.fromSku);
	const b = catalogKey(ig.skuB || ig.toSku);
	if (a === null || b === null || a === b) continue;
	if (canonOf(a) === canonOf(b)) continue;
	add(a, b, 0, "ignore");
}

// noTrain pairs — explicitly emitted with noTrain:true so trainers can route them to TEST only.
for (const { label, a, b } of noTrainPairKeys.values()) {
	if (!env.bySku.has(a) || !env.bySku.has(b)) continue;
	if (label === 0 && canonOf(a) === canonOf(b)) continue; // contradiction check for ignores
	add(a, b, label, label === 1 ? "pos" : "ignore", true);
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
// Say this out loud. A filter that removes training data silently is how the stale-embeddings
// incident happened; if the collisions file grows wrong, the count is the only way to notice.
console.log(
	`  excluded ${droppedCollisionPairs} pair(s) touching ${collisionSkus.size} known cross-store sku collision(s) (data/sku_collisions.json)`,
);

/* ---------------- write sku_texts.jsonl (embedder inputs) ---------------- */

const textsPath = path.join(OUT_DIR, "sku_texts.jsonl");
let nText = 0;
const tw = [];
for (const it of env.allAgg) {
	const text = skuToTextEnriched(it.sku, env);
	if (!text || text.length < 2) continue;
	tw.push(JSON.stringify({ sku: it.sku, text, canon: canonOf(it.sku) }));
	nText++;
}
fs.writeFileSync(textsPath, tw.join("\n") + "\n");
console.log("sku_texts.jsonl:", nText, "SKUs");

/* ---------------- write groups.json ---------------- */

// train_embed.py builds its contrastive positives from these groups, so the collision filter in
// add() must apply here too or a collided sku is still trained as its group's positive.
const groups = [...canonToSkus.values()].map((g) => g.filter((s) => !collisionSkus.has(s))).filter((g) => g.length >= 2);
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
