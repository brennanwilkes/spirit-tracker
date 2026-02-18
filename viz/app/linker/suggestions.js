// viz/app/linker/suggestions.js
import { tokenizeQuery, normSearchText } from "../sku.js";
import {
	smwsKeyFromName,
	extractAgeFromText,
	filterSimTokens,
	tokenContainmentScore,
	fastSimilarityScore,
	similarityScore,
} from "./similarity.js";

/* ---------------- Randomization helpers ---------------- */

function mulberry32(seed) {
	let t = seed >>> 0;
	return function () {
		t += 0x6d2b79f5;
		let x = Math.imul(t ^ (t >>> 15), 1 | t);
		x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffleInPlace(arr, rnd) {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = (rnd() * (i + 1)) | 0;
		const tmp = arr[i];
		arr[i] = arr[j];
		arr[j] = tmp;
	}
	return arr;
}

/* ---------------- Suggestion helpers ---------------- */

export function topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus) {
	const scored = [];
	for (const it of allAgg) {
		if (!it) continue;
		// if (mappedSkus && mappedSkus.has(String(it.sku))) continue;
		if (otherPinnedSku && String(it.sku) === String(otherPinnedSku)) continue;

		const stores = it.stores ? it.stores.size : 0;
		const hasPrice = it.cheapestPriceNum !== null ? 1 : 0;
		const hasName = it.name ? 1 : 0;
		const unknown = String(it.sku || "").startsWith("u:") ? 1 : 0;

		scored.push({ it, s: stores * 2 + hasPrice * 1.2 + hasName * 1.0 + unknown * 0.6 });
	}
	scored.sort((a, b) => b.s - a.s);
	return scored.slice(0, limit).map((x) => x.it);
}

// viz/app/linker/suggestions.js
// (requires fnv1a32u(str) helper to exist in this file)

