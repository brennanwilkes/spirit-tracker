// viz/app/linker/similarity.js
import { tokenizeQuery, normSearchText } from "../sku.js";

// Ignore ultra-common / low-signal tokens in bottle names.
const SIM_STOP_TOKENS = new Set([
	"the",
	"a",
	"an",
	"and",
	"of",
	"to",
	"in",
	"for",
	"with",
	"year",
	"years",
	"yr",
	"yrs",
	"old",
	"whisky",
	"whiskey",
	"scotch",
	"single",
	"malt",
	"cask",
	"finish",
	"edition",
	"release",
	"batch",
	"strength",
	"abv",
	"proof",
	"anniversary",
]);

const SMWS_WORD_RE = /\bsmws\b/i;
const SMWS_CODE_RE = /\b(\d{1,3}\.\d{1,4})\b/;

export function smwsKeyFromName(name) {
	const s = String(name || "");
	if (!SMWS_WORD_RE.test(s)) return "";
	const m = s.match(SMWS_CODE_RE);
	return m ? m[1] : "";
}

const ORDINAL_RE = /^(\d+)(st|nd|rd|th)$/i;

export function numKey(t) {
	const s = String(t || "")
		.trim()
		.toLowerCase();
	if (!s) return "";
	if (/^\d+$/.test(s)) return s;
	const m = s.match(ORDINAL_RE);
	return m ? m[1] : "";
}

function isNumberToken(t) {
	return !!numKey(t);
}

export function extractAgeFromText(normName) {
	const s = String(normName || "");
	if (!s) return "";

	const m = s.match(/\b(?:aged\s*)?(\d{1,2})\s*(?:yr|yrs|year|years)\b/i);
	if (m && m[1]) return String(parseInt(m[1], 10));

	const m2 = s.match(/\b(\d{1,2})\s*yo\b/i);
	if (m2 && m2[1]) return String(parseInt(m2[1], 10));

	return "";
}

// Best-effort ABV (% alcohol) from a name. Handles "46.8 ABV", "46%",
// "43.5 % abv", and "92 proof" (→ 46). Returns a number or null. Deliberately
// soft: ABV is relevant but vaguely formatted, so callers should nudge, not gate.
export function extractAbv(normName) {
	const s = String(normName || "");
	let m = s.match(/(\d{2,3}(?:\.\d+)?)\s*proof\b/i);
	if (m) {
		const v = parseFloat(m[1]) / 2;
		if (v >= 20 && v <= 75) return v;
	}
	m = s.match(/(\d{2,3}(?:\.\d+)?)\s*(?:%|abv)/i);
	if (m) {
		const v = parseFloat(m[1]);
		if (v >= 20 && v <= 75) return v;
	}
	return null;
}

// Loose normalization that PRESERVES periods (and ' / & boundaries collapse to
// space) so decimal edition codes like Octomore "15.1" or SMWS "53.471" survive
// — the standard normSearchText strips the dot and would fuse them into noise.
export function normForEditionCodes(name) {
	return (
		" " +
		String(name || "")
			.toLowerCase()
			.replace(/[^a-z0-9.]+/g, " ")
			.replace(/\s+/g, " ")
			.trim() +
		" "
	);
}

