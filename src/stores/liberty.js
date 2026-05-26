"use strict";
const { createWooStoreApiAdapter } = require("../platforms/woocommerce_store_api");

function createStore(defaultUa) {
	const scan = (wooCategoryId) => createWooStoreApiAdapter({ wooCategoryId });
	return {
		key: "liberty",
		region: "BC",
		name: "Liberty Wine Merchants",
		host: "www.libertywinemerchants.com",
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whisky", label: "Whisky", startUrl: "https://www.libertywinemerchants.com/product-category/whisky/", _scan: scan(1075) },
			{ key: "rum",    label: "Rum",    startUrl: "https://www.libertywinemerchants.com/product-category/rum/",    _scan: scan(817)  },
			{ key: "gin",    label: "Gin",    startUrl: "https://www.libertywinemerchants.com/product-category/gin/",    _scan: scan(814)  },
		],
	};
}

module.exports = { createStore };
