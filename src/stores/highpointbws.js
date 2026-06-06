"use strict";
const { createBarnetAdapter } = require("../platforms/barnet_network");

const HOST = "shop.highpointbws.com";

// sub_category=WHISKEY is the umbrella for scotch/Irish/Canadian/world whisky
// (server-side filter, case-sensitive). Confirmed complete vs deduped
// category_name counts (240/59/73).
function createStore(defaultUa) {
	const scan = (subCategory) => createBarnetAdapter({ category: "SPIRITS", subCategory });
	const start = (sub) => `https://${HOST}/products?category=SPIRITS&sub_category=${sub}`;
	return {
		key: "highpointbws",
		region: "BC",
		name: "High Point BWS",
		host: HOST,
		shopId: "96",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whiskey", label: "Whiskey", startUrl: start("WHISKEY"), _scan: scan("WHISKEY") },
			{ key: "rum",     label: "Rum",     startUrl: start("RUM"),     _scan: scan("RUM")     },
			{ key: "gin",     label: "Gin",     startUrl: start("Gin"),     _scan: scan("Gin")     },
		],
	};
}

module.exports = { createStore };
