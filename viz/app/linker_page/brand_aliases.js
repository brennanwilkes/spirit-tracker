// viz/app/linker_page/brand_aliases.js
//
// Curated brand-name / bottler aliases. Each entry maps a synthetic token to
// the set of normalized-text patterns that should yield it. Both the
// abbreviation ("tbwc") and the expanded form ("that boutique y whisky
// company") inject the SAME synth token, so listings using either form share a
// distinctive term in the vocabulary.
//
// The synth tokens are rare across the catalog (they're injected only when a
// pattern matches), which gives them naturally high IDF — they behave as
// strong "distinctive" terms in the matching algorithm without any special
// casing. The leading `__bnd_` prefix keeps them out of normal text and
// prevents collision with real words.
//
// Add aliases here as you discover false negatives (e.g. SCN/Single Cask
// Nation, BNS/Brave New Spirits, OMC/Old Malt Cask, G&M/Gordon & MacPhail).
// Each pattern is matched as a whole-word substring against the normalized
// (lowercased, punctuation-stripped) name.

export const BRAND_ALIASES = [
	{
		synth: "__bnd_tbwc",
		patterns: [
			"tbwc",
			"that boutique y whisky",
			"that boutique whisky company",
			"that boutiquey whisky",
		],
	},
	{
		synth: "__bnd_bns",
		patterns: ["bns", "brave new spirits"],
	},
	{
		synth: "__bnd_omc",
		patterns: ["omc", "old malt cask"],
	},
	{
		synth: "__bnd_gm",
		patterns: ["g m", "gordon macphail", "gordon mac phail", "gordon and macphail"],
	},
	{
		synth: "__bnd_bwe",
		patterns: ["bwe", "banff whisky experience"],
	},
	{
		synth: "__bnd_scn",
		patterns: ["scn", "single cask nation"],
	},
];

// Build a single combined regex per synth for efficient detection. Patterns are
// matched as whole-word substrings within the normalized name.
const COMPILED = BRAND_ALIASES.map((a) => ({
	synth: a.synth,
	re: new RegExp(
		"(?:^|[^a-z0-9])(?:" + a.patterns.map(escapeRegex).join("|") + ")(?:[^a-z0-9]|$)",
		"i",
	),
}));

function escapeRegex(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Detect every alias matching the normalized name and return the set of synth
// tokens to inject into the vocabulary entry.
export function detectBrandAliasSynths(normName) {
	const out = new Set();
	const s = String(normName || "");
	if (!s) return out;
	for (const { synth, re } of COMPILED) if (re.test(s)) out.add(synth);
	return out;
}
