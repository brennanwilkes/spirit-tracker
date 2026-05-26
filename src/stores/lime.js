"use strict";
const { createShopifyCollectionAdapter } = require("../platforms/shopify_collection");

function createStore(defaultUa) {
	const scan = (handle) => createShopifyCollectionAdapter({
		collectionHandle: handle,
		skuFallback: "none",
	});
	return {
		key: "lime",
		region: "AB",
		name: "Lime Liquor",
		host: "limeliquor.ca",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whiskey", label: "Whiskey", _scan: scan("whiskey") },
			{ key: "rum",     label: "Rum",     _scan: scan("rum")     },
			{ key: "gin",     label: "Gin",     _scan: scan("gin")     },
		],
	};
}

module.exports = { createStore };
