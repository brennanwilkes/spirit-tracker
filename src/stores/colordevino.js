"use strict";
const { createWooStoreApiAdapter } = require("../platforms/woocommerce_store_api");

// Category permalinks 404 in-browser (WC quirk); the Store API resolves the
// numeric term IDs directly. whisky-whiskey (1501) and whisky-sc-sm (1502)
// are disjoint, so both are tracked.
function createStore(defaultUa) {
	const scan = (wooCategoryId) => createWooStoreApiAdapter({ wooCategoryId });
	return {
		key: "colordevino",
		region: "AB",
		name: "Color de Vino",
		host: "colordevino.ca",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whisky", label: "Whisky/Whiskey", _scan: scan(1501) },
			{ key: "scotch", label: "Whisky SC SM",   _scan: scan(1502) },
			{ key: "rum",    label: "Rum",            _scan: scan(1498) },
			{ key: "gin",    label: "Gin",            _scan: scan(1493) },
		],
	};
}

module.exports = { createStore };
