"use strict";

// Elbow Liquor (Calgary, AB) — rebranded to vinox.ca in 2026. The old ASP.NET storefront at
// elbowliquor.ca/products/spirits/* now 301s to https://vinox.ca/shop and none of its markup
// survived, which is why every category failed for weeks. The store id/label stay "elbowliquor"
// / "Elbow Liquor" (same business; vinox.ca's own <title> is still "Shop | Elbow Liquor").
//
// IMPORTANT — vinox is a CASE-SALE wholesaler. Every listing carries a "Sold by case" badge and
// two prices: a per-unit price and a case price (`data-product-price` is the CASE price, so never
// use that attribute). Measured 2026-09-04 across all 1468 spirits listings: case sizes run
// 1,2,3,4,5,6,8,9,10,12,18,20,24,44,48,60,96,120 — 1090 of them are case-of-6.
//
// We therefore track ONLY `per case of 1` listings. Rationale:
//  - A case-of-6 unit price is not a price anyone can pay for one bottle, so publishing it would
//    hand Elbow bogus "cheapest"/best-price badges, fire false price-drop alerts, and drag the
//    market-median stats down.
//  - ~94% of the catalogue is products other stores already carry, so nothing is lost.
//  - The case-of-1 rows are precisely the rare/collectible bottles worth tracking (Glen Grant
//    Platinum Jubilee 1952, Bowmore 30YO, Glen Grant 1962 Archive Release, Dalmore 25YO,
//    Ardbeg 25YO …) and their per-unit price IS a real single-bottle price.
// Measured: 31 such listings (30 whisky, 1 rum). If vinox switches an item to single-bottle
// sale it starts being tracked automatically; if it moves to a multipack it retires.
//
// SKUs are not in the listing (only a 4-digit internal `data-product-id`), but the product page
// carries the real 6-digit AGLC CSPC in JSON-LD, so new items get a budgeted detail fetch. The
// tracked set is tiny, so one run hydrates everything.

const { decodeHtml, cleanText, extractFirstImgUrl } = require("../utils/html");
const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { avoidMassRemoval } = require("../tracker/merge");
const { finalizeCategoryScan } = require("../tracker/finalize");

const HOST = "vinox.ca";
const PAGE_HARD_CAP = 80; // ~43 pages on whisky today; cap guards a pagination loop
const SKU_FETCH_BUDGET = 60; // detail fetches per category per run (tracked set is ~31 total)

// Only single-bottle listings are tracked — see the header note.
const MAX_CASE_SIZE = 1;

function priceStr(n) {
	const v = Number(String(n == null ? "" : n).replace(/[^0-9.]/g, ""));
	return Number.isFinite(v) && v > 0 ? `$${v.toFixed(2)}` : "";
}

// One product per `<div class="col">` grid cell.
function parseProductsVinox(html, ctx) {
	const out = [];
	const cells = String(html || "").split(/<div class="col">/i).slice(1);

	for (const cell of cells) {
		const caseSize = Number(/per case of\s*(\d+)/i.exec(cell)?.[1] || 0);
		if (!Number.isFinite(caseSize) || caseSize < 1) continue;
		if (caseSize > MAX_CASE_SIZE) continue;

		const href = /href="(\/product\/[^"]+)"/i.exec(cell)?.[1];
		if (!href) continue;
		let url = "";
		try {
			url = new URL(decodeHtml(href), `https://${HOST}/`).toString();
		} catch {
			continue;
		}

		const nameRaw =
			/<h2[^>]*class="[^"]*card-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i.exec(cell)?.[1] ||
			/data-product-name="([^"]*)"/i.exec(cell)?.[1] ||
			"";
		const name = cleanText(decodeHtml(nameRaw));
		if (!name) continue;

		// The bold primary price is the PER-UNIT price; `data-product-price` is the case total.
		const unit = /class="[^"]*text-primary[^"]*"[^>]*>\s*\$([\d.,]+)/i.exec(cell)?.[1];
		const price = priceStr(unit);

		const internalId = String(/data-product-id="([^"]+)"/i.exec(cell)?.[1] || "").trim();
		// Real CSPC comes from the detail page; until then key off the internal id so the record
		// is stable across runs (pickBetterSku upgrades it once hydrated).
		const seed = /^\d{1,11}$/.test(internalId) ? `id:${internalId}` : "";
		const sku = normalizeSkuKey(seed, { storeLabel: ctx?.store?.name, url });

		out.push({ name, price, url, sku, img: extractFirstImgUrl(cell, `https://${HOST}/`) });
	}

	return out;
}

