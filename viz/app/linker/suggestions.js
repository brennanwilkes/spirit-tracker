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
	sameGroupFn, // ✅ NEW
	sizePenaltyFn,
	pricePenaltyFn,
) {
	const itemsAll = allAgg.filter((it) => !!it);

	const seed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
	const rnd = mulberry32(seed);
	const itemsShuf = itemsAll.slice();
	shuffleInPlace(itemsShuf, rnd);

	// Bigger cap is fine; still bounded
	const WORK_CAP = Math.min(9000, itemsShuf.length);
	const workAll = itemsShuf.length > WORK_CAP ? itemsShuf.slice(0, WORK_CAP) : itemsShuf;

	// Unmapped-only view for normal similarity stage
	const work = workAll.filter((it) => {
		if (!it) return false;
		return !(mappedSkus && mappedSkus.has(String(it.sku)));
	});

	function itemRank(it) {
		const stores = it.stores ? it.stores.size : 0;
		const hasPrice = it.cheapestPriceNum != null ? 1 : 0;
		const hasName = it.name ? 1 : 0;
		const unknown = String(it.sku || "").startsWith("u:") ? 1 : 0;
		return stores * 3 + hasPrice * 2 + hasName * 0.5 + unknown * 0.25;
	}

	// --- SMWS exact-code pairs first (now blocks sameGroup + mapped) ---
	function smwsPairsFirst(workArr, limit) {
		const buckets = new Map(); // code -> items[]
		for (const it of workArr) {
			if (!it) continue;
			const sku = String(it.sku || "");
			if (!sku) continue;

			// ✅ NEW: keep SMWS stage unmapped-only
			if (mappedSkus && mappedSkus.has(sku)) continue;

			const code = smwsKeyFromName(it.name || "");
			if (!code) continue;
			let arr = buckets.get(code);
			if (!arr) buckets.set(code, (arr = []));
			arr.push(it);
		}

		const candPairs = [];

		for (const arr0 of buckets.values()) {
			if (!arr0 || arr0.length < 2) continue;

			const arr = arr0
				.slice()
				.sort((a, b) => itemRank(b) - itemRank(a))
				.slice(0, 80);

			const anchor = arr.slice().sort((a, b) => itemRank(b) - itemRank(a))[0];
			if (!anchor) continue;

			for (const u of arr) {
				if (u === anchor) continue;
				const a = anchor;
				const b = u;
				const aSku = String(a.sku || "");
				const bSku = String(b.sku || "");
				if (!aSku || !bSku || aSku === bSku) continue;

				if (typeof sameStoreFn === "function" && sameStoreFn(aSku, bSku)) continue;
				if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(aSku, bSku)) continue;

				// ✅ NEW: do not suggest if already linked
				if (typeof sameGroupFn === "function" && sameGroupFn(aSku, bSku)) continue;

				// ✅ NEW: extra safety (should already be unmapped-only, but keep)
				if (mappedSkus && (mappedSkus.has(aSku) || mappedSkus.has(bSku))) continue;

				const s = 1e9 + itemRank(a) + itemRank(b);
				candPairs.push({ a, b, score: s });
			}
		}

		candPairs.sort((x, y) => y.score - x.score);

		const usedUnmapped = new Set();
		const out0 = [];
		for (const p of candPairs) {
			const bSku = String(p.b.sku || "");
			if (!bSku) continue;
			if (usedUnmapped.has(bSku)) continue;
			usedUnmapped.add(bSku);
			out0.push(p);
			if (out0.length >= limit) break;
		}

		return { pairs: out0, usedUnmapped };
	}

	// ✅ CHANGED: SMWS stage now runs on `work` (unmapped-only), not `workAll`
	const smwsFirst = smwsPairsFirst(work, limitPairs);
	const used = new Set(smwsFirst.usedUnmapped);
	const out = smwsFirst.pairs.slice();
	if (out.length >= limitPairs) return out.slice(0, limitPairs);

	// --- Improved general pairing logic ---

	const seeds = topSuggestions(work, Math.min(220, work.length), "", mappedSkus).filter(
		(it) => !used.has(String(it?.sku || "")),
	);

	// Build token buckets over normalized names
	const TOKEN_BUCKET_CAP = 700;
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

	const bestByPair = new Map();
	const MAX_CAND_TOTAL = 450;
	const MAX_FINE = 18;

	for (const a of seeds) {
		const aSku = String(a.sku || "");
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
				if (!b) continue;
				const bSku = String(b.sku || "");
				if (!bSku || bSku === aSku) continue;
				if (used.has(bSku)) continue;

				if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(aSku, bSku)) continue;
				if (typeof sameStoreFn === "function" && sameStoreFn(aSku, bSku)) continue;

				// ✅ NEW: block already-linked groups here too
				if (typeof sameGroupFn === "function" && sameGroupFn(aSku, bSku)) continue;

				cand.set(bSku, b);
			}
			if (cand.size >= MAX_CAND_TOTAL) break;
		}
		if (!cand.size) continue;

		// Cheap score stage
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
				let mult = 0.1 + 0.95 * contain;
				if (smallN <= 3 && contain < 0.78) mult *= 0.22;
				s *= Math.min(1.0, mult);
			}

			if (typeof sizePenaltyFn === "function") s *= sizePenaltyFn(aSku, bSku);
			if (typeof pricePenaltyFn === "function") s *= pricePenaltyFn(aSku, bSku);

			const bAge = extractAgeFromText(bNorm);
			if (aAge && bAge) {
				if (aAge === bAge) s *= 1.6;
				else s *= 0.22;
			}

			if (String(aSku).startsWith("u:") || String(bSku).startsWith("u:")) s *= 1.06;

			if (s > 0) cheap.push({ b, s, bNorm, bRaw, bFilt, contain, firstMatch, bAge });
		}

		if (!cheap.length) continue;
		cheap.sort((x, y) => y.s - x.s);

		// Fine stage
		let bestB = null;
		let bestS = 0;

		for (const x of cheap.slice(0, MAX_FINE)) {
			const b = x.b;
			const bSku = String(b.sku || "");

			let s = similarityScore(a.name || "", b.name || "");
			if (s <= 0) continue;

			if (!x.firstMatch) {
				const smallN = Math.min(aFilt.length || 0, (x.bFilt || []).length || 0);
				let mult = 0.1 + 0.95 * x.contain;
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
				if (aAge === x.bAge) s *= 2.0;
				else s *= 0.15;
			}

			if (String(aSku).startsWith("u:") || String(bSku).startsWith("u:")) s *= 1.1;

			if (s > bestS) {
				bestS = s;
				bestB = b;
			}
		}

		if (!bestB || bestS < 0.5) continue;

		const bSku = String(bestB.sku || "");
		if (!bSku || used.has(bSku)) continue;

		const key = aSku < bSku ? `${aSku}|${bSku}` : `${bSku}|${aSku}`;
		const prev = bestByPair.get(key);
		if (!prev || bestS > prev.score) bestByPair.set(key, { a, b: bestB, score: bestS });
	}

	const pairs = Array.from(bestByPair.values());
	pairs.sort((x, y) => y.score - x.score);

	// ---- light randomness inside a top band ----
	const need = Math.max(0, limitPairs - out.length);
	if (!need) return out.slice(0, limitPairs);

	const TOP_BAND = Math.min(700, pairs.length);
	const JITTER = 0.08;

	const band = pairs.slice(0, TOP_BAND).map((p) => {
		const jitter = (rnd() - 0.5) * JITTER;
		return { ...p, _rank: p.score * (1 + jitter) };
	});
	band.sort((a, b) => b._rank - a._rank);

	function tryTake(p) {
		const aSku = String(p.a.sku || "");
		const bSku = String(p.b.sku || "");
		if (!aSku || !bSku || aSku === bSku) return false;
		if (used.has(aSku) || used.has(bSku)) return false;
		if (typeof sameStoreFn === "function" && sameStoreFn(aSku, bSku)) return false;
		if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(aSku, bSku)) return false;

		// ✅ NEW: block already-linked groups here too
		if (typeof sameGroupFn === "function" && sameGroupFn(aSku, bSku)) return false;

		used.add(aSku);
		used.add(bSku);
		out.push({ a: p.a, b: p.b, score: p.score });
		return true;
	}

	for (const p of band) {
		if (out.length >= limitPairs) break;
		tryTake(p);
	}

	if (out.length < limitPairs) {
		for (let i = TOP_BAND; i < pairs.length; i++) {
			if (out.length >= limitPairs) break;
			tryTake(pairs[i]);
		}
	}

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
