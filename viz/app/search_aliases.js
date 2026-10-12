// Search aliases: every way of writing one brand collapses to one synthetic token, on both
// sides of the match. Detection runs on the RAW text, because normSearchText turns "G&M"
// into "g m", which is indistinguishable from any other two letters.
//
// - spellings: full names of the brand. Index side tags the group; query side REPLACES the
//   spelling with the token, so "g&m macallan" searches ["gordonmacphail", "macallan"].
// - queryOnly: abbreviations too ambiguous to tag a listing with, but clear as a query.
// - markers: index-only evidence (brand-exclusive range names, url slugs, abbreviations next
//   to a brand word). Never applied to a query: "speymalt" must stay a plain search.
//
// Scope and rulings: docs/gm-search-aliasing.md. A bottler alias covers products carrying its
// brand, never the distillery it owns (no Benromach rule). Bare "gordon" stays plain search.
const SEARCH_ALIASES = [
	{
		token: "gordonmacphail",
		spellings: [
			/\bgordon(?:[\s/+_-]|&|\band\b)*mac[\s-]?phail/i,
			/\bg\s*(?:&amp;|&|\+|\/)\s*m\b/i,
			/\bg\s+and\s+m\b/i,
		],
		queryOnly: [/\bgm\b/i],
		markers: [
			/\bg-m\b/i,
			/\bgm\s+(?:macphails?|cc)\b/i,
			/\bgordan\b/i,
			/\bconnoisseurs?\s*choice\b/i,
			/\bspeymalt\b/i,
			/\bmr\.?\s*george\b/i,
			/\bdistillery\s+labels?\b/i,
			/\bgenerations\b/i,
		],
	},
];

const QUERY_RULES = SEARCH_ALIASES.map((a) => ({
	token: a.token,
	res: [...a.spellings, ...a.queryOnly].map((re) => new RegExp(re.source, "gi")),
}));

export function searchAliasTokens(raw) {
	const s = String(raw ?? "");
	const out = [];
	for (const a of SEARCH_ALIASES) {
		if (a.spellings.some((re) => re.test(s)) || a.markers.some((re) => re.test(s))) out.push(a.token);
	}
	return out;
}

export function applyQueryAliases(raw) {
	let s = String(raw ?? "");
	for (const { token, res } of QUERY_RULES) {
		for (const re of res) s = s.replace(re, ` ${token} `);
	}
	return s;
}
