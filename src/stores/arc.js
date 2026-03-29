// src/stores/arc.js
"use strict";

const { padLeft, padRight } = require("../utils/string");
const { kbStr, secStr, pageStr, pctStr } = require("../utils/format");
const { barnetItemToTracked, buildBarnetApiUrl } = require("../utils/barnet");

const { avoidMassRemoval } = require("../tracker/merge");
const { finalizeCategoryScan } = require("../tracker/finalize");


function parseCategoryParamsFromStartUrl(startUrl) {
	try {
		const u = new URL(startUrl);
		const category = u.searchParams.get("category") || "";
		const sub = u.searchParams.get("sub_category") || "";
		return { category, sub };
	} catch {
		return { category: "", sub: "" };
	}
}


async function scanCategoryArcApi(ctx, prevDb, report) {
	const t0 = Date.now();

	// Warm cookies / session (Barnet-based shops sometimes need this)
	try {
		await ctx.http.fetchTextWithRetry(ctx.cat.startUrl, `arc:warm:${ctx.cat.key}`, ctx.store.ua);
	} catch (_) {}

	const { category: urlCat, sub: urlSub } = parseCategoryParamsFromStartUrl(ctx.cat.startUrl);
	const category = String(ctx.cat.arcCategory || urlCat || "Spirits").trim();
	const subCategory = String(ctx.cat.arcSubCategory || urlSub || "").trim();

	if (!subCategory) {
		ctx.logger.warn(`${ctx.catPrefixOut} | ARC missing sub_category; skipping scan.`);
		return;
	}

	const discovered = new Map();

	const maxPagesCap = ctx.config.maxPages === null ? 5000 : ctx.config.maxPages;
	const hardCap = Math.min(5000, Math.max(1, maxPagesCap));

	let donePages = 0;
	let aborted = false;

	// Pagination safety
	let pageSize = 0; // inferred from first non-empty page
	const seenPageFingerprints = new Set();
	let stagnantPages = 0;

	for (let page = 1; page <= hardCap; page++) {
		const pageUrl = buildBarnetApiUrl(
			ctx.store.host,
			ctx.store.shopId,
			category,
			subCategory,
			page,
			ctx.cat.sortBy || "price_desc",
		);

		let r;
		try {
			r = await ctx.http.fetchJsonWithRetry(pageUrl, `arc:api:${ctx.cat.key}:p${page}`, ctx.store.ua, {
				method: "GET",
				headers: {
					Accept: "application/json, */*",
					"X-Requested-With": "XMLHttpRequest",
					Referer: ctx.cat.startUrl,
				},
			});
		} catch (e) {
			ctx.logger.warn(`${ctx.catPrefixOut} | ARC API page ${page} failed: ${e?.message || e}`);
			aborted = true;
			break;
		}

		const arr = Array.isArray(r?.json?.items) ? r.json.items : [];
		donePages++;

		const rawCount = arr.length;

		// Log early (even for empty)
		ctx.logger.ok(
			`${ctx.catPrefixOut} | API Page ${pageStr(donePages, donePages)} | ${(r?.status || "")
				.toString()
				.padEnd(3)} | raw=${padLeft(rawCount, 3)} kept=${padLeft(0, 3)} | bytes=${kbStr(r.bytes)} | ${padRight(
				ctx.http.inflightStr(),
				11,
			)} | ${secStr(r.ms)}`,
		);

		if (!rawCount) break;

		// Infer page size from first non-empty page
		if (!pageSize) pageSize = rawCount;

		// Detect wrap/repeat: fingerprint by ids+urls (stable enough)
		const fp = arr
			.map((p) => `${p?.id || ""}:${p?.url || ""}`)
			.sort()
			.join("|");
		if (fp && seenPageFingerprints.has(fp)) {
			ctx.logger.warn(`${ctx.catPrefixOut} | ARC pagination repeated at p=${page}; stopping.`);
			break;
		}
		if (fp) seenPageFingerprints.add(fp);

		const before = discovered.size;

		let kept = 0;
		for (const p of arr) {
			const it = barnetItemToTracked(p, ctx);
			if (!it) continue;
			discovered.set(it.url, it);
			kept++;
		}

		// Re-log with kept filled in (overwrite-style isn't possible; just emit a second line)
		ctx.logger.ok(
			`${ctx.catPrefixOut} | API Page ${pageStr(donePages, donePages)} | ${(r?.status || "")
				.toString()
				.padEnd(
					3,
				)} | raw=${padLeft(rawCount, 3)} kept=${padLeft(kept, 3)} | bytes=${kbStr(r.bytes)} | ${padRight(
				ctx.http.inflightStr(),
				11,
			)} | ${secStr(r.ms)}`,
		);

		// Stop condition #1: last page (short page)
		if (pageSize && rawCount < pageSize) break;

		// Stop condition #2: no new uniques for 2 pages (safety)
		if (discovered.size === before) stagnantPages++;
		else stagnantPages = 0;

		if (stagnantPages >= 2) {
			ctx.logger.warn(`${ctx.catPrefixOut} | ARC pagination stalled (no new items); stopping.`);
			break;
		}
	}

	if (aborted) {
		avoidMassRemoval(prevDb, discovered, ctx, `api pages=${donePages} sub=${subCategory}`);
	}

	ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);

	const { merged, metaChangedItems } = finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: Math.max(1, donePages) });
	ctx.logger.ok(`${ctx.catPrefixOut} | DB saved: ${ctx.logger.dim(ctx.dbFile)} (${merged.size} items)`);
	report.totals.metaChangedCount += metaChangedItems.length;
}

function createStore(defaultUa) {
	return {
		key: "arc",
		region: "BC",
		name: "ARC Liquor",
		host: "kelownaharveyave.armstrong.coop",
		shopId: "644-290",
		ua: defaultUa,
		scanCategory: scanCategoryArcApi,
		categories: [
			{
				key: "spirits-rum",
				label: "Spirits - Rum",
				startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Rum",
				arcCategory: "Spirits",
				arcSubCategory: "Rum",
				sortBy: "price_desc",
			},
			{
				key: "spirits-scotch",
				label: "Spirits - Scotch",
				startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Scotch",
				arcCategory: "Spirits",
				arcSubCategory: "Scotch",
				sortBy: "price_desc",
			},
			{
				key: "spirits-whiskey",
				label: "Spirits - Whiskey",
				startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Whiskey",
				arcCategory: "Spirits",
				arcSubCategory: "Whiskey",
				sortBy: "price_desc",
			},
			{
				key: "spirits-gin",
				label: "Spirits - Gin",
				startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Gin",
				arcCategory: "Spirits",
				arcSubCategory: "Gin",
				sortBy: "price_desc",
			},
		],
	};
}

module.exports = { createStore };
