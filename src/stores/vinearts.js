"use strict";
const { createShopifyCollectionAdapter } = require("../platforms/shopify_collection");

// Vine Arts operates Calgary and Edmonton storefronts off a single Shopify
// catalog. We track only the Calgary + Nationwide Shipping inventory. The
// location signal is on `product.tags`; we exclude products tagged
// "Edmonton" unless they also carry "Calgary + Nationwide Shipping".
// Untagged products (~10% of whiskey) display as Calgary 17th Ave on the
// site, so they are kept.
function isCalgaryListing(p) {
	const tags = Array.isArray(p?.tags) ? p.tags : [];
	return !(tags.includes("Edmonton") && !tags.includes("Calgary + Nationwide Shipping"));
}

function createStore(defaultUa) {
	const scan = (handle) => createShopifyCollectionAdapter({
		collectionHandle: handle,
		skuFallback: "none",
		allowProduct: isCalgaryListing,
	});
	return {
		key: "vinearts",
		region: "AB",
		name: "Vine Arts",
		host: "vinearts.ca",
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
