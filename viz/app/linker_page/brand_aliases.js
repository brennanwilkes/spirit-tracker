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

// ---- Auto-discovered aliases (live, link-supervised) --------------------------
// Mined from the CONFIRMED canonical groups: if one member writes an abbreviation
// and a linked member writes a phrase whose initials match, they're the same brand
// (the link is the supervision). Registered as dynamic synths so both forms share a
// distinctive token — exactly like the curated list above, but self-populating.
// 2-letter abbrevs are excluded (ambiguous: "cc" = Canadian Club AND Connoisseur's
// Choice); a tiny stoplist removes units/age fillers that spuriously match initials.
const STOP_ABBREV = new Set(["yo", "yr", "yrs", "abv", "esb", "ipa"]);
const PHRASE_STOP = new Set(["the", "of", "and", "y", "a", "de", "la", "el", "with"]);
let LEARNED_COMPILED = [];

// The abbrev must equal the initials of a CONSECUTIVE run of words (stopwords
// skippable). Returns the matched run (the expansion phrase) or null.
function consecutiveRun(ab, words) {
	for (let start = 0; start < words.length; start++) {
		let i = 0;
		const run = [];
		for (let j = start; j < words.length && i < ab.length; j++) {
			const w = words[j];
			run.push(w);
			if (PHRASE_STOP.has(w)) continue;
			if (w[0] !== ab[i]) {
				run.length = 0;
				break;
			}
			i++;
		}
		if (i === ab.length && run.length) return run.join(" ");
	}
	return null;
}

// nameGroups: array of arrays of raw names (one inner array per confirmed group).
// normFn: the catalog's normSearchText. Returns the learned alias list (also stored
// for detectBrandAliasSynths). Idempotent — call once after the link map is loaded.
//
// ⚠ DORMANT — not wired live yet. Measured net-NEGATIVE (AUC+ 0.8196→0.8107):
// it discovers mostly GENERIC-PHRASE abbreviations (bib=bottled-in-bond,
// lny=lunar-new-year) that are shared across many brands, so collapsing them into
// one synth over-links a whole category. The good brand abbrevs (tbwc/scn/omc) are
// already curated above, so net yield of NEW safe aliases is low. Before enabling,
// add a brand-rarity gate: only keep a learned alias whose expansion phrase is
// DISTINCTIVE catalog-wide (low df) — i.e., a brand, not a style/occasion.
export function learnAliasesFromGroups(nameGroups, normFn) {
	const norm = typeof normFn === "function" ? normFn : (s) => String(s || "").toLowerCase();
	const staticPats = new Set(BRAND_ALIASES.flatMap((a) => a.patterns));
	const byAbbrev = new Map(); // abbrev -> shortest matched phrase
	for (const names of nameGroups || []) {
		if (!names || names.length < 2) continue;
		const toks = names.map((n) => norm(n).split(" ").filter(Boolean));
		for (let a = 0; a < toks.length; a++) {
			for (const t of toks[a]) {
				if (!/^[a-z]{3,5}$/.test(t) || STOP_ABBREV.has(t) || staticPats.has(t)) continue;
				for (let b = 0; b < toks.length; b++) {
					if (b === a || toks[b].includes(t)) continue;
					const content = toks[b].filter((w) => w.length >= 2 && !PHRASE_STOP.has(w));
					if (content.length <= t.length) continue;
					const run = consecutiveRun(t, toks[b]);
					if (run && run.split(" ").filter((w) => !PHRASE_STOP.has(w)).length >= 2) {
						const cur = byAbbrev.get(t);
						if (!cur || run.length < cur.length) byAbbrev.set(t, run);
					}
				}
			}
		}
	}
	const learned = [];
	for (const [ab, phrase] of byAbbrev) learned.push({ synth: "__bnd_dyn_" + ab, patterns: [ab, phrase] });
	LEARNED_COMPILED = learned.map((a) => ({
		synth: a.synth,
		re: new RegExp(
			"(?:^|[^a-z0-9])(?:" + a.patterns.map(escapeRegex).join("|") + ")(?:[^a-z0-9]|$)",
			"i",
		),
	}));
	return learned;
}

// Detect every alias matching the normalized name and return the set of synth
// tokens to inject into the vocabulary entry (curated + auto-discovered).
export function detectBrandAliasSynths(normName) {
	const out = new Set();
	const s = String(normName || "");
	if (!s) return out;
	for (const { synth, re } of COMPILED) if (re.test(s)) out.add(synth);
	for (const { synth, re } of LEARNED_COMPILED) if (re.test(s)) out.add(synth);
	return out;
}