// Extract identifying "edition codes" from a name. These are short, structured
// tokens that uniquely identify a specific bottling and should be treated as
// hard if/else discriminators: two items both carrying a code OF THE SAME KIND
// but with DIFFERENT values are almost certainly different products (different
// cask, season-batch, SMWS code, release/series number). Returned codes are
// kind-prefixed so we only compare like with like. Pass the raw display name;
// this applies its own period-preserving normalization internally.
//
// Kinds covered:
//   - SMWS classic:  53.471, 1.234
//   - SMWS lettered:  R4, G1   (single-letter prefix + 1-3 digits)
//   - Roman numerals (length ≥ 2 to avoid ambiguous single letters): II, III, IV, V…
//   - Season/Winter batch codes: S22, S24, S2023, W21, W2024
//   - Numbered editions: Release 42, Series 3, Recipe 01, Chapter 8, No. 6, N.4
//   - Decimal version codes: Octomore 15.1 / 16.1 (guarded against ABV/proof)
export function extractEditionCodes(normName) {
	const s = normForEditionCodes(normName);
	const out = new Set();
	if (!s.trim()) return out;
	// SMWS classic decimal (53.471). Gated on the "smws" marker because a bare
	// "\d.\d" pattern otherwise swallows ABV values (59.1, 46.8) now that periods
	// survive normalization — and those would create bogus same-kind conflicts.
	if (/\bsmws\b/.test(s)) {
		const smws = s.match(/\b\d{1,3}\.\d{1,4}\b/g);
		if (smws) for (const m of smws) out.add("smws:" + m);
	}
	const lettered = s.match(/\b[a-z]\d{1,3}\b/gi);
	if (lettered)
		for (const m of lettered) {
			const v = m.toLowerCase();
			// Only treat as SMWS-lettered if NOT a season code (s/w prefix handled below)
			if (!/^[sw]\d{2,4}$/i.test(v)) out.add("smws:" + v);
		}
	// Roman numerals length ≥ 2 — skip bare "i"/"v"/"x"
	const roman = s.match(/\b(?:ix|iv|v?i{2,3}|x{2,3}|vi{1,3}|xi{1,3})\b/gi);
	if (roman) for (const m of roman) out.add("roman:" + m.toLowerCase());
	const season = s.match(/\b[sw]\d{2,4}\b/gi);
	if (season) for (const m of season) out.add("season:" + m.toLowerCase());

	// Numbered editions: "release 42", "series 3", "recipe 01", "chapter 8",
	// "no. 6", "n.4". Leading zeros normalized so "01" ≡ "1". Each keyword is its
	// own kind so a release number never conflicts with a series number.
	const numbered = [
		[/\brelease\s+(\d{1,3})\b/g, "release"],
		[/\bseries\s+(\d{1,3})\b/g, "series"],
		[/\brecipe\s+(\d{1,3})\b/g, "recipe"],
		[/\bchapter\s+(\d{1,3})\b/g, "chapter"],
		[/\bbatch\s+(?:no\.?\s*|number\s*|#\s*)?(\d{1,3})\b/g, "batch"],
		[/\bno\.?\s*(\d{1,3})\b/g, "no"],
		[/\bn\.\s*(\d{1,2})\b/g, "no"],
	];
	for (const [re, kind] of numbered) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(s))) out.add(kind + ":" + String(parseInt(m[1], 10)));
	}

	// Decimal version codes (Octomore 15.1, 8.3). Guard against ABV/proof: skip a
	// decimal that is immediately followed by % / "abv" / "proof", and skip values
	// in the typical ABV range (20–75). The 1–2 digit fraction keeps SMWS-style
	// 3+ digit fractions (already captured above) out of this bucket.
	const verRe = /\b(\d{1,2})\.(\d{1,2})\b(?!\s*(?:%|abv|proof|percent))/gi;
	let vm;
	while ((vm = verRe.exec(s))) {
		const val = parseFloat(vm[1] + "." + vm[2]);
		if (val >= 20 && val <= 75) continue; // looks like an ABV/proof, not a version
		out.add("ver:" + vm[1] + "." + parseInt(vm[2], 10));
	}
	return out;
}

// Compare two edition-code sets. If both carry codes OF THE SAME KIND and none
// of those codes are shared, return a strong demotion factor. If they share a
// code, return a mild boost. Otherwise neutral.
export function editionCodeMultiplier(a, b) {
	if (!a || !b || !a.size || !b.size) return 1;
	const byKind = (set) => {
		const m = new Map();
		for (const c of set) {
			const i = c.indexOf(":");
			if (i < 0) continue;
			const k = c.slice(0, i);
			if (!m.has(k)) m.set(k, new Set());
			m.get(k).add(c);
		}
		return m;
	};
	const aK = byKind(a);
	const bK = byKind(b);
	let sharedAny = false;
	let conflictAny = false;
	for (const [kind, aset] of aK) {
		const bset = bK.get(kind);
		if (!bset) continue;
		let shared = 0;
		for (const c of aset) if (bset.has(c)) shared++;
		if (shared > 0) sharedAny = true;
		else conflictAny = true;
	}
	if (sharedAny) return 1.15;
	if (conflictAny) return 0.1;
	return 1;
}