// A record still needs a detail fetch while its sku is empty, synthetic (`u:`) or merely the
// store's internal `id:` seed — only a real CSPC links across stores. (Deliberately NOT
// utils/sku.js::needsSkuDetail, which treats `id:` as already-good.)
function needsCspcHydration(sku) {
	const s = String(sku ?? "").trim();
	return !s || /^u:/i.test(s) || /^id:/i.test(s);
}

// JSON-LD on the product page carries the AGLC CSPC: "sku": "125973".
function extractVinoxCspc(html) {
	const s = String(html || "");
	const m = /"sku"\s*:\s*"?(\d{5,7})"?/i.exec(s);
	return m ? m[1] : "";
}

async function scanCategoryVinox(ctx, prevDb, report) {
	const t0 = Date.now();
	const slug = String(ctx.cat.vinoxSlug || "").trim();
	if (!slug) {
		ctx.logger.warn(`${ctx.catPrefixOut} | vinox missing category slug; skipping scan.`);
		return;
	}

	const discovered = new Map();
	const maxPages = ctx.config.maxPages === null ? PAGE_HARD_CAP : Math.min(ctx.config.maxPages, PAGE_HARD_CAP);

	let scanned = 0;
	let seenTotal = 0;
	for (let page = 1; page <= maxPages; page++) {
		const url = `https://${HOST}/shop/spirits/${slug}${page > 1 ? `?Page=${page}` : ""}`;
		const { text } = await ctx.http.fetchTextWithRetry(url, `elbow:vinox:${ctx.cat.key}:p${page}`, ctx.store.ua);
		scanned++;

		const cells = text.split(/<div class="col">/i).length - 1;
		seenTotal += cells;
		for (const it of parseProductsVinox(text, ctx)) discovered.set(it.url, it);

		// Pagination advertises the last page in ?Page=N links; stop once we pass it.
		const lastPage = Math.max(0, ...[...text.matchAll(/[?&]Page=(\d+)/gi)].map((m) => Number(m[1]) || 0));
		if (!cells || (lastPage && page >= lastPage)) break;
	}

	ctx.logger.ok(
		`${ctx.catPrefixOut} | vinox pages=${scanned} listings=${seenTotal} single-bottle kept=${discovered.size}`,
	);

	// Hydrate real CSPCs for items we don't already have one for.
	let fetched = 0;
	for (const it of discovered.values()) {
		if (fetched >= SKU_FETCH_BUDGET) break;
		const prev = prevDb?.byUrl?.get(it.url) || null;
		if (prev && !needsCspcHydration(prev.sku)) {
			// Already hydrated on an earlier run — reuse, don't re-fetch.
			it.sku = pickBetterSku(it.sku, prev.sku);
			continue;
		}
		try {
			const { text } = await ctx.http.fetchTextWithRetry(
				it.url,
				`elbow:vinox:sku:${ctx.cat.key}:${fetched}`,
				ctx.store.ua,
			);
			fetched++;
			const cspc = extractVinoxCspc(text);
			if (cspc) it.sku = pickBetterSku(normalizeSkuKey(cspc, { storeLabel: ctx.store.name, url: it.url }), it.sku);
		} catch {
			/* keep the id: seed; a later run retries */
		}
	}
	if (fetched) ctx.logger.ok(`${ctx.catPrefixOut} | vinox CSPC detail fetches=${fetched}`);

	avoidMassRemoval(prevDb, discovered, ctx, `vinox pages=${scanned}`, report);
	finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: scanned });
}

function createStore(defaultUa) {
	const cat = (key, label, slug) => ({
		key,
		label,
		startUrl: `https://${HOST}/shop/spirits/${slug}`,
		vinoxSlug: slug,
	});
	return {
		key: "elbowliquor",
		region: "AB",
		name: "Elbow Liquor",
		host: HOST,
		ua: defaultUa,
		scanCategory: scanCategoryVinox,
		categories: [cat("whisky", "Whisky", "whisky"), cat("rum", "Rum", "rum"), cat("gin", "Gin", "gin")],
	};
}

module.exports = { createStore, parseProductsVinox };
