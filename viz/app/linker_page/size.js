// viz/app/linker/size.js
import { keySkuForRow } from "../sku.js";

export function parseSizesMlFromText(text) {
	const s = String(text || "").toLowerCase();
	if (!s) return [];

	const out = new Set();
	const re = /\b(\d+(?:\.\d+)?)\s*(ml|cl|l|litre|litres|liter|liters)\b/g;

	let m;
	while ((m = re.exec(s))) {
		const val = parseFloat(m[1]);
		const unit = m[2];
		if (!isFinite(val) || val <= 0) continue;

		let ml = 0;
		if (unit === "ml") ml = Math.round(val);
		else if (unit === "cl") ml = Math.round(val * 10);
		else ml = Math.round(val * 1000);

		if (ml >= 50 && ml <= 5000) out.add(ml);
	}

	return Array.from(out);
}

// Standard bottle-size equivalence classes (mL). Market-equivalent fills map to
// one canonical bucket so they're treated as the SAME size: 700≡750 (standard),
// 350≡375 (half). Genuinely different formats stay in different buckets. Units
// are already converted to mL by parseSizesMlFromText (so 1.14L→1140, 1.75L→1750).
const SIZE_BUCKETS = [
	{ canon: 50, lo: 40, hi: 65 }, // mini
	{ canon: 100, lo: 90, hi: 115 },
	{ canon: 200, lo: 180, hi: 220 },
	{ canon: 375, lo: 330, hi: 400 }, // 350 & 375 half-bottle
	{ canon: 500, lo: 480, hi: 560 },
	{ canon: 700, lo: 680, hi: 760 }, // 700 & 750 standard
	{ canon: 1000, lo: 950, hi: 1060 }, // 1L
	{ canon: 1140, lo: 1100, hi: 1180 }, // 1.14L (Canadian 40oz)
	{ canon: 1500, lo: 1450, hi: 1550 },
	{ canon: 1750, lo: 1700, hi: 1800 }, // 1.75L handle
	{ canon: 3000, lo: 2900, hi: 3100 },
];

function canonSizeMl(ml) {
	for (const b of SIZE_BUCKETS) if (ml >= b.lo && ml <= b.hi) return b.canon;
	return ml; // unknown size: itself (so two odd-but-equal sizes still match)
}

function canonSet(set) {
	const out = new Set();
	for (const ml of set) out.add(canonSizeMl(ml));
	return out;
}

export function sizePenalty(aSet, bSet) {
	if (!aSet?.size || !bSet?.size) return 1.0; // unknown size → don't penalize
	const A = canonSet(aSet);
	const B = canonSet(bSet);
	for (const c of A) if (B.has(c)) return 1.0; // same canonical bucket → match
	return 0.08; // different bottle format
}

/**
 * Builds caches and returns a function (aSku,bSku)=>penalty.
 * This keeps linker_page.js clean and makes cache rebuild explicit when rules change.
 */
export function buildSizePenaltyForPair({ allRows, allAgg, rules }) {
	const SKU_SIZE_CACHE = new Map(); // skuKey -> Set<int ml>

	function ensureSkuSet(k) {
		let set = SKU_SIZE_CACHE.get(k);
		if (!set) SKU_SIZE_CACHE.set(k, (set = new Set()));
		return set;
	}

	for (const r of allRows) {
		if (!r || r.removed) continue;
		const skuKey = String(keySkuForRow(r) || "").trim();
		if (!skuKey) continue;

		const name = r.name || r.title || r.productName || "";
		const sizes = parseSizesMlFromText(name);
		if (!sizes.length) continue;

		const set = ensureSkuSet(skuKey);
		for (const x of sizes) set.add(x);
	}

	for (const it of allAgg) {
		const skuKey = String(it?.sku || "").trim();
		if (!skuKey || !it?.name) continue;
		const sizes = parseSizesMlFromText(it.name);
		if (!sizes.length) continue;

		const set = ensureSkuSet(skuKey);
		for (const x of sizes) set.add(x);
	}

	const CANON_SIZE_CACHE = new Map(); // canon -> Set<int ml>

	function ensureCanonSet(k) {
		let set = CANON_SIZE_CACHE.get(k);
		if (!set) CANON_SIZE_CACHE.set(k, (set = new Set()));
		return set;
	}

	for (const it of allAgg) {
		const skuKey = String(it?.sku || "").trim();
		if (!skuKey) continue;

		const canon = String(rules.canonicalSku(skuKey) || skuKey);
		const canonSet = ensureCanonSet(canon);

		const skuSet = SKU_SIZE_CACHE.get(skuKey);
		if (skuSet) for (const x of skuSet) canonSet.add(x);
	}

	// Cheapest price per canonical — used to infer the missing size when exactly
	// one side states a size (a sizeless listing priced like a 700 is a 700).
	const CANON_PRICE = new Map();
	for (const it of allAgg) {
		const p = it?.cheapestPriceNum;
		if (p == null || !(p > 0)) continue;
		const canon = String(rules.canonicalSku(String(it.sku || "")) || it.sku || "");
		const cur = CANON_PRICE.get(canon);
		if (cur == null || p < cur) CANON_PRICE.set(canon, p);
	}

	return function sizePenaltyForPair(aSku, bSku) {
		const aCanon = String(rules.canonicalSku(String(aSku || "")) || "");
		const bCanon = String(rules.canonicalSku(String(bSku || "")) || "");
		const A = aCanon ? CANON_SIZE_CACHE.get(aCanon) || new Set() : new Set();
		const B = bCanon ? CANON_SIZE_CACHE.get(bCanon) || new Set() : new Set();

		const aHas = A.size > 0;
		const bHas = B.size > 0;

		if (aHas && bHas) return sizePenalty(A, B);
		if (aHas === bHas) return 1.0; // neither states a size → no info

		// Exactly one side states a size: lean on price to guess the other's size.
		// Similar price ⇒ probably the same size (keep); a price gap consistent
		// with a different format (e.g. 375 is ~half a 700) ⇒ probably different.
		const pA = CANON_PRICE.get(aCanon);
		const pB = CANON_PRICE.get(bCanon);
		if (pA == null || pB == null) return 1.0; // no price → can't infer, stay neutral
		const ratio = Math.max(pA, pB) / Math.min(pA, pB);
		if (ratio <= 1.4) return 1.0; // ~same price → likely same size
		if (ratio >= 1.6) return 0.3; // priced like a different format → likely different
		return 0.7; // borderline
	};
}
