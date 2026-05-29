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
export const FLAVOR_CONFLICT = 0.15; // a flavored variant (cream/spiced/fruit/…) ≠ the base

// Flavor / variant qualifiers. A spirit carrying one of these is a distinct
// product from the same line without it (Buffalo Trace Bourbon ↔ Bourbon Cream;
// Edinburgh Gin ↔ Edinburgh Gin Raspberry). Curated to words that, in the
// catalog, only ever appear as variant markers — validated against the labels to
// break ≤2 confirmed links each. Excludes "lemon" (SMWS tasting-note noise),
// "peated"/"smoked" (core styles, not variants). SMWS shared-cask matches are
// protected by a final floor in suggestions.js, so tasting-note names here are
// harmless.
const VARIANT_FLAVORS = [
	"cream", "spiced", "spice", "vanilla", "chocolate", "coffee", "espresso", "mocha",
	"caramel", "toffee", "honey", "ginger", "cinnamon", "coconut", "berry", "raspberry",
	"strawberry", "blueberry", "blackberry", "cranberry", "cherry", "apple", "peach",
	"mango", "orange", "lime", "citrus", "grapefruit", "pineapple", "passionfruit",
	"rhubarb", "elderflower", "sloe", "rose", "cucumber", "watermelon", "banana", "salted",
];
const FLAVOR_RE = VARIANT_FLAVORS.map((f) => [f, new RegExp("\\b" + f + "\\b")]);
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
	// "straight malt" (American single-malt mashbill, e.g. Woodford) joins the
	// malt member so it conflicts with bourbon/rye/wheat the same way.
	if (/\b(?:single|straight)\s+malt\b/.test(n)) out.add("singlemalt");
	if (/\bsingle\s+grain\b|\bgrain\s+(whisky|whiskey|scotch)\b/.test(n)) out.add("grain");
	if (/\bpot\s+still\b/.test(n)) out.add("potstill");
	if (/\bbourbon\b/.test(n)) out.add("bourbon");
	if (/\brye\b/.test(n)) out.add("rye");
	if (/\bcorn\s+(whisky|whiskey)\b/.test(n)) out.add("corn");
	// "wheat whiskey" is its own mashbill; NOT "wheated" (that's a bourbon).
	if (/\bwheat\s+whisk(?:e)?y\b/.test(n)) out.add("wheat");
	return out;
}

// Cask / wine-finish family — a bottling finished in Port vs Madeira vs PX is a
// different product. The sherry family (oloroso/PX/fino/…) is ONE bucket so
// "Sherry Cask" ↔ "Oloroso" don't conflict. "port" is guarded against distillery/
// expression names (Port Charlotte/Ellen/Mourant/Askaig). 0 confirmed-link breaks.
export function caskTypeSet(norm) {
	const n = lc(norm);
	const out = new Set();
	if (/\b(sherry|oloroso|pedro\s*ximenez|\bpx\b|fino|amontillado|manzanilla|palo\s+cortado)\b/.test(n))
		out.add("sherry");
	if (/\bport\b/.test(n) && !/\bport\s+(charlotte|ellen|mourant|askaig|dundas)\b/.test(n))
		out.add("port");
	if (/\bmadeira\b/.test(n)) out.add("madeira");
	if (/\bsauternes\b/.test(n)) out.add("sauternes");
	if (/\bmarsala\b/.test(n)) out.add("marsala");
	if (/\b(moscatel|muscat)\b/.test(n)) out.add("moscatel");
	if (/\brum\s+(cask|casks|finish|finished|barrel)\b/.test(n)) out.add("rum");
	if (/\bcognac\s+(cask|finish|finished)\b/.test(n)) out.add("cognac");
	if (/\b(burgundy|bordeaux|cabernet|tokaji|rioja|red\s+wine|wine\s+(cask|finish))\b/.test(n))
		out.add("wine");
	return out;
}

// Agave/rum maturation class — mutually exclusive (blanco ≠ reposado ≠ añejo …).
// Spanish terms are accent-folded upstream (años→anos, añejo→anejo). 0 label breaks.
export function maturationSet(norm) {
	const n = lc(norm);
	const out = new Set();
	if (/\bblanco\b|\bsilver\b/.test(n)) out.add("blanco");
	if (/\breposado\b/.test(n)) out.add("reposado");
	if (/\banejo\b/.test(n)) out.add("anejo");
	if (/\bjoven\b/.test(n)) out.add("joven");
	if (/\bcristalino\b/.test(n)) out.add("cristalino");
	return out;
}

// Gin style — London Dry ≠ Old Tom ≠ Plymouth (mutually exclusive). Gated on
// "gin". 0 confirmed-link breaks. ("Navy" omitted — it's a strength that coexists
// with a style, e.g. a London Dry can be Navy Strength.)
export function ginStyleSet(norm) {
	const n = lc(norm);
	if (!/\bgin\b/.test(n)) return new Set();
	const out = new Set();
	if (/\blondon\s+dry\b/.test(n)) out.add("londondry");
	if (/\bold\s+tom\b/.test(n)) out.add("oldtom");
	if (/\bplymouth\b/.test(n)) out.add("plymouth");
	return out;
}

// Rum colour tier — white/silver ≠ gold/amber ≠ dark/black. Gated on "rum" so
// "White Label"/"Gold Label" scotch can't trigger it. 2 confirmed-link breaks.
export function rumColorSet(norm) {
	const n = lc(norm);
	if (!/\brum\b/.test(n)) return new Set();
	const out = new Set();
	if (/\b(white|silver|light|crystal|blanc)\b/.test(n)) out.add("white");
	if (/\b(gold|golden|oro|amber)\b/.test(n)) out.add("gold");
	if (/\b(dark|black|negro)\b/.test(n)) out.add("dark");
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

// The set of flavor/variant qualifiers a name asserts.
export function flavorSet(name) {
	const n = lc(name);
	const out = new Set();
	for (const [f, re] of FLAVOR_RE) if (re.test(n)) out.add(f);
	return out;
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

	if (disjointConflict(maturationSet(aName), maturationSet(bName))) m *= SUBSTYLE_CONFLICT;

	if (disjointConflict(caskTypeSet(aName), caskTypeSet(bName))) m *= SUBSTYLE_CONFLICT;

	if (disjointConflict(rumColorSet(aName), rumColorSet(bName))) m *= SUBSTYLE_CONFLICT;

	if (disjointConflict(ginStyleSet(aName), ginStyleSet(bName))) m *= SUBSTYLE_CONFLICT;

	// A 0.0% expression vs the real spirit is never the same SKU.
	if (hasNonAlcoholic(aName) !== hasNonAlcoholic(bName)) m *= NON_ALC_CONFLICT;

	// A flavored variant ≠ the base (or a differently-flavored one): if the two
	// names assert different flavor-qualifier sets, demote.
	const af = flavorSet(aName);
	const bf = flavorSet(bName);
	if (af.size !== bf.size || [...af].some((f) => !bf.has(f))) m *= FLAVOR_CONFLICT;

	// Gentle presence/absence nudges (tunable; off by setting the const to 1).
	if (CASK_STRENGTH_MARKER !== 1) {
		if (hasCaskStrength(aName) !== hasCaskStrength(bName)) m *= CASK_STRENGTH_MARKER;
	}
	if (SHERRY_MARKER !== 1) {
		if (hasSherry(aName) !== hasSherry(bName)) m *= SHERRY_MARKER;
	}

	return m;
}
