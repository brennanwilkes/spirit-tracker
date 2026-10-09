"use strict";

// Wine and Beyond runs Shopify across ~16 Alberta stores.
//
// Since its 2026-10-06 storefront rebuild, /collections/{kind}/products.json is the whole
// source: real per-variant `price` and an `available` flag that is a genuine stock signal.
// Measured 2026-10-09 against the last healthy scan (old product-page stock table): all 1,377
// previously in-stock SKUs are `available:true`, and 27 previously out-of-stock SKUs are still
// `available:false`. The product page's own signals (`product:availability` meta, JSON-LD
// `Offer.availability`) agree with the flag on every page checked.
//
// What the rebuild removed (the old adapter depended on all of it, which is why the 2026-10-06
// scan parsed every product as out of stock):
//   * the server-rendered per-location stock table and `data-block-type="price"` block on the
//     product page, and the `cart_form_<id>` location cards used for price rescue. The new
//     availability modal reads a `PdpAvailabilityStores-*` JSON that renders as `[]` with or
//     without a selected location, so per-location stock is no longer observable.
//   * the old handles. Every handle gained a `-<sku>` suffix (`aviation-gin-750ml` →
//     `aviation-gin-750ml-1007790`). SKUs are unchanged, so merge.js's skuKey rematch carries
//     each record to its new URL.
// Before the rebuild, products.json `price` was always 0.00 and `available` was a meaningless
// master flag. If prices go back to zero, the priceless check below fails the category loudly.

const { sanitizeName } = require("../utils/text");
const { normalizeSkuKey } = require("../utils/sku");
const { normalizeShopifyProductUrl } = require("../utils/shopify");
const { cad } = require("../utils/format");
const { finalizeCategoryScan } = require("../tracker/finalize");

const HOST = "www.wineandbeyond.ca";
// gin collection 500s at limit>=200; use a single safe ceiling everywhere.
const JSON_LIMIT = 150;
// A few priceless rows are tolerable; most of them means the catalog JSON stopped carrying prices.
const MAX_PRICELESS_FRACTION = 0.1;

function normalizeWnbSku(rawSku, ctx, url) {
	// W&B uses 7-digit SNDL IDs; wrap as id: so they bypass the 6-digit CSPC
	// regex and land as stable id: values rather than synthetic u: hashes.
	const sku = String(rawSku || "").trim();
	const input = /^\d+$/.test(sku) && !/^\d{6}$/.test(sku) ? `id:${sku}` : sku;
	return normalizeSkuKey(input, { storeLabel: ctx.store.name, url });
}

function firstImage(p) {
	const im = Array.isArray(p?.images) ? p.images[0] : null;
	let s = im ? (typeof im === "string" ? im : String(im.src || "")) : "";
	if (s.startsWith("//")) s = `https:${s}`;
	return s;
}

function scanCategoryWnB(collectionHandle) {
	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();
		const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);

		const discovered = new Map();
		let catalog = 0;
		let unavailable = 0;
		let priceless = 0;
		let page = 1;
		while (true) {
			const url = `https://${HOST}/collections/${collectionHandle}/products.json?limit=${JSON_LIMIT}&page=${page}`;
			const r = await ctx.http.fetchJsonWithRetry(url, `${ctx.store.key}:catalog:${ctx.cat.key}:p${page}`, ctx.store.ua);
			const products = r.json.products;
			if (!Array.isArray(products)) throw new Error(`W&B products.json p${page}: no products array`);
			if (!products.length) break;

			for (const p of products) {
				const title = sanitizeName(String(p.title || "").trim());
				if (!p.handle || !title) continue;
				catalog++;

				const variant = p.variants.find((v) => v.available);
				if (!variant) { unavailable++; continue; }

				const itemUrl = normalizeShopifyProductUrl(`https://${HOST}/products/${p.handle}`);
				const priceNum = Number(variant.price);
				const price = priceNum > 0 ? cad(priceNum) : "";
				if (!price) priceless++;

				discovered.set(itemUrl, {
					name: title,
					price,
					url: itemUrl,
					sku: normalizeWnbSku(variant.sku, ctx, itemUrl),
					img: firstImage(p),
				});
			}

			if (products.length < JSON_LIMIT) break;
			if (++page > maxPages) break;
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | wineandbeyond catalog=${catalog} inStock=${discovered.size} unavailable=${unavailable} priceless=${priceless}`,
		);

		if (discovered.size && priceless / discovered.size > MAX_PRICELESS_FRACTION) {
			throw new Error(
				`W&B ${priceless}/${discovered.size} in-stock products have no price; products.json format changed again`,
			);
		}

		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: page });
	};
}

function createStore(defaultUa) {
	return {
		key: "wineandbeyond",
		region: "AB",
		name: "Wine and Beyond",
		host: HOST,
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whiskey", label: "Whiskey", _scan: scanCategoryWnB("whiskey") },
			{ key: "rum",     label: "Rum",     _scan: scanCategoryWnB("rum")     },
			{ key: "gin",     label: "Gin",     _scan: scanCategoryWnB("gin")     },
		],
	};
}

module.exports = { createStore };
