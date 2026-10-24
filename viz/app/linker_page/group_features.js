// viz/app/linker_page/group_features.js
//
// LIVE computation of the canonical-GROUP pair features the blend/GBT consumes — the
// group↔group dimension neither the bag-of-tokens scorer nor the bi-encoder can see
// (e.g. "both groups stock a DIFFERENT sku at the same store" ⇒ different products).
//
// MUST stay in sync with tools/linker_ml/featurize.mjs::groupPairFeatures (the trainer).
// The trainer edge-cuts the scored pair's link so positives use PRE-merge groups; live the
// linker never scores same-group pairs (sameGroupFn filters them), so candidates are always
// cross-group and we compute on the full current groups — identical to the trainer's
// cross-group path. Keep the formulas/constants identical to avoid train/serve skew.

import { normSearchText, tokenizeQuery } from "../sku.js";
import { filterSimTokens, extractAbv, extractAgeFromText } from "./similarity.js";
import { parseSizesMlFromText } from "./size.js";

// Standard bottle buckets — identical to size.js SIZE_BUCKETS / featurize SIZE_BUCKETS_FT.
const SIZE_BUCKETS = [
	[40, 65, 50], [90, 115, 100], [180, 220, 200], [330, 400, 375], [480, 560, 500],
	[680, 760, 700], [950, 1060, 1000], [1100, 1180, 1140], [1450, 1550, 1500],
	[1700, 1800, 1750], [2900, 3100, 3000],
];
const bucketMl = (ml) => {
	for (const [lo, hi, c] of SIZE_BUCKETS) if (ml >= lo && ml <= hi) return c;
	return ml;
};
function jaccard(A, B) {
	if (!A.size && !B.size) return 1;
	let inter = 0;
	for (const x of A) if (B.has(x)) inter++;
	const uni = A.size + B.size - inter;
	return uni ? inter / uni : 1;
}

export const GRP_NEUTRAL = {
	grpStoreOverlap: 0, grpStoreCollideCount: 0, grpStoreJaccard: 0, grpSameSkuShare: 0,
	grpSizeConflict: 0, grpSizeJaccard: 1, grpAbvDiff: 0, grpAbvBoth: 0, grpYearDiff: 0,
	grpYearBoth: 0, grpPriceRatio: 1, grpCountA: 1, grpCountB: 1,
	xTokCovAB: 1, xTokCovBA: 1, xBestJacc: 1, xAgeOmitA: 0, xAgeOmitB: 0, xAbvOmitA: 0, xAbvOmitB: 0,
};

/* ---- title features over each group's member titles (shared with featurize.mjs, so one formula) ---- */

const _titleTok = new Map();
export function titleTokens(name) {
	const key = String(name || "");
	let t = _titleTok.get(key);
	if (!t) _titleTok.set(key, (t = new Set(filterSimTokens(tokenizeQuery(normSearchText(key))))));
	return t;
}

// One group's catalog-member titles → per-title token sets, core tokens (in at least half the titles),
// token union, and the share of titles stating no age / no ABV. Order-independent, uncapped.
export function groupTitleProfile(names) {
	if (!names.length) throw new Error("groupTitleProfile: empty group");
	const toks = [];
	const counts = new Map();
	let noAge = 0;
	let noAbv = 0;
	for (const name of names) {
		const t = titleTokens(name);
		toks.push(t);
		for (const x of t) counts.set(x, (counts.get(x) || 0) + 1);
		if (!extractAgeFromText(normSearchText(name || ""))) noAge++;
		if (extractAbv(name || "") == null) noAbv++;
	}
	const core = new Set();
	for (const [x, c] of counts) if (c * 2 >= names.length) core.add(x);
	return { toks, core, union: new Set(counts.keys()), ageOmit: noAge / names.length, abvOmit: noAbv / names.length };
}

function coverage(core, union) {
	if (!core.size) return 0;
	let i = 0;
	for (const t of core) if (union.has(t)) i++;
	return i / core.size;
}

// xTokCov*: how much of one group's core title tokens the other group's titles carry at all, so a
// truncated, lower-cased or extra-wordy newcomer still finds its product's words in some member title.
// xBestJacc: the closest single pair of titles. Omission shares tell a title that simply leaves out
// the age / ABV apart from one that states a different one.
export function groupTitleFeatures(pa, pb) {
	let best = 0;
	for (const x of pa.toks) {
		for (const y of pb.toks) {
			if (!x.size && !y.size) continue;
			let i = 0;
			for (const t of x) if (y.has(t)) i++;
			const j = i / (x.size + y.size - i);
			if (j > best) best = j;
		}
	}
	return {
		xTokCovAB: coverage(pa.core, pb.union),
		xTokCovBA: coverage(pb.core, pa.union),
		xBestJacc: best,
		xAgeOmitA: pa.ageOmit,
		xAgeOmitB: pb.ageOmit,
		xAbvOmitA: pa.abvOmit,
		xAbvOmitB: pb.abvOmit,
	};
}

