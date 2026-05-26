"use strict";

// Wine and Beyond runs Shopify across 15 physical stores. Its data is split:
//
//   * /collections/{kind}/products.json — clean catalog (one row per bottle,
//     real SKU + title + image) but price is always 0.00 and availability is
//     a meaningless master flag. Good ONLY for the handle -> sku/title/img map.
//   * /products.json (global) — only ~16% of the catalog is replicated here
//     per location; the rest (allocations / exclusives like Benromach) never
//     appear. So it is NOT a reliable price/stock source. Unused.
//   * Storefront collection HTML with the custom availability facet
//     `filter.p.m.display.available_at={locationId}` — returns ONLY items
//     in stock at that location, with the real price rendered in each card.
//     Repeating the facet key OR's locations, so all 15 locations in one
//     query yields every in-stock-anywhere bottle + price in a single
//     paginated view. This is the authoritative price/availability source.
//
// Strategy per category:
//   1. Build handle -> {sku,title,img} from products.json (fast JSON).
//   2. Discover the 15 available_at location IDs from the collection facet.
//   3. Paginate the all-locations-OR'd filtered collection HTML; every card
//      is in stock somewhere. Parse handle -> price.
//   4. Join on handle; emit one row per in-stock bottle.
//
// "Low Stock" counts as in stock (the facet already encodes that). No
// per-item product-page fetches are needed.

const { sanitizeName } = require("../utils/text");
const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { normalizeShopifyProductUrl } = require("../utils/shopify");
const { finalizeCategoryScan } = require("../tracker/finalize");

const HOST = "www.wineandbeyond.ca";
// gin collection 500s at limit>=200; use a single safe ceiling everywhere.
const JSON_LIMIT = 150;

// Module-level cache: location IDs are the same across all categories.
let _locationIdsCache = null;

function parsePriceNum(s) {
	const n = Number(String(s || "").replace(/[^0-9.]/g, ""));
	return Number.isFinite(n) ? n : null;
}

function normalizeWnbSku(rawSku, ctx, url) {
	// W&B uses 7-digit SNDL IDs; wrap as id: so they bypass the 6-digit CSPC
	// regex and land as stable id: values rather than synthetic u: hashes.
	const sku = String(rawSku || "").trim();
	const input = /^\d+$/.test(sku) && !/^\d{6}$/.test(sku) ? `id:${sku}` : sku;
	return normalizeSkuKey(input, { storeLabel: ctx.store.name, url });
}

async function fetchCatalogMap(ctx, collectionHandle) {
	const byHandle = new Map();
	const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);
	let page = 1;
	while (true) {
		const url = `https://${HOST}/collections/${collectionHandle}/products.json?limit=${JSON_LIMIT}&page=${page}`;
		const r = await ctx.http.fetchJsonWithRetry(url, `${ctx.store.key}:catalog:${ctx.cat.key}:p${page}`, ctx.store.ua);
		const products = Array.isArray(r?.json?.products) ? r.json.products : [];
		if (!products.length) break;
		for (const p of products) {
			const handle = String(p?.handle || "").trim();
			if (!handle) continue;
			byHandle.set(handle, {
				sku: String(p?.variants?.[0]?.sku || "").trim(),
				title: sanitizeName(String(p?.title || "").trim()),
				img: (() => {
					const im = Array.isArray(p?.images) ? p.images[0] : null;
					let s = im ? (typeof im === "string" ? im : String(im.src || "")) : "";
					if (s.startsWith("//")) s = `https:${s}`;
					return s;
				})(),
			});
		}
		if (products.length < JSON_LIMIT) break;
		if (++page > maxPages) break;
	}
	return byHandle;
}

async function discoverLocationIds(ctx, collectionHandle) {
	if (_locationIdsCache) return _locationIdsCache;
	const url = `https://${HOST}/collections/${collectionHandle}?sort_by=title-ascending`;
	const { text } = await ctx.http.fetchTextWithRetry(url, `${ctx.store.key}:locdisc`, ctx.store.ua);
	const ids = Array.from(new Set((text.match(/available_at=(\d+)/g) || []).map((s) => s.split("=")[1])));
	_locationIdsCache = ids;
	return ids;
}

async function fetchInStockPrices(ctx, collectionHandle, locationIds) {
	const filterQS = locationIds.map((id) => `filter.p.m.display.available_at=${id}`).join("&");
	const byHandle = new Map();
	const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);
	let page = 1;
	while (true) {
		const url = `https://${HOST}/collections/${collectionHandle}?${filterQS}&sort_by=title-ascending&page=${page}`;
		const { text } = await ctx.http.fetchTextWithRetry(url, `${ctx.store.key}:instock:${ctx.cat.key}:p${page}`, ctx.store.ua);
		const segments = text.split('<a href="/products/');
		let cardsThisPage = 0;
		for (let i = 1; i < segments.length; i++) {
			const seg = segments[i];
			const hm = seg.match(/^([a-z0-9-]+)/);
			if (!hm) continue;
			const handle = hm[1];
			const pm = seg.slice(0, 3000).match(/\$([0-9][0-9.,]*)/);
			if (!pm) continue;
			cardsThisPage++;
			if (!byHandle.has(handle)) byHandle.set(handle, pm[1]);
		}
		if (cardsThisPage === 0) break;
		if (++page > maxPages) break;
	}
	return byHandle;
}

function scanCategoryWnB(collectionHandle) {
	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();

		const catalog = await fetchCatalogMap(ctx, collectionHandle);
		const locationIds = await discoverLocationIds(ctx, collectionHandle);
		const inStock = await fetchInStockPrices(ctx, collectionHandle, locationIds);

		const discovered = new Map();
		let missingCatalog = 0;

		for (const [handle, priceStr] of inStock) {
			const meta = catalog.get(handle);
			// Card appeared in the in-stock view but not the catalog json (rare
			// race / cross-category). Skip — we have no reliable SKU for it.
			if (!meta) { missingCatalog++; continue; }

			const title = meta.title;
			if (!title) continue;

			const url = normalizeShopifyProductUrl(`https://${HOST}/products/${handle}`);
			const prev = prevDb?.byUrl?.get(url) || null;

			const priceNum = parsePriceNum(priceStr);
			const price = priceNum !== null ? `$${priceNum.toFixed(2)}` : (prev?.price || "");

			const skuNorm = normalizeWnbSku(meta.sku, ctx, url);
			const finalSku = pickBetterSku(skuNorm, prev?.sku || "");

			discovered.set(url, {
				name: title,
				price,
				url,
				sku: finalSku,
				img: meta.img || prev?.img || "",
			});
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | wineandbeyond catalog=${catalog.size} locations=${locationIds.length} inStock=${inStock.size} kept=${discovered.size} noCatalog=${missingCatalog}`,
		);

		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 0 });
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
