"use strict";
const { createWooStoreApiAdapter } = require("../platforms/woocommerce_store_api");

function createStore(defaultUa) {
	const scan = (categorySlug) => createWooStoreApiAdapter({ categorySlug });
	return {
		key: "highlander",
		region: "AB",
		name: "Highlander Wine & Spirits",
		host: "highlanderwine.com",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			// "Whiskey" (113) covers american/canadian/irish but NOT scotch;
			// union with scotch (120) + scotch-single-malt (121). The WC Store
			// API dedups the comma list, so no item is double-counted.
			{ key: "whiskey", label: "Whiskey", startUrl: "https://highlanderwine.com/product-category/liquor-spirits/whiskey/", _scan: scan("113,120,121") },
			{ key: "rum",     label: "Rum",     startUrl: "https://highlanderwine.com/product-category/rum/",                   _scan: scan("200") },
			{ key: "gin",     label: "Gin",     startUrl: "https://highlanderwine.com/product-category/gin/",                   _scan: scan("415") },
		],
	};
}

module.exports = { createStore };
