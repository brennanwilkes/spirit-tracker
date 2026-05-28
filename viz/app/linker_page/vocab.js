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
import { detectBrandAliasSynths } from "./brand_aliases.js";

export const DISTINCTIVE_IDF = 5.5;
export const WO_POW = 3.0;
export const TOP_TERM_BONUS = 0.6;
export const BASE_FLOOR = 0.05;
// Asymmetry: a target term the candidate is MISSING counts full weight (recall —
// e.g. Gold missing "gray"), but a candidate's EXTRA term counts only this much
// (precision — e.g. "...Island Distillery..." embellishment shouldn't tank the
// score when the distinctive terms are all shared).
export const EXTRA_TERM_WEIGHT = 0.4;
// Coverage of the target's *distinctive* unigrams: M / K. If the candidate
// misses some, score is multiplied by max(FLOOR, coverage^EXP). FLOOR keeps the
// candidate alive (we still want it on the list for the user to inspect) but
// well below items that DO share the distinguishing terms. This is what
// separates "same brand, wrong edition" from a true match (Compass Box Stranger
// lacks `magic`; Bridgeland Innisfail Pot Still lacks `sherry`).
export const COVERAGE_PENALTY_FLOOR = 0.2;
export const COVERAGE_PENALTY_EXP = 1.5;
export const COVERAGE_PENALTY_FLOOR_CAND = COVERAGE_PENALTY_FLOOR;
export const COVERAGE_PENALTY_EXP_CAND = COVERAGE_PENALTY_EXP;

// Broadness threshold for the "brand-descriptor" detector. A candidate-side
// distinctive term that co-occurs (across the catalog) with at least this many
// other distinctive terms — AND with one of the shared distinctive terms in the
// target — is treated as brand boilerplate and EXCLUDED from the candidate-side
// coverage check. Captures words like `island`/`distillery` for Macaloney (which
// appear across Kildara, Killeigh, An Loy, …) while still penalizing edition
// markers like `amethyst` (only with Detour) or `magic` (only with Compass Box).
export const BRAND_DESCRIPTOR_BROADNESS_MIN = 5;

// Secondary "graded" coverage applied only when the binary distinctive check
// passed (all target distinctive terms shared). Catches the case where the
// target has a moderate-idf term (e.g. `sherry`, below DISTINCTIVE_IDF) that
// the candidate lacks — Bridgeland Innisfail Sherry vs Pot Still. Gentler than
// the primary distinctive penalty.
export const GRADED_COVERAGE_FLOOR = 0.4;
export const GRADED_COVERAGE_EXP = 1.5;
// A missing/extra bigram whose both component words are present anyway is mostly
// redundant with those unigrams (words present but non-adjacent) — count it low.
export const BIGRAM_REDUNDANT_WEIGHT = 0.2;

function bigramKey(a, b) {
	return a < b ? `b:${a}~${b}` : `b:${b}~${a}`;
}

// Insert spaces at letter↔digit transitions so glued tokens like "blairathol11yo"
// or "GLENALLACHIE8YOSCOTTISHOAK" tokenize sanely. Done at the normName level
// before tokenizeQuery so the rest of the pipeline is unchanged.
function expandGluedNumerics(normName) {
	return String(normName || "")
		.replace(/([a-z])(\d)/g, "$1 $2")
		.replace(/(\d)([a-z])/g, "$1 $2");
}

// Segment a glued letter-only token into ≥2 pieces that all live in `dict`.
// Uses a shortest-first DP so that a token which is itself in the dict
// (e.g. "tincup" with df=2) still gets split into "tin" + "cup". Returns the
// shortest valid segmentation, or null if none exists. Also tries stripping a
// leading stop-suffix ("yo", "yr") which can appear glued after a digit was
// peeled off (e.g. "yoscottishoak" → drop "yo" → "scottishoak" → ["scottish","oak"]).
function compoundSplit(token, dict, minPiece) {
	if (!/^[a-z]+$/.test(token)) return null;
	function trySplit(s) {
		if (!s) return [];
		const maxLen = Math.min(s.length, 20);
		// shortest-first so we don't greedily eat the whole token as one piece
		for (let len = minPiece; len <= maxLen; len++) {
			if (len === s.length && len < minPiece) continue;
			const piece = s.slice(0, len);
			if (!dict.has(piece)) continue;
			if (len === s.length) return [piece];
			const rest = trySplit(s.slice(len));
			if (rest && rest.length >= 1) return [piece, ...rest];
		}
		return null;
	}
	const direct = trySplit(token);
	if (direct && direct.length >= 2) return direct;
	for (const prefix of ["yo", "yr", "yrs"]) {
		if (token.length > prefix.length && token.startsWith(prefix)) {
			const rest = trySplit(token.slice(prefix.length));
			if (rest && rest.length >= 1) return rest;
		}
	}
	return null;
}

// Filtered unigrams (with possessive repair) → the ordered unigram list.
// Short numbers (1–2 digit, e.g. "46 ABV", "8" for 8yo) and decimals ("46.8")
// are dropped — they're almost always ABV/age/proof noise that pulls in
// unrelated bottles sharing a percentage (Maker's Mark 46, Two Brewers 46…);
// ages are scored by the dedicated age path instead. Longer numbers (3+ digits)
// are KEPT because they are meaningful edition/year identifiers ("1884" vs
// "1856", "1952", "100 Proof") that distinguish otherwise-identical names.
//
// Brand aliases (TBWC/Single Cask Nation/OMC/G&M/…) inject synthetic high-IDF
// tokens so that abbreviation and expanded forms share a distinctive term.
// `compoundDict` is filled by buildVocab after the initial token pass.
// `compoundBigrams` is the set of adjacent ordered token-pairs (space-joined)
// observed in the catalog. We only accept a split if its pieces correspond to
// a bigram that EXISTS naturally somewhere — keeps `GlenGrant`/`TINCUP` split
// while leaving unitary brand names like `Bridgeland` alone.
let compoundDict = null;
let compoundBigrams = null;
const COMPOUND_MIN_LEN = 6;
const COMPOUND_PIECE_MIN = 3;

