// viz/app/spirit_types.js
// Taxonomy: maps raw store category keys → top-level spirit types for filtering.

export const SPIRIT_TYPE_LIST = [
	{ id: "rum",    label: "Rum" },
	{ id: "whisky", label: "Whisky" },
	{ id: "gin",    label: "Gin" },
];

const CATEGORY_TO_TYPES = {
	// ── Rum ──────────────────────────────────────────────────────────────────
	"rum":                          ["rum"],
	"rum-cane-spirit":              ["rum"],
	"spirits-rum":                  ["rum"],

	// ── Whisky (all variants, including scotch/bourbon/canadian/etc.) ─────────
	"whisky":                       ["whisky"],
	"whisky-whiskey":               ["whisky"],
	"spirits-whiskey":              ["whisky"],
	"american-whiskey":             ["whisky"],
	"bourbon-whiskey":              ["whisky"],
	"canadian-whisky":              ["whisky"],
	"world-whisky":                 ["whisky"],
	"scotch":                       ["whisky"],
	"scotch-whisky":                ["whisky"],
	"scotch-selections":            ["whisky"],
	"scottish-blends":              ["whisky"],
	"scottish-single-malts":        ["whisky"],
	"single-malt-whisky":           ["whisky"],
	"spirits-scotch":               ["whisky"],
	"whiskey-scotch":               ["whisky"],

	// ── Gin ──────────────────────────────────────────────────────────────────
	"gin":                          ["gin"],
	"spirits-gin":                  ["gin"], // ARC / Strath naming convention

	// ── Mixed rum+whisky DBs (allowUrl-filtered at scrape time) ─────────────
	"spirits-liquor":               ["rum", "whisky"], // sierrasprings: URL-filtered to rum|whiskey
	"all-minus-gin-tequila-mezcal": ["rum", "whisky"], // maltsandgrains: specialist rum/whisky store

	// ── Whisky-only catch-all DBs (confirmed by scraper filters or content) ──
	"fine-rare":                    ["whisky"], // sierrasprings fine & rare = premium whisky
	"other":                        ["whisky"], // sierrasprings other = whisky rescue by allowUrl

	// ── All-types DB (show under any filter, future-proof) ───────────────────
	"spirits":                      ["rum", "whisky", "gin"], // sierrasprings: unfiltered general spirits
};

/**
 * Map a raw category key to spirit type ids.
 * Returns null for unclassifiable categories.
 * @param {string} categoryKey
 * @returns {string[]|null}
 */
export function categoryToSpiritTypes(categoryKey) {
	const k = String(categoryKey || "").toLowerCase().trim();
	return CATEGORY_TO_TYPES[k] || null;
}

// ── Signals used for per-item classification of mixed-category DBs ───────────

// Rum finish patterns: "rum" or "rhum" followed by a cask/finish keyword within
// 25 chars. These indicate a WHISKY finished in rum casks, not an actual rum.
// "fnsh" catches URL slug abbreviations like "rum-fnsh".
const _RUM_FINISH = /\b(rum|rhum)\b.{0,25}\b(cask|finish|fnsh|barrel|barrique)\b/i;

// Primary rum keyword (includes rhum agricole).
const _RUM = /\b(rum|rhum)\b/i;

// Whisky co-signals used to confirm a RUM_FINISH match is really a whisky.
// "peated" is unambiguous (no peated rums exist).
const _WHISKY_CO = /\b(whisk(?:e)?y|scotch|single malt|blended malt|bourbon|rye|peated|islay|speyside|highland|lowland|campbeltown|irish|japanese)\b/i;

// Small rum brand list for products that omit "rum" in name/URL.
// Matches craftcellars.js pattern; kept intentionally short.
const _RUM_BRANDS = /\b(appleton|mount gay|doorly'?s|foursquare|worthy park|hampden|long pond|river antoine|clairin|angostura|paranubes|el dorado|diplomatico|zacapa|plantation|planteray|velier|rum sponge)\b/i;

/**
 * Per-item spirit type resolution. Narrows ambiguous categories using the item
 * name and URL. Single-type and unclassifiable categories pass straight through.
 *
 * Two stores have genuinely mixed DBs:
 *
 * - maltsandgrains__all-minus-gin-tequila-mezcal: whisky-primary (573 vs 14 rum).
 *   Product slugs are distillery + age, so URL alone is insufficient. Uses name +
 *   URL with rum-finish suppression logic (mirrors craftcellars.js classifyCraftProduct).
 *
 * - sierrasprings__spirits-liquor: scraper URL-filters to rum|whiskey slugs, so URL
 *   alone works. One genuinely ambiguous item stays ["rum","whisky"].
 *
 * @param {string} categoryKey
 * @param {string} [url]
 * @param {string} [name]
 * @returns {string[]|null}
 */
export function resolveItemSpiritTypes(categoryKey, url, name) {
	const k = String(categoryKey || "").toLowerCase().trim();

	// Malts & Grains catch-all: apply craftcellars-style rum-finish suppression.
	if (k === "all-minus-gin-tequila-mezcal") {
		const t = `${String(name || "")} ${String(url || "")}`.toLowerCase();
		const hasRum      = _RUM.test(t) || _RUM_BRANDS.test(t);
		const hasRumFinish = _RUM_FINISH.test(t);
		const hasWhiskyCo  = _WHISKY_CO.test(t);
		// Suppress rum classification only when "rum" is clearly a cask-finish
		// descriptor AND there's an independent whisky signal.
		const rumFinishOnly = hasRum && hasRumFinish && hasWhiskyCo;
		return (hasRum && !rumFinishOnly) ? ["rum"] : ["whisky"];
	}

	// Sierra Springs spirits-liquor: URL slug reliably says rum or whiskey.
	if (k === "spirits-liquor") {
		const u = String(url || "").toLowerCase();
		const hasRum    = /\brum\b/.test(u);
		const hasWhisky = /\bwhisk/.test(u);
		if (hasRum && !hasWhisky) return ["rum"];
		if (hasWhisky && !hasRum) return ["whisky"];
		return ["rum", "whisky"]; // genuinely ambiguous (1 item)
	}

	return categoryToSpiritTypes(k);
}