export function recommendSimilar(
	allAgg,
	pinned,
	limit,
	otherPinnedSku,
	mappedSkus,
	isIgnoredPairFn,
	sizePenaltyFn,
	pricePenaltyFn,
	sameStoreFn,
	sameGroupFn,
) {
	if (!pinned || !pinned.name) return topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus);

	const pinnedSku = String(pinned.sku || "");
	const otherSku = otherPinnedSku ? String(otherPinnedSku) : "";
	const base = String(pinned.name || "");

	const pinNorm = normSearchText(pinned.name || "");
	const pinRawToks = tokenizeQuery(pinNorm);
	const pinToks = filterSimTokens(pinRawToks);
	const pinBrand = pinToks[0] || "";
	const pinAge = extractAgeFromText(pinNorm);
	const pinnedSmws = smwsKeyFromName(pinned.name || "");

	// ---- Tuning knobs ----
	const MAX_SCAN = 5000; // cap for huge catalogs
	const FULL_SCAN_UNDER = 12000; // ✅ scan everything if catalog is "small"
	const MAX_CHEAP_KEEP = 320; // keep top candidates from cheap stage
	const MAX_FINE = 70; // expensive score only on top-N
	// ----------------------

	// Faster "topK" keeper: only sorts occasionally.
	function pushTopK(arr, item, k) {
		arr.push(item);
		if (arr.length >= k * 2) {
			arr.sort((a, b) => b.s - a.s);
			arr.length = k;
		}
	}

	const cheap = [];
	const nAll = allAgg.length || 0;
	if (!nAll) return [];

	// ✅ scan whole catalog when it's not huge
	const scanN = nAll <= FULL_SCAN_UNDER ? nAll : Math.min(MAX_SCAN, nAll);

	// ✅ rotate start to avoid alphabetical bias, but still cover scanN sequentially
	const start = (fnv1a32u(pinnedSku || pinNorm) % nAll) >>> 0;

	// Optional debug: uncomment to verify we’re actually hitting the region you expect
	// console.log("[linker] recommendSimilar scan2", { pinnedSku, nAll, scanN, start, startName: allAgg[start]?.name });

	for (let i = 0; i < scanN; i++) {
		const it = allAgg[(start + i) % nAll];
		if (!it) continue;

		const itSku = String(it.sku || "");
		if (!itSku) continue;

		if (itSku === pinnedSku) continue;
		if (otherSku && itSku === otherSku) continue;

		// HARD BLOCKS ONLY:
		if (typeof sameStoreFn === "function" && sameStoreFn(pinnedSku, itSku)) continue;
		if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(pinnedSku, itSku)) continue;
		if (typeof sameGroupFn === "function" && sameGroupFn(pinnedSku, itSku)) continue;

		// (Optional) original mapped exclusion lives here in your codebase.
		// Keep it if you want, but it wasn't your issue:
		//   if (mappedSkus && mappedSkus.has(itSku)) continue;

		// SMWS exact NUM.NUM match => keep at top
		if (pinnedSmws) {
			const k = smwsKeyFromName(it.name || "");
			if (k && k === pinnedSmws) {
				const stores = it.stores ? it.stores.size : 0;
				const hasPrice = it.cheapestPriceNum != null ? 1 : 0;
				pushTopK(cheap, { it, s: 1e9 + stores * 10 + hasPrice, itNorm: "", itRawToks: null }, MAX_CHEAP_KEEP);
				continue;
			}
		}

		const itNorm = normSearchText(it.name || "");
		if (!itNorm) continue;

		const itRawToks = tokenizeQuery(itNorm);
		const itToks = filterSimTokens(itRawToks);
		if (!itToks.length) continue;

		const itBrand = itToks[0] || "";
		const firstMatch = pinBrand && itBrand && pinBrand === itBrand;
		const contain = tokenContainmentScore(pinRawToks, itRawToks);

		// Cheap score first (no Levenshtein)
		let s0 = fastSimilarityScore(pinRawToks, itRawToks, pinNorm, itNorm);
		if (s0 <= 0) s0 = 0.01 + 0.25 * contain;

		// Soft first-token mismatch penalty (never blocks)
		if (!firstMatch) {
			const smallN = Math.min(pinToks.length || 0, itToks.length || 0);
			let mult = 0.1 + 0.95 * contain;
			if (smallN <= 3 && contain < 0.78) mult *= 0.22;
			s0 *= Math.min(1.0, mult);
		}

		// Size penalty early
		if (typeof sizePenaltyFn === "function") {
			s0 *= sizePenaltyFn(pinnedSku, itSku);
		}

		// Price penalty early
		if (typeof pricePenaltyFn === "function") {
			s0 *= pricePenaltyFn(pinnedSku, itSku);
		}

		// Age handling early
		const itAge = extractAgeFromText(itNorm);
		if (pinAge && itAge) {
			if (pinAge === itAge) s0 *= 1.6;
			else s0 *= 0.22;
		}

		// Unknown boost
		if (pinnedSku.startsWith("u:") || itSku.startsWith("u:")) s0 *= 1.08;

		pushTopK(cheap, { it, s: s0, itNorm, itRawToks }, MAX_CHEAP_KEEP);
	}

	// Final trim/sort for cheap stage
	cheap.sort((a, b) => b.s - a.s);
	if (cheap.length > MAX_CHEAP_KEEP) cheap.length = MAX_CHEAP_KEEP;

	// Fine stage: expensive scoring only on top candidates
	const fine = [];
	for (const x of cheap.slice(0, MAX_FINE)) {
		const it = x.it;
		const itSku = String(it.sku || "");

		let s = similarityScore(base, it.name || "");
		if (s <= 0) continue;

		const itNorm = x.itNorm || normSearchText(it.name || "");
		const itRawToks = x.itRawToks || tokenizeQuery(itNorm);
		const itToks = filterSimTokens(itRawToks);
		const itBrand = itToks[0] || "";
		const firstMatch = pinBrand && itBrand && pinBrand === itBrand;
		const contain = tokenContainmentScore(pinRawToks, itRawToks);

		if (!firstMatch) {
			const smallN = Math.min(pinToks.length || 0, itToks.length || 0);
			let mult = 0.1 + 0.95 * contain;
			if (smallN <= 3 && contain < 0.78) mult *= 0.22;
			s *= Math.min(1.0, mult);
			if (s <= 0) continue;
		}

		if (typeof sizePenaltyFn === "function") {
			s *= sizePenaltyFn(pinnedSku, itSku);
			if (s <= 0) continue;
		}

		if (typeof pricePenaltyFn === "function") {
			s *= pricePenaltyFn(pinnedSku, itSku);
			if (s <= 0) continue;
		}

		const itAge = extractAgeFromText(itNorm);
		if (pinAge && itAge) {
			if (pinAge === itAge) s *= 2.0;
			else s *= 0.15;
		}

		if (pinnedSku.startsWith("u:") || itSku.startsWith("u:")) s *= 1.12;

		fine.push({ it, s });
	}

	fine.sort((a, b) => b.s - a.s);
	const out = fine.slice(0, limit).map((x) => x.it);
	if (out.length) return out;

	// Fallback (unchanged)
	const fallback = [];
	for (const it of allAgg) {
		if (!it) continue;
		const itSku = String(it.sku || "");
		if (!itSku) continue;
		if (itSku === pinnedSku) continue;
		if (otherSku && itSku === otherSku) continue;

		if (typeof sameStoreFn === "function" && sameStoreFn(pinnedSku, itSku)) continue;
		if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(pinnedSku, itSku)) continue;
		if (typeof sameGroupFn === "function" && sameGroupFn(pinnedSku, itSku)) continue;

		const stores = it.stores ? it.stores.size : 0;
		const hasPrice = it.cheapestPriceNum !== null ? 1 : 0;
		const hasName = it.name ? 1 : 0;
		fallback.push({ it, s: stores * 2 + hasPrice * 1.2 + hasName * 1.0 });
		if (fallback.length >= 250) break;
	}

	fallback.sort((a, b) => b.s - a.s);
	return fallback.slice(0, limit).map((x) => x.it);
}

