// src/platforms/barnet_network.js
"use strict";

// Platform adapter for Barnet Network storefronts (s.barnetnetwork.com).
// Used by newer Barnet stores (High Point BWS, New District). The existing
// arc.js / vintagespirits.js stores predate this adapter and still carry
// their own copies of the scan loop — migrating them is future work.
//
// The store config provides `shopId` (e.g. "96") and per-category opts via
// the closure below; the adapter walks the paginated Barnet products API and
// maps each row through the shared barnet helpers.

const { padLeft, padRight } = require("../utils/string");
const { kbStr, secStr, pageStr } = require("../utils/format");
const { barnetItemToTracked, buildBarnetApiUrl } = require("../utils/barnet");
const { avoidMassRemoval } = require("../tracker/merge");
const { finalizeCategoryScan } = require("../tracker/finalize");

// Shared raw-item cache so a broad category (e.g. all SPIRITS) is fetched
// once per run and reused across the store's whisky/rum/gin categories.
const _barnetRawCache = new Map(); // key host|shopId|category|sortBy -> Promise<{items, pages, aborted}>

async function fetchAllBarnetItems(ctx, category, subCategory, sortBy) {
	const items = [];
	const maxPagesCap = ctx.config.maxPages === null ? 5000 : ctx.config.maxPages;
	const hardCap = Math.min(5000, Math.max(1, maxPagesCap));
	let pages = 0;
	let aborted = false;
	let pageSize = 0;
	const seen = new Set();
	let stagnant = 0;

	for (let page = 1; page <= hardCap; page++) {
		const pageUrl = buildBarnetApiUrl(ctx.store.host, ctx.store.shopId, category, subCategory, page, sortBy);
		let r;
		try {
			r = await ctx.http.fetchJsonWithRetry(pageUrl, `${ctx.store.key}:api:${ctx.cat.key}:p${page}`, ctx.store.ua, {
				method: "GET",
				headers: {
					Accept: "application/json, */*",
					"X-Requested-With": "XMLHttpRequest",
					Referer: ctx.cat.startUrl,
				},
			});
		} catch (e) {
			ctx.logger.warn(`${ctx.catPrefixOut} | Barnet API page ${page} failed: ${e?.message || e}`);
			aborted = true;
			break;
		}

		const arr = Array.isArray(r?.json?.items) ? r.json.items : [];
		pages++;
		const rawCount = arr.length;
		if (!rawCount) break;
		if (!pageSize) pageSize = rawCount;

		const fp = arr.map((p) => `${p?.id || ""}:${p?.url || ""}`).sort().join("|");
		if (fp && seen.has(fp)) break;
		if (fp) seen.add(fp);

		const before = items.length;
		items.push(...arr);

		if (pageSize && rawCount < pageSize) break;
		if (items.length === before) stagnant++;
		else stagnant = 0;
		if (stagnant >= 2) break;
	}

	return { items, pages, aborted };
}

/**
 * createBarnetAdapter
 *
 * opts:
 *  - category: string (Barnet `category` param, e.g. "SPIRITS")
 *  - subCategory: string (Barnet `sub_category` param, case-sensitive). Server-side
 *      filter. NOTE: on some shops sub_category=WHISKEY undercounts (scotch/world
 *      whisky carry category_name=WHISKEY but a different sub_category) — prefer
 *      allowItem in that case.
 *  - allowItem: (rawItem) => boolean. When provided, the broad `category` is
 *      fetched once (shared cache) and classified client-side. subCategory is
 *      left empty for the fetch.
 *  - sortBy: string (default "price_desc")
 */
function createBarnetAdapter(opts) {
	const {
		category = "",
		subCategory = "",
		allowItem = null,
		sortBy = "price_desc",
	} = opts || {};

	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();

		// Warm cookies / session.
		try {
			await ctx.http.fetchTextWithRetry(ctx.cat.startUrl, `${ctx.store.key}:warm:${ctx.cat.key}`, ctx.store.ua);
		} catch (_) {}

		const cat = String(category).trim();
		const sub = String(subCategory).trim();
		const useClientFilter = typeof allowItem === "function";

		if (!sub && !useClientFilter) {
			ctx.logger.warn(`${ctx.catPrefixOut} | Barnet missing sub_category and allowItem; skipping scan.`);
			return;
		}

		// Fetch raw items: broad+cached when client-filtering, else server-filtered.
		let raw;
		if (useClientFilter) {
			const key = `${ctx.store.host}|${ctx.store.shopId}|${cat}|${sortBy}`;
			let p = _barnetRawCache.get(key);
			if (!p) {
				p = fetchAllBarnetItems(ctx, cat, "", sortBy);
				_barnetRawCache.set(key, p);
			}
			raw = await p;
		} else {
			raw = await fetchAllBarnetItems(ctx, cat, sub, sortBy);
		}

		const discovered = new Map();
		for (const p of raw.items) {
			if (useClientFilter && !allowItem(p)) continue;
			const it = barnetItemToTracked(p, ctx);
			if (!it) continue;
			discovered.set(it.url, it);
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | Barnet pages=${pageStr(raw.pages, raw.pages)} raw=${padLeft(raw.items.length, 4)} kept=${padLeft(discovered.size, 4)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(Date.now() - t0)} | ${kbStr(0)}`,
		);

		if (raw.aborted) {
			avoidMassRemoval(prevDb, discovered, ctx, `api pages=${raw.pages} sub=${sub || "(client)"}`);
		}

		const { merged, metaChangedItems } = finalizeCategoryScan(ctx, prevDb, discovered, report, {
			t0,
			scannedPages: Math.max(1, raw.pages),
		});
		ctx.logger.ok(`${ctx.catPrefixOut} | DB saved: ${ctx.logger.dim(ctx.dbFile)} (${merged.size} items)`);
		report.totals.metaChangedCount += metaChangedItems.length;
	};
}

module.exports = { createBarnetAdapter };
