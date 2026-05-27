// viz/app/linker/suggestions.js
import { tokenizeQuery, normSearchText } from "../sku.js";
import {
	smwsKeyFromName,
	extractAgeFromText,
	bareAgeCandidates,
	filterSimTokens,
	tokenContainmentScore,
	fastSimilarityScore,
	similarityScore,
} from "./similarity.js";
import { DISTINCTIVE_IDF, WO_POW, TOP_TERM_BONUS, BASE_FLOOR } from "./vocab.js";

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

/* ---------------- Bad/invalid SKU detection ---------------- */
// A "bad" SKU is one that can never be matched automatically by ID and
// therefore is more likely to need manual linking. These are exactly the
// SKUs that should be boosted in suggestions.
function isBadSku(sku) {
	const s = String(sku || "").toLowerCase();
	if (!s) return true;
	if (s.startsWith("u:")) return true;
	if (s.startsWith("id:")) return true;
	if (s.startsWith("upc:")) return true;
	if (s === "unknown") return true;
	return false;
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
		const bad = isBadSku(it.sku) ? 1 : 0;

		scored.push({ it, s: stores * 2 + hasPrice * 1.2 + hasName * 1.0 + bad * 0.8 });
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
	opts,
) {
	if (!pinned || !pinned.name) return topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus);

	// Optional IDF-vocabulary boost + same-store enablement. When `vocab` is
	// absent, every code path below behaves exactly as before (all new logic is
	// guarded by `if (vocab)`).
	const vocab = opts && opts.vocab ? opts.vocab : null;
	const allowSameStore = !!(opts && opts.allowSameStore);
	const pinTopTerm = vocab ? vocab.topTerm(pinned.name || "") : null;

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
	// Scan the whole catalog for any realistic size. These were 5000/12000,
	// but the 33-store catalog (~12.4k aggregates) exceeded 12000, which
	// silently dropped ~60% of candidates from the scan — including most
	// new-store items — so pinned suggestions never surfaced them. The cheap
	// scoring pass is O(n) and fine at this scale; keep a high ceiling only as
	// a guard against a pathologically huge catalog.
	const MAX_SCAN = 200000; // cap for huge catalogs
	const FULL_SCAN_UNDER = 200000; // scan everything below this
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
		// Same-store is blocked unless allowSameStore (so a store's duplicate SKUs
		// for the same item can be matched).
		if (!allowSameStore && typeof sameStoreFn === "function" && sameStoreFn(pinnedSku, itSku))
			continue;
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
				pushTopK(
					cheap,
					{ it, s: 1e9 + stores * 10 + hasPrice, itNorm: "", itRawToks: null },
					MAX_CHEAP_KEEP,
				);
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

		// IDF vocab overlap: shared distinctive terms dominate ranking and let
		// word-order/brand-position mismatches off the hook.
		let wo = null;
		let distinctiveShared = false;
		if (vocab) {
			wo = vocab.weightedOverlap(base, it.name || "");
			distinctiveShared = wo.shared.some((x) => x.idf >= DISTINCTIVE_IDF);
		}
		const brandMatch = firstMatch || distinctiveShared;

		let s0;
		if (vocab) {
			// Validated IDF formula: shared distinctive terms dominate; the
			// containment factor guards against winning purely on a single
			// rare-term coincidence (union-denominator quirk). No brand-position
			// penalty — the IDF overlap is already word-order independent.
			s0 = (BASE_FLOOR + contain) * Math.pow(1 + wo.score, WO_POW);
			if (
				pinTopTerm &&
				pinTopTerm.idf >= DISTINCTIVE_IDF &&
				vocab.termsForName(it.name || "").has(pinTopTerm.term)
			) {
				s0 *= 1 + TOP_TERM_BONUS;
			}
		} else {
			// Cheap score first (no Levenshtein)
			s0 = fastSimilarityScore(pinRawToks, itRawToks, pinNorm, itNorm);
			if (s0 <= 0) s0 = 0.01 + 0.25 * contain;

			// Soft first-token mismatch penalty (never blocks)
			if (!brandMatch) {
				const smallN = Math.min(pinToks.length || 0, itToks.length || 0);
				let mult = 0.1 + 0.95 * contain;
				if (smallN <= 3 && contain < 0.78) mult *= 0.22;
				s0 *= Math.min(1.0, mult);
			}
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
			if (pinAge === itAge) s0 *= vocab ? 1.8 : 1.6;
			else s0 *= vocab ? 0.2 : 0.22;
		} else if (vocab && pinAge && !itAge && bareAgeCandidates(itNorm).has(pinAge)) {
			// bare number (e.g. "16") matches the pinned explicit age
			s0 *= 1.8;
		}

		// Bad/invalid SKU boost — these will never auto-link, so we want them
		// to surface more often in manual suggestions.
		if (isBadSku(pinnedSku) || isBadSku(itSku)) s0 *= 1.15;

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

		const itNorm = x.itNorm || normSearchText(it.name || "");
		const itRawToks = x.itRawToks || tokenizeQuery(itNorm);
		const itToks = filterSimTokens(itRawToks);
		const itBrand = itToks[0] || "";
		const firstMatch = pinBrand && itBrand && pinBrand === itBrand;
		const contain = tokenContainmentScore(pinRawToks, itRawToks);

		let s;
		if (vocab) {
			const wo = vocab.weightedOverlap(base, it.name || "");
			s = (BASE_FLOOR + contain) * Math.pow(1 + wo.score, WO_POW);
			if (s <= 0) continue;
			if (
				pinTopTerm &&
				pinTopTerm.idf >= DISTINCTIVE_IDF &&
				vocab.termsForName(it.name || "").has(pinTopTerm.term)
			) {
				s *= 1 + TOP_TERM_BONUS;
			}
		} else {
			s = similarityScore(base, it.name || "");
			if (s <= 0) continue;
			if (!firstMatch) {
				const smallN = Math.min(pinToks.length || 0, itToks.length || 0);
				let mult = 0.1 + 0.95 * contain;
				if (smallN <= 3 && contain < 0.78) mult *= 0.22;
				s *= Math.min(1.0, mult);
				if (s <= 0) continue;
			}
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
			if (pinAge === itAge) s *= vocab ? 1.8 : 2.0;
			else s *= vocab ? 0.2 : 0.15;
		} else if (vocab && pinAge && !itAge && bareAgeCandidates(itNorm).has(pinAge)) {
			s *= 1.8;
		}

		if (isBadSku(pinnedSku) || isBadSku(itSku)) s *= 1.2;

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

		if (!allowSameStore && typeof sameStoreFn === "function" && sameStoreFn(pinnedSku, itSku))
			continue;
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
	opts,
) {
	const itemsAll = allAgg.filter((it) => !!it);
	if (!itemsAll.length) return [];

	// -------- temperature (0..1) --------
	const TEMP = Math.max(0, Math.min(1, Number(opts?.temp ?? 0.22)));
	const lerp = (a, b, t) => a + (b - a) * t;
	const DETERMINISTIC = TEMP <= 0;

	// -------- RNG (stable per load) --------
	let s0 = 1; // fixed seed for deterministic mode
	if (!DETERMINISTIC) {
		s0 = seed;
		if (s0 == null) {
			try {
				const u = new Uint32Array(1);
				crypto.getRandomValues(u);
				s0 = u[0] >>> 0;
			} catch {
				s0 = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
			}
		}
	}
	const rnd = mulberry32(s0 >>> 0 || 1);
	const randInt = (n) => (n <= 1 ? 0 : (rnd() * n) | 0);

	function blocked(aSku, bSku) {
		if (!aSku || !bSku || aSku === bSku) return true;
		if (typeof sameStoreFn === "function" && sameStoreFn(aSku, bSku)) return true;
		if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(aSku, bSku)) return true;
		if (typeof sameGroupFn === "function" && sameGroupFn(aSku, bSku)) return true;
		return false;
	}

	function itemRank(it) {
		const stores = it.stores ? it.stores.size : 0;
		const hasPrice = it.cheapestPriceNum != null ? 1 : 0;
		const hasName = it.name ? 1 : 0;
		const bad = isBadSku(it.sku) ? 1 : 0;
		return stores * 3 + hasPrice * 2 + hasName * 0.6 + bad * 0.6;
	}

	// Randomized catalog view (helps variety), but bounded
	const itemsShuf = itemsAll.slice();
	shuffleInPlace(itemsShuf, rnd);

	const WORK_CAP = Math.min(200000, itemsShuf.length);
	let workAll;

	if (DETERMINISTIC) {
		// stable order: sku asc (or whatever stable key you want)
		workAll = itemsAll.slice().sort((a, b) => {
			const as = String(a?.sku || "");
			const bs = String(b?.sku || "");
			return as < bs ? -1 : as > bs ? 1 : 0;
		});
	} else {
		const itemsShuf = itemsAll.slice();
		shuffleInPlace(itemsShuf, rnd);

		const WORK_CAP = Math.min(200000, itemsShuf.length);
		workAll = itemsShuf.length > WORK_CAP ? itemsShuf.slice(0, WORK_CAP) : itemsShuf;
	}

	// Unmapped-only pool for initial suggestions
	const work = workAll.filter((it) => it && !(mappedSkus && mappedSkus.has(String(it.sku || ""))));
	if (!work.length) return [];

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

	// ---------------- SMWS stage (DETERMINISTIC + PRECISE) ----------------
	// Exact code buckets, pick top-ranked anchor + top-ranked valid partner.
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

		const smwsPairs = [];
		for (const [code, arr0] of buckets.entries()) {
			if (!arr0 || arr0.length < 2) continue;

			// deterministic: sort by rank desc, then sku asc
			const arr = arr0.slice().sort((a, b) => {
				const dr = itemRank(b) - itemRank(a);
				if (dr) return dr;
				const as = String(a?.sku || "");
				const bs = String(b?.sku || "");
				return as < bs ? -1 : as > bs ? 1 : 0;
			});

			const anchor = arr[0];
			const aSku = String(anchor?.sku || "");
			if (!aSku) continue;

			for (let i = 1; i < arr.length; i++) {
				const partner = arr[i];
				const bSku = String(partner?.sku || "");
				if (!bSku) continue;
				if (blocked(aSku, bSku)) continue;

				const sc = 1e9 + itemRank(anchor) + itemRank(partner);
				smwsPairs.push({ a: anchor, b: partner, score: sc });
				break;
			}
		}

		// deterministic: best SMWS pairs first
		smwsPairs.sort((x, y) => y.score - x.score);

		for (const p of smwsPairs) {
			if (out.length >= limitPairs) break;
			tryAddPair(p.a, p.b, p.score);
		}
	}

	// Number of pinned SMWS pairs at the head of `out`. These must stay at the
	// top — never get shuffled into the general pool below.
	const smwsCount = out.length;

	if (out.length >= limitPairs) {
		return out.slice(0, limitPairs);
	}

	// ---------------- General stage (temperature controls randomness) ----------------

	// Token buckets
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

	// knobs: lower TEMP => smaller pools, more greedy
	const SEED_N = Math.min(work.length, Math.round(lerp(220, 520, TEMP)));
	const MAX_CAND_TOTAL = Math.round(lerp(420, 900, TEMP));
	const CHEAP_TOP = Math.round(lerp(24, 70, TEMP));
	const FINE_TOP = Math.round(lerp(6, 22, TEMP));
	const EPS = TEMP; // probability to not pick the top-1 partner

	// seeds: deterministic when TEMP=0, otherwise sampled/shuffled
	let seeds;
	if (TEMP <= 0) {
		seeds = topSuggestions(work, Math.min(SEED_N, work.length), "", mappedSkus);
	} else {
		seeds = work.slice();
		shuffleInPlace(seeds, rnd);
		seeds.length = SEED_N;
		// bias toward higher-rank items but still varied:
		seeds.sort((a, b) => {
			const dr = itemRank(b) - itemRank(a);
			if (dr) return dr;
			return String(a?.sku || "") < String(b?.sku || "") ? -1 : 1;
		});
		// then scramble again so we don't always start with the same best ones
		shuffleInPlace(seeds, rnd);
	}

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

		// candidates from buckets
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

		// cheap stage
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

			if (isBadSku(aSku) || isBadSku(bSku)) s *= 1.15;

			if (s > 0) cheap.push({ b, s, bNorm, bRaw, bFilt, contain, firstMatch, bAge });
		}
		if (!cheap.length) continue;

		cheap.sort((x, y) => y.s - x.s);

		// fine stage
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

			if (isBadSku(aSku) || isBadSku(bSku)) s *= 1.2;

			fine.push({ b, s });
		}
		if (!fine.length) continue;

		fine.sort((x, y) => y.s - x.s);
		const top = fine.slice(0, FINE_TOP);
		if (!top.length) continue;

		// pick partner: greedy when TEMP low, more varied when TEMP high
		let picked = top[0];
		if (TEMP > 0 && rnd() < EPS && top.length > 1) {
			// weighted pick among topN: lower TEMP => sharper bias to best
			const best = Math.max(1e-12, top[0].s);
			const power = lerp(8.0, 2.2, TEMP);
			let sum = 0;
			const w = [];
			for (let i = 0; i < top.length; i++) {
				const rel = Math.max(1e-12, top[i].s) / best;
				const wi = Math.pow(rel, power);
				w[i] = wi;
				sum += wi;
			}
			let r = rnd() * sum;
			for (let i = 0; i < top.length; i++) {
				r -= w[i];
				if (r <= 0) {
					picked = top[i];
					break;
				}
			}
		}

		if (picked.s < 0.45) continue;
		tryAddPair(a, picked.b, picked.s);
	}

	if (!DETERMINISTIC && out.length > smwsCount) {
		// Keep SMWS pairs pinned at the top; only shuffle the non-SMWS tail.
		const tail = out.slice(smwsCount);
		shuffleInPlace(tail, rnd);
		out.length = smwsCount;
		for (const p of tail) out.push(p);
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
