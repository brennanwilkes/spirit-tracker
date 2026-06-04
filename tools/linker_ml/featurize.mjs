#!/usr/bin/env node
/**
 * tools/linker_ml/featurize.mjs — the shared substrate for the learned linker.
 *
 * Three deliverables, all reusing the LIVE scorer's helpers (never forking scoring):
 *
 *   buildEnv()        — load the catalog + links, build the vocab/size/price context
 *                       exactly the way tools/linker_eval.mjs does, so features and the
 *                       live ranker can never drift.
 *   featurizeSku()    — "convert a SKU into the right shape": one structured record
 *                       (tokens, distinctive tokens, sizes, abv, age, edition codes,
 *                       brand, category, price, stores) + skuToText() for an embedder.
 *   featurizePair()   — the ~25-column feature vector for a (skuA, skuB) pair: the full
 *                       deterministic score (scorePairWithVocab) PLUS the decomposed
 *                       sub-factors the blend can reweight, PLUS a slot for embed_cosine.
 *
 * The deterministic score is kept as one feature because the live scorer applies max()
 * floors (SMWS / spaceless-core / mid-cut) that don't decompose into a clean product —
 * so we let the blend scale the whole algo and ADD orthogonal signals around it.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { normSearchText, tokenizeQuery, parsePriceToNumber, keySkuForRow } from "../../viz/app/sku.js";
import { normalizeStoreId } from "../../viz/app/stores.js";
import {
	filterSimTokens,
	tokenContainmentScore,
	extractAbv,
	abvMultiplier,
	extractAgeFromText,
	bareAgeCandidates,
	extractEditionCodes,
	editionCodeMultiplier,
	smwsKeyFromName,
} from "../../viz/app/linker_page/similarity.js";
import { conceptConflictMultiplier } from "../../viz/app/linker_page/concepts.js";
import { buildVocab, DISTINCTIVE_IDF } from "../../viz/app/linker_page/vocab.js";
import { buildSizePenaltyForPair, parseSizesMlFromText } from "../../viz/app/linker_page/size.js";
import { buildPricePenaltyForPair } from "../../viz/app/linker_page/price.js";
import { prepScorePairCtx, scorePairWithVocab } from "../../viz/app/linker_page/suggestions.js";
import { extractBlendFeatures, FEATURE_KEYS } from "../../viz/app/linker_page/blend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");
export const WORKTREE = process.env.DATA_WORKTREE || path.join(ROOT, ".worktrees/data");
export const OUT_DIR = path.join(__dirname, "out");

const INDEX_PATH = path.join(WORKTREE, "viz/data/index.json");
const LINKS_PATH = path.join(WORKTREE, "data/sku_links.json");
const LINKS_AUTO_PATH = path.join(WORKTREE, "data/sku_links_auto.json");
const HIDDEN_PATH = path.join(WORKTREE, "data/sku_hidden.json");

// (storeId,rawSku) listings curated as "never track" in sku_hidden.json. The LINKER ML
// excludes them from EVERYTHING (training/eval/analysis) — stricter than the rest of the
// system where hide is presentation-only. Mirror viz/app/hidden.js's key + catalog.js's
// per-listing filter. See [[feedback_notrain_and_hidden_exclusion]].
function loadHiddenSet() {
	const set = new Set();
	try {
		for (const e of readJson(HIDDEN_PATH).hidden || []) {
			const sid = normalizeStoreId(e?.storeId);
			const sku = String(e?.sku || "").trim();
			if (sid && sku) set.add(`${sid}|${sku}`);
		}
	} catch {
		/* no hidden file → no exclusions */
	}
	return set;
}

