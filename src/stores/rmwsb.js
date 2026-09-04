"use strict";
const { createWooStoreApiAdapter } = require("../platforms/woocommerce_store_api");

function createStore(defaultUa) {
	// stockStatusFilter is dropped deliberately; parseWooStoreProductsJson still filters
	// is_in_stock client-side. (The old comment here blamed a "4-byte WAF stub" for page 2+ —
	// that was a misdiagnosis. The 4 bytes are "[]", HTTP 200: this API's honest answer for an
	// empty or absent category. It only looked like a failure because the HTTP client's
	// short-body guard rejected it; see allowShortBody in the adapter.)
	//
	// Categories are addressed by SLUG, not numeric term id. The store gutted its catalogue in
	// 2026 (as of 2026-09-04 it is whisky + tequila only, ~170 items; its site says the online
	// shop is "launching again shortly"), and the old ids 222/rum, 219/gin and 999/scotch are
	// gone. Slugs survive a taxonomy rebuild, so when rum/gin come back under those slugs they
	// are picked up with no code change — today they simply return "[]".
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
			// startUrls are unchanged on purpose: the DB filename hashes them, so editing them
			// would strand the existing history as orphan files.
			{ key: "whiskey", label: "Whiskey", startUrl: `${base}/liquor-spirits/whiskey/`, _scan: scan("whiskey") },
			{ key: "rum",     label: "Rum",     startUrl: `${base}/rum/`,                     _scan: scan("rum") },
			{ key: "gin",     label: "Gin",     startUrl: `${base}/gin/`,                     _scan: scan("gin") },
		],
	};
}

module.exports = { createStore };
