// src/stores/everythingwine.js
"use strict";

// Everything Wine — Magento storefront (BC chain). HTML listing parse + a budgeted
// detail-page repair pass for the real SKU.
//
// Two Magento quirks drive the design:
//  1. Pagination CLAMPS: `?p=99999` returns page 1, not an empty grid — so the standard
//     binary-search probe would never see a MISS. We instead read the total product
//     count from the `toolbar-number` ("1-24 of 543") and compute the page count, via a
//     custom scanCategory.
//  2. The real SKU is the BCL catalogue code (same code other BC stores carry — e.g.
//     681665, or short codes like 42 → 000042 — so resolving it earns free implicit
//     cross-store linking). It is NOT in the card's data-attributes (those are the Magento
//     entity id), but the catalog IMAGE filename is prefixed with it
//     (.../42_canadian_club.jpg), which parseProducts extracts with no extra fetch.
//     Products with a placeholder image have no such number; a budgeted detail-page fetch
//     (JSON-LD "sku", seeded from prevDb so learned SKUs persist) repairs those.
//
// Listing-stock note: the per-card stock class is relative to the default store
// (Vancouver) and is NOT a global signal. An audit of a full listing page found every
// listed product globally salable (`is_salable:1`), incl. those "unavailable" at the
// default store — Magento drops sold-out-everywhere products from category listings. So
// we treat all listed products as in-stock, and only use the detail page's `is_salable`
// as a cheap guard to drop a product if it ever reports 0 while we're fetching it anyway.

const { decodeHtml, stripTags, cleanText, extractFirstImgUrl } = require("../utils/html");
const { extractPrice } = require("../utils/price");
const { normalizeSkuKey, pickBetterSku, needsSkuDetail } = require("../utils/sku");
const { makePageUrlQueryParam } = require("../utils/url");
const { parallelMapStaggered } = require("../utils/async");
const { finalizeCategoryScan } = require("../tracker/finalize");
const { avoidMassRemoval } = require("../tracker/merge");
const { padLeft } = require("../utils/string");
const { secStr, kbStr, pctStr } = require("../utils/format");

const DEFAULT_DETAIL_BUDGET = 200;

// EW SKUs are BCL catalogue codes, 2–6 digits. 6-digit ones are CSPCs as-is; shorter ones
// get the id: zero-pad (42 → 000042) so they match other stores' canonical keys.
function normalizeEwSku(raw, storeLabel, url) {
	const d = String(raw || "").trim();
	if (!d) return "";
	const skuInput = /^\d{6}$/.test(d) ? d : `id:${d}`;
	return normalizeSkuKey(skuInput, { storeLabel, url });
}

// The catalog image filename is prefixed with the SKU:
// /media/catalog/product/4/2/42_canadian_club_nl.jpg → 42. Verified to equal the
// detail-page SKU for every non-placeholder image, so most products are resolved here
// with no detail fetch. Placeholder images (no number) fall back to the repair pass.
function skuFromImg(img) {
	return String(img || "").match(/\/product\/[^"]*?\/(\d{1,8})_[^/"]*\.(?:jpe?g|png|webp)/i)?.[1] || "";
}

