"use strict";
const { createShopifyCollectionAdapter } = require("../platforms/shopify_collection");

function createStore(defaultUa) {
	const scan = (handle) => createShopifyCollectionAdapter({
		collectionHandle: handle,
		skuFallback: "none",
	});
	return {
		key: "whiskydrop",
		region: "AB",
		name: "Whisky Drop",
		host: "www.whiskydrop.ca",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whisky", label: "Whisky", _scan: scan("all-whisky") },
			{ key: "rum",    label: "Rum",    _scan: scan("rum")        },
			{ key: "gin",    label: "Gin",    _scan: scan("gin")        },
		],
	};
}

module.exports = { createStore };
