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
import { filterSimTokens, extractAbv } from "./similarity.js";
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
};

// Build a group index from the live catalog once per (re)load. canonicalSkuFn maps a raw
// SKU → its canonical group id (rules.canonicalSku). Precomputes per-group aggregates so
// per-pair feature extraction is cheap.
export function buildGroupIndex(allAgg, canonicalSkuFn) {
	const groupOf = new Map(); // sku -> canon
	const groups = new Map(); // canon -> { storeMap, sizes, abvSum, abvN, year, minPrice, count }
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
			g = { storeMap: new Map(), sizes: new Set(), abvSum: 0, abvN: 0, year: null, minPrice: null, count: 0 };
			groups.set(canon, g);
		}
		g.count++;
		const stores = it.stores instanceof Set ? it.stores : new Set(it.stores || []);
		for (const st of stores) {
			let s = g.storeMap.get(st);
			if (!s) g.storeMap.set(st, (s = new Set()));
			s.add(sku);
		}
		const norm = normSearchText(name);
		for (const ml of parseSizesMlFromText(name)) g.sizes.add(bucketMl(ml));
		const ab = extractAbv(norm);
		if (ab != null) {
			g.abvSum += ab;
			g.abvN++;
		}
		if (g.year == null) {
			const ym = norm.match(/\b(19\d\d|20\d\d)\b/);
			if (ym) g.year = parseInt(ym[1], 10);
		}
		const p = it.cheapestPriceNum;
		if (p != null && p > 0) g.minPrice = g.minPrice == null ? p : Math.min(g.minPrice, p);
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

		const grpPriceRatio = ga.minPrice && gb.minPrice
			? Math.max(ga.minPrice, gb.minPrice) / Math.min(ga.minPrice, gb.minPrice)
			: 1;

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
		};
	}

	return { features };
}
