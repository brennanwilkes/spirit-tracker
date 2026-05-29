#!/usr/bin/env node
/**
 * tools/linker_eval.mjs — SKU-matching evaluation harness (big-set edition).
 *
 * Imports the live scoring helper (scorePairWithVocab / prepScorePairCtx) from
 * viz/app/linker_page/* so the eval and the ranker can never drift.
 *
 * Evaluated ENTIRELY against the growing ground truth in data/sku_links.json
 * (confirmed links = positives, confirmed ignores = curated hard negatives).
 * The old curated fixtures.json is gone — the labeled set is now large and
 * accurate enough to subsume it (the ignores already cover the "should-not-
 * match / precision-only" role the fixtures used to). Sections:
 *
 *   1. AUC variants. AUC against RANDOM negatives is uninformative (a trivial
 *      "do they share any word" scorer already wins it). The metric that matters
 *      is AUC+ = AUC against AUTO-MINED HARD negatives (pairs sharing a
 *      distinctive bigram but in different canonical groups). A trivial
 *      shared-word baseline is printed alongside so the floor is visible.
 *
 *   2. Auto-link threshold table — for precision targets (0.90 … 0.99) over
 *      positives vs (ignores + hard negatives), the lowest score threshold that
 *      hits the target and the recall there. This is the operational number:
 *      "what cutoff auto-links at 99% precision, and how much does it catch?"
 *
 *   3. Worst false positives (ignores scored high) and worst false negatives
 *      (links scored low) — with SKUs, for direct lookup / relabeling.
 *
 *   4. Stratified band samples — N pairs per confidence band to eyeball.
 *
 * The labeled pair set is persisted to tools/linker_eval/pairs.json so scores
 * can be diffed run-over-run as the algorithm changes.
 *
 * Run:    node tools/linker_eval.mjs
 * Data:   reads .worktrees/data/viz/data/index.json and .worktrees/data/data/sku_links*.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prepScorePairCtx, scorePairWithVocab } from "../viz/app/linker_page/suggestions.js";
import { buildVocab } from "../viz/app/linker_page/vocab.js";
import { buildSizePenaltyForPair } from "../viz/app/linker_page/size.js";
import { buildPricePenaltyForPair } from "../viz/app/linker_page/price.js";
import { tokenizeQuery, normSearchText } from "../viz/app/sku.js";
import { filterSimTokens } from "../viz/app/linker_page/similarity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKTREE = process.env.DATA_WORKTREE || path.join(ROOT, ".worktrees/data");
const INDEX_PATH = path.join(WORKTREE, "viz/data/index.json");
const LINKS_PATH = path.join(WORKTREE, "data/sku_links.json");
const LINKS_AUTO_PATH = path.join(WORKTREE, "data/sku_links_auto.json");
const OUT_DIR = path.join(ROOT, "tools/linker_eval");
const PAIRS_PERSIST_PATH = path.join(OUT_DIR, "pairs.json");
const LAST_RUN_PATH = path.join(OUT_DIR, "last_run.json");

/* ---------------- load catalog + links ---------------- */

