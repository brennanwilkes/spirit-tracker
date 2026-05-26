"use strict";

// Liquorama — bespoke custom REST API (Vite SPA front-end, open JSON API).
// /api/v1/products?category={slug}&page=N&limit=50 with pagination meta.
// The whisky/scotch/bourbon category slugs are disjoint, so the whisky
// category unions all three (deduped by SKU).

const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { finalizeCategoryScan } = require("../tracker/finalize");

const HOST = "liquorama.ca";
const LIMIT = 50;

function formatPrice(n) {
	const v = Number(n);
	return Number.isFinite(v) ? `$${v.toFixed(2)}` : "";
}

async function fetchCategorySlug(ctx, slug, intoMap, prevDb) {
	const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);
	let page = 1;
	while (page <= maxPages) {
		const url = `https://${HOST}/api/v1/products?category=${encodeURIComponent(slug)}&page=${page}&limit=${LIMIT}`;
		const r = await ctx.http.fetchJsonWithRetry(url, `${ctx.store.key}:api:${ctx.cat.key}:${slug}:p${page}`, ctx.store.ua);
		const data = Array.isArray(r?.json?.data) ? r.json.data : [];
		if (!data.length) break;

		for (const p of data) {
			const inStock = Number(p?.current_stock) > 0 && String(p?.status || "") === "Active";
			if (!inStock) continue;

			const sku = String(p?.sku ?? "").trim();
			const slugPath = String(p?.slug || "").trim();
			const prodUrl = `https://${HOST}/product/${sku}/${slugPath}`;
			const img = p?.image_url ? `https://${HOST}${p.image_url}` : "";

			const prev = prevDb?.byUrl?.get(prodUrl) || null;
			// Short numeric SKUs (e.g. "570") are valid CSPCs that miss the
			// 6-digit regex; prefix id: so they zero-pad ("570" -> "000570"),
			// same convention as the Shopify adapter and BCL.
			const skuInput = /^\d+$/.test(sku) && !/^\d{6}$/.test(sku) ? `id:${sku}` : sku;
			const skuNorm = normalizeSkuKey(skuInput, { storeLabel: ctx.store.name, url: prodUrl });
			const finalSku = pickBetterSku(skuNorm, prev?.sku || "");

			intoMap.set(prodUrl, {
				name: String(p?.name || "").trim(),
				price: formatPrice(p?.price) || prev?.price || "",
				url: prodUrl,
				sku: finalSku,
				img: img || prev?.img || "",
			});
		}

		if (!r?.json?.pagination?.has_next) break;
		page++;
	}
}

function scanCategoryLiquorama(slugs) {
	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();
		const discovered = new Map();
		for (const slug of slugs) {
			await fetchCategorySlug(ctx, slug, discovered, prevDb);
		}
		ctx.logger.ok(`${ctx.catPrefixOut} | liquorama slugs=${slugs.join("+")} kept=${discovered.size}`);
		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 0 });
	};
}

function createStore(defaultUa) {
	return {
		key: "liquorama",
		region: "AB",
		name: "Liquorama",
		host: HOST,
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			// whisky/scotch/bourbon slugs are disjoint — union for full whisky.
			{ key: "whisky", label: "Whisky", _scan: scanCategoryLiquorama(["whisky", "scotch", "bourbon"]) },
			{ key: "rum",    label: "Rum",    _scan: scanCategoryLiquorama(["rum"]) },
			{ key: "gin",    label: "Gin",    _scan: scanCategoryLiquorama(["gin"]) },
		],
	};
}

module.exports = { createStore };
