// viz/app/linker_page/concepts.js
//
// Mutually-exclusive "concept" detection for SKU matching. Some spirit
// attributes are categorical: a product is a gin OR a rum, never both; a whisky
// is a single malt OR a bourbon OR a rye, never two at once; a release is a
// single barrel OR a small batch. When two listings would otherwise look alike
// (same brand words) but each asserts a DIFFERENT member of one of these
// mutually-exclusive groups, they are almost certainly different products.
//
// This is the structured counterpart to the IDF/coverage name scoring in
// suggestions.js: those treat words as interchangeable bag-of-tokens evidence,
// but "gin" vs "whiskey" is not a missing-token nuance — it is a hard category
// wall. We encode each group as a detector that returns the set of members a
// name asserts, then demote a pair when the two sides assert disjoint members.
//
// IMPORTANT — only conflicts that survive against the LABELS are hard:
//   - category (gin/rum/whisky/vodka/…)  : 0 confirmed-link breaks  → hard
//   - single barrel ↔ small batch        : 0 confirmed-link breaks  → hard
//   - whisky substyle (malt/bourbon/rye/ : reliable distillation types only —
//     grain/pot still/corn)                "blend"/"blended malt" excluded, the
//                                          catalog labels them interchangeably
// Presence/absence "markers" (cask strength, sherry) are NOT categorical — a
// store routinely drops the qualifier for the SAME product (Aberlour A'Bunadh
// is cask strength whether or not the listing says so), so they break 20–30
// confirmed links. They are exposed here only as gentle, tunable nudges.

// ---- tuning knobs (see tools/linker_eval.mjs / linker_outliers.mjs) ----
export const CATEGORY_CONFLICT = 0.1; // gin vs rum vs whisky … — hard wall
export const SUBSTYLE_CONFLICT = 0.25; // single malt vs bourbon vs rye — moderate
export const BATCHING_CONFLICT = 0.15; // single barrel vs small batch
export const NON_ALC_CONFLICT = 0.1; // 0.0% / alcohol-free vs the real spirit
// Presence/absence nudges — gentle on purpose (high false-negative risk).
export const CASK_STRENGTH_MARKER = 0.7;
export const SHERRY_MARKER = 0.75;

// Lowercase + pad with spaces so \b anchors fire at string edges. Detectors
// accept either a raw display name or a normalized string — they only rely on
// word boundaries, which punctuation supplies just as well as spaces, so a raw
// "Empress 1908 0.0% Indigo Gin" keeps its "0.0%" that normSearchText drops.
function lc(s) {
	return " " + String(s || "").toLowerCase() + " ";
}

// "bourbon"/"rum"/"cognac"/"rye" double as cask/finish words on a whisky that
// is NOT itself that spirit ("ex-bourbon cask", "rum finish"). Strip those
// contexts before reading the word as a category/substyle assertion.
function stripCaskContexts(n) {
	return n
		.replace(/\bex[-\s]?(bourbon|rum|sherry|wine|port|cognac|brandy|rye)\b/g, " ")
		.replace(
			/\b(first[-\s]?fill|refill|double|triple|virgin|second[-\s]?fill)\s+(bourbon|rum|sherry|wine|port|cognac|brandy|oak)\b/g,
			" ",
		)
		.replace(
			/\b(bourbon|rum|sherry|wine|port|cognac|brandy|oloroso|px|pedro\s*ximenez|madeira|marsala|sauternes|moscatel|rye)\s+(cask|casks|barrel|barrels|finish|finished|wood|matured|maturation|hogshead|butt|puncheon|quarter)\b/g,
			" ",
		);
}

// Top-level spirit category asserted by a name. Returns a Set; a name that
// asserts more than one (after cask-context stripping) is ambiguous and yields
// an empty set so it can never trigger a false conflict.
export function categorySet(norm) {
	const n = stripCaskContexts(lc(norm));
	const out = new Set();
	if (/\bgin\b/.test(n)) out.add("gin");
	if (/\brum\b/.test(n)) out.add("rum");
	if (/\bvodka\b/.test(n)) out.add("vodka");
	if (/\btequila\b/.test(n)) out.add("tequila");
	if (/\bmezcal\b/.test(n)) out.add("mezcal");
	if (/\b(brandy|cognac|armagnac|calvados)\b/.test(n)) out.add("brandy");
	if (/\b(whisky|whiskey|bourbon|scotch|rye|malt)\b/.test(n)) out.add("whisky");
	if (out.size > 1) return new Set(); // ambiguous → assert nothing
	return out;
}