function readJson(p) {
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

const idx = readJson(INDEX_PATH);
const rows = idx.items || [];

// Aggregate per RAW sku (not canonical) — the eval asks "would the algorithm
// correctly identify these as the same product, given only the names/prices?"
const bySku = new Map();
for (const r of rows) {
	const sku = String(r.sku || "");
	if (!sku) continue;
	let a = bySku.get(sku);
	if (!a) {
		a = { sku, name: r.name || "", stores: new Set(), cheapestPriceNum: null };
		bySku.set(sku, a);
	}
	if (r.storeLabel) a.stores.add(r.storeLabel);
	const p = parseFloat(String(r.price || "").replace(/[^0-9.]/g, ""));
	if (Number.isFinite(p) && p > 0)
		a.cheapestPriceNum = a.cheapestPriceNum == null ? p : Math.min(a.cheapestPriceNum, p);
}
const allAgg = [...bySku.values()];

const manualLinks = (() => {
	try {
		return readJson(LINKS_PATH).links || [];
	} catch {
		return [];
	}
})();
const ignoreEntries = (() => {
	try {
		return readJson(LINKS_PATH).ignores || [];
	} catch {
		return [];
	}
})();
const autoLinks = (() => {
	try {
		return readJson(LINKS_AUTO_PATH).links || [];
	} catch {
		return [];
	}
})();
const allLinks = [...manualLinks, ...autoLinks];

// Union-find over labeled links → canonical groups (= positives = same-product).
const parent = new Map();
function find(x) {
	const path = [];
	while (parent.has(x)) {
		path.push(x);
		x = parent.get(x);
	}
	for (const p of path) parent.set(p, x);
	return x;
}
function union(a, b) {
	const ra = find(a);
	const rb = find(b);
	if (ra !== rb) parent.set(ra, rb);
}
for (const l of allLinks) {
	const f = String(l.fromSku || "").trim();
	const t = String(l.toSku || "").trim();
	if (f && t && f !== t && bySku.has(f) && bySku.has(t)) union(f, t);
}

const canonOf = (s) => find(String(s));
const canonToSkus = new Map();
for (const s of bySku.keys()) {
	const c = canonOf(s);
	if (!canonToSkus.has(c)) canonToSkus.set(c, []);
	canonToSkus.get(c).push(s);
}

/* ---------------- scoring context (single source of truth) ---------------- */

const vocab = buildVocab(allAgg);
const rulesStub = { canonicalSku: (s) => String(s) };
const sizeFn = buildSizePenaltyForPair({ allRows: rows, allAgg, rules: rulesStub });
const priceFn = buildPricePenaltyForPair({ allAgg, rules: rulesStub });

const ctxCache = new Map();
function ctxFor(sku) {
	let c = ctxCache.get(sku);
	if (c) return c;
	const it = bySku.get(sku);
	if (!it) return null;
	c = prepScorePairCtx(it, { vocab, sizePenaltyFn: sizeFn, pricePenaltyFn: priceFn });
	ctxCache.set(sku, c);
	return c;
}
function scoreOf(a, b) {
	const ca = ctxFor(a);
	const itB = bySku.get(b);
	if (!ca || !itB) return null;
	return scorePairWithVocab(ca, itB);
}

// Trivial baseline: count of shared filtered name tokens. A reference floor for
// the AUC numbers — anything a dumb word-overlap scorer can do is not signal.
const tokCache = new Map();
function toks(sku) {
	let t = tokCache.get(sku);
	if (!t) {
		t = new Set(filterSimTokens(tokenizeQuery(normSearchText(bySku.get(sku)?.name || ""))));
		tokCache.set(sku, t);
	}
	return t;
}
function trivialScore(a, b) {
	const A = toks(a);
	const B = toks(b);
	let n = 0;
	for (const x of A) if (B.has(x)) n++;
	return n;
}

// A name that's just a SKU number / empty — a scrape gap, not a scorer fault.
function isNoName(sku) {
	const n = (bySku.get(sku)?.name || "").trim();
	return !n || /^\d+$/.test(n) || n.length < 4;
}

/* ---------------- deterministic PRNG ---------------- */

let _seed = 0x9e3779b1 >>> 0;
function rand() {
	_seed =
		(Math.imul(_seed ^ (_seed >>> 16), 0x85ebca6b) >>> 0) ^ (Math.imul(_seed, 0xc2b2ae35) >>> 0);
	return (_seed >>> 0) / 0xffffffff;
}

/* ---------------- build labeled pair sets ---------------- */

const pairs = [];
const seenPairKey = new Set();
function pairKey(a, b) {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}
// kind: "pos" | "ignore" | "hard" | "random"
function addPair(a, b, label, kind) {
	if (a === b) return false;
	const k = pairKey(a, b);
	if (seenPairKey.has(k)) return false;
	seenPairKey.add(k);
	pairs.push({ a, b, label, kind });
	return true;
}

// Positives: pairs within each canonical group (capped to avoid quadratic blowup)
const POS_PER_GROUP = 20;
for (const skus of canonToSkus.values()) {
	if (skus.length < 2) continue;
	let count = 0;
	outer: for (let i = 0; i < skus.length; i++) {
		for (let j = i + 1; j < skus.length; j++) {
			addPair(skus[i], skus[j], 1, "pos");
			if (++count >= POS_PER_GROUP) break outer;
		}
	}
}
const posCount = pairs.filter((p) => p.label === 1).length;

// Negatives — explicit ignores (the curated "do not match" pairs)
let ignoreAdded = 0;
for (const ig of ignoreEntries) {
	const a = String(ig.skuA || ig.fromSku || "").trim();
	const b = String(ig.skuB || ig.toSku || "").trim();
	if (!a || !b || !bySku.has(a) || !bySku.has(b)) continue;
	if (canonOf(a) === canonOf(b)) continue; // contradiction (linked + ignored) → skip
	if (addPair(a, b, 0, "ignore")) ignoreAdded++;
}

// Hard negatives: items sharing a distinctive bigram (idf ≥ 5) but in different
// canonical groups. This is the population AUC+ is measured against.
const byBigram = new Map();
for (const it of allAgg) {
	if (!it.name) continue;
	for (const t of vocab.termsForName(it.name)) {
		if (!t.startsWith("b:") || vocab.idf(t) < 5) continue;
		if (!byBigram.has(t)) byBigram.set(t, []);
		byBigram.get(t).push(it.sku);
	}
}
const bigramKeys = [...byBigram.keys()];
const HARD_TARGET = Math.min(4000, posCount);
let hardAdded = 0;
let hardTries = 0;
while (hardAdded < HARD_TARGET && hardTries < HARD_TARGET * 25) {
	hardTries++;
	const arr = byBigram.get(bigramKeys[(rand() * bigramKeys.length) | 0]);
	if (!arr || arr.length < 2) continue;
	const a = arr[(rand() * arr.length) | 0];
	const b = arr[(rand() * arr.length) | 0];
	if (a === b || canonOf(a) === canonOf(b)) continue;
	if (addPair(a, b, 0, "hard")) hardAdded++;
}

// Random negatives (easy) — kept only for the contrast AUC.
const skuList = [...bySku.keys()];
let randAdded = 0;
let randTries = 0;
while (randAdded < posCount && randTries < posCount * 6) {
	randTries++;
	const a = skuList[(rand() * skuList.length) | 0];
	const b = skuList[(rand() * skuList.length) | 0];
	if (a === b || canonOf(a) === canonOf(b)) continue;
	if (addPair(a, b, 0, "random")) randAdded++;
}

for (const p of pairs) {
	p.score = scoreOf(p.a, p.b) ?? 0;
}

const pos = pairs.filter((p) => p.kind === "pos");
const negIgnore = pairs.filter((p) => p.kind === "ignore");
const negHard = pairs.filter((p) => p.kind === "hard");
const negRandom = pairs.filter((p) => p.kind === "random");

console.log(
	`pairs — positives ${pos.length} | ignores ${negIgnore.length} | hard-bigram ${negHard.length} | random ${negRandom.length}`,
);

/* ---------------- table renderer ---------------- */
// headers: [{ key, label, max?, align? }]; rows: array of objects keyed by `key`.
// Auto-sizes columns, truncates long cells with "…", draws a single rule. Output
// is monospace-aligned and copy-pasteable.
function fmtTable(headers, rows) {
	const cell = (h, r) => {
		let v = String(r[h.key] ?? "");
		const cap = h.max || 60;
		if (v.length > cap) v = v.slice(0, cap - 1) + "…";
		return v;
	};
	const widths = headers.map((h) => {
		let w = h.label.length;
		for (const r of rows) w = Math.max(w, cell(h, r).length);
		return Math.min(w, h.max || 60);
	});
	const pad = (s, w, align) => (align === "r" ? String(s).padStart(w) : String(s).padEnd(w));
	const row = (cells) => "  " + cells.map((c, i) => pad(c, widths[i], headers[i].align)).join(" │ ");
	const lines = [row(headers.map((h) => h.label)), "  " + widths.map((w) => "─".repeat(w)).join("─┼─")];
	for (const r of rows) lines.push(row(headers.map((h) => cell(h, r))));
	return lines.join("\n");
}

/* ---------------- 1. Headline metrics ---------------- */

function auc(P, N, scoreFn) {
	if (!P.length || !N.length) return NaN;
	const S = Math.min(40000, P.length * 40);
	let wins = 0;
	let ties = 0;
	for (let i = 0; i < S; i++) {
		const p = scoreFn(P[(rand() * P.length) | 0]);
		const n = scoreFn(N[(rand() * N.length) | 0]);
		if (p > n) wins++;
		else if (p === n) ties++;
	}
	return (wins + ties * 0.5) / S;
}
const byScore = (p) => p.score;
const byTrivial = (p) => trivialScore(p.a, p.b);

// Negatives that matter for an auto-link decision: curated ignores + auto-mined
// hard negatives (random easy negatives would inflate precision).
const NEG_OP = [...negIgnore, ...negHard];

function thresholdForPrecision(P, N, target) {
	const all = [...P.map((x) => ({ s: x.score, p: 1 })), ...N.map((x) => ({ s: x.score, p: 0 }))].sort(
		(a, b) => b.s - a.s,
	);
	let tp = 0;
	let fp = 0;
	let best = null;
	for (const x of all) {
		if (x.p) tp++;
		else fp++;
		const prec = tp / (tp + fp);
		if (prec >= target) best = { T: x.s, prec, rec: tp / P.length, tp, fp };
	}
	return best;
}

const aucHard = auc(pos, negHard, byScore);
const aucIgnore = auc(pos, negIgnore, byScore);
const aucRandom = auc(pos, negRandom, byScore);
const aucTrivHard = auc(pos, negHard, byTrivial);
const aucTrivIgnore = auc(pos, negIgnore, byTrivial);

console.log("\n================= HEADLINE METRICS =================");
console.log(
	fmtTable(
		[
			{ key: "m", label: "Metric", max: 34 },
			{ key: "v", label: "Value", align: "r" },
			{ key: "n", label: "Floor / note", max: 32 },
		],
		[
			{ m: "AUC+ (vs hard negatives)", v: aucHard.toFixed(4), n: `trivial floor ${aucTrivHard.toFixed(3)}` },
			{ m: "AUC (vs ignores)", v: aucIgnore.toFixed(4), n: `trivial ${aucTrivIgnore.toFixed(3)}` },
			{ m: "AUC (vs random)", v: aucRandom.toFixed(4), n: "≈free — not a quality signal" },
			{ m: "positives / ignores / hard", v: `${pos.length}/${negIgnore.length}/${negHard.length}`, n: "labeled pair counts" },
		],
	),
);

console.log("\n================= AUTO-LINK THRESHOLDS (positives vs ignores+hard) =================");
console.log(
	fmtTable(
		[
			{ key: "p", label: "Precision target", align: "r" },
			{ key: "t", label: "Threshold", align: "r" },
			{ key: "r", label: "Recall", align: "r" },
			{ key: "tp", label: "TP", align: "r" },
			{ key: "fp", label: "FP", align: "r" },
			{ key: "ap", label: "Actual prec", align: "r" },
		],
		[0.99, 0.98, 0.95, 0.9].map((tgt) => {
			const r = thresholdForPrecision(pos, NEG_OP, tgt);
			return r
				? { p: `≥ ${tgt.toFixed(2)}`, t: r.T.toFixed(2), r: (r.rec * 100).toFixed(1) + "%", tp: r.tp, fp: r.fp, ap: r.prec.toFixed(4) }
				: { p: `≥ ${tgt.toFixed(2)}`, t: "—", r: "—", tp: "—", fp: "—", ap: "unreachable" };
		}),
	),
);

console.log("\n================= PRECISION / RECALL @ FIXED THRESHOLD (vs ignores+hard) =================");
console.log(
	fmtTable(
		[
			{ key: "t", label: "Threshold", align: "r" },
			{ key: "p", label: "Precision", align: "r" },
			{ key: "r", label: "Recall", align: "r" },
			{ key: "tp", label: "TP", align: "r" },
			{ key: "fp", label: "FP", align: "r" },
		],
		[0.5, 1.0, 2.0, 4.0, 8.0, 16.0].map((t) => {
			const tp = pos.filter((p) => p.score >= t).length;
			const fp = NEG_OP.filter((p) => p.score >= t).length;
			return { t: t.toFixed(1), p: (tp + fp ? tp / (tp + fp) : 1).toFixed(3), r: (tp / pos.length).toFixed(3), tp, fp };
		}),
	),
);

/* ---------------- 2. Worst offenders (consistent chart) ---------------- */

// Columns are identical for both tables so they read the same: rank, the algo's
// score, what the labels EXPECT, both SKUs, both names.
const OFFENDER_COLS = [
	{ key: "rank", label: "#", align: "r" },
	{ key: "score", label: "Algo score", align: "r" },
	{ key: "expected", label: "Expected" },
	{ key: "skuA", label: "SKU A", max: 16 },
	{ key: "nameA", label: "Name A", max: 30 },
	{ key: "skuB", label: "SKU B", max: 16 },
	{ key: "nameB", label: "Name B", max: 30 },
];
function offenderRows(list, expected) {
	return list.map((p, i) => ({
		rank: i + 1,
		score: p.score.toFixed(2),
		expected,
		skuA: p.a,
		nameA: bySku.get(p.a)?.name || "",
		skuB: p.b,
		nameB: bySku.get(p.b)?.name || "",
	}));
}

console.log("\n================= 15 WORST FALSE POSITIVES (ignored pairs the algo scores high) =================");
console.log(
	fmtTable(
		OFFENDER_COLS,
		offenderRows([...negIgnore].sort((a, b) => b.score - a.score).slice(0, 15), "IGNORE"),
	),
);

console.log("\n================= 15 WORST FALSE NEGATIVES (linked pairs the algo scores low; no-name gaps excluded) =================");
console.log(
	fmtTable(
		OFFENDER_COLS,
		offenderRows(
			pos.filter((p) => !isNoName(p.a) && !isNoName(p.b)).sort((a, b) => a.score - b.score).slice(0, 15),
			"LINK",
		),
	),
);

/* ---------------- 4. Stratified band samples ---------------- */

console.log("\n========== STRATIFIED BAND SAMPLES ==========");
const bands = [
	[0, 0.3],
	[0.3, 0.8],
	[0.8, 1.5],
	[1.5, 3.0],
	[3.0, 6.0],
	[6.0, Infinity],
];
for (const [lo, hi] of bands) {
	const inBand = pairs.filter((p) => p.score >= lo && p.score < hi);
	const posInBand = inBand.filter((p) => p.label === 1).length;
	console.log(
		`\n[${lo} ≤ score < ${hi === Infinity ? "∞" : hi}]  ${inBand.length} pairs  (${posInBand} pos, ${inBand.length - posInBand} neg, ${inBand.length ? Math.round((posInBand / inBand.length) * 100) : 0}% positive)`,
	);
	for (let i = 0; i < 5 && inBand.length; i++) {
		const p = inBand[(rand() * inBand.length) | 0];
		const ia = bySku.get(p.a);
		const ib = bySku.get(p.b);
		const tag = p.label === 1 ? "✓" : p.kind === "hard" ? "Ⓗ" : p.kind === "ignore" ? "✗ig" : "✗";
		console.log(`   ${p.score.toFixed(2).padStart(5)} ${tag}  ${ia?.name}  ‖  ${ib?.name}`);
	}
}

/* ---------------- persist + diff ---------------- */

const persist = pairs.map((p) => ({
	a: p.a,
	b: p.b,
	label: p.label,
	kind: p.kind,
	score: +p.score.toFixed(4),
}));
fs.mkdirSync(OUT_DIR, { recursive: true });

let prev = null;
try {
	prev = readJson(PAIRS_PERSIST_PATH);
} catch {}
if (Array.isArray(prev)) {
	const prevMap = new Map(prev.map((p) => [pairKey(p.a, p.b), p.score]));
	const moved = [];
	for (const p of persist) {
		const old = prevMap.get(pairKey(p.a, p.b));
		if (old != null && Math.abs(old - p.score) > 0.5)
			moved.push({ ...p, prevScore: old, delta: p.score - old });
	}
	moved.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
	console.log(`\n========== SCORE DELTAS vs LAST RUN (|Δ|>0.5) ==========`);
	console.log(`pairs with notable score movement: ${moved.length}`);
	for (const m of moved.slice(0, 20)) {
		const ia = bySku.get(m.a);
		const ib = bySku.get(m.b);
		console.log(
			`  ${m.label === 1 ? "✓" : "✗"} ${m.prevScore.toFixed(2)} → ${m.score.toFixed(2)}  (Δ ${m.delta >= 0 ? "+" : ""}${m.delta.toFixed(2)})  ${ia?.name} ‖ ${ib?.name}`,
		);
	}
}

fs.writeFileSync(PAIRS_PERSIST_PATH, JSON.stringify(persist, null, 2));
fs.writeFileSync(
	LAST_RUN_PATH,
	JSON.stringify(
		{
			ts: new Date().toISOString(),
			aucHard: +aucHard.toFixed(4),
			aucIgnore: +aucIgnore.toFixed(4),
			aucTrivialHard: +aucTrivHard.toFixed(4),
			n_pos: pos.length,
			n_ignore: negIgnore.length,
			n_hard: negHard.length,
		},
		null,
		2,
	),
);
console.log(`\nSaved ${persist.length} pairs → ${path.relative(ROOT, PAIRS_PERSIST_PATH)}`);
console.log(`Last-run summary  → ${path.relative(ROOT, LAST_RUN_PATH)}`);
