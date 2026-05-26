"use strict";
const { createBarnetAdapter } = require("../platforms/barnet_network");

const HOST = "shop.newdistrict.ca";

// sub_category=WHISKEY is the umbrella (server-side filter), confirmed
// complete vs deduped category_name counts (73/24/43).
function createStore(defaultUa) {
	const scan = (subCategory) => createBarnetAdapter({ category: "SPIRITS", subCategory });
	const start = (sub) => `https://${HOST}/products?category=SPIRITS&sub_category=${sub}`;
	return {
		key: "newdistrict",
		region: "BC",
		name: "New District",
		host: HOST,
		shopId: "111",
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