// Soft-but-firm ABV agreement multiplier. ABV is relevant but vaguely formatted,
// so a small gap (rounding: 46 vs 46.3) is neutral/positive, while a clear gap
// (different cask-strength batches: 58.1 vs 53.9) is a strong non-match signal.
// Returns 1 when either side has no parseable ABV.
export function abvMultiplier(a, b) {
	if (a == null || b == null) return 1;
	const d = Math.abs(a - b);
	if (d <= 0.6) return 1.15; // effectively the same → small confidence boost
	if (d <= 1.5) return 1.0; // rounding / minor formatting → neutral
	if (d <= 3) return 0.4; // likely different bottling
	return 0.12; // clearly different strength → heavy non-match
}

// Bare 1–2 digit numeric tokens (e.g. "16" in "Gray Label 16 Seagrass") that
// could be an age but lack an explicit yr/yo suffix. Used only to *accept* a
// match when the other side has an explicit age — never to penalize, since a
// bare number is just as likely a batch/edition number.
export function bareAgeCandidates(normName) {
	const out = new Set();
	const toks = filterSimTokens(tokenizeQuery(String(normName || "")));
	for (const t of toks) {
		if (/^\d{1,2}$/.test(t)) out.add(t);
	}
	return out;
}

export function filterSimTokens(tokens) {
	const out = [];
	const seen = new Set();

	const SIM_EQUIV = new Map([
		["years", "yr"],
		["year", "yr"],
		["yrs", "yr"],
		["yr", "yr"],
		["whiskey", "whisky"],
		["whisky", "whisky"],
		["bourbon", "bourbon"],
	]);

	const VOL_UNIT = new Set(["ml", "l", "cl", "oz", "liter", "liters", "litre", "litres"]);
	const VOL_INLINE_RE = /^\d+(?:\.\d+)?(?:ml|l|cl|oz)$/i; // 700ml, 1.14l
	const PCT_INLINE_RE = /^\d+(?:\.\d+)?%$/; // 46%, 40.0%

	const arr = Array.isArray(tokens) ? tokens : [];

	for (let i = 0; i < arr.length; i++) {
		const raw = arr[i];
		let t = String(raw || "")
			.trim()
			.toLowerCase();
		if (!t) continue;

		if (!/[a-z0-9]/i.test(t)) continue;

		if (VOL_INLINE_RE.test(t)) continue;
		if (PCT_INLINE_RE.test(t)) continue;

		t = SIM_EQUIV.get(t) || t;

		const nk = numKey(t);
		if (nk) t = nk;

		if (VOL_UNIT.has(t) || t === "abv" || t === "proof") continue;

		if (/^\d+(?:\.\d+)?$/.test(t)) {
			const next = String(arr[i + 1] || "")
				.trim()
				.toLowerCase();
			const nextNorm = SIM_EQUIV.get(next) || next;
			if (VOL_UNIT.has(nextNorm)) {
				i++;
				continue;
			}
		}

		if (!isNumberToken(t) && SIM_STOP_TOKENS.has(t)) continue;

		if (seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}

	return out;
}

export function numberMismatchPenalty(aTokens, bTokens) {
	const aNums = new Set((aTokens || []).map(numKey).filter(Boolean));
	const bNums = new Set((bTokens || []).map(numKey).filter(Boolean));
	if (!aNums.size || !bNums.size) return 1.0;
	for (const n of aNums) if (bNums.has(n)) return 1.0;
	return 0.28;
}

export function levenshtein(a, b) {
	a = String(a || "");
	b = String(b || "");
	const n = a.length,
		m = b.length;
	if (!n) return m;
	if (!m) return n;

	const dp = new Array(m + 1);
	for (let j = 0; j <= m; j++) dp[j] = j;

	for (let i = 1; i <= n; i++) {
		let prev = dp[0];
		dp[0] = i;
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= m; j++) {
			const tmp = dp[j];
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
			prev = tmp;
		}
	}
	return dp[m];
}

export function tokenContainmentScore(aTokens, bTokens) {
	const A = filterSimTokens(aTokens || []);
	const B = filterSimTokens(bTokens || []);
	if (!A.length || !B.length) return 0;

	const aSet = new Set(A);
	const bSet = new Set(B);

	const small = aSet.size <= bSet.size ? aSet : bSet;
	const big = aSet.size <= bSet.size ? bSet : aSet;

	let hit = 0;
	for (const t of small) if (big.has(t)) hit++;

	const recall = hit / Math.max(1, small.size);
	const precision = hit / Math.max(1, big.size);
	const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);

	return f1;
}

