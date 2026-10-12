"use strict";

const { createShopifyCollectionAdapter } = require("../platforms/shopify_collection");

/*
 * Malts & Grains replatformed WooCommerce → Shopify (malts-grains.myshopify.com) in
 * early Aug 2026. The old /shop/page/N/ and /product-category/gin/ URLs now 404, which
 * is why the WooCommerce parser returned 0 products from ~Aug 5 onward.
 *
 * The category startUrls below are kept VERBATIM even though nothing fetches them —
 * the DB filename hash is derived from startUrl, so changing them would strand the
 * existing DB files and lose the tracked history. Same trick sierrasprings.js uses.
 *
 * Buckets come from Shopify's product_type. Do NOT match on the title: "Glen Elgin",
 * "Virgin Oak" and "Gin[ger]" all contain "gin".
 */

const UNKNOWN_PRODUCT_TYPES = new Set();

// "France" is the store's type for French wine (177 products, all wine, 2026-10-12).
const NON_SPIRIT_TYPE_RE =
	/wine|\bred\b|\bwhite\b|ros[eé]|sparkling|champagne|tequila|mezcal|vodka|liqueur|beer|cider|seltzer|sake|cognac|brandy|armagnac|calvados|^france$/;
const KNOWN_SPIRIT_TYPE_RE = /whisk|whsk|brbn|bourbon|\brye\b|scotch|\bmalt\b|\brum\b|cane|irish|japan|grain|blend/;

// "On Sale" is a promo product_type that mixes tequila with Springbank and Lagavulin, so
// for types like it the agave check falls back to the store's tag and the title. Only for
// those: a product typed as whisky or rum is trusted over its title, because tequila- and
// mezcal-cask whiskies ("Smokehead Tequila Islay", "Rock Island Mezcal Blended Malt") name
// the agave without being agave. Missing a tequila is cheap (hide it); dropping a whisky
// loses its history.
const AGAVE_TITLE_RE = /\btequila\b|\bmezcal\b|\bnom[- ]?\d{4}\b|\bmaguey\b/i;
// Whisky words and a truncated "Ca"/"Cas" ending ("Stillhead Tequila Ca") also keep it.
const AGAVE_FALSE_POSITIVE_RE =
	/\bcask|finish|barrel|terminado|edition|\bwood\b|\bcas?$|whisk|\bmalt\b|bourbon|\brye\b|scotch|islay/i;

function classifyMaltsProduct(p) {
	const type = String(p?.product_type || "")
		.trim()
		.toLowerCase();

	if (!type) {
		UNKNOWN_PRODUCT_TYPES.add("(empty product_type)");
		return "other";
	}
	if (/\bgin\b/.test(type)) return "gin";
	if (NON_SPIRIT_TYPE_RE.test(type)) return "other";

	// Everything else counts as a tracked spirit. This store is a whisky specialist and
	// names its types loosely ("Irish & Japanese", "American Whsk/Brbn"), so an allowlist
	// silently drops whole categories — including by default and denying the handful of
	// known non-spirits is the safer failure mode. Unrecognized types are still logged.
	if (!KNOWN_SPIRIT_TYPE_RE.test(type)) {
		if (p.tags.some((t) => /tequila|mezcal/i.test(t))) return "other";
		const title = String(p.title || "");
		if (AGAVE_TITLE_RE.test(title) && !AGAVE_FALSE_POSITIVE_RE.test(title)) return "other";
		UNKNOWN_PRODUCT_TYPES.add(type);
	}
	return "spirits";
}

function createStore(defaultUa) {
	const scan = createShopifyCollectionAdapter({
		useGlobalProductsJson: true,
		classify: classifyMaltsProduct,
		skuFallback: "none",
	});

	return {
		key: "maltsandgrains",
		region: "AB",
		name: "Malts & Grains",
		host: "maltsandgrains.store",
		ua: defaultUa,

		async scanCategory(ctx, prevDb, report) {
			await scan(ctx, prevDb, report);

			// Surface catalog drift: a product_type we don't recognize is silently dropped,
			// so a newly-added whisky category would otherwise vanish without a trace.
			if (UNKNOWN_PRODUCT_TYPES.size) {
				ctx.logger.warn(
					`${ctx.catPrefixOut} | Unclassified Shopify product_type(s): ${[...UNKNOWN_PRODUCT_TYPES].join(", ")}`,
				);
				UNKNOWN_PRODUCT_TYPES.clear();
			}
		},

		categories: [
			{
				key: "all-minus-gin-tequila-mezcal",
				label: "All Spirits",
				kind: "spirits",
				startUrl: "https://maltsandgrains.store/shop/page/1/",
			},
			{
				key: "gin",
				label: "Gin",
				kind: "gin",
				startUrl: "https://maltsandgrains.store/product-category/gin/page/1/",
			},
		],
	};
}

module.exports = { createStore };
