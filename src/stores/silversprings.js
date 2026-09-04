"use strict";
const { createBarnetAdapter } = require("../platforms/barnet_network");

const HOST = "shop.silverspringsls.com";

// Silver Springs Liquor Store (Calgary, AB) — Barnet network shop, same API shape as ARC /
// High Point / New District / Vintage: /api/shop/<shopId>/products?category=&sub_category=.
// Every listing carries a real cspcid, so SKUs link cross-store for free.
//
// There is NO umbrella "WHISKEY" sub_category here (it returns 0) — the whiskies are split
// across six regional sub-categories, so each is scraped separately. Measured 2026-09-04:
// scotch 178, US 54, Canadian 43, Irish 15, world 14, Japanese 7, rum 46, gin 33.
//
// sortBy is name_asc, NOT the adapter's price_desc default. Barnet pages via LIMIT/OFFSET and
// re-runs its ORDER BY per request, so rows tied on the sort key swap between pages: one gets
// served twice and its partner not at all, which reads as a phantom sellout. Measured under
// price_desc: SCOTCH WHISKY returned 174/178 (4 duplicate rows) and US WHISKEY 52/54 (2). Under
// name_asc every sub-category returns exactly items_count with zero duplicates. See
// src/CLAUDE.md "ARC amendment" for the full diagnosis.
function createStore(defaultUa) {
	const scan = (subCategory) => createBarnetAdapter({ category: "SPIRITS", subCategory, sortBy: "name_asc" });
	const start = (sub) => `https://${HOST}/?category=SPIRITS&sub_category=${encodeURIComponent(sub)}`;
	const cat = (key, label, sub) => ({ key, label, startUrl: start(sub), _scan: scan(sub) });

	return {
		key: "silversprings",
		region: "AB",
		name: "Silver Springs Liquor",
		host: HOST,
		shopId: "574-242",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			cat("scotch-whisky", "Scotch Whisky", "SCOTCH WHISKY"),
			cat("us-whiskey", "US Whiskey", "US WHISKEY"),
			cat("canadian-whiskey", "Canadian Whiskey", "CANADIAN WHISKEY"),
			cat("irish-whiskey", "Irish Whiskey", "IRISH WHISKEY"),
			cat("world-whisky", "World Whisky", "WORLD WHISKY"),
			cat("japanese-whisky", "Japanese Whisky", "JAPANESE WHISKY"),
			cat("rum", "Rum", "RUM"),
			cat("gin", "Gin", "GIN"),
		],
	};
}

module.exports = { createStore };
