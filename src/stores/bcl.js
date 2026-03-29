"use strict";

const { normalizeCspc } = require("../utils/sku");
const { padLeft, padRight } = require("../utils/string");
const { kbStr, secStr, pageStr, pctStr, cad } = require("../utils/format");
const { normalizeAbsUrl: _normUrl } = require("../utils/url");

const { finalizeCategoryScan } = require("../tracker/finalize");


function asNumber(n) {
	if (n == null) return NaN;
	if (typeof n === "number") return n;
	const t = String(n).trim();
	if (!t) return NaN;
	const x = Number(t.replace(/[^0-9.]/g, ""));
	return x;
}

function bclTotalHits(json) {
	const t = json?.hits?.total;
	if (typeof t === "number") return t;
	if (t && typeof t.value === "number") return t.value; // ES-style
	return 0;
}

function bclIsInStock(src) {
	const candidates = [
		src?.availability_override, // <-- add this
		src?.availability,
		src?.availabilityText,
		src?.availabilityStatus,
		src?.availability_status,
		src?.stockStatus,
		src?.stock_status,
		src?.status,
		src?.statusText,
	]
		.map((v) => (v == null ? "" : String(v)))
		.filter(Boolean);

	for (const s of candidates) {
		if (/out of stock/i.test(s)) return false;
		if (/\bin stock\b/i.test(s)) return true;
		if (/\bavailable\b/i.test(s)) return true; // "Available Feb 07"
	}

	const units = Number(src?.availableUnits);
	if (Number.isFinite(units)) return units > 0;

	return true;
}

const bclNormalizeAbsUrl = (raw) => _normUrl(raw, "https://www.bcliquorstores.com/");

function bclPickImage(src) {
	const cands = [
		src?.imageUrl,
		src?.imageURL,
		src?.image,
		src?.thumbnail,
		src?.thumbnailUrl,
		src?.thumbnailURL,
		src?.primaryImage,
		src?.primaryImageUrl,
	];

	for (const c of cands) {
		if (typeof c === "string" && c.trim()) return bclNormalizeAbsUrl(c);
	}

	const arrs = [src?.images, src?.imageUrls, src?.image_urls];
	for (const a of arrs) {
		if (!Array.isArray(a) || !a.length) continue;
		const v = a[0];
		if (typeof v === "string" && v.trim()) return bclNormalizeAbsUrl(v);
		if (v && typeof v === "object") {
			const s = String(v.src || v.url || "").trim();
			if (s) return bclNormalizeAbsUrl(s);
		}
	}

	return "";
}

function bclHitToItem(hit) {
	const src = hit?._source || null;
	if (!src) return null;

	const skuRaw = src.sku != null ? String(src.sku).trim() : "";
	if (!skuRaw) return null;

	// SKU in URL (requested)
	const url = `https://www.bcliquorstores.com/product/${encodeURIComponent(skuRaw)}`;

	const name = String(src.name || "").trim();
	if (!name) return null;

	// Sale support: pick currentPrice when present; otherwise regularPrice.
	const current = asNumber(src.currentPrice);
	const regular = asNumber(src.regularPrice);
	const price = cad(Number.isFinite(current) ? current : regular);

	// SKU key:
	// - Keep CSPC 6-digit when present (rare for BCL, but safe)
	// - Otherwise upgrade to an explicit soft key: id:<digits>
	//
	// ✅ PATCH: handle tiny SKUs too (3/4/5-digit) by forcing id:<digits>
	//          only fall back to raw (NOT u:) if it’s genuinely non-numeric.
	let sku = normalizeCspc(skuRaw);
	if (!sku) {
		const m = skuRaw.match(/^\d{1,6}$/); // BCL product IDs like 141, 596, 984, 117, etc.
		sku = m ? `id:${m[0]}` : `id:${skuRaw}`;
	}

	const inStock = bclIsInStock(src);
	if (!inStock) return null;

	// ✅ Fix: BCL appears to serve .jpg (not .jpeg) for these imagecache URLs.
	// Also use https.
	const img = `https://www.bcliquorstores.com/sites/default/files/imagecache/height400px/${encodeURIComponent(
		skuRaw,
	)}.jpg`;

	return { name, price, url, sku, img };
}

