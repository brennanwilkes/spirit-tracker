// viz/app/linker/suggestions.js
import { tokenizeQuery, normSearchText } from "../sku.js";
import {
	smwsKeyFromName,
	extractAgeFromText,
	extractAbv,
	abvMultiplier,
	extractEditionCodes,
	editionCodeMultiplier,
	bareAgeCandidates,
	filterSimTokens,
	tokenContainmentScore,
	fastSimilarityScore,
	similarityScore,
} from "./similarity.js";
import {
	DISTINCTIVE_IDF,
	WO_POW,
	TOP_TERM_BONUS,
	BASE_FLOOR,
	COVERAGE_PENALTY_FLOOR,
	COVERAGE_PENALTY_EXP,
	COVERAGE_PENALTY_FLOOR_CAND,
	COVERAGE_PENALTY_EXP_CAND,
	BRAND_DESCRIPTOR_BROADNESS_MIN,
	GRADED_COVERAGE_FLOOR,
	GRADED_COVERAGE_EXP,
} from "./vocab.js";

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

/* ---------------- Per-pair scoring (single source of truth) ---------------- */

// Build the per-anchor context once; pass it to scorePairWithVocab for each
// candidate. Used by recommendSimilar, computeInitialPairsFast, and
// tools/linker_eval.mjs — so the live ranker and the eval can never drift.
export function prepScorePairCtx(pinned, opts) {
	const name = String(pinned?.name || "");
	const norm = normSearchText(name);
	const rawToks = tokenizeQuery(norm);
	const toks = filterSimTokens(rawToks);
	const vocab = opts && opts.vocab ? opts.vocab : null;

	// Distinctive unigrams of the TARGET — terms a true match should share.
	const distinctiveTerms = vocab ? vocab.distinctiveUnigramsForName(name) : null;
	const allUnigrams = vocab ? vocab.allUnigramsForName(name) : null;

	return {
		sku: String(pinned?.sku || ""),
		name,
		norm,
		rawToks,
		toks,
		brand: toks[0] || "",
		age: extractAgeFromText(norm),
		abv: vocab ? extractAbv(norm) : null,
		editionCodes: vocab ? extractEditionCodes(norm) : null,
		topTerm: vocab ? vocab.topTerm(name) : null,
		distinctiveTerms,
		allUnigrams,
		vocab,
		sizePenaltyFn: opts && opts.sizePenaltyFn,
		pricePenaltyFn: opts && opts.pricePenaltyFn,
	};
}

