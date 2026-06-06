"use strict";
const { createWooStoreApiAdapter } = require("../platforms/woocommerce_store_api");

function createStore(defaultUa) {
	// RMWSB's WAF returns a 4-byte stub for page 2+ of a paginated query that
	// carries stock_status=instock (page 1 is fine). Dropping the param avoids
	// the choke; parseWooStoreProductsJson still filters is_in_stock client-side.
	const scan = (categorySlug) => createWooStoreApiAdapter({ categorySlug, stockStatusFilter: null });
	const base = "https://rockymountainwinespiritsbeer.com/product-category";
	return {
		key: "rmwsb",
		region: "AB",
		name: "Rocky Mountain Wine Spirits Beer",
		host: "rockymountainwinespiritsbeer.com",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			// "Whiskey" (223) does NOT include scotch (999); union them.
			// The WC Store API dedups the comma list.
			{ key: "whiskey", label: "Whiskey", startUrl: `${base}/liquor-spirits/whiskey/`, _scan: scan("223,999") },
			{ key: "rum",     label: "Rum",     startUrl: `${base}/rum/`,                     _scan: scan("222") },
			{ key: "gin",     label: "Gin",     startUrl: `${base}/gin/`,                     _scan: scan("219") },
		],
	};
}

module.exports = { createStore };