export function computeInitialPairsFast(
	allAgg,
	mappedSkus,
	limitPairs,
	isIgnoredPairFn,
	sameStoreFn,
	sameGroupFn,
	sizePenaltyFn,
	pricePenaltyFn,
	seed,
) {
	const itemsAll = allAgg.filter((it) => !!it);
	if (!itemsAll.length) return [];

	// ---- RNG (stable per page-load seed) ----
	let s0 = seed;
	if (s0 == null) {
		try {
			const u = new Uint32Array(1);
			crypto.getRandomValues(u);
			s0 = u[0] >>> 0;
		} catch {
			s0 = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
		}
	}
	const rnd = mulberry32((s0 >>> 0) || 1);

	function randInt(n) {
		return n <= 1 ? 0 : ((rnd() * n) | 0);
	}

	function weightedSampleWithoutReplacement(arr, k, weightFn) {
		// Efraimidis–Spirakis: key = U^(1/w), pick largest keys
		const tmp = [];
		for (const it of arr) {
			const w0 = weightFn(it);
			const w = Math.max(1e-6, Number.isFinite(w0) ? w0 : 1e-6);
			let u = rnd();
			if (u <= 0) u = 1e-12;
			const key = Math.pow(u, 1 / w);
			tmp.push({ it, key });
		}
		tmp.sort((a, b) => b.key - a.key);
		const out = [];
		const n = Math.min(k, tmp.length);
		for (let i = 0; i < n; i++) out.push(tmp[i].it);
		return out;
	}

	function pickFromTopByScore(scored, topN, power) {
		const n = Math.min(topN, scored.length);
		if (!n) return null;
		if (n === 1) return scored[0];

		const best = Math.max(1e-12, scored[0].s);
		const w = new Array(n);
		let sum = 0;

		for (let i = 0; i < n; i++) {
			const s = Math.max(1e-12, scored[i].s);
			const rel = s / best; // <= 1 typically
			const wi = Math.pow(rel, power); // closer to 1 => higher chance
			w[i] = wi;
			sum += wi;
		}

		let r = rnd() * sum;
		for (let i = 0; i < n; i++) {
			r -= w[i];
			if (r <= 0) return scored[i];
		}
		return scored[n - 1];
	}

	// Randomize catalog view, but keep bounded
	const itemsShuf = itemsAll.slice();
	shuffleInPlace(itemsShuf, rnd);

	const WORK_CAP = Math.min(12000, itemsShuf.length);
	const workAll = itemsShuf.length > WORK_CAP ? itemsShuf.slice(0, WORK_CAP) : itemsShuf;

	// Unmapped-only pool for initial suggestions
	const work = workAll.filter((it) => it && !(mappedSkus && mappedSkus.has(String(it.sku || ""))));
	if (!work.length) return [];

	function itemRank(it) {
		const stores = it.stores ? it.stores.size : 0;
		const hasPrice = it.cheapestPriceNum != null ? 1 : 0;
		const hasName = it.name ? 1 : 0;
		const unknown = String(it.sku || "").startsWith("u:") ? 1 : 0;
		return stores * 3 + hasPrice * 2 + hasName * 0.6 + unknown * 0.4;
	}

	// Helpers for hard blocks
	function blocked(aSku, bSku) {
		if (!aSku || !bSku || aSku === bSku) return true;
		if (typeof sameStoreFn === "function" && sameStoreFn(aSku, bSku)) return true;
		if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(aSku, bSku)) return true;
		if (typeof sameGroupFn === "function" && sameGroupFn(aSku, bSku)) return true;
		return false;
	}

	const used = new Set();
	const out = [];

	function tryAddPair(a, b, score) {
		const aSku = String(a?.sku || "");
		const bSku = String(b?.sku || "");
		if (!aSku || !bSku) return false;
		if (used.has(aSku) || used.has(bSku)) return false;
		if (blocked(aSku, bSku)) return false;

		used.add(aSku);
		used.add(bSku);
		out.push({ a, b, score: score || 0 });
		return true;
	}

	// ---------------- SMWS stage (random per load) ----------------
	// Build buckets on UNMAPPED-ONLY work, then pick random bucket order,
	// random anchor among top few, random partner among top few.
	{
		const buckets = new Map(); // code -> items[]
		for (const it of work) {
			const sku = String(it?.sku || "");
			if (!sku) continue;
			const code = smwsKeyFromName(it.name || "");
			if (!code) continue;
			let arr = buckets.get(code);
			if (!arr) buckets.set(code, (arr = []));
			arr.push(it);
		}

		const codes = Array.from(buckets.keys());
		shuffleInPlace(codes, rnd);

		for (const code of codes) {
			if (out.length >= limitPairs) break;
			const arr0 = buckets.get(code) || [];
			if (arr0.length < 2) continue;

			// rank within bucket
			const arr = arr0.slice().sort((a, b) => itemRank(b) - itemRank(a));
			const ANCHOR_TOP = Math.min(6, arr.length);
			const PARTNER_TOP = Math.min(45, arr.length);

			const anchor = arr[randInt(ANCHOR_TOP)];
			const aSku = String(anchor?.sku || "");
			if (!aSku || used.has(aSku)) continue;

			// try a few random partners
			let added = false;
			for (let t = 0; t < 10 && !added; t++) {
				const j = randInt(PARTNER_TOP);
				const partner = arr[j];
				if (!partner || partner === anchor) continue;
				const bSku = String(partner?.sku || "");
				if (!bSku || used.has(bSku)) continue;
				if (blocked(aSku, bSku)) continue;

				added = tryAddPair(anchor, partner, 1e9 + itemRank(anchor) + itemRank(partner));
			}
		}
	}

	if (out.length >= limitPairs) {
		shuffleInPlace(out, rnd);
		return out.slice(0, limitPairs);
	}

	// ---------------- General stage (random anchors + random best-of-top partner) ----------------

	// Token buckets (as before)
	const TOKEN_BUCKET_CAP = 800;
	const tokMap = new Map(); // token -> items[]
	const itemRawToks = new Map(); // sku -> raw tokens
	const itemNorm = new Map(); // sku -> norm name
	const itemFilt = new Map(); // sku -> filtered tokens

	for (const it of work) {
		const sku = String(it.sku || "");
		if (!sku) continue;

		const n = normSearchText(it.name || "");
		const raw = tokenizeQuery(n);
		const filt = filterSimTokens(raw);

		itemNorm.set(sku, n);
		itemRawToks.set(sku, raw);
		itemFilt.set(sku, filt);

		for (const t of filt.slice(0, 12)) {
			let arr = tokMap.get(t);
			if (!arr) tokMap.set(t, (arr = []));
			if (arr.length < TOKEN_BUCKET_CAP) arr.push(it);
		}
	}

	// Pick truly different anchors each load:
	// weighted sample across whole pool (not “topSuggestions” deterministic set).
	const SEED_N = Math.min(420, work.length);
	const seeds = weightedSampleWithoutReplacement(work, SEED_N, (it) => 1 + Math.max(0.1, itemRank(it)));
	shuffleInPlace(seeds, rnd);

	const MAX_CAND_TOTAL = 750;
	const CHEAP_TOP = 60; // widen variety
	const FINE_TOP = 20;

	for (const a of seeds) {
		if (out.length >= limitPairs) break;

		const aSku = String(a?.sku || "");
		if (!aSku || used.has(aSku)) continue;

		const aNorm = itemNorm.get(aSku) || normSearchText(a.name || "");
		const aRaw = itemRawToks.get(aSku) || tokenizeQuery(aNorm);
		const aFilt = itemFilt.get(aSku) || filterSimTokens(aRaw);
		if (!aFilt.length) continue;

		const aBrand = aFilt[0] || "";
		const aAge = extractAgeFromText(aNorm);

		// Gather candidates from token buckets
		const cand = new Map();
		for (const t of aFilt.slice(0, 10)) {
			const arr = tokMap.get(t);
			if (!arr) continue;

			for (let i = 0; i < arr.length && cand.size < MAX_CAND_TOTAL; i++) {
				const b = arr[i];
				const bSku = String(b?.sku || "");
				if (!bSku || bSku === aSku) continue;
				if (used.has(bSku)) continue;
				if (blocked(aSku, bSku)) continue;
				cand.set(bSku, b);
			}
			if (cand.size >= MAX_CAND_TOTAL) break;
		}
		if (!cand.size) continue;

		// Cheap stage for many options
		const cheap = [];
		for (const b of cand.values()) {
			const bSku = String(b.sku || "");
			const bNorm = itemNorm.get(bSku) || normSearchText(b.name || "");
			const bRaw = itemRawToks.get(bSku) || tokenizeQuery(bNorm);
			const bFilt = itemFilt.get(bSku) || filterSimTokens(bRaw);
			if (!bFilt.length) continue;

			const contain = tokenContainmentScore(aRaw, bRaw);
			const bBrand = bFilt[0] || "";
			const firstMatch = aBrand && bBrand && aBrand === bBrand;

			let s = fastSimilarityScore(aRaw, bRaw, aNorm, bNorm);
			if (s <= 0) s = 0.01 + 0.25 * contain;

			if (!firstMatch) {
				const smallN = Math.min(aFilt.length || 0, bFilt.length || 0);
				let mult = 0.12 + 0.9 * contain;
				if (smallN <= 3 && contain < 0.78) mult *= 0.22;
				s *= Math.min(1.0, mult);
			}

			if (typeof sizePenaltyFn === "function") s *= sizePenaltyFn(aSku, bSku);
			if (typeof pricePenaltyFn === "function") s *= pricePenaltyFn(aSku, bSku);

			const bAge = extractAgeFromText(bNorm);
			if (aAge && bAge) {
				if (aAge === bAge) s *= 1.5;
				else s *= 0.22;
			}

			if (String(aSku).startsWith("u:") || String(bSku).startsWith("u:")) s *= 1.07;

			if (s > 0) cheap.push({ b, s, bNorm, bRaw, bFilt, contain, firstMatch, bAge });
		}
		if (!cheap.length) continue;

		cheap.sort((x, y) => y.s - x.s);

		// Fine stage on a wider top set, then RANDOMLY choose among top results
		const fine = [];
		for (const x of cheap.slice(0, CHEAP_TOP)) {
			const b = x.b;
			const bSku = String(b.sku || "");

			let s = similarityScore(a.name || "", b.name || "");
			if (s <= 0) continue;

			if (!x.firstMatch) {
				const smallN = Math.min(aFilt.length || 0, (x.bFilt || []).length || 0);
				let mult = 0.12 + 0.9 * x.contain;
				if (smallN <= 3 && x.contain < 0.78) mult *= 0.22;
				s *= Math.min(1.0, mult);
				if (s <= 0) continue;
			}

			if (typeof sizePenaltyFn === "function") {
				s *= sizePenaltyFn(aSku, bSku);
				if (s <= 0) continue;
			}

			if (typeof pricePenaltyFn === "function") {
				s *= pricePenaltyFn(aSku, bSku);
				if (s <= 0) continue;
			}

			if (aAge && x.bAge) {
				if (aAge === x.bAge) s *= 1.9;
				else s *= 0.15;
			}

			if (String(aSku).startsWith("u:") || String(bSku).startsWith("u:")) s *= 1.12;

			fine.push({ b, s });
		}

		if (!fine.length) continue;
		fine.sort((x, y) => y.s - x.s);

		// ✅ THIS is the key: pick partner probabilistically, not always the max.
		const picked = pickFromTopByScore(fine, FINE_TOP, 2.0); // power↑ => more greedy
		if (!picked) continue;

		if (picked.s < 0.45) continue;

		if (tryAddPair(a, picked.b, picked.s)) {
			// added
		}
	}

	// Final scramble + trim
	shuffleInPlace(out, rnd);
	return out.slice(0, limitPairs);
}

function fnv1a32u(str) {
	let h = 0x811c9dc5;
	str = String(str || "");
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}
