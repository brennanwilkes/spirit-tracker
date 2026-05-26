"use strict";

// Marquis Wine Cellars — BigCommerce + Halo theme. No public JSON API; the
// catalog grid is rendered client-side, but every category page embeds its
// products inline as a TagRocket analytics array:
//   {price:81.99,currency:'CAD',name:"...",category:{...},sku:"1025673",
//    productSku:"1025673",productId:15102 }
// We regex those objects out of the HTML.
//
// SKU caveat: the `sku` is a BC-internal 7-digit ID, NOT a BCLDB code, so it
// must NOT be promoted to a CSPC (that would falsely merge with real CSPC /
// id: SKUs at other stores). We let it fall through to a synthetic u: key —
// Marquis items are singletons until manually bridged in data/sku_links.json
// by bottle name. This is the documented Marquis exception (~100% u:).
//
// No stock flag in the inline data: presence in the listing => available.
// No image / URL in the inline data: URL is the stable search-by-sku link.

const { sanitizeName } = require("../utils/text");
const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { finalizeCategoryScan } = require("../tracker/finalize");

const HOST = "www.marquis-wines.com";

// Matches one inline product object; tolerant of field whitespace.
const PRODUCT_RE = /price:([0-9.]+),currency:'[^']*',name:"((?:[^"\\]|\\.)*)",category:\{[^{}]*\},sku:"(\d+)"/g;

function decodeJsString(s) {
	return String(s || "").replace(/\\(["'\\/])/g, "$1").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function fetchCategorySlug(ctx, slug, intoMap, prevDb) {
	const maxPages = ctx.config.maxPages === null ? 50 : Math.min(ctx.config.maxPages, 50);
	let page = 1;
	while (page <= maxPages) {
		const url = `https://${HOST}/${slug}/?page=${page}`;
		let text;
		try {
			({ text } = await ctx.http.fetchTextWithRetry(url, `${ctx.store.key}:html:${ctx.cat.key}:${slug}:p${page}`, ctx.store.ua));
		} catch (e) {
			// Marquis returns 404 past the last page (not an empty 200).
			if (page > 1) break;
			throw e;
		}
		let found = 0;
		PRODUCT_RE.lastIndex = 0;
		let m;
		while ((m = PRODUCT_RE.exec(text)) !== null) {
			found++;
			const price = `$${Number(m[1]).toFixed(2)}`;
			const name = sanitizeName(decodeJsString(m[2]));
			const sku = m[3];
			if (!name) continue;

			// Stable per-product URL (search-by-sku resolves to the product).
			const prodUrl = `https://${HOST}/search.php?search_query=${sku}`;
			const prev = prevDb?.byUrl?.get(prodUrl) || null;

			// Pass raw 7-digit BC-internal sku: it is NOT a CSPC, so it
			// normalizes to a synthetic u: key (no false cross-store merge).
			const skuNorm = normalizeSkuKey(sku, { storeLabel: ctx.store.name, url: prodUrl });
			const finalSku = pickBetterSku(skuNorm, prev?.sku || "");

			intoMap.set(prodUrl, {
				name,
				price: price || prev?.price || "",
				url: prodUrl,
				sku: finalSku,
				img: prev?.img || "",
			});
		}
		if (found === 0) break;
		page++;
	}
}

function scanCategoryMarquis(slugs) {
	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();
		const discovered = new Map();
		for (const slug of slugs) {
			await fetchCategorySlug(ctx, slug, discovered, prevDb);
		}
		ctx.logger.ok(`${ctx.catPrefixOut} | marquis slugs=${slugs.join("+")} kept=${discovered.size}`);
		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 0 });
	};
}

function createStore(defaultUa) {
	return {
		key: "marquis",
		region: "BC",
		name: "Marquis Wine Cellars",
		host: HOST,
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whisky", label: "Whisky", _scan: scanCategoryMarquis(["single-malt-scotch", "american-whiskey", "other-whiskey"]) },
			{ key: "rum",    label: "Rum",    _scan: scanCategoryMarquis(["rum"]) },
			{ key: "gin",    label: "Gin",    _scan: scanCategoryMarquis(["gin"]) },
		],
	};
}

module.exports = { createStore };
