"use strict";

const { padLeft, padRight } = require("../utils/string");
const { kbStr, secStr, pageStr, pctStr } = require("../utils/format");
const { barnetItemToTracked, buildBarnetApiUrl } = require("../utils/barnet");

const { finalizeCategoryScan } = require("../tracker/finalize");



async function fetchVintagePage(ctx, page) {
	const url = buildBarnetApiUrl(
		ctx.store.host,
		ctx.store.shopId,
		ctx.cat.vsCategory,
		ctx.cat.vsSubCategory,
		page,
		"desc",
	);
	return await ctx.http.fetchJsonWithRetry(url, `vintage:api:${ctx.cat.key}:p${page}`, ctx.store.ua, {
		method: "GET",
		headers: {
			Accept: "*/*",
			Referer: ctx.cat.startUrl,
			Origin: `https://${ctx.store.host}`,
		},
		// cookies not required in my testing; enable if you hit 403/empty
		cookies: true,
	});
}

async function scanCategoryVintageApi(ctx, prevDb, report) {
	const t0 = Date.now();

	let first;
	try {
		first = await fetchVintagePage(ctx, 1);
	} catch (e) {
		ctx.logger.warn(`${ctx.catPrefixOut} | Vintage API fetch failed: ${e?.message || e}`);

		const discovered = new Map();
		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 1 });
		return;
	}

	const totalPages = Math.max(1, Number(first?.json?.paginator?.pages) || 1);
	const scanPages = ctx.config.maxPages === null ? totalPages : Math.min(ctx.config.maxPages, totalPages);

	ctx.logger.ok(
		`${ctx.catPrefixOut} | Pages: ${scanPages}${scanPages !== totalPages ? ` (cap from ${totalPages})` : ""}`,
	);

	const pages = [];
	for (let p = 1; p <= scanPages; p++) pages.push(p);

	let donePages = 0;

	const perPageItems = await require("../utils/async").parallelMapStaggered(
		pages,
		ctx.config.concurrency,
		ctx.config.staggerMs,
		async (page, idx) => {
			const r = page === 1 ? first : await fetchVintagePage(ctx, page);
			const arr = Array.isArray(r?.json?.items) ? r.json.items : [];

			const items = [];
			for (const raw of arr) {
				const it = barnetItemToTracked(raw, ctx);
				if (it) items.push(it);
			}

			donePages++;
			ctx.logger.ok(
				`${ctx.catPrefixOut} | Page ${pageStr(idx + 1, pages.length)} | ${String(r.status || "").padEnd(
					3,
				)} | ${pctStr(donePages, pages.length)} | items=${padLeft(items.length, 3)} | bytes=${kbStr(
					r.bytes,
				)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`,
			);

			return items;
		},
	);

	const discovered = new Map();
	let dups = 0;
	for (const arr of perPageItems) {
		for (const it of arr) {
			if (discovered.has(it.url)) dups++;
			discovered.set(it.url, it);
		}
	}

	ctx.logger.ok(
		`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}${dups ? ` (${dups} dups)` : ""}`,
	);

	finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: scanPages });
}

function createStore(defaultUa) {
	return {
		key: "vintage",
		region: "BC",
		name: "Vintage Spirits",
		host: "shop.vintagespirits.ca",
		shopId: "679-320",
		ua: defaultUa,
		scanCategory: scanCategoryVintageApi,
		categories: [
			{
				key: "whisky-whiskey",
				label: "Whisky & Whiskey",
				startUrl: "https://shop.vintagespirits.ca/products?category=40+SPIRITS&sub_category=WHISKY+%26+WHISKEY",
				vsCategory: "40 SPIRITS",
				vsSubCategory: "WHISKY & WHISKEY",
			},
			{
				key: "single-malt-whisky",
				label: "Single Malt Whisky",
				startUrl: "https://shop.vintagespirits.ca/products?category=40+SPIRITS&sub_category=SINGLE+MALT+WHISKY",
				vsCategory: "40 SPIRITS",
				vsSubCategory: "SINGLE MALT WHISKY",
			},
			{
				key: "rum",
				label: "Rum",
				startUrl: "https://shop.vintagespirits.ca/products?category=40+SPIRITS&sub_category=RUM",
				vsCategory: "40 SPIRITS",
				vsSubCategory: "RUM",
			},
			{
				key: "gin",
				label: "Gin",
				startUrl: "https://shop.vintagespirits.ca/products?category=40+SPIRITS&sub_category=GIN",
				vsCategory: "40 SPIRITS",
				vsSubCategory: "GIN",
			},
		],
	};
}

module.exports = { createStore };