export function similarityScore(aName, bName) {
	const a = normSearchText(aName);
	const b = normSearchText(bName);
	if (!a || !b) return 0;

	const aAge = extractAgeFromText(a);
	const bAge = extractAgeFromText(b);
	const ageBoth = !!(aAge && bAge);
	const ageMatch = ageBoth && aAge === bAge;
	const ageMismatch = ageBoth && aAge !== bAge;

	const aToksRaw = tokenizeQuery(a);
	const bToksRaw = tokenizeQuery(b);

	const aToks = filterSimTokens(aToksRaw);
	const bToks = filterSimTokens(bToksRaw);
	if (!aToks.length || !bToks.length) return 0;

	const contain = tokenContainmentScore(aToksRaw, bToksRaw);

	const aFirst = aToks[0] || "";
	const bFirst = bToks[0] || "";
	const firstMatch = aFirst && bFirst && aFirst === bFirst ? 1 : 0;

	const A = new Set(aToks.slice(1));
	const B = new Set(bToks.slice(1));
	let inter = 0;
	for (const w of A) if (B.has(w)) inter++;
	const denom = Math.max(1, Math.max(A.size, B.size));
	const overlapTail = inter / denom;

	const d = levenshtein(a, b);
	const maxLen = Math.max(1, Math.max(a.length, b.length));
	const levSim = 1 - d / maxLen;

	let gate = firstMatch ? 1.0 : Math.min(0.8, 0.06 + 0.95 * contain);

	const smallN = Math.min(aToks.length, bToks.length);
	if (!firstMatch && smallN <= 3 && contain < 0.78) gate *= 0.18;

	const numGate = numberMismatchPenalty(aToks, bToks);

	let s =
		numGate *
		(firstMatch * 3.0 +
			overlapTail * 2.2 * gate +
			levSim * (firstMatch ? 1.0 : 0.1 + 0.7 * contain));

	if (ageMatch) s *= 2.2;
	else if (ageMismatch) s *= 0.18;

	s *= 1 + 0.9 * contain;

	return s;
}

export function fastSimilarityScore(aTokens, bTokens, aNormName, bNormName) {
	const aTokensRaw = aTokens || [];
	const bTokensRaw = bTokens || [];

	const aTokF = filterSimTokens(aTokensRaw);
	const bTokF = filterSimTokens(bTokensRaw);
	if (!aTokF.length || !bTokF.length) return 0;

	const a = String(aNormName || "");
	const b = String(bNormName || "");

	const aAge = extractAgeFromText(a);
	const bAge = extractAgeFromText(b);
	const ageBoth = !!(aAge && bAge);
	const ageMatch = ageBoth && aAge === bAge;
	const ageMismatch = ageBoth && aAge !== bAge;

	const contain = tokenContainmentScore(aTokensRaw, bTokensRaw);

	const aFirst = aTokF[0] || "";
	const bFirst = bTokF[0] || "";
	const firstMatch = aFirst && bFirst && aFirst === bFirst ? 1 : 0;

	const aTail = aTokF.slice(1);
	const bTail = bTokF.slice(1);

	let inter = 0;
	const bSet = new Set(bTail);
	for (const t of aTail) if (bSet.has(t)) inter++;

	const denom = Math.max(1, Math.max(aTail.length, bTail.length));
	const overlapTail = inter / denom;

	const pref =
		firstMatch && a.slice(0, 10) && b.slice(0, 10) && a.slice(0, 10) === b.slice(0, 10) ? 0.2 : 0;

	let gate = firstMatch ? 1.0 : Math.min(0.8, 0.06 + 0.95 * contain);
	const smallN = Math.min(aTokF.length, bTokF.length);
	if (!firstMatch && smallN <= 3 && contain < 0.78) gate *= 0.18;

	const numGate = numberMismatchPenalty(aTokF, bTokF);

	let s = numGate * (firstMatch * 2.4 + overlapTail * 2.0 * gate + pref);

	if (ageMatch) s *= 2.0;
	else if (ageMismatch) s *= 0.2;

	s *= 1 + 0.9 * contain;

	return s;
}