// Whisky sub-style — the RELIABLE, mutually-exclusive distillation types only.
// "blend" / "blended malt" are deliberately NOT members: the catalog uses those
// labels interchangeably and wrongly (a store will call the same bottling
// "Blended Malt" and "Blended Scotch Whisky", or even "Single Malt"), so they
// cannot separate products without false demotes — unlike malt↔rye↔bourbon,
// which stores label consistently.
export function substyleSet(norm) {
	const n = stripCaskContexts(lc(norm));
	const out = new Set();
	if (/\bsingle\s+malt\b/.test(n)) out.add("singlemalt");
	if (/\bsingle\s+grain\b|\bgrain\s+(whisky|whiskey|scotch)\b/.test(n)) out.add("grain");
	if (/\bpot\s+still\b/.test(n)) out.add("potstill");
	if (/\bbourbon\b/.test(n)) out.add("bourbon");
	if (/\brye\b/.test(n)) out.add("rye");
	if (/\bcorn\s+(whisky|whiskey)\b/.test(n)) out.add("corn");
	return out;
}

// Single barrel / single cask vs small batch — a release-format wall.
export function batchingSet(norm) {
	const n = lc(norm);
	const out = new Set();
	if (/\b(single\s+barrel|single\s+cask|single\s+grain\s+cask)\b/.test(n)) out.add("single");
	if (/\bsmall\s+batch\b/.test(n)) out.add("smallbatch");
	return out;
}

export function hasCaskStrength(norm) {
	return /\b(cask\s+strength|batch\s+strength|barrel\s+proof|cask\s+proof|barrel\s+strength)\b/.test(
		lc(norm),
	);
}

export function hasSherry(norm) {
	// match the literal sherry words; cask-context stripping isn't needed here —
	// "ex-sherry cask" still signals a sherry-influenced bottling for this nudge.
	return /\b(sherry|oloroso|amontillado|manzanilla|fino|pedro\s*ximenez|\bpx\b)\b/.test(lc(norm));
}

// Alcohol-free / 0.0% expression. Requires the explicit "0.0%" (the trailing %
// rules out ABV figures like "50.00") or an alcohol-free phrase. Detected on the
// raw name because normSearchText strips the period and percent sign.
export function hasNonAlcoholic(name) {
	return /\b0\s*\.\s*0\s*%|\bnon[-\s]?alcoholic\b|\balcohol[-\s]?free\b|\bzero[-\s]?proof\b|\b0\s*\.\s*0\s*abv\b/.test(
		lc(name),
	);
}

// Disjoint-assertion conflict: both sides assert a nonempty member set for the
// group and they share none. Mirrors the user's rule — "same brand, but a
// distinguishing marker present on BOTH that doesn't match ⇒ not a pair."
function disjointConflict(aSet, bSet) {
	if (!aSet.size || !bSet.size) return false;
	for (const x of aSet) if (bSet.has(x)) return false;
	return true;
}

// Combined multiplier for a pair of RAW display names. Each group contributes
// independently (product), so the eval can attribute movement to one lever.
// Pass raw names (not normSearchText output) so "0.0%" survives for the
// non-alcoholic wall; the other detectors are punctuation-insensitive.
export function conceptConflictMultiplier(aName, bName) {
	let m = 1;

	const aCat = categorySet(aName);
	const bCat = categorySet(bName);
	const categoryConflict = disjointConflict(aCat, bCat);
	if (categoryConflict) m *= CATEGORY_CONFLICT;

	// Substyle only when category did NOT already wall them off, and only when
	// both are (or could be) whisky — otherwise "rye"/"bourbon" tokens are noise.
	if (!categoryConflict) {
		const aWhisky = aCat.has("whisky") || aCat.size === 0;
		const bWhisky = bCat.has("whisky") || bCat.size === 0;
		if (aWhisky && bWhisky) {
			if (disjointConflict(substyleSet(aName), substyleSet(bName))) m *= SUBSTYLE_CONFLICT;
		}
	}

	if (disjointConflict(batchingSet(aName), batchingSet(bName))) m *= BATCHING_CONFLICT;

	// A 0.0% expression vs the real spirit is never the same SKU.
	if (hasNonAlcoholic(aName) !== hasNonAlcoholic(bName)) m *= NON_ALC_CONFLICT;

	// Gentle presence/absence nudges (tunable; off by setting the const to 1).
	if (CASK_STRENGTH_MARKER !== 1) {
		if (hasCaskStrength(aName) !== hasCaskStrength(bName)) m *= CASK_STRENGTH_MARKER;
	}
	if (SHERRY_MARKER !== 1) {
		if (hasSherry(aName) !== hasSherry(bName)) m *= SHERRY_MARKER;
	}

	return m;
}
