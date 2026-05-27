// viz/app/linker_page/vocab.js
//
// Catalog-derived term vocabulary with IDF (inverse document frequency)
// weighting. Built once from the full aggregated catalog (itself the union of
// every DB file via index.json), so it self-updates as stores are added — no
// separate build artifact.
//
// The idea, in the user's words: build a vocabulary of distillery / expression
// terms; if two listings share a distinctive one ("lagavulin", "loy"), they're
// probably the same product. Formally that is IDF weighting — a term's
// match-strength is how distinctive it is across the whole catalog. Filler like
// "reserve" / "cask" appears everywhere → near-zero IDF; an expression name
// appears on a handful of listings → high IDF. Two listings sharing a high-IDF
// term, IN ANY POSITION, is strong evidence of a match.
//
// Terms are filtered unigrams plus UNORDERED adjacent bigrams (so "Seagrass 16"
// and "16 Seagrass" share a term, and multi-word distilleries like "buffalo
// trace" behave as one distinctive term). A possessive repair re-joins the lone
// "s" that normSearchText leaves behind for "Macaloney's" → "macaloney s".

import { tokenizeQuery, normSearchText } from "../sku.js";
import { filterSimTokens } from "./similarity.js";

export const DISTINCTIVE_IDF = 5.5;
export const WO_POW = 3.0;
export const TOP_TERM_BONUS = 0.6;
export const BASE_FLOOR = 0.05;

function bigramKey(a, b) {
	return a < b ? `b:${a}~${b}` : `b:${b}~${a}`;
}

// Filtered unigrams (with possessive repair) → the ordered unigram list.
function unigramsForName(name) {
	const filt = filterSimTokens(tokenizeQuery(normSearchText(name)));
	const out = [];
	for (const t of filt) {
		if (t === "s" && out.length) {
			// possessive: "macaloney" + "s" -> "macaloneys"
			out[out.length - 1] = out[out.length - 1] + "s";
			continue;
		}
		out.push(t);
	}
	return out;
}

// All terms (unigrams + unordered bigrams) for a name as a Set.
function buildTermSet(uni) {
	const set = new Set(uni);
	for (let i = 0; i + 1 < uni.length; i++) set.add(bigramKey(uni[i], uni[i + 1]));
	return set;
}

export function buildVocab(allAgg) {
	const items = Array.isArray(allAgg) ? allAgg : [];
	const df = new Map();
	let N = 0;

	for (const it of items) {
		if (!it || !it.name) continue;
		N++;
		const terms = buildTermSet(unigramsForName(it.name));
		for (const t of terms) df.set(t, (df.get(t) || 0) + 1);
	}

	const Nsafe = Math.max(1, N);
	function idf(term) {
		return Math.log((Nsafe + 1) / ((df.get(term) || 0) + 1));
	}

	function isDistinctive(term) {
		return idf(term) >= DISTINCTIVE_IDF;
	}

	// The pinned name is re-scored against thousands of candidates, so memoize.
	const termCache = new Map(); // name -> { uni: string[], set: Set }
	function entryForName(name) {
		const key = String(name || "");
		let v = termCache.get(key);
		if (v) return v;
		const uni = unigramsForName(key);
		v = { uni, set: buildTermSet(uni) };
		termCache.set(key, v);
		return v;
	}

	function termsForName(name) {
		return entryForName(name).set;
	}

	const topCache = new Map(); // name -> { term, idf } | null
	function topTerm(name) {
		const key = String(name || "");
		if (topCache.has(key)) return topCache.get(key);
		let best = null;
		for (const t of entryForName(key).uni) {
			const w = idf(t);
			if (!best || w > best.idf) best = { term: t, idf: w };
		}
		topCache.set(key, best);
		return best;
	}

	// IDF-weighted Jaccard over the union of uni+bigrams, plus shared terms sorted
	// by distinctiveness (most distinctive first) for UI display.
	function weightedOverlap(aName, bName) {
		const A = entryForName(aName).set;
		const B = entryForName(bName).set;
		if (!A.size || !B.size) return { score: 0, shared: [] };

		const small = A.size <= B.size ? A : B;
		const big = A.size <= B.size ? B : A;

		let interW = 0;
		const shared = [];
		for (const t of small) {
			if (big.has(t)) {
				const w = idf(t);
				interW += w;
				shared.push({ term: t, idf: w });
			}
		}
		if (!shared.length) return { score: 0, shared: [] };

		let unionW = 0;
		for (const t of A) unionW += idf(t);
		for (const t of B) if (!A.has(t)) unionW += idf(t);

		shared.sort((x, y) => y.idf - x.idf);
		return { score: unionW > 0 ? interW / unionW : 0, shared };
	}

	return { N: Nsafe, idf, isDistinctive, termsForName, topTerm, weightedOverlap };
}
