"use strict";
const { createShopifyCollectionAdapter } = require("../platforms/shopify_collection");

function createStore(defaultUa) {
	const scan = (handle) => createShopifyCollectionAdapter({
		collectionHandle: handle,
		skuFallback: "none",
	});
	return {
		key: "liquorwarehouse",
		region: "BC",
		name: "Liquor Warehouse",
		host: "liquorwarehouse.ca",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whiskey-scotch", label: "Whiskey/Scotch", _scan: scan("whiskey-scotch") },
			{ key: "rum",            label: "Rum",            _scan: scan("rum")            },
			{ key: "gin",            label: "Gin",            _scan: scan("gin")            },
		],
	};
}

module.exports = { createStore };
