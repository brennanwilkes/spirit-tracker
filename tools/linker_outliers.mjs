#!/usr/bin/env node
/**
 * tools/linker_outliers.mjs — label-quality & disagreement analytics for the
 * SKU linker, built to drive a manual labeling pass.
 *
 * It reuses the SAME data loading, union-find canonicalization, IDF vocab, and
 * single-source pair scorer (scorePairWithVocab) as tools/linker_eval.mjs, so
 * scores here always match the live #/link ranker.
 *
 * Three reports:
 *
 *   1. DISAGREEMENTS — where the algorithm and your labels disagree. Three lists:
 *        • MISSED       unlabeled pairs the algorithm scores high → likely links
 *                       you haven't made yet (the labeling worklist). Split into
 *                       cross-store (primary) and same-store (size-variant noise).
 *        • SUSPECT IGNORES  pairs you marked "ignore" that score high → either a
 *                       genuine hard negative the algo fails on, or a mislabel.
 *        • SUSPECT LINKS    pairs you linked that score LOW → either a mislink
 *                       (labeling error) or an algorithm blind spot (e.g. an
 *                       abbreviation like PM = Port Mourant that token overlap
 *                       can't see). These are the cases embeddings would fix.
 *
 *   2. GROUP CONFLICTS — intra-canonical-group attribute conflicts (size / ABV /
 *      age / edition-code / same-store-twice). A pure QA check on your own links:
 *      a group with mixed sizes or two SKUs from one store is probably a mislink,
 *      and the same-store overlap is itself a (weak) signal we'll feed training.
 *
 *   3. COVERAGE — how much of the catalog is labeled, group-size distribution,
 *      and the size of the actionable MISSED backlog.
 *
 * Output: a human-readable console report + a structured tools/linker_eval/outliers.json.
 *
 * Run now (mid-labeling) it's mostly unlabeled MISSED noise. Run it AFTER a
 * labeling pass and MISSED shrinks to real omissions while SUSPECT/CONFLICT
 * surface the interesting outliers.
 *
 * Usage:
 *   node tools/linker_outliers.mjs                  # defaults
 *   node tools/linker_outliers.mjs --min-score 1.5 --top 150
 *   node tools/linker_outliers.mjs --include-same-store
 * Data: reads .worktrees/data/viz/data/index.json and .worktrees/data/data/sku_links*.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
	prepScorePairCtx,
	scorePairWithVocab,
} from "../viz/app/linker_page/suggestions.js";
import { buildVocab } from "../viz/app/linker_page/vocab.js";
import { buildSizePenaltyForPair } from "../viz/app/linker_page/size.js";
import { buildPricePenaltyForPair } from "../viz/app/linker_page/price.js";
import { parseSizesMlFromText, sizePenalty } from "../viz/app/linker_page/size.js";
import {
	extractAbv,
	extractAgeFromText,
	extractEditionCodes,
	editionCodeMultiplier,
	abvMultiplier,
	bareAgeCandidates,
} from "../viz/app/linker_page/similarity.js";
import { normSearchText } from "../viz/app/sku.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKTREE = process.env.DATA_WORKTREE || path.join(ROOT, ".worktrees/data");
const INDEX_PATH = path.join(WORKTREE, "viz/data/index.json");
const LINKS_PATH = path.join(WORKTREE, "data/sku_links.json");
const LINKS_AUTO_PATH = path.join(WORKTREE, "data/sku_links_auto.json");
const OUT_DIR = path.join(ROOT, "tools/linker_eval");
const OUT_PATH = path.join(OUT_DIR, "outliers.json");

/* ---------------- args ---------------- */

function argVal(name, def) {
	const i = process.argv.indexOf(name);
	if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
	return def;
}
const MIN_SCORE = parseFloat(argVal("--min-score", "1.0"));
const TOP = parseInt(argVal("--top", "120"), 10);
const INCLUDE_SAME_STORE = process.argv.includes("--include-same-store");
const DISTINCTIVE_IDF = parseFloat(argVal("--idf", "5.0")); // unigram idf floor for candidate generation
const BUCKET_CAP = parseInt(argVal("--bucket-cap", "90"), 10); // skip terms appearing in > this many items
const SUSPECT_IGNORE_MIN = parseFloat(argVal("--suspect-ignore-min", "1.5"));
const SUSPECT_LINK_MAX = parseFloat(argVal("--suspect-link-max", "0.5"));
const SCORE_CAP = 400000; // hard ceiling on pairs scored; reported if hit

