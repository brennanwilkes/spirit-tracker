"use strict";
const { createWooStoreApiAdapter } = require("../platforms/woocommerce_store_api");

// Some Sherbrooke records are orphaned/trashed (slug "__trashed", permalink
// contains /__trashed/). Drop them.
function isNotTrashed(it) {
	// Trashed slugs are "__trashed", "__trashed-12", etc.
	return !/\/__trashed/.test(String(it?.url || ""));
}

function createStore(defaultUa) {
	const scan = (slug) => createWooStoreApiAdapter({
		categorySlug: slug,
		allowProduct: isNotTrashed,
	});
	const base = "https://sherbrookeliquor.com/shop/category/spirits";
	return {
		key: "sherbrooke",
		region: "AB",
		name: "Sherbrooke Liquor",
		host: "sherbrookeliquor.com",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			// "whisky" excludes scotch (disjoint); union them. single-malt
			// and blended-malt are subsets of scotch. WC Store API dedups.
			{ key: "whisky", label: "Whisky", startUrl: `${base}/whisky/`, _scan: scan("whisky,scotch") },
			{ key: "rum",    label: "Rum",    startUrl: `${base}/rum/`,    _scan: scan("rum")    },
			{ key: "gin",    label: "Gin",    startUrl: `${base}/gin/`,    _scan: scan("gin")    },
		],
	};
}

module.exports = { createStore };
