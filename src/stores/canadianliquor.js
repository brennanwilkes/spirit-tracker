"use strict";
const { createShopifyCollectionAdapter } = require("../platforms/shopify_collection");

// "case sale only product" listings price the full case (typically 6 bottles)
// rather than a single bottle. Including them would skew cross-store
// price comparisons. Drop at the adapter layer.
function isNotCaseOnly(p) {
	const tags = Array.isArray(p?.tags) ? p.tags : [];
	return !tags.includes("case sale only product");
}

function createStore(defaultUa) {
	const scan = (handle) => createShopifyCollectionAdapter({
		collectionHandle: handle,
		skuFallback: "none",
		allowProduct: isNotCaseOnly,
	});
	return {
		key: "canadianliquor",
		region: "AB",
		name: "Canadian Liquor Store",
		host: "www.canadianliquorstore.ca",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whisky", label: "Whisky", _scan: scan("whisky") },
			{ key: "rum",    label: "Rum",    _scan: scan("rum")    },
			{ key: "gin",    label: "Gin",    _scan: scan("gin")    },
		],
	};
}

module.exports = { createStore };