function readJson(p) {
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

/* ---------------- load catalog + links (mirrors linker_eval.mjs) ---------------- */

const idx = readJson(INDEX_PATH);
const rows = idx.items || [];

// Aggregate per RAW sku; track per-sku store SET (not merged) so we can detect
// same-store overlap within a group.
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

const linksDoc = (() => {
	try {
		return readJson(LINKS_PATH);
	} catch {
		return { links: [], ignores: [] };
	}
})();
const manualLinks = linksDoc.links || [];
const ignores = linksDoc.ignores || [];
const autoLinks = (() => {
	try {
		return readJson(LINKS_AUTO_PATH).links || [];
	} catch {
		return [];
	}
})();
const allLinks = [...manualLinks, ...autoLinks];

// Union-find over labeled links → canonical groups
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

// Ignore sets — both at raw-pair level and canonical-group level (so a single
// ignore between two members suppresses the whole group pairing).
function pairKey(a, b) {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}
const ignoreRaw = new Set();
const ignoreCanon = new Set();
for (const ig of ignores) {
	const a = String(ig.skuA || "").trim();
	const b = String(ig.skuB || "").trim();
	if (!a || !b) continue;
	ignoreRaw.add(pairKey(a, b));
	ignoreCanon.add(pairKey(canonOf(a), canonOf(b)));
}
function isIgnored(a, b) {
	return ignoreRaw.has(pairKey(a, b)) || ignoreCanon.has(pairKey(canonOf(a), canonOf(b)));
}
function sameStore(a, b) {
	const ia = bySku.get(a);
	const ib = bySku.get(b);
	if (!ia || !ib) return false;
	for (const s of ia.stores) if (ib.stores.has(s)) return true;
	return false;
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

const nameOf = (s) => bySku.get(s)?.name || "(?)";
const storesStr = (s) => [...(bySku.get(s)?.stores || [])].join(",");

// Reconstruct the score as final = residual × (deterministic multipliers).
// Each multiplier is recomputed independently with the SAME exported helpers
// the scorer uses; dividing them out of the final score isolates `residual` —
// the base/token-overlap/coverage/top-term contribution. This lets a downstream
// analysis pinpoint which factor tanked (or inflated) a score. The age/abv/
// edition guards mirror scorePairWithVocab exactly (target = first arg).
const isBadSkuLocal = (s) => /^(u:|id:|upc:)/.test(s) || /unknown/i.test(s);
function decompose(a, b) {
	const final = scoreOf(a, b) ?? 0;
	const ia = bySku.get(a);
	const ib = bySku.get(b);
	if (!ia || !ib) return null;
	const normA = normSearchText(ia.name);
	const normB = normSearchText(ib.name);

	const size = sizeFn(a, b);
	const price = priceFn(a, b);

	const ageA = extractAgeFromText(normA);
	const ageB = extractAgeFromText(normB);
	let age = 1;
	if (ageA && ageB) age = ageA === ageB ? 1.8 : 0.2;
	else if (ageA && !ageB && bareAgeCandidates(normB).has(ageA)) age = 1.8;

	const abvA = extractAbv(normA);
	const abv = abvA != null ? abvMultiplier(abvA, extractAbv(normB)) : 1;

	const codesA = extractEditionCodes(normA);
	const edition =
		codesA && codesA.size > 0 ? editionCodeMultiplier(codesA, extractEditionCodes(normB)) : 1;

	const bad = isBadSkuLocal(a) || isBadSkuLocal(b) ? 1.2 : 1;

	const known = size * price * age * abv * edition * bad;
	const residual = known > 0 ? final / known : final;
	return { final, residual, size, price, age, abv, edition, bad };
}

// Human-readable tag list of the factors that materially moved a score.
function factorTags(d) {
	const t = [];
	if (d.residual < 0.5) t.push(`weak-name ${d.residual.toFixed(2)}`);
	else if (d.residual >= 3) t.push(`strong-name ${d.residual.toFixed(1)}`);
	for (const [k, v] of [
		["size", d.size],
		["price", d.price],
		["age", d.age],
		["abv", d.abv],
		["edition", d.edition],
		["badSku", d.bad],
	]) {
		if (v < 0.98) t.push(`${k}↓ ${v.toFixed(2)}`);
		else if (v > 1.02) t.push(`${k}↑ ${v.toFixed(2)}`);
	}
	return t;
}

/* ============================================================
 * 1. DISAGREEMENTS — candidate pairs via shared distinctive term
 * ============================================================ */

// Inverted index: distinctive unigram (idf >= floor) → SKUs containing it.
// Distinctive terms have small document frequency by definition, so the buckets
// stay small and the pair generation is tractable.
const byTerm = new Map();
for (const it of allAgg) {
	if (!it.name) continue;
	const terms = vocab.termsForName(it.name);
	const seen = new Set();
	for (const t of terms) {
		if (t.startsWith("b:")) continue; // unigrams only for retrieval
		if (vocab.idf(t) < DISTINCTIVE_IDF) continue;
		if (seen.has(t)) continue;
		seen.add(t);
		if (!byTerm.has(t)) byTerm.set(t, []);
		byTerm.get(t).push(it.sku);
	}
}

// Generate, dedupe, score candidate pairs.
const scoredKeys = new Set();
let scoredCount = 0;
let cappedAt = 0;
const missed = []; // unlabeled, cross-store
const missedSameStore = []; // unlabeled, same-store
const suspectIgnores = []; // ignored but high score

outer: for (const [, skus] of byTerm) {
	if (skus.length < 2 || skus.length > BUCKET_CAP) continue;
	for (let i = 0; i < skus.length; i++) {
		for (let j = i + 1; j < skus.length; j++) {
			const a = skus[i];
			const b = skus[j];
			if (a === b) continue;
			const k = pairKey(a, b);
			if (scoredKeys.has(k)) continue;
			scoredKeys.add(k);
			if (scoredCount >= SCORE_CAP) {
				cappedAt = scoredCount;
				break outer;
			}
			scoredCount++;

			const linked = canonOf(a) === canonOf(b);
			if (linked) continue; // already a link, not a disagreement here

			const sc = scoreOf(a, b) ?? 0;
			if (sc < MIN_SCORE) continue;

			const ss = sameStore(a, b);
			const rec = { a, b, score: +sc.toFixed(3), sameStore: ss };
			if (isIgnored(a, b)) {
				if (sc >= SUSPECT_IGNORE_MIN) suspectIgnores.push(rec);
			} else if (ss) {
				missedSameStore.push(rec);
			} else {
				missed.push(rec);
			}
		}
	}
}

missed.sort((x, y) => y.score - x.score);
missedSameStore.sort((x, y) => y.score - x.score);
suspectIgnores.sort((x, y) => y.score - x.score);

// SUSPECT LINKS — labeled-positive pairs that score low. Walk each group's
// adjacent member pairs (cap per group) and keep the low scorers.
const suspectLinks = [];
for (const skus of canonToSkus.values()) {
	if (skus.length < 2) continue;
	let n = 0;
	outerg: for (let i = 0; i < skus.length; i++) {
		for (let j = i + 1; j < skus.length; j++) {
			const sc = scoreOf(skus[i], skus[j]) ?? 0;
			if (sc <= SUSPECT_LINK_MAX) {
				suspectLinks.push({
					a: skus[i],
					b: skus[j],
					score: +sc.toFixed(3),
					sameStore: sameStore(skus[i], skus[j]),
				});
			}
			if (++n >= 40) break outerg; // cap per group
		}
	}
}
suspectLinks.sort((x, y) => x.score - y.score);

/* ============================================================
 * 2. GROUP CONFLICTS — intra-group attribute QA
 * ============================================================ */

const groupConflicts = [];
for (const [canon, skus] of canonToSkus) {
	if (skus.length < 2) continue;
	const members = skus.map((s) => {
		const it = bySku.get(s);
		const norm = normSearchText(it.name);
		return {
			sku: s,
			name: it.name,
			stores: [...it.stores],
			sizes: parseSizesMlFromText(it.name) || [],
			abv: extractAbv(norm),
			age: extractAgeFromText(norm),
			codes: extractEditionCodes(norm),
		};
	});

	// size conflict: any two members whose stated sizes are in different buckets
	let sizeConflict = false;
	for (let i = 0; i < members.length && !sizeConflict; i++) {
		for (let j = i + 1; j < members.length; j++) {
			const A = members[i].sizes;
			const B = members[j].sizes;
			if (A.length && B.length && sizePenalty(A, B) < 0.5) {
				sizeConflict = true;
				break;
			}
		}
	}

	// abv conflict: spread of stated ABVs > 1.5
	const abvs = members.map((m) => m.abv).filter((x) => Number.isFinite(x));
	const abvConflict = abvs.length >= 2 && Math.max(...abvs) - Math.min(...abvs) > 1.5;

	// age conflict: more than one distinct stated age
	const ages = [...new Set(members.map((m) => m.age).filter((x) => Number.isFinite(x)))];
	const ageConflict = ages.length >= 2;

	// edition-code conflict: any pair the edition-code rule strongly demotes
	let editionConflict = false;
	for (let i = 0; i < members.length && !editionConflict; i++) {
		for (let j = i + 1; j < members.length; j++) {
			if (editionCodeMultiplier(members[i].codes, members[j].codes) < 0.5) {
				editionConflict = true;
				break;
			}
		}
	}

	// same-store-twice: two distinct member SKUs sharing a store
	const storeToSkus = new Map();
	for (const m of members)
		for (const st of m.stores) {
			if (!storeToSkus.has(st)) storeToSkus.set(st, new Set());
			storeToSkus.get(st).add(m.sku);
		}
	const sameStoreDup = [...storeToSkus.entries()]
		.filter(([, set]) => set.size >= 2)
		.map(([st, set]) => ({ store: st, skus: [...set] }));

	if (sizeConflict || abvConflict || ageConflict || editionConflict || sameStoreDup.length) {
		groupConflicts.push({
			canon,
			size: skus.length,
			conflicts: {
				size: sizeConflict,
				abv: abvConflict,
				age: ageConflict,
				edition: editionConflict,
				sameStore: sameStoreDup,
			},
			members: members.map((m) => ({ sku: m.sku, name: m.name, stores: m.stores })),
		});
	}
}
// Most-conflicted first: count conflict types, then group size.
function conflictWeight(g) {
	const c = g.conflicts;
	return (c.size ? 1 : 0) + (c.abv ? 1 : 0) + (c.age ? 1 : 0) + (c.edition ? 1 : 0) + (c.sameStore.length ? 1 : 0);
}
groupConflicts.sort((a, b) => conflictWeight(b) - conflictWeight(a) || b.size - a.size);

/* ============================================================
 * 3. COVERAGE STATS
 * ============================================================ */

const groupSizes = [...canonToSkus.values()].map((v) => v.length);
const inGroup = groupSizes.filter((n) => n >= 2);
const totalSkus = bySku.size;
const skusInGroups = inGroup.reduce((s, n) => s + n, 0);
const maxGroup = groupSizes.length ? Math.max(...groupSizes) : 0;

// A size-1 canonical group isn't necessarily unlinked: if its single raw SKU
// appears at ≥2 stores it's *implicitly* linked (same sku across stores = free
// positive). Only a 1-store, size-1 node is a genuinely isolated/unlinked item.
let implicitMultiStore = 0;
let trulyIsolated = 0;
for (const skus of canonToSkus.values()) {
	if (skus.length !== 1) continue;
	const it = bySku.get(skus[0]);
	if (it && it.stores.size >= 2) implicitMultiStore++;
	else trulyIsolated++;
}

/* ============================================================
 * OUTPUT
 * ============================================================ */

function showPair(p, mark = "") {
	console.log(
		`  ${p.score.toFixed(2).padStart(7)} ${p.sameStore ? "⌂" : " "}${mark}  ${p.a.padEnd(11)} ↔ ${p.b}`,
	);
	console.log(`           A: ${nameOf(p.a)}   [${storesStr(p.a)}]`);
	console.log(`           B: ${nameOf(p.b)}   [${storesStr(p.b)}]`);
}

console.log("\n================ COVERAGE ================");
console.log(`catalog SKUs (raw):        ${totalSkus}`);
console.log(`linked via sku_links (≥2): ${skusInGroups}  across ${inGroup.length} groups`);
console.log(`implicit links (same sku @ ≥2 stores): ${implicitMultiStore}`);
console.log(`truly isolated (1 store):  ${trulyIsolated}   ← the real unlinked backlog`);
console.log(`largest group:             ${maxGroup} SKUs`);
console.log(`manual links / ignores:    ${manualLinks.length} / ${ignores.length}  (+${autoLinks.length} auto links)`);
console.log(
	`actionable MISSED backlog: ${missed.length} cross-store (+${missedSameStore.length} same-store) at score ≥ ${MIN_SCORE}`,
);
if (cappedAt) console.log(`⚠ candidate scoring hit the ${SCORE_CAP} cap — lower --bucket-cap or raise --idf for full coverage`);

console.log("\n================ 1a. MISSED (unlabeled, cross-store, high score) ================");
console.log("Likely links you haven't made. The labeling worklist — review top-down.\n");
if (!missed.length) console.log("  (none above threshold)");
missed.slice(0, TOP).forEach((p) => showPair(p));
if (missed.length > TOP) console.log(`  … +${missed.length - TOP} more (see outliers.json)`);

if (INCLUDE_SAME_STORE) {
	console.log("\n================ 1b. MISSED (unlabeled, SAME-store) ================");
	console.log("Mostly size/edition variants within one store; occasionally a true store duplicate.\n");
	missedSameStore.slice(0, Math.floor(TOP / 2)).forEach((p) => showPair(p));
}

console.log("\n================ 1c. SUSPECT IGNORES (ignored but algo scores high) ================");
console.log("Either a hard negative the algo fails on, or a mislabeled ignore. Review each.\n");
if (!suspectIgnores.length) console.log("  (none)");
suspectIgnores.slice(0, TOP).forEach((p) => showPair(p, "✗"));

console.log("\n================ 1d. SUSPECT LINKS (linked but algo scores LOW) ================");
console.log("Either a mislink (labeling error) or an algorithm blind spot (abbreviations, synonyms).\n");
if (!suspectLinks.length) console.log("  (none)");
suspectLinks.slice(0, TOP).forEach((p) => showPair(p, "✓"));

console.log("\n================ 2. GROUP CONFLICTS (label QA) ================");
console.log("Intra-group attribute conflicts — probable mislinks. ⌂=same-store-twice.\n");
if (!groupConflicts.length) console.log("  (none)");
for (const g of groupConflicts.slice(0, TOP)) {
	const tags = [];
	if (g.conflicts.size) tags.push("SIZE");
	if (g.conflicts.abv) tags.push("ABV");
	if (g.conflicts.age) tags.push("AGE");
	if (g.conflicts.edition) tags.push("EDITION");
	if (g.conflicts.sameStore.length) tags.push(`SAME-STORE×${g.conflicts.sameStore.length}`);
	console.log(`── group ${g.canon}  (${g.size} SKUs)  [${tags.join(" ")}]`);
	for (const m of g.members)
		console.log(`     ${m.sku.padEnd(11)} ${m.name}   [${m.stores.join(",")}]`);
	if (g.conflicts.sameStore.length)
		for (const ss of g.conflicts.sameStore)
			console.log(`     ⌂ ${ss.store}: ${ss.skus.join(", ")}`);
	console.log();
}
if (groupConflicts.length > TOP) console.log(`  … +${groupConflicts.length - TOP} more (see outliers.json)`);

/* ---------------- persist ---------------- */

fs.mkdirSync(OUT_DIR, { recursive: true });
const enrich = (p) => ({ ...p, nameA: nameOf(p.a), nameB: nameOf(p.b) });
const out = {
	generatedAt: new Date().toISOString(),
	params: { MIN_SCORE, TOP, DISTINCTIVE_IDF, BUCKET_CAP, SUSPECT_IGNORE_MIN, SUSPECT_LINK_MAX },
	stats: {
		totalSkus,
		skusInGroups,
		groups: inGroup.length,
		implicitMultiStore,
		trulyIsolated,
		maxGroup,
		manualLinks: manualLinks.length,
		ignores: ignores.length,
		autoLinks: autoLinks.length,
		scoredPairs: scoredCount,
		cappedAt,
	},
	missed: missed.map(enrich),
	missedSameStore: missedSameStore.map(enrich),
	suspectIgnores: suspectIgnores.map(enrich),
	suspectLinks: suspectLinks.map(enrich),
	groupConflicts,
};
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`\nSaved structured report → ${path.relative(ROOT, OUT_PATH)}`);
console.log(
	`(${missed.length} missed, ${suspectIgnores.length} suspect-ignores, ${suspectLinks.length} suspect-links, ${groupConflicts.length} group-conflicts)`,
);

/* ---------------- markdown failure report (for LLM analysis) ---------------- */

const REPORT_CAP = parseInt(argVal("--report-cap", "80"), 10);
const MD_PATH = path.join(OUT_DIR, "algo_failures.md");

function storesShort(s, n = 4) {
	const arr = [...(bySku.get(s)?.stores || [])];
	if (arr.length <= n) return arr.join(", ");
	return `${arr.slice(0, n).join(", ")} … (${arr.length} stores)`;
}
// A listing whose "name" is just its SKU/number (scraper didn't capture a real
// name) — these score 0 with nothing to match on, but it's a data gap, not a
// formula fault. Flag so the analysis doesn't try to "fix the formula" for them.
const nameIsMissing = (s) => nameOf(s).replace(/[^a-zA-Z]/g, "").length < 3;
function mdCase(p) {
	const d = decompose(p.a, p.b);
	if (!d) return "";
	const tags = factorTags(d);
	if (nameIsMissing(p.a) || nameIsMissing(p.b)) tags.unshift("NO-NAME (scrape gap — not a formula fault)");
	const factorLine = `residual ${d.residual.toFixed(2)} · size ${d.size.toFixed(2)} · price ${d.price.toFixed(2)} · age ${d.age.toFixed(2)} · abv ${d.abv.toFixed(2)} · edition ${d.edition.toFixed(2)}`;
	return [
		`**${d.final.toFixed(2)}** · \`${p.a}\` ↔ \`${p.b}\`${tags.length ? ` — _${tags.join(", ")}_` : ""}`,
		`- A: ${nameOf(p.a)} · ${storesShort(p.a)}`,
		`- B: ${nameOf(p.b)} · ${storesShort(p.b)}`,
		`- factors: ${factorLine}`,
		"",
	].join("\n");
}

const md = [];
md.push("# Linker Algorithm — Failure Cases for Analysis");
md.push("");
md.push(`Generated ${out.generatedAt}. Ground truth = confirmed human labels in \`sku_links.json\`.`);
md.push("");
md.push(
	"This report isolates pairs where the **deterministic scorer disagrees with the human labels** — algorithm errors, assuming the labels are correct. The goal is to improve the **non-ML scoring formula** (see `TECHNICAL_REPORT.md` §3 for the full formula and constants).",
);
md.push("");
md.push("## How to read each case");
md.push("");
md.push("The score factors as a product:");
md.push("");
md.push("```");
md.push("final = residual × size × price × age × abv × edition × badSku");
md.push("```");
md.push("");
md.push(
	"- **residual** = everything name-based (token-containment + IDF weighted-overlap + coverage penalties + top-term bonus). It is recovered by dividing the deterministic multipliers out of the final score, so it is exact.",
);
md.push("- the six **multipliers** are recomputed independently; `<1` demotes, `>1` boosts.");
md.push("- the italic tags flag factors that materially moved the score (e.g. `age↓ 0.20`, `weak-name 0.01`).");
md.push("");
md.push(
	"> ⚠ Some low-scoring links may themselves be **mislabels** (bad data), not algorithm faults. Flag those for relabeling rather than degrading the formula to fit them.",
);
md.push("");
md.push(`## A. UNDER-SCORING — human LINKED these, algorithm scores low (false negatives)`);
md.push("");
md.push(
	`These are the algorithm's blind spots: confirmed matches it fails to recognize. Look for systematic causes — abbreviations/synonyms it can't see (token overlap is zero), size-variant penalties on genuine same-product links, age/ABV demotes that shouldn't apply. ${suspectLinks.length} total; showing up to ${REPORT_CAP}, lowest first.`,
);
md.push("");
for (const p of suspectLinks.slice(0, REPORT_CAP)) md.push(mdCase(p));

md.push(`## B. OVER-SCORING — human IGNORED these, algorithm scores high (false positives)`);
md.push("");
md.push(
	`These are where the algorithm is too eager: confirmed non-matches it scores highly. Look for shared brand/boilerplate dominating, distinctive edition markers it misses, or size/ABV/edition differences it under-weights. ${suspectIgnores.length} total; showing up to ${REPORT_CAP}, highest first.`,
);
md.push("");
for (const p of suspectIgnores.slice(0, REPORT_CAP)) md.push(mdCase(p));

fs.writeFileSync(MD_PATH, md.join("\n"));
console.log(`Markdown failure report → ${path.relative(ROOT, MD_PATH)}`);