async function bclFetchBrowsePage(ctx, page1, size) {
	const type = ctx.cat.bclType; // e.g. "rum" or "whisky / whiskey"
	const category = "spirits";
	const sort = "featuredProducts:desc";

	const u = new URL("https://www.bcliquorstores.com/ajax/browse");
	u.searchParams.set("category", category);
	u.searchParams.set("type", type);
	u.searchParams.set("sort", sort);
	u.searchParams.set("size", String(size));
	u.searchParams.set("page", String(page1));

	const referer =
		`https://www.bcliquorstores.com/product-catalogue?` +
		`category=${encodeURIComponent(category)}` +
		`&type=${encodeURIComponent(type)}` +
		`&sort=${encodeURIComponent(sort)}` +
		`&page=${encodeURIComponent(String(page1))}`;

	return await ctx.http.fetchJsonWithRetry(u.toString(), `bcl:${ctx.cat.key}:p${page1}`, ctx.store.ua, {
		method: "GET",
		headers: {
			Accept: "application/json, text/plain, */*",
			Referer: referer,
			Origin: "https://www.bcliquorstores.com",
		},
	});
}

async function scanCategoryBCLAjax(ctx, prevDb, report) {
	const t0 = Date.now();
	const size = 24;

	let first;
	try {
		first = await bclFetchBrowsePage(ctx, 1, size);
	} catch (e) {
		ctx.logger.warn(`${ctx.catPrefixOut} | BCL browse fetch failed: ${e?.message || e}`);

		const discovered = new Map();
		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 1 });
		return;
	}

	const total = bclTotalHits(first?.json);
	const totalPages = Math.max(1, Math.ceil(total / size));
	const scanPages = ctx.config.maxPages === null ? totalPages : Math.min(ctx.config.maxPages, totalPages);

	ctx.logger.ok(
		`${ctx.catPrefixOut} | Total=${total} Size=${size} Pages: ${scanPages}${scanPages !== totalPages ? ` (cap from ${totalPages})` : ""}`,
	);

	const pageNums = [];
	for (let p = 1; p <= scanPages; p++) pageNums.push(p);

	let donePages = 0;

	const perPageItems = await require("../utils/async").parallelMapStaggered(
		pageNums,
		ctx.config.concurrency,
		ctx.config.staggerMs,
		async (page1, idx) => {
			const r = page1 === 1 ? first : await bclFetchBrowsePage(ctx, page1, size);
			const hits = Array.isArray(r?.json?.hits?.hits) ? r.json.hits.hits : [];

			const items = [];
			for (const h of hits) {
				const it = bclHitToItem(h);
				if (it) items.push(it);
			}

			donePages++;
			ctx.logger.ok(
				`${ctx.catPrefixOut} | Page ${pageStr(idx + 1, pageNums.length)} | ${String(r.status || "").padEnd(3)} | ${pctStr(donePages, pageNums.length)} | items=${padLeft(
					items.length,
					3,
				)} | bytes=${kbStr(r.bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`,
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

	const { merged } = finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: scanPages });
	ctx.logger.ok(`${ctx.catPrefixOut} | DB saved: ${ctx.logger.dim(ctx.dbFile)} (${merged.size} items)`);
}

function createStore(defaultUa) {
	return {
		key: "bcl",
		region: "BC",
		name: "BCL",
		host: "www.bcliquorstores.com",
		ua: defaultUa,
		scanCategory: scanCategoryBCLAjax, // JSON-driven (async browse)
		categories: [
			{
				key: "whisky",
				label: "Whisky / Whiskey",
				// informational only; scan uses ajax/browse
				startUrl:
					"https://www.bcliquorstores.com/product-catalogue?category=spirits&type=whisky%20/%20whiskey&sort=featuredProducts:desc&page=1",
				bclType: "whisky / whiskey",
			},
			{
				key: "rum",
				label: "Rum",
				startUrl:
					"https://www.bcliquorstores.com/product-catalogue?category=spirits&type=rum&sort=featuredProducts:desc&page=1",
				bclType: "rum",
			},
			{
				key: "gin",
				label: "Gin",
				startUrl:
					"https://www.bcliquorstores.com/product-catalogue?category=spirits&type=gin&sort=featuredProducts:desc&page=1",
				bclType: "gin",
			},
		],
	};
}

module.exports = { createStore };
