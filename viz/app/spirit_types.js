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
	"canadian-whiskey":             ["whisky"], // sierrasprings naming
	"irish-whiskey":                ["whisky"], // sierrasprings naming
	"world-whisky":                 ["whisky"],
	"scotch":                       ["whisky"],
	"scotch-whisky":                ["whisky"],
	"scotch-whisky-single-malt":    ["whisky"], // sierrasprings naming
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

	// ── sierrasprings "spirits": unfiltered catch-all DB.
	// Contains rum, whisky, gin, tequila, vodka, liqueurs, etc. Classified
	// per-item by URL slug in resolveItemSpiritTypes(); listed here so the
	// key is "known" — value is unused.
	"spirits":                      [],
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
const _RUM_FINISH = /\b(rum|rhum)\b.{0,25}\b(cask|finish(?:ed)?|fnsh|barrel|barrique)\b/i;

// Primary rum keyword (includes rhum agricole).
const _RUM = /\b(rum|rhum)\b/i;

// Whisky co-signals used to confirm a RUM_FINISH match is really a whisky.
// "peated" is unambiguous (no peated rums exist).
const _WHISKY_CO = /\b(whisk(?:e)?y|scotch|single malt|blended malt|bourbon|rye|peated|islay|speyside|highland|lowland|campbeltown|irish|japanese)\b/i;

// Rum brand list for products that omit "rum" in name/URL. Extended over time
// as cross-category classifier audits surface new misclassified brands.
const _RUM_BRANDS = /\b(appleton|mount gay|doorly'?s|foursquare|worthy park|hampden|long pond|river antoine|clairin|angostura|paranubes|el dorado|diplomatico|zacapa|plantation|planteray|velier|rum sponge|bumbu|brugal|bacardi|black tot|sailor jerry|kraken|zaya|lamb'?s|dictador|navy island|smith\s*&\s*cross|asta morris|valinch\s*&\s*mallet|boutique-?y rum|alambique|dram mor|quarterdeck|maman brigitte|twin fin|bedford park)\b/i;

// Secondary rum signals: country-of-origin bottlings that are virtually never
// whisky, plus rum-specific terminology. Only counted when there is no whisky
// signal in the same name (see resolveItemSpiritTypes maltsandgrains branch).
const _RUM_ORIGIN = /\b(jamaica|jamaican|guyana|guyanese|trinidad|trinidadian|barbados|fiji|fijian|haiti|haitian|grenada|nicaragua|venezuela|cuban|guadeloupe|martinique|st\.?\s*lucia|panama(?:nian)?|antigua|mauritius|dominican|south pacific)\b/i;
const _RUM_KEYWORDS = /\b(aguardiente|rhum agricole|agricole|solera|cachaca|caña|cana de azucar)\b/i;

// Generic name-override signals. These detect a spirit type from the product
// name itself, regardless of the store's category. Used as a final pass to
// correct miscategorisations at single-type-category stores (e.g. craftcellars
// filing a gin under whisky, ARC filing Aqua Vitae under gin, sierraspring's
// spirits catch-all routing bourbon via a /rum/ URL slug).
const _GIN_NAME      = /\bgin\b/i;
const _GIN_AS_FINISH = /\bgin\b\s*(?:cask|finish(?:ed)?|barrel)/i;
const _WHISKY_NAME   = /\b(whisk(?:e)?y|scotch|single malt|bourbon|rye whisk|aqua vitae)\b/i;
const _RUM_NAME      = /\b(rum|rhum)\b/i;

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

	// Malts & Grains catch-all: whisky-dominant DB with ~14 rum items mixed in.
	// Apply rum signals with rum-finish suppression. Strong (primary) signals
	// are the word "rum" or a rum-only brand; weak (secondary) signals are
	// country-of-origin bottlings and rum-specific keywords, which only count
	// when there is no whisky term anywhere in the name.
	if (k === "all-minus-gin-tequila-mezcal") {
		const t = `${String(name || "")} ${String(url || "")}`.toLowerCase();
		const hasRumPrimary   = _RUM.test(t) || _RUM_BRANDS.test(t);
		const hasRumSecondary = _RUM_ORIGIN.test(t) || _RUM_KEYWORDS.test(t);
		const hasRumFinish    = _RUM_FINISH.test(t);
		const hasWhiskyCo     = _WHISKY_CO.test(t);
		const rumFinishOnly   = (hasRumPrimary || hasRumSecondary) && hasRumFinish && hasWhiskyCo;
		const isRum = (hasRumPrimary && !rumFinishOnly)
		           || (hasRumSecondary && !hasWhiskyCo);
		return _applyNameOverride(isRum ? ["rum"] : ["whisky"], name);
	}

	// Sierra Springs "spirits" catch-all: URL slug after /shop/spirits/<slug>/
	// is unreliable (the store routes some bourbons through /spirits/rum/).
	// Use slug only as a fallback; the generic name override below corrects
	// it when the product name clearly identifies the spirit type.
	if (k === "spirits") {
		const u = String(url || "").toLowerCase();
		const m = u.match(/\/shop\/spirits\/([^/]+)\//);
		const slug = m ? m[1] : "";
		if (!slug) return _applyNameOverride(null, name);
		let base = null;
		if (/^rum\b|^rum-/.test(slug)) base = ["rum"];
		else if (/^gin\b|^gin-/.test(slug)) base = ["gin"];
		else if (/whisky|whiskey|scotch|bourbon|rye/.test(slug)) base = ["whisky"];
		return _applyNameOverride(base, name);
	}

	// Sierra Springs spirits-liquor: URL slug reliably says rum or whiskey.
	if (k === "spirits-liquor") {
		const u = String(url || "").toLowerCase();
		const hasRum    = /\brum\b/.test(u);
		const hasWhisky = /\bwhisk/.test(u);
		if (hasRum && !hasWhisky) return _applyNameOverride(["rum"], name);
		if (hasWhisky && !hasRum) return _applyNameOverride(["whisky"], name);
		return ["rum", "whisky"]; // genuinely ambiguous (1 item)
	}

	return _applyNameOverride(categoryToSpiritTypes(k), name);
}

// When a single-type category disagrees with an unambiguous name signal,
// trust the name. "Unambiguous" = exactly one of {rum, whisky, gin} appears in
// the name (rum-cask-finish whiskies and "gin cask"-finished rums excluded).
function _applyNameOverride(types, name) {
	if (!Array.isArray(types) || types.length !== 1) return types;
	const nm = String(name || "");
	if (!nm) return types;

	const rumFinish = _RUM_FINISH.test(nm);
	const isRumName    = _RUM_NAME.test(nm) && !rumFinish;
	const isWhiskyName = _WHISKY_NAME.test(nm);
	const isGinName    = _GIN_NAME.test(nm) && !_GIN_AS_FINISH.test(nm);

	const signals = (isRumName ? 1 : 0) + (isWhiskyName ? 1 : 0) + (isGinName ? 1 : 0);
	if (signals !== 1) return types;

	if (isRumName)    return ["rum"];
	if (isWhiskyName) return ["whisky"];
	if (isGinName)    return ["gin"];
	return types;
}
