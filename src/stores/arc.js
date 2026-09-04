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

	// The API reports its own totals ("paginator":{"page":1,"pages":7,"items_count":102}).
	// We record them so the sweep can be checked for completeness below.
	let apiItemsCount = 0;
	let apiPages = 0;
	const rawIds = new Set(); // every row id the API handed us, pre stock-filter

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

		const pag = r?.json?.paginator;
		if (pag) {
			if (Number.isFinite(Number(pag.items_count))) apiItemsCount = Number(pag.items_count);
			if (Number.isFinite(Number(pag.pages))) apiPages = Number(pag.pages);
		}

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
			// Count the RAW row before any stock filtering. Completeness below is measured
			// against the API's own items_count, which is a raw row count — comparing it to
			// the post-filter map would report a permanent shortfall the moment the API
			// starts returning an out-of-stock row.
			if (p && p.id !== undefined && p.id !== null) rawIds.add(String(p.id));
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

	// Completeness safety net.
	//
	// The Barnet API pages via LIMIT/OFFSET and re-runs its ORDER BY per request, so rows that
	// TIE on the sort key can swap between requests: one lands on both neighbouring pages (a
	// harmless duplicate) while its tied partner lands on neither and is silently skipped. The
	// skipped listing then looks like a sellout and "restocks" next run.
	//
	// Measured live under the old `price_desc` sort: Spirits-Rum served 101 of 102 rows and
	// Spirits-Whiskey 159 of 160, with `rowsFetched === items_count` and
	// `duplicateRows === shortfall` in every category — i.e. the API always hands over exactly
	// items_count rows, just with one of them repeated in place of another. On Rum the pair was
	// 478594 and 265031, both $87.99, straddling the page-1/page-2 boundary.
	//
	// The categories now sort by `name_asc`, which has no ties in this catalog and returns
	// 160/160, 227/227, 102/102 and 83/83. This block stays as the self-healing net for a
	// future tie: re-sweep with a DIFFERENT sort, which re-partitions the pages and surfaces
	// the skipped row. Re-sweeping the SAME order is useless — the skip is deterministic
	// (verified: 5/5 identical sweeps repeated row 410603 and dropped the same partner).
	const primarySort = ctx.cat.sortBy || "price_desc";
	const RESWEEP_SORT = primarySort === "price_asc" ? "name_asc" : "price_asc";
	// Under --maxPages the short sweep is intentional, so don't "repair" it.
	if (ctx.config.maxPages === null && !aborted && apiItemsCount > 0 && apiPages > 0 && rawIds.size < apiItemsCount) {
		const reCap = Math.min(apiPages, hardCap); // never trust a remote page count unbounded
		ctx.logger.warn(
			`${ctx.catPrefixOut} | ARC sweep incomplete: ${rawIds.size}/${apiItemsCount} rows; re-sweeping ${reCap} page(s) as ${RESWEEP_SORT}.`,
		);
		for (let page = 1; page <= reCap && rawIds.size < apiItemsCount; page++) {
			try {
				const r = await ctx.http.fetchJsonWithRetry(
					buildBarnetApiUrl(ctx.store.host, ctx.store.shopId, category, subCategory, page, RESWEEP_SORT),
					`arc:api:${ctx.cat.key}:resweep:p${page}`,
					ctx.store.ua,
					{ method: "GET", headers: { Accept: "application/json, */*", "X-Requested-With": "XMLHttpRequest", Referer: ctx.cat.startUrl } },
				);
				for (const p of Array.isArray(r?.json?.items) ? r.json.items : []) {
					if (p && p.id !== undefined && p.id !== null) rawIds.add(String(p.id));
					const it = barnetItemToTracked(p, ctx);
					if (it) discovered.set(it.url, it);
				}
			} catch (e) {
				ctx.logger.warn(`${ctx.catPrefixOut} | ARC re-sweep page ${page} failed: ${e?.message || e}`);
				break;
			}
		}
		ctx.logger.ok(`${ctx.catPrefixOut} | ARC after re-sweep: ${rawIds.size}/${apiItemsCount} rows`);
	}

	// Deliberately NO "preserve unseen listings" fallback on a remaining shortfall. A genuine
	// sellout also lowers items_count, so a leftover gap cannot be told apart from one, and
	// carrying unseen records forward would pin a real sellout live indefinitely. Re-sweeping is
	// safe because it can only ADD rows the API actually serves; inferring stock from a gap is
	// not. (An earlier version of this fix did preserve, justified by 287777 STILLHEAD PX CASK
	// RYE looking permanently absent under price_desc — it was in fact the straddle victim, and
	// name_asc returns it. Don't reintroduce the fallback on that evidence.)
	if (aborted) {
		avoidMassRemoval(prevDb, discovered, ctx, `api pages=${donePages} sub=${subCategory}`, report);
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
				sortBy: "name_asc",
			},
			{
				key: "spirits-scotch",
				label: "Spirits - Scotch",
				startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Scotch",
				arcCategory: "Spirits",
				arcSubCategory: "Scotch",
				sortBy: "name_asc",
			},
			{
				key: "spirits-whiskey",
				label: "Spirits - Whiskey",
				startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Whiskey",
				arcCategory: "Spirits",
				arcSubCategory: "Whiskey",
				sortBy: "name_asc",
			},
			{
				key: "spirits-gin",
				label: "Spirits - Gin",
				startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Gin",
				arcCategory: "Spirits",
				arcSubCategory: "Gin",
				sortBy: "name_asc",
			},
		],
	};
}

module.exports = { createStore };