// Score a single candidate against the pinned-side ctx using the vocab formula.
// Returns 0 when the candidate has no usable name/tokens, when scoring would be
// undefined, or when ctx has no vocab. Penalties (size/price) are applied if
// the ctx carries those fns; bad-SKU boost is applied last.
export function scorePairWithVocab(ctx, candidate) {
	if (!ctx || !ctx.vocab || !candidate) return 0;
	const itName = String(candidate.name || "");
	const itNorm = normSearchText(itName);
	if (!itNorm) return 0;
	const itRawToks = tokenizeQuery(itNorm);
	const itToks = filterSimTokens(itRawToks);
	if (!itToks.length) return 0;
	const itSku = String(candidate.sku || "");

	const contain = tokenContainmentScore(ctx.rawToks, itRawToks);
	const wo = ctx.vocab.weightedOverlap(ctx.name, itName);
	let s = (BASE_FLOOR + contain) * Math.pow(1 + wo.score, WO_POW);

	if (
		ctx.topTerm &&
		ctx.topTerm.idf >= DISTINCTIVE_IDF &&
		ctx.vocab.termsForName(itName).has(ctx.topTerm.term)
	) {
		s *= 1 + TOP_TERM_BONUS;
	}

	// Distinctive-coverage penalty (symmetric): how many of the target's
	// distinctive unigrams does the candidate share, AND how many of the
	// candidate's distinctive unigrams does the target share? Missing on either
	// side means "same brand, different edition" (Compass Box Stranger lacks
	// `magic`; Detour Amethyst has its own distinctive `amethyst` the target
	// lacks). The two sides multiply.
	if (ctx.distinctiveTerms) {
		const candDistinctive = ctx.vocab.distinctiveUnigramsForName(itName);
		const targetAllTerms = ctx.vocab.termsForName(ctx.name);
		const candAllTerms = ctx.vocab.termsForName(itName);

		// Target-side: candidate missing target's edition word → strong penalty.
		// (Tried symmetric cooc brand-descriptor filtering here too; it caused
		// regressions like BNS Voodoo 2.25 → 1.05 because terms whose absence
		// was legitimately demoting got filtered. Kept candidate-side-only.)
		let targetBinaryFullCoverage = true;
		if (ctx.distinctiveTerms.size > 0) {
			let m = 0;
			for (const t of ctx.distinctiveTerms) if (candAllTerms.has(t)) m++;
			const coverage = m / ctx.distinctiveTerms.size;
			if (coverage < 1) {
				targetBinaryFullCoverage = false;
				s *= Math.max(COVERAGE_PENALTY_FLOOR, Math.pow(coverage, COVERAGE_PENALTY_EXP));
			}
		}

		// Graded coverage on ALL target unigrams, applied only when binary
		// distinctive coverage was full. Catches sub-distinctive terms the
		// candidate lacks (e.g. `sherry` in Bridgeland Innisfail Sherry Cask).
		if (targetBinaryFullCoverage && ctx.allUnigrams && ctx.allUnigrams.size > 0) {
			let interW = 0;
			let totalW = 0;
			for (const t of ctx.allUnigrams) {
				const w = ctx.vocab.idf(t);
				totalW += w;
				if (candAllTerms.has(t)) interW += w;
			}
			if (totalW > 0) {
				const covIdf = interW / totalW;
				if (covIdf < 1) s *= Math.max(GRADED_COVERAGE_FLOOR, Math.pow(covIdf, GRADED_COVERAGE_EXP));
			}
		}

		// Candidate-side: candidate has its OWN distinctive edition that target
		// lacks → penalty. But EXCLUDE brand-descriptor words (broadly co-occur
		// with many distinctive terms AND with a shared distinctive from the
		// target). "Island Distillery" across Macaloney variants is brand
		// boilerplate; "amethyst" only with Detour is an edition.
		if (candDistinctive && candDistinctive.size > 0) {
			// Which target distinctives did the candidate share? Those are the
			// "shared distinctive" anchors used to validate brand-descriptor cooc.
			const sharedDistinctive = [];
			for (const t of ctx.distinctiveTerms) if (candAllTerms.has(t)) sharedDistinctive.push(t);

			let m = 0;
			let k = 0;
			for (const t of candDistinctive) {
				if (targetAllTerms.has(t)) {
					m++;
					k++;
					continue;
				}
				// Unshared candidate distinctive: brand-descriptor or edition?
				const cooc = ctx.vocab.coocSet(t);
				let isBrandDescriptor = false;
				if (cooc && cooc.size >= BRAND_DESCRIPTOR_BROADNESS_MIN) {
					for (const sd of sharedDistinctive)
						if (cooc.has(sd)) {
							isBrandDescriptor = true;
							break;
						}
				}
				if (!isBrandDescriptor) k++;
			}
			if (k > 0) {
				const coverage = m / k;
				if (coverage < 1)
					s *= Math.max(
						COVERAGE_PENALTY_FLOOR_CAND,
						Math.pow(coverage, COVERAGE_PENALTY_EXP_CAND),
					);
			}
		}
	}

	if (typeof ctx.sizePenaltyFn === "function") s *= ctx.sizePenaltyFn(ctx.sku, itSku);
	if (typeof ctx.pricePenaltyFn === "function") s *= ctx.pricePenaltyFn(ctx.sku, itSku);

	const itAge = extractAgeFromText(itNorm);
	if (ctx.age && itAge) {
		if (ctx.age === itAge) s *= 1.8;
		else s *= 0.2;
	} else if (ctx.age && !itAge && bareAgeCandidates(itNorm).has(ctx.age)) {
		s *= 1.8;
	}

	if (ctx.abv != null) s *= abvMultiplier(ctx.abv, extractAbv(itNorm));

	// Hard if/else on edition codes: SMWS X.YYY / R4 / G1, Roman numerals
	// (III/IV/V…), season codes (S22/S24/S2023). When both sides carry codes of
	// the same kind and they differ, the products are different (different cask,
	// release, batch).
	if (ctx.editionCodes && ctx.editionCodes.size > 0) {
		s *= editionCodeMultiplier(ctx.editionCodes, extractEditionCodes(itNorm));
	}

	if (isBadSku(ctx.sku) || isBadSku(itSku)) s *= 1.2;

	return s;
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

	const pinnedSku = String(pinned.sku || "");
	const otherSku = otherPinnedSku ? String(otherPinnedSku) : "";
	const base = String(pinned.name || "");

	// Single source of truth for per-pair scoring; used in the cheap loop below.
	const ctx = prepScorePairCtx(pinned, { vocab, sizePenaltyFn, pricePenaltyFn });
	const pinNorm = ctx.norm;
	const pinRawToks = ctx.rawToks;
	const pinToks = ctx.toks;
	const pinBrand = ctx.brand;
	const pinAge = ctx.age;
	const pinTopTerm = ctx.topTerm;
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

		if (vocab) {
			// Single-source-of-truth scoring (also used by tools/linker_eval.mjs).
			const s0 = scorePairWithVocab(ctx, it);
			if (s0 > 0) pushTopK(cheap, { it, s: s0 }, MAX_CHEAP_KEEP);
			continue;
		}

		// ---- Legacy (vocab-off) path: kept for back-compat / fallback ----
		const itNorm = normSearchText(it.name || "");
		if (!itNorm) continue;
		const itRawToks = tokenizeQuery(itNorm);
		const itToks = filterSimTokens(itRawToks);
		if (!itToks.length) continue;

		const itBrand = itToks[0] || "";
		const firstMatch = pinBrand && itBrand && pinBrand === itBrand;
		const contain = tokenContainmentScore(pinRawToks, itRawToks);

		let s0 = fastSimilarityScore(pinRawToks, itRawToks, pinNorm, itNorm);
		if (s0 <= 0) s0 = 0.01 + 0.25 * contain;
		if (!firstMatch) {
			const smallN = Math.min(pinToks.length || 0, itToks.length || 0);
			let mult = 0.1 + 0.95 * contain;
			if (smallN <= 3 && contain < 0.78) mult *= 0.22;
			s0 *= Math.min(1.0, mult);
		}
		if (typeof sizePenaltyFn === "function") s0 *= sizePenaltyFn(pinnedSku, itSku);
		if (typeof pricePenaltyFn === "function") s0 *= pricePenaltyFn(pinnedSku, itSku);
		const itAge = extractAgeFromText(itNorm);
		if (pinAge && itAge) {
			if (pinAge === itAge) s0 *= 1.6;
			else s0 *= 0.22;
		}
		if (isBadSku(pinnedSku) || isBadSku(itSku)) s0 *= 1.15;
		pushTopK(cheap, { it, s: s0, itNorm, itRawToks }, MAX_CHEAP_KEEP);
	}

	// Final trim/sort for cheap stage
	cheap.sort((a, b) => b.s - a.s);
	if (cheap.length > MAX_CHEAP_KEEP) cheap.length = MAX_CHEAP_KEEP;

	let fine;
	if (vocab) {
		// scorePairWithVocab is the final score; no rescoring needed.
		fine = cheap.slice(0, MAX_FINE).map((x) => ({ it: x.it, s: x.s }));
	} else {
		fine = [];
		for (const x of cheap.slice(0, MAX_FINE)) {
			const it = x.it;
			const itSku = String(it.sku || "");
			const itNorm = x.itNorm || normSearchText(it.name || "");
			const itRawToks = x.itRawToks || tokenizeQuery(itNorm);
			const itToks = filterSimTokens(itRawToks);
			const itBrand = itToks[0] || "";
			const firstMatch = pinBrand && itBrand && pinBrand === itBrand;
			const contain = tokenContainmentScore(pinRawToks, itRawToks);

			let s = similarityScore(base, it.name || "");
			if (s <= 0) continue;
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
			if (isBadSku(pinnedSku) || isBadSku(itSku)) s *= 1.2;
			fine.push({ it, s });
		}
	}

	const withScores = !!(opts && opts.withScores);
	fine.sort((a, b) => b.s - a.s);
	if (fine.length) {
		const top = fine.slice(0, limit);
		return withScores ? top.map((x) => ({ it: x.it, score: x.s })) : top.map((x) => x.it);
	}

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
	const fb = fallback.slice(0, limit);
	return withScores ? fb.map((x) => ({ it: x.it, score: x.s })) : fb.map((x) => x.it);
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
	const vocab = opts && opts.vocab ? opts.vocab : null;
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

		// Per-seed scoring context (shared with eval — single source of truth).
		const aCtx = vocab ? prepScorePairCtx(a, { vocab, sizePenaltyFn, pricePenaltyFn }) : null;

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

			let s;
			if (vocab) {
				s = scorePairWithVocab(aCtx, b);
				if (s > 0) cheap.push({ b, s });
				continue;
			}

			// Legacy (vocab-off) path
			const bNorm = itemNorm.get(bSku) || normSearchText(b.name || "");
			const bRaw = itemRawToks.get(bSku) || tokenizeQuery(bNorm);
			const bFilt = itemFilt.get(bSku) || filterSimTokens(bRaw);
			if (!bFilt.length) continue;
			const contain = tokenContainmentScore(aRaw, bRaw);
			const bBrand = bFilt[0] || "";
			const firstMatch = aBrand && bBrand && aBrand === bBrand;

			s = fastSimilarityScore(aRaw, bRaw, aNorm, bNorm);
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
		let fine;
		if (vocab) {
			// scorePairWithVocab is already the final score.
			fine = cheap.slice(0, CHEAP_TOP).map((x) => ({ b: x.b, s: x.s }));
		} else {
			fine = [];
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

	// Strongest suggestions first so the user works strong → weak. SMWS pairs
	// carry score ~1e9 so they stay pinned at the head naturally.
	out.sort((x, y) => (y.score || 0) - (x.score || 0));
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