function parseProductsEverythingWine(html, ctx) {
	const s = String(html || "");
	const base = `https://${(ctx && ctx.store && ctx.store.host) || "www.everythingwine.ca"}/`;

	const parts = s.split(/<a class="product-item-info"/);
	const items = [];

	for (let i = 1; i < parts.length; i++) {
		const block = '<a class="product-item-info"' + parts[i];

		const href = block.match(/href="([^"]+)"/)?.[1] || "";
		if (!href) continue;
		let url;
		try {
			url = new URL(decodeHtml(href), base).toString();
		} catch {
			continue;
		}

		const nameHtml = block.match(/product-item-link"[^>]*>([\s\S]*?)<\/span>/)?.[1] || "";
		const name = cleanText(decodeHtml(stripTags(nameHtml)));
		if (!name) continue;

		// Final (post-sale) price: data-price-amount on the finalPrice span.
		const amount = block.match(/data-price-amount="([\d.]+)"\s+data-price-type="finalPrice"/)?.[1] || "";
		const price = amount ? `$${amount}` : extractPrice(block);

		let img = extractFirstImgUrl(block, base);
		if (/placeholder/i.test(img)) img = "";

		const pid = block.match(/data-product-id="(\d+)"/)?.[1] || "";
		const sku = normalizeEwSku(skuFromImg(img), (ctx && ctx.store && ctx.store.name) || "", url);

		items.push({ name, price, url, sku, img, pid });
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

// "1-24 of 543" → 543. The toolbar renders three <span class="toolbar-number"> values
// (from, to, total); the total is the max. Returns 0 if not found.
function extractTotalCount(html) {
	const nums = [...String(html || "").matchAll(/toolbar-number"[^>]*>\s*([\d,]+)/gi)].map((m) =>
		Number(m[1].replace(/,/g, "")),
	);
	const finite = nums.filter((n) => Number.isFinite(n));
	return finite.length ? Math.max(...finite) : 0;
}

// Detail page → real CSPC. EW SKUs are 2–6 digit BCL codes; 6-digit ones are CSPCs as-is,
// shorter ones get the id: zero-pad (42 → 000042) so they match other stores' canonical
// keys. Returns { sku, salable } (salable=false only when explicitly is_salable:0).
function extractDetail(html, storeLabel, url) {
	const s = String(html || "");
	const raw =
		s.match(/"sku":"(\d{1,8})"/)?.[1] ||
		s.match(/catalog_product_view_sku_(\d{1,8})/)?.[1] ||
		s.match(/"SKU":"(\d{1,8})"/)?.[1] ||
		"";

	const sku = normalizeEwSku(raw, storeLabel, url);

	const salableRaw = s.match(/"is_salable":"?(\d)"?/)?.[1];
	const salable = salableRaw !== "0";

	return { sku, salable };
}

async function repairSkus(ctx, discovered, prevDb) {
	const budget = Number.isFinite(ctx?.config?.everythingwineDetailBudget)
		? ctx.config.everythingwineDetailBudget
		: DEFAULT_DETAIL_BUDGET;
	let used = 0;
	let dropped = 0;

	for (const [url, it] of discovered.entries()) {
		if (!it) continue;

		// Seed from prev DB so we don't re-fetch products whose SKU we already learned.
		const prev = prevDb?.byUrl?.get(url);
		if (prev) it.sku = pickBetterSku(it.sku, prev.sku);

		if (!needsSkuDetail(it.sku)) continue;
		if (used >= budget) break;
		used++;

		let html = "";
		try {
			const r = await ctx.http.fetchTextWithRetry(url, `${ctx.store.key}:detail`, ctx.store.ua);
			html = r?.text || "";
		} catch {
			html = "";
		}
		if (!html) continue;

		const { sku, salable } = extractDetail(html, ctx.store.name, url);

		// Defense-in-depth: drop a product only if the detail page explicitly says it's
		// not salable anywhere (the audit found none on listings, but cheap to guard).
		if (!salable) {
			discovered.delete(url);
			dropped++;
			continue;
		}

		if (sku) it.sku = pickBetterSku(sku, it.sku);
	}

	ctx.logger.ok(
		`${ctx.catPrefixOut} | SKU repair (detail): used=${used}/${budget}${dropped ? ` dropped(OOS)=${dropped}` : ""}`,
	);
}

function scanCategoryEverythingWine(ctx, prevDb, report) {
	return (async () => {
		const { logger, config } = ctx;
		const t0 = Date.now();

		// Page 1: get products + total count to compute page span (probing is unsafe —
		// out-of-range pages clamp to page 1 rather than returning empty).
		const url1 = makePageUrlQueryParam(ctx.baseUrl, "p", 1);
		const { text: html1 } = await ctx.http.fetchTextWithRetry(url1, `${ctx.store.key}:p1`, ctx.store.ua);

		const items1 = parseProductsEverythingWine(html1, ctx);
		const total = extractTotalCount(html1);
		const perPage = items1.length;

		let totalPages = total > 0 && perPage > 0 ? Math.ceil(total / perPage) : 1;
		if (config.maxPages !== null) totalPages = Math.min(config.maxPages, totalPages);

		logger.ok(`${ctx.catPrefixOut} | Pages: ${totalPages} (of ${total} products @ ${perPage}/pg)`);

		const pages = [];
		for (let p = 1; p <= totalPages; p++) pages.push(makePageUrlQueryParam(ctx.baseUrl, "p", p));

		let donePages = 0;
		const pageConc = Number.isFinite(ctx.cat.pageConcurrency) ? ctx.cat.pageConcurrency : config.concurrency;
		const pageStagger = Number.isFinite(ctx.cat.pageStaggerMs) ? ctx.cat.pageStaggerMs : config.staggerMs;

		const perPageItems = await parallelMapStaggered(pages, pageConc, pageStagger, async (pageUrl, idx) => {
			const pnum = idx + 1;
			let html = html1;
			let ms = 0;
			let bytes = html1.length;
			let status = 200;
			if (pnum > 1) {
				const r = await ctx.http.fetchTextWithRetry(pageUrl, `${ctx.store.key}:${ctx.cat.key}:p${pnum}`, ctx.store.ua);
				html = r.text;
				ms = r.ms;
				bytes = r.bytes;
				status = r.status;
			}
			const items = parseProductsEverythingWine(html, ctx);
			donePages++;
			logger.ok(
				`${ctx.catPrefixOut} | Page ${pnum}/${pages.length} | ${status} | ${pctStr(donePages, pages.length)} | ` +
					`items=${padLeft(items.length, 3)} | ${kbStr(bytes)} | ${secStr(ms)}`,
			);
			return items;
		});

		const discovered = new Map();
		for (const arr of perPageItems) {
			for (const it of arr) discovered.set(it.url, it);
		}

		await repairSkus(ctx, discovered, prevDb);

		avoidMassRemoval(prevDb, discovered, ctx, `everythingwine pages=${donePages}`, report);

		logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);
		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: pages.length });
	})();
}

function createStore(defaultUa) {
	return {
		key: "everythingwine",
		region: "BC",
		name: "Everything Wine",
		host: "www.everythingwine.ca",
		ua: defaultUa,

		scanCategory: scanCategoryEverythingWine,

		categories: [
			{
				key: "whisky",
				label: "Whisky",
				startUrl: "https://www.everythingwine.ca/all-spirits/spirits/whisky",
			},
			{
				key: "rum",
				label: "Rum",
				startUrl: "https://www.everythingwine.ca/all-spirits/spirits/rum",
			},
			{
				key: "gin",
				label: "Gin",
				startUrl: "https://www.everythingwine.ca/all-spirits/spirits/gin",
			},
		],
	};
}

module.exports = { createStore, parseProductsEverythingWine };