// Build a group index from the live catalog once per (re)load. canonicalSkuFn maps a raw
// SKU → its canonical group id (rules.canonicalSku). Precomputes per-group aggregates so
// per-pair feature extraction is cheap.
export function medianOf(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const h = s.length >> 1;
	return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

export function buildGroupIndex(allAgg, canonicalSkuFn) {
	const groupOf = new Map(); // sku -> canon
	const groups = new Map(); // canon -> { storeMap, sizes, abvSum, abvN, year, prices, count }
	const nameBySku = new Map();
	const tokBySku = new Map();

	for (const it of allAgg) {
		const sku = String(it?.sku || "");
		if (!sku) continue;
		const canon = String(canonicalSkuFn ? canonicalSkuFn(sku) || sku : sku);
		groupOf.set(sku, canon);
		const name = it.name || "";
		nameBySku.set(sku, name);

		let g = groups.get(canon);
		if (!g) {
			g = { storeMap: new Map(), sizes: new Set(), abvSum: 0, abvN: 0, year: null, prices: [], count: 0, names: [], profile: null };
			groups.set(canon, g);
		}
		g.count++;
		g.names.push(name);
		const stores = it.stores instanceof Set ? it.stores : new Set(it.stores || []);
		for (const st of stores) {
			let s = g.storeMap.get(st);
			if (!s) g.storeMap.set(st, (s = new Set()));
			s.add(sku);
		}
		const norm = normSearchText(name);
		for (const ml of parseSizesMlFromText(name)) g.sizes.add(bucketMl(ml));
		const ab = extractAbv(name);
		if (ab != null) {
			g.abvSum += ab;
			g.abvN++;
		}
		if (g.year == null) {
			const ym = norm.match(/\b(19\d\d|20\d\d)\b/);
			if (ym) g.year = parseInt(ym[1], 10);
		}
		if (!Array.isArray(it.listingPrices)) throw new Error(`buildGroupIndex: aggregate ${sku} has no listingPrices`);
		g.prices.push(...it.listingPrices);
	}

	function tokOf(sku) {
		let t = tokBySku.get(sku);
		if (!t) tokBySku.set(sku, (t = new Set(filterSimTokens(tokenizeQuery(normSearchText(nameBySku.get(sku) || ""))))));
		return t;
	}
	// An upgrade/relist (same product, two SKUs at one store) has near-identical names; a
	// genuine collision (different products) does not. Discount the former.
	function nameNearDup(x, y) {
		const a = tokOf(x);
		const b = tokOf(y);
		if (!a.size || !b.size) return false;
		let inter = 0;
		for (const t of a) if (b.has(t)) inter++;
		const uni = a.size + b.size - inter;
		return uni > 0 && inter / uni >= 0.8;
	}

	function features(aSku, bSku) {
		const ca = groupOf.get(String(aSku));
		const cb = groupOf.get(String(bSku));
		const ga = ca != null ? groups.get(ca) : null;
		const gb = cb != null ? groups.get(cb) : null;
		if (!ga || !gb || ca === cb) return { ...GRP_NEUTRAL };

		const smA = ga.storeMap;
		const smB = gb.storeMap;
		const storeSetA = new Set(smA.keys());
		const storeSetB = new Set(smB.keys());
		const allStores = new Set([...storeSetA, ...storeSetB]);
		let colliding = 0;
		let sameSku = 0;
		for (const [st, SA] of smA) {
			const SB = smB.get(st);
			if (!SB) continue;
			let collide = false;
			let identical = false;
			for (const x of SA) {
				for (const y of SB) {
					if (x === y) identical = true;
					else if (!nameNearDup(x, y)) collide = true;
				}
			}
			if (collide) colliding++;
			if (identical) sameSku++;
		}
		const grpStoreOverlap = allStores.size ? colliding / allStores.size : 0;
		const grpSameSkuShare = allStores.size ? sameSku / allStores.size : 0;
		const grpStoreJaccard = jaccard(storeSetA, storeSetB);

		let shared = false;
		for (const c of ga.sizes) if (gb.sizes.has(c)) { shared = true; break; }
		const grpSizeConflict = ga.sizes.size && gb.sizes.size && !shared ? 1 : 0;
		const grpSizeJaccard = ga.sizes.size && gb.sizes.size ? jaccard(ga.sizes, gb.sizes) : 1;

		const abvA = ga.abvN ? ga.abvSum / ga.abvN : null;
		const abvB = gb.abvN ? gb.abvSum / gb.abvN : null;
		const grpAbvBoth = abvA != null && abvB != null ? 1 : 0;
		const grpAbvDiff = grpAbvBoth ? Math.abs(abvA - abvB) : 0;

		const grpYearBoth = ga.year != null && gb.year != null ? 1 : 0;
		const grpYearDiff = grpYearBoth ? Math.abs(ga.year - gb.year) : 0;

		const pA = medianOf(ga.prices);
		const pB = medianOf(gb.prices);
		const grpPriceRatio = pA && pB ? Math.max(pA, pB) / Math.min(pA, pB) : 1;

		ga.profile ??= groupTitleProfile(ga.names);
		gb.profile ??= groupTitleProfile(gb.names);

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
			grpCountA: ga.count,
			grpCountB: gb.count,
			...groupTitleFeatures(ga.profile, gb.profile),
		};
	}

	return { features };
}
