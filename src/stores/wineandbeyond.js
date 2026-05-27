"use strict";

// Wine and Beyond runs Shopify across 15 physical stores. Its data is split:
//
//   * /collections/{kind}/products.json — clean catalog (one row per bottle,
//     real SKU + title + image) but price is always 0.00 and availability is
//     a meaningless master flag. Used ONLY for the handle -> sku/title/img map
//     and the per-kind product list.
//   * /products.json (global) — only ~16% of the catalog is replicated per
//     location; the rest never appear. NOT a reliable stock source. Unused.
//   * The `filter.p.m.display.available_at={loc}` collection facet means
//     "CARRIED/listed at that location" — NOT "in stock". It returns items
//     with zero inventory (sold-out everywhere), so it cannot be used to
//     determine availability. (This was a prior bug.)
//   * The PRODUCT PAGE renders a per-location stock table server-side
//     (`<span class="font-semibold">{Location}:&nbsp;</span><span>{state}</span>`)
//     plus the real price. This is the ONLY accurate stock source.
//
// Strategy per category:
//   1. Build handle -> {sku,title,img} from products.json.
//   2. For each product, fetch its product page; parse the per-location table
//      (in stock if any location is "In Stock"/"Low Stock") and the price.
//   3. Emit only in-stock bottles.
//
// This is ~1 fetch per catalogued product (whisky ~1400). W&B tolerates a
// tight cadence, so we lower the per-host interval (see WNB_INTERVAL_MS).
// "Low Stock" counts as in stock.

const { sanitizeName } = require("../utils/text");
const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { normalizeShopifyProductUrl } = require("../utils/shopify");
const { finalizeCategoryScan } = require("../tracker/finalize");

const HOST = "www.wineandbeyond.ca";
// gin collection 500s at limit>=200; use a single safe ceiling everywhere.
const JSON_LIMIT = 150;
// W&B tolerates a tight cadence; per-product stock checks need many fetches.
const WNB_INTERVAL_MS = 400;

let _pacingSet = false;

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

// Parse the product page: in stock if any location reports In/Low Stock; price
// from the data-block-type="price" block.
const STOCK_RE = /font-semibold">[^<]+?:(?:&nbsp;|\s)*<\/span>\s*<span>([^<]+)<\/span>/g;
function parseProductPage(text) {
	let inStock = false;
	STOCK_RE.lastIndex = 0;
	let m;
	while ((m = STOCK_RE.exec(text)) !== null) {
		const st = m[1].trim().toLowerCase();
		if (st === "low stock" || st === "in stock") { inStock = true; break; }
	}
	const pm = text.match(/data-block-type="price"[\s\S]*?\$([0-9][0-9.,]*)/);
	let price = "";
	if (pm) {
		const n = Number(pm[1].replace(/,/g, ""));
		if (Number.isFinite(n) && n > 0) price = `$${n.toFixed(2)}`;
	}
	return { inStock, price };
}

function scanCategoryWnB(collectionHandle) {
	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();

		if (!_pacingSet && typeof ctx.http.setHostInterval === "function") {
			ctx.http.setHostInterval(HOST, WNB_INTERVAL_MS);
			_pacingSet = true;
		}

		const catalog = await fetchCatalogMap(ctx, collectionHandle);

		const discovered = new Map();
		let checked = 0;
		let outOfStock = 0;

		for (const [handle, meta] of catalog) {
			const title = meta.title;
			if (!title) continue;

			const url = normalizeShopifyProductUrl(`https://${HOST}/products/${handle}`);
			let text;
			try {
				({ text } = await ctx.http.fetchTextWithRetry(url, `${ctx.store.key}:prod:${ctx.cat.key}:${handle}`, ctx.store.ua));
			} catch (_) {
				continue; // skip on fetch failure; mass-removal protection guards history
			}
			checked++;

			const { inStock, price } = parseProductPage(text);
			if (!inStock) { outOfStock++; continue; }

			const prev = prevDb?.byUrl?.get(url) || null;
			const finalSku = pickBetterSku(normalizeWnbSku(meta.sku, ctx, url), prev?.sku || "");

			discovered.set(url, {
				name: title,
				price: price || prev?.price || "",
				url,
				sku: finalSku,
				img: meta.img || prev?.img || "",
			});
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | wineandbeyond catalog=${catalog.size} checked=${checked} inStock=${discovered.size} oos=${outOfStock}`,
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