function unigramsForName(name) {
	const norm = normSearchText(name);
	const synths = detectBrandAliasSynths(norm);
	const expanded = expandGluedNumerics(norm);
	const filt = filterSimTokens(tokenizeQuery(expanded));
	const out = [];
	for (const s of synths) out.push(s);
	for (const t of filt) {
		if (t === "s" && out.length) {
			out[out.length - 1] = out[out.length - 1] + "s";
			continue;
		}
		if (/^\d{1,2}$/.test(t) || /^\d+\.\d+$/.test(t)) continue;
		if (/^\d{1,2}(?:yr|yrs|yo|year|years|y)$/.test(t)) continue;
		// Try compound split for glued letter-only tokens. Accept the split only
		// if the resulting adjacent bigrams actually appear in the catalog (so
		// `GlenGrant`/`TINCUP` split but `Bridgeland` stays put — "Bridge Land"
		// is never written that way). When a split is accepted, drop the glued
		// original from the term set (its content is now in the pieces; keeping
		// it would inflate the target's distinctive-term count and over-penalize
		// shorter candidate spellings).
		if (compoundDict && t.length >= COMPOUND_MIN_LEN && /^[a-z]+$/.test(t)) {
			const split = compoundSplit(t, compoundDict, COMPOUND_PIECE_MIN);
			if (split && bigramsCovered(split, compoundBigrams)) {
				for (const p of split) out.push(p);
				continue;
			}
		}
		out.push(t);
	}
	return out;
}

function bigramsCovered(pieces, bigrams) {
	if (!bigrams || pieces.length < 2) return false;
	for (let i = 0; i + 1 < pieces.length; i++) {
		if (!bigrams.has(pieces[i] + " " + pieces[i + 1])) return false;
	}
	return true;
}

// All terms (unigrams + unordered bigrams) for a name as a Set.
function buildTermSet(uni) {
	const set = new Set(uni);
	for (let i = 0; i + 1 < uni.length; i++) set.add(bigramKey(uni[i], uni[i + 1]));
	return set;
}

export function buildVocab(allAgg) {
	const items = Array.isArray(allAgg) ? allAgg : [];

	// Pass A: collect raw token frequencies AND adjacent-bigram frequencies (no
	// compound splitting yet). The dictionary tells us valid pieces; the bigram
	// set tells us a compound split is LEGITIMATE (the pieces actually appear
	// spaced together in the catalog: "Glen Grant" exists → GlenGrant splits;
	// "Bridge Land" doesn't → bridgeland stays put).
	compoundDict = null;
	compoundBigrams = null;
	const rawCount = new Map();
	const rawBigrams = new Set();
	for (const it of items) {
		if (!it || !it.name) continue;
		const uni = unigramsForName(it.name);
		for (const t of new Set(uni)) rawCount.set(t, (rawCount.get(t) || 0) + 1);
		// adjacent-pair (ordered) bigrams from the raw tokens
		for (let i = 0; i + 1 < uni.length; i++) {
			const a = uni[i];
			const b = uni[i + 1];
			if (/^[a-z]+$/.test(a) && /^[a-z]+$/.test(b)) rawBigrams.add(a + " " + b);
		}
	}
	const dict = new Set();
	for (const [t, c] of rawCount) {
		if (c >= 2 && t.length >= COMPOUND_PIECE_MIN && /^[a-z]+$/.test(t)) dict.add(t);
	}
	compoundDict = dict;
	compoundBigrams = rawBigrams;

	// Pass B: the real df with compound splitting now active.
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

	// Second pass: for each item, record co-occurrence among its DISTINCTIVE
	// unigrams. coocSet(t) returns the set of distinctive unigrams that ever
	// appear in the same listing as t — i.e. how broadly t is associated. A
	// candidate-side term that is broadly associated with many distinctive terms
	// (and with one in the target) is brand boilerplate (e.g. `island`/`distillery`
	// across all Macaloney listings) rather than an edition marker.
	const coocMap = new Map();
	for (const it of items) {
		if (!it || !it.name) continue;
		const uni = unigramsForName(it.name);
		const seen = new Set();
		const distinct = [];
		for (const t of uni) {
			if (seen.has(t)) continue;
			seen.add(t);
			if (Math.log((Nsafe + 1) / ((df.get(t) || 0) + 1)) >= DISTINCTIVE_IDF) distinct.push(t);
		}
		for (let i = 0; i < distinct.length; i++) {
			let s = coocMap.get(distinct[i]);
			if (!s) coocMap.set(distinct[i], (s = new Set()));
			for (let j = 0; j < distinct.length; j++) if (i !== j) s.add(distinct[j]);
		}
	}
	function coocSet(term) {
		return coocMap.get(term) || null;
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

	function distinctiveUnigramsForName(name) {
		const out = new Set();
		const seen = new Set();
		for (const t of entryForName(name).uni) {
			if (seen.has(t)) continue;
			seen.add(t);
			if (idf(t) >= DISTINCTIVE_IDF) out.add(t);
		}
		return out;
	}

	function allUnigramsForName(name) {
		return new Set(entryForName(name).uni);
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

	return {
		N: Nsafe,
		idf,
		isDistinctive,
		termsForName,
		distinctiveUnigramsForName,
		allUnigramsForName,
		coocSet,
		topTerm,
		weightedOverlap,
	};
}