export function readJson(p) {
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

/* ---------------- environment (single source of truth) ---------------- */

// Mirrors tools/linker_eval.mjs's setup so the feature context is identical to the
// live ranker's: per-raw-SKU aggregates, catalog vocab, size/price penalty closures.
export function buildEnv() {
	const idx = readJson(INDEX_PATH);
	const rows = idx.items || [];

	const hiddenSet = loadHiddenSet();
	let nHidden = 0;
	const bySku = new Map();
	for (const r of rows) {
		const sku = String(r.sku || "");
		if (!sku) continue;
		// Per-listing hidden exclusion (matches viz/app/catalog.js::aggregateBySku): skip a
		// hidden store-listing before it enters any aggregate, so it never reaches training,
		// eval, or analysis. A SKU hidden at every store drops out entirely.
		if (hiddenSet.size && hiddenSet.has(`${normalizeStoreId(r.storeLabel || r.store)}|${keySkuForRow(r)}`)) {
			nHidden++;
			continue;
		}
		let a = bySku.get(sku);
		if (!a) {
			a = {
				sku,
				name: r.name || "",
				stores: new Set(),
				cheapestPriceNum: null,
				category: r.category || "",
				categoryLabel: r.categoryLabel || "",
			};
			bySku.set(sku, a);
		}
		if (r.storeLabel) a.stores.add(r.storeLabel);
		const p = parsePriceToNumber(r.price);
		if (Number.isFinite(p) && p > 0)
			a.cheapestPriceNum = a.cheapestPriceNum == null ? p : Math.min(a.cheapestPriceNum, p);
		// Keep the FIRST non-empty name — MATCHES viz/app/catalog.js aggregateBySku (the serving
		// aggregation). The model must be trained on the SAME product name the UI scores against;
		// keeping the longest here was a train/serve skew (det/name features computed from a
		// different string live vs in training).
		if (!a.name && r.name) a.name = r.name;
		if (!a.category && r.category) a.category = r.category;
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

	// Link adjacency (manual+auto) for canonical-GROUP BFS used by the group-wise
	// features. Built once; featurizePair cuts the scored pair's direct edge so the
	// feature is computed on honest PRE-merge groups (no label leakage for positives).
	const linkAdj = new Map();
	const addAdj = (f, t) => {
		let s = linkAdj.get(f);
		if (!s) linkAdj.set(f, (s = new Set()));
		s.add(t);
	};
	for (const l of allLinks) {
		const f = String(l.fromSku || l.skuA || "").trim();
		const t = String(l.toSku || l.skuB || "").trim();
		if (f && t && f !== t) {
			addAdj(f, t);
			addAdj(t, f);
		}
	}

	const vocab = buildVocab(allAgg);
	const rulesStub = { canonicalSku: (s) => String(s) };
	const sizeFn = buildSizePenaltyForPair({ allRows: rows, allAgg, rules: rulesStub });
	const priceFn = buildPricePenaltyForPair({ allAgg, rules: rulesStub });

	const ctxCache = new Map();
	function ctxFor(sku) {
		let c = ctxCache.get(sku);
		if (c !== undefined) return c;
		const it = bySku.get(sku);
		c = it ? prepScorePairCtx(it, { vocab, sizePenaltyFn: sizeFn, pricePenaltyFn: priceFn }) : null;
		ctxCache.set(sku, c);
		return c;
	}

	return {
		rows,
		bySku,
		allAgg,
		vocab,
		sizeFn,
		priceFn,
		ctxFor,
		linkAdj,
		manualLinks,
		autoLinks,
		allLinks,
		ignoreEntries,
		nHidden,
	};
}

/* ---------------- group-wise pair features (honest, pre-merge) ---------------- */

function bfsComponent(adj, seed, banA, banB) {
	const seen = new Set([seed]);
	const st = [seed];
	while (st.length) {
		const x = st.pop();
		const ns = adj.get(x);
		if (!ns) continue;
		for (const y of ns) {
			if ((x === banA && y === banB) || (x === banB && y === banA)) continue; // cut the scored edge
			if (!seen.has(y)) {
				seen.add(y);
				st.push(y);
			}
		}
	}
	return seen;
}

// Standard bottle buckets (mirror size.js) so 700≡750 etc.
const SIZE_BUCKETS_FT = [
	[40, 65, 50], [90, 115, 100], [180, 220, 200], [330, 400, 375], [480, 560, 500],
	[680, 760, 700], [950, 1060, 1000], [1100, 1180, 1140], [1450, 1550, 1500],
	[1700, 1800, 1750], [2900, 3100, 3000],
];
const bucketMl = (ml) => {
	for (const [lo, hi, c] of SIZE_BUCKETS_FT) if (ml >= lo && ml <= hi) return c;
	return ml;
};

function groupSizeBuckets(members, env) {
	const out = new Set();
	for (const s of members) {
		const it = env.bySku.get(String(s));
		if (!it) continue;
		for (const ml of parseSizesMlFromText(it.name || "")) out.add(bucketMl(ml));
	}
	return out;
}

function groupStoreSkus(members, env) {
	const m = new Map(); // store -> Set(sku)
	for (const s of members) {
		const it = env.bySku.get(String(s));
		if (!it) continue;
		for (const st of it.stores) {
			let z = m.get(st);
			if (!z) m.set(st, (z = new Set()));
			z.add(String(s));
		}
	}
	return m;
}

const _tokCache = new Map();
function tokSet(name) {
	const key = String(name || "");
	let s = _tokCache.get(key);
	if (!s) _tokCache.set(key, (s = new Set(filterSimTokens(tokenizeQuery(normSearchText(key))))));
	return s;
}
// An UPGRADE/relist (same product, two SKUs at one store) has near-identical names; a
// genuine collision (different products a store stocks together) does not. Discount the
// former so a SKU upgrade isn't counted as evidence the groups are different.
function nameNearDup(skuX, skuY, env) {
	const a = tokSet(env.bySku.get(String(skuX))?.name);
	const b = tokSet(env.bySku.get(String(skuY))?.name);
	if (!a.size || !b.size) return false;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	const union = a.size + b.size - inter;
	return union > 0 && inter / union >= 0.8;
}

function groupAbvMean(members, env) {
	let s = 0;
	let n = 0;
	for (const m of members) {
		const a = extractAbv(normSearchText(env.bySku.get(String(m))?.name || ""));
		if (a != null) {
			s += a;
			n++;
		}
	}
	return n ? s / n : null;
}
function groupYear(members, env) {
	for (const m of members) {
		const y = normSearchText(env.bySku.get(String(m))?.name || "").match(/\b(19\d\d|20\d\d)\b/);
		if (y) return parseInt(y[1], 10);
	}
	return null;
}
function groupMinPrice(members, env) {
	let p = null;
	for (const m of members) {
		const v = env.bySku.get(String(m))?.cheapestPriceNum;
		if (v != null && v > 0) p = p == null ? v : Math.min(p, v);
	}
	return p;
}
function jaccard(A, B) {
	if (!A.size && !B.size) return 1;
	let inter = 0;
	for (const x of A) if (B.has(x)) inter++;
	const uni = A.size + B.size - inter;
	return uni ? inter / uni : 1;
}

const GRP_NEUTRAL = {
	grpStoreOverlap: 0, grpStoreCollideCount: 0, grpStoreJaccard: 0, grpSameSkuShare: 0,
	grpSizeConflict: 0, grpSizeJaccard: 1, grpAbvDiff: 0, grpAbvBoth: 0, grpYearDiff: 0,
	grpYearBoth: 0, grpPriceRatio: 1, grpCountA: 1, grpCountB: 1,
};

// Rich group-wise feature set for pair (a,b), on PRE-merge groups (cut the direct a–b edge
// so a confirmed link doesn't get its own merged group as the answer). All signals are
// canonical-GROUP level (not pairwise) — the dimension neither the bag-of-tokens scorer nor
// the bi-encoder can see. A nonlinear blend can mine interactions across these.
export function groupPairFeatures(aSku, bSku, env) {
	const adj = env.linkAdj;
	if (!adj) return { ...GRP_NEUTRAL };
	const GA = bfsComponent(adj, aSku, aSku, bSku);
	if (GA.has(bSku)) return { ...GRP_NEUTRAL }; // multi-path → same product, no honest pre-merge signal
	const GB = bfsComponent(adj, bSku, aSku, bSku);

	const smA = groupStoreSkus(GA, env);
	const smB = groupStoreSkus(GB, env);
	const storeSetA = new Set(smA.keys());
	const storeSetB = new Set(smB.keys());
	const allStores = new Set([...storeSetA, ...storeSetB]);
	let colliding = 0; // different-sku, non-upgrade, same store → evidence of different products
	let sameSku = 0; // identical sku at same store → upgrade/identity → evidence of SAME product
	for (const [st, SA] of smA) {
		const SB = smB.get(st);
		if (!SB) continue;
		let collide = false;
		let identical = false;
		for (const x of SA) {
			for (const y of SB) {
				if (x === y) identical = true;
				else if (!nameNearDup(x, y, env)) collide = true;
			}
		}
		if (collide) colliding++;
		if (identical) sameSku++;
	}
	const grpStoreOverlap = allStores.size ? colliding / allStores.size : 0;
	const grpSameSkuShare = allStores.size ? sameSku / allStores.size : 0;
	const grpStoreJaccard = jaccard(storeSetA, storeSetB);

	const szA = groupSizeBuckets(GA, env);
	const szB = groupSizeBuckets(GB, env);
	let shared = false;
	for (const c of szA) if (szB.has(c)) { shared = true; break; }
	const grpSizeConflict = szA.size && szB.size && !shared ? 1 : 0;
	const grpSizeJaccard = szA.size && szB.size ? jaccard(szA, szB) : 1;

	const abvA = groupAbvMean(GA, env);
	const abvB = groupAbvMean(GB, env);
	const grpAbvBoth = abvA != null && abvB != null ? 1 : 0;
	const grpAbvDiff = grpAbvBoth ? Math.abs(abvA - abvB) : 0;

	const yA = groupYear(GA, env);
	const yB = groupYear(GB, env);
	const grpYearBoth = yA != null && yB != null ? 1 : 0;
	const grpYearDiff = grpYearBoth ? Math.abs(yA - yB) : 0;

	const pA = groupMinPrice(GA, env);
	const pB = groupMinPrice(GB, env);
	const grpPriceRatio = pA && pB ? Math.max(pA, pB) / Math.min(pA, pB) : 1;

	return {
		grpStoreOverlap,
		grpStoreCollideCount: colliding,
		grpStoreJaccard,
		grpSameSkuShare,
		grpSizeConflict,
		grpSizeJaccard,
		grpAbvDiff,
		grpAbvBoth,
		grpYearDiff,
		grpYearBoth,
		grpPriceRatio,
		grpCountA: GA.size,
		grpCountB: GB.size,
	};
}

/* ---------------- SKU → shape ---------------- */

// One canonical text string for an embedder. We feed the normalized NAME only — the
// attention model's job is semantic name equivalence (TBWC↔That Boutique-y, MCDXCIV↔1494,
// Compass Box↔Great King Street); size/abv/edition stay as deterministic vetoes (the
// embedding raising recall, hard rules protecting precision — CLASSIFIER_PLAN §5).
export function skuToText(item) {
	return normSearchText(item?.name || "");
}

// Category word from the name (coarse class the concept walls use). One token, appended
// to the embedder text so same/different category nudges the cosine the right way.
function categoryWord(name) {
	const s = ` ${String(name || "").toLowerCase()} `;
	if (/\bgin\b/.test(s)) return "gincat";
	if (/\brum\b/.test(s)) return "rumcat";
	if (/\bvodka\b/.test(s)) return "vodkacat";
	if (/\b(tequila|mezcal)\b/.test(s)) return "tequilacat";
	if (/\b(brandy|cognac|armagnac)\b/.test(s)) return "brandycat";
	if (/\bliqueur\b/.test(s)) return "liqueurcat";
	if (/\b(whisky|whiskey|scotch|bourbon|rye|malt)\b/.test(s)) return "whiskycat";
	return "";
}

// Embedder text ENRICHED with GROUP-resolved, processed attribute tokens (Increment 2):
// the normalized name PLUS size bucket / ABV / vintage year / category, unioned across the
// SKU's whole canonical group (so a sizeless listing inherits its siblings' size). These
// are per-SKU attributes whose meaning is ALIGNED with cosine similarity (same size →
// closer), unlike pairwise store-overlap which stays a blend feature. No raw store names.
export function skuToTextEnriched(sku, env) {
	const it = env.bySku.get(String(sku));
	if (!it) return "";
	const base = normSearchText(it.name || "");
	const members = env.linkAdj ? bfsComponent(env.linkAdj, String(sku), null, null) : new Set([String(sku)]);
	if (!members.has(String(sku))) members.add(String(sku));

	const sizeCounts = new Map();
	let year = null;
	let abv = null;
	for (const m of members) {
		const nm = env.bySku.get(String(m))?.name || "";
		const norm = normSearchText(nm);
		for (const ml of parseSizesMlFromText(nm)) {
			const c = bucketMl(ml);
			sizeCounts.set(c, (sizeCounts.get(c) || 0) + 1);
		}
		if (year == null) {
			const ym = norm.match(/\b(19\d\d|20\d\d)\b/);
			if (ym) year = ym[1];
		}
		if (abv == null) {
			const a = extractAbv(norm);
			if (a != null) abv = a;
		}
	}

	const parts = [base];
	if (sizeCounts.size) {
		const top = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
		parts.push("size", String(top));
	}
	if (abv != null) parts.push("abv", String(Math.round(abv)));
	if (year) parts.push("year", String(year));
	const cat = categoryWord(it.name);
	if (cat) parts.push(cat);
	return parts.join(" ");
}

// Structured single-SKU representation — the "right shape" for any downstream model.
export function featurizeSku(sku, env) {
	const it = env.bySku.get(String(sku));
	if (!it) return null;
	const name = it.name || "";
	const norm = normSearchText(name);
	const rawToks = tokenizeQuery(norm);
	const toks = filterSimTokens(rawToks);
	const distinctive = env.vocab.distinctiveUnigramsForName(name);
	return {
		sku: it.sku,
		name,
		text: norm,
		toks,
		distinctiveToks: [...(distinctive || [])],
		sizesMl: parseSizesMlFromText(name),
		abv: extractAbv(norm),
		age: extractAgeFromText(norm) || null,
		editionCodes: [...(extractEditionCodes(name) || [])],
		smws: smwsKeyFromName(name) || null,
		brand: toks[0] || "",
		category: it.category || "",
		priceNum: it.cheapestPriceNum,
		stores: [...it.stores],
	};
}

/* ---------------- pair → feature vector ---------------- */

const NUM_RE = /^\d+$/;

// The pair feature vector. Delegates to the SHARED extractBlendFeatures in
// viz/app/linker_page/blend.js (the same function the live ranker uses) so the eval and
// production can never drift. detScore (the full deterministic score) is added explicitly
// because the blend consumes it as `logDet` but downstream tools also read it raw.
export function featurizePair(skuA, skuB, env) {
	const a = env.bySku.get(String(skuA));
	const b = env.bySku.get(String(skuB));
	if (!a || !b) return null;
	const ctxA = env.ctxFor(a.sku);
	if (!ctxA) return null;
	const detScore = scorePairWithVocab(ctxA, b);
	const grp = groupPairFeatures(a.sku, b.sku, env);
	const feats = extractBlendFeatures(ctxA, b, {
		vocab: env.vocab,
		sizePenaltyFn: env.sizeFn,
		pricePenaltyFn: env.priceFn,
		detScore,
	});
	return { a: a.sku, b: b.sku, detScore, ...feats, ...grp };
}

// FEATURE_KEYS is the single source of truth in blend.js; re-exported for the trainer.
export { FEATURE_KEYS, NUM_RE };
