"use strict";
const { createShopifyCollectionAdapter } = require("../platforms/shopify_collection");

function createStore(defaultUa) {
	const scan = (handle) => createShopifyCollectionAdapter({
		collectionHandle: handle,
		skuFallback: "none",
	});
	return {
		key: "clbspirits",
		region: "AB",
		name: "CLB Spirits",
		host: "clbspirits.com",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whisky", label: "Whisky", _scan: scan("whisky-1") },
			{ key: "rum",    label: "Rum",    _scan: scan("rum-1")    },
			{ key: "gin",    label: "Gin",    _scan: scan("gin-1")    },
		],
	};
}

module.exports = { createStore };
