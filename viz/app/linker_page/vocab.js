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
// Asymmetry: a target term the candidate is MISSING counts full weight (recall —
// e.g. Gold missing "gray"), but a candidate's EXTRA term counts only this much
// (precision — e.g. "...Island Distillery..." embellishment shouldn't tank the
// score when the distinctive terms are all shared).
export const EXTRA_TERM_WEIGHT = 0.4;
// A missing/extra bigram whose both component words are present anyway is mostly
// redundant with those unigrams (words present but non-adjacent) — count it low.
export const BIGRAM_REDUNDANT_WEIGHT = 0.2;

function bigramKey(a, b) {
	return a < b ? `b:${a}~${b}` : `b:${b}~${a}`;
}

// Filtered unigrams (with possessive repair) → the ordered unigram list.
// Short numbers (1–2 digit, e.g. "46 ABV", "8" for 8yo) and decimals ("46.8")
// are dropped — they're almost always ABV/age/proof noise that pulls in
// unrelated bottles sharing a percentage (Maker's Mark 46, Two Brewers 46…);
// ages are scored by the dedicated age path instead. Longer numbers (3+ digits)
// are KEPT because they are meaningful edition/year identifiers ("1884" vs
// "1856", "1952", "100 Proof") that distinguish otherwise-identical names.
function unigramsForName(name) {
	const filt = filterSimTokens(tokenizeQuery(normSearchText(name)));
	const out = [];
	for (const t of filt) {
		if (t === "s" && out.length) {
			// possessive: "macaloney" + "s" -> "macaloneys"
			out[out.length - 1] = out[out.length - 1] + "s";
			continue;
		}
		if (/^\d{1,2}$/.test(t) || /^\d+\.\d+$/.test(t)) continue;
		// Glued age tokens ("10yr", "18yo", "12year") are handled by the dedicated
		// age path (extractAgeFromText), not as lexical terms — otherwise "10yr"
		// wouldn't match "10 year" and would just add noise.
		if (/^\d{1,2}(?:yr|yrs|yo|year|years|y)$/.test(t)) continue;
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

	// Directional IDF-weighted overlap. `aName` is the item being matched FROM
	// (the target). Terms it shares with the candidate are the numerator; terms
	// the target HAS but the candidate lacks count full weight (recall), while the
	// candidate's EXTRA terms count only EXTRA_TERM_WEIGHT (precision) — so
	// embellishments like "Island Distillery" don't crush a true match, but a
	// missing distinctive term (Gold lacking "gray") still does. Also returns the
	// shared terms sorted by distinctiveness for UI display.
	function weightedOverlap(aName, bName) {
		const A = entryForName(aName).set;
		const B = entryForName(bName).set;
		if (!A.size || !B.size) return { score: 0, shared: [] };

		// A missing bigram whose BOTH component words are present in the other set
		// is a spurious miss — the words exist, just not adjacent ("Macaloneys …
		// An Loy" vs "Macaloneys An Loy"). Discount it. This does NOT weaken a real
		// collocation: "Highland Park" vs "Mr Park" lacks "highland", so its
		// highland~park bigram is not redundant and keeps full weight; and a shared
		// "highland park" is unordered so reordering still matches.
		const redundant = (term, otherSet) => {
			if (!term.startsWith("b:")) return false;
			const parts = term.slice(2).split("~");
			return parts.length === 2 && otherSet.has(parts[0]) && otherSet.has(parts[1]);
		};

		let interW = 0;
		let aOnlyW = 0; // target terms missing from candidate
		const shared = [];
		for (const t of A) {
			const w = idf(t);
			if (B.has(t)) {
				interW += w;
				shared.push({ term: t, idf: w });
			} else {
				aOnlyW += redundant(t, B) ? BIGRAM_REDUNDANT_WEIGHT * w : w;
			}
		}
		if (!shared.length) return { score: 0, shared: [] };

		let bOnlyW = 0; // candidate's extra terms (discounted)
		for (const t of B) {
			if (A.has(t)) continue;
			const w = redundant(t, A) ? BIGRAM_REDUNDANT_WEIGHT * idf(t) : idf(t);
			bOnlyW += w;
		}

		const denom = interW + aOnlyW + EXTRA_TERM_WEIGHT * bOnlyW;
		shared.sort((x, y) => y.idf - x.idf);
		return { score: denom > 0 ? interW / denom : 0, shared };
	}

	return { N: Nsafe, idf, isDistinctive, termsForName, topTerm, weightedOverlap };
}
