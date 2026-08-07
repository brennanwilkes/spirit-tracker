"use strict";

// Elbow Liquor (Calgary, AB) — ASP.NET storefront, server-rendered HTML grids.
// No JSON API. Category pages at /products/spirits/{whisky,rum,gin}, paginated
// via ?pageNumber=N&sort=name_asc (15 products/page). Each in-stock product card
// carries an <button class="addToCartBtn"> with clean data-sku (6-digit AGLC
// CSPC), data-name, and data-price attributes. Out-of-stock / "Not Available"
// cards have no addToCartBtn, so they are skipped (the merge marks them removed).

const { decodeHtml, extractHtmlAttr, extractFirstImgUrl, escapeRe } = require("../utils/html");
const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { avoidMassRemoval } = require("../tracker/merge");
const { finalizeCategoryScan } = require("../tracker/finalize");

const HOST = "elbowliquor.ca";

function formatPrice(n) {
	const v = Number(n);
	return Number.isFinite(v) ? `$${v.toFixed(2)}` : "";
}

// Depth-counting block splitter (kwm.js approach), but with a STRICT class-token
// match: the card's class is exactly "product", and sibling classes like
// "product-grid-wrapper" / "product-actions" / "product__name" must NOT match.
// A plain \bproduct\b matches "product-grid-wrapper" (hyphen is a word boundary)
// and would swallow the whole grid as one block, so we forbid an adjacent word
// char OR hyphen on either side of the token.
function extractDivBlocksByExactClass(html, className, maxBlocks) {
	const out = [];
	const s = String(html || "");
	const re = new RegExp(
		`<div\\b[^>]*class=["'][^"']*(?<![\\w-])${escapeRe(className)}(?![\\w-])[^"']*["'][^>]*>`,
		"gi",
	);

	let m;
	while ((m = re.exec(s))) {
		if (out.length >= maxBlocks) break;

		let i = m.index + m[0].length;
		let depth = 1;
		while (i < s.length) {
			const nextOpen = s.indexOf("<div", i);
			const nextClose = s.indexOf("</div>", i);
			if (nextClose === -1) break;

			if (nextOpen !== -1 && nextOpen < nextClose) {
				depth++;
				i = nextOpen + 4;
				continue;
			}
			depth--;
			if (depth === 0) {
				out.push(s.slice(m.index, nextClose + 6));
				re.lastIndex = nextClose + 6;
				break;
			}
			i = nextClose + 6;
		}
	}
	return out;
}

function parseProductsElbow(html, ctx) {
	const base = `https://${HOST}/`;
	const blocks = extractDivBlocksByExactClass(html, "product", 5000);
	const items = [];

	for (const block of blocks) {
		// In-stock cards have the add-to-cart button (and only it carries the
		// data-sku/name/price). OOS / Not Available cards have no button — skip.
		if (!/addToCartBtn/i.test(block)) continue;

		const sku = String(extractHtmlAttr(block, "data-sku") || "").trim();
		const name = decodeHtml(String(extractHtmlAttr(block, "data-name") || "")).trim();
		if (!sku || !name) continue;

		const price = formatPrice(extractHtmlAttr(block, "data-price"));

		const hrefM = block.match(/href=["'](\/Products\/Details\/[^"']+)["']/i);
		if (!hrefM) continue;
		let url;
		try {
			url = new URL(decodeHtml(hrefM[1]), base).toString();
		} catch {
			continue;
		}

		const img = extractFirstImgUrl(block, base);

		items.push({ name, price, url, sku, img });
	}

	return items;
}

async function fetchCategoryUrl(ctx, categoryUrl, intoMap, prevDb) {
	const maxPages = ctx.config.maxPages === null ? 100 : Math.min(ctx.config.maxPages, 100);
	let page = 1;
	while (page <= maxPages) {
		const sep = categoryUrl.includes("?") ? "&" : "?";
		const url = `${categoryUrl}${sep}pageNumber=${page}&sort=name_asc`;
		const r = await ctx.http.fetchTextWithRetry(url, `${ctx.store.key}:html:${ctx.cat.key}:p${page}`, ctx.store.ua);
		const items = parseProductsElbow(r.text || "", ctx);
		if (!items.length) break;

		for (const it of items) {
			if (intoMap.has(it.url)) continue;
			const prev = prevDb?.byUrl?.get(it.url) || null;
			// 6-digit codes are AGLC CSPCs as-is; shorter numerics get the id:
			// zero-pad convention so they implicitly link with other AB stores.
			const skuInput = /^\d+$/.test(it.sku) && !/^\d{6}$/.test(it.sku) ? `id:${it.sku}` : it.sku;
			const skuNorm = normalizeSkuKey(skuInput, { storeLabel: ctx.store.name, url: it.url });
			const finalSku = pickBetterSku(skuNorm, prev?.sku || "");

			intoMap.set(it.url, {
				name: it.name,
				price: it.price || prev?.price || "",
				url: it.url,
				sku: finalSku,
				img: it.img || prev?.img || "",
			});
		}

		page++;
	}
}

function scanCategoryElbow(categoryUrls) {
	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();
		const discovered = new Map();
		for (const categoryUrl of categoryUrls) {
			await fetchCategoryUrl(ctx, categoryUrl, discovered, prevDb);
		}
		ctx.logger.ok(`${ctx.catPrefixOut} | elbow urls=${categoryUrls.length} kept=${discovered.size}`);
		avoidMassRemoval(prevDb, discovered, ctx, "elbow partial scan", report);
		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 0 });
	};
}

function createStore(defaultUa) {
	return {
		key: "elbowliquor",
		region: "AB",
		name: "Elbow Liquor",
		host: HOST,
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			// Site nav has no separate scotch/single-malt/bourbon category —
			// /products/spirits/whisky is the umbrella (verified 2026-06-27).
			{ key: "whisky", label: "Whisky", _scan: scanCategoryElbow(["https://elbowliquor.ca/products/spirits/whisky"]) },
			{ key: "rum",    label: "Rum",    _scan: scanCategoryElbow(["https://elbowliquor.ca/products/spirits/rum"]) },
			{ key: "gin",    label: "Gin",    _scan: scanCategoryElbow(["https://elbowliquor.ca/products/spirits/gin"]) },
		],
	};
}

module.exports = { createStore };
