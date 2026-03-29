// src/stores/kwm.js
"use strict";

const { decodeHtml, stripTags, cleanText, extractHtmlAttr, escapeRe, extractFirstImgUrl } = require("../utils/html");
const { sanitizeName } = require("../utils/text");
const { normalizeCspc } = require("../utils/sku");
const { normalizeBaseUrl } = require("../utils/url");
const { parallelMapStaggered } = require("../utils/async");

const { padLeft, padRight } = require("../utils/string");
const { kbStr, secStr, pageStr, pctStr } = require("../utils/format");

const { avoidMassRemoval } = require("../tracker/merge");
const { finalizeCategoryScan } = require("../tracker/finalize");


/* ---------------- paging ---------------- */

function makePageUrlKWM(baseUrl, pageNum) {
	const u = new URL(normalizeBaseUrl(baseUrl));
	u.hash = "";
	if (pageNum <= 1) {
		u.searchParams.delete("page");
		u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : "";
		return u.toString();
	}
	u.searchParams.set("page", String(pageNum));
	u.search = `?${u.searchParams.toString()}`;
	return u.toString();
}

/* ---------------- listing block extraction ---------------- */

function extractDivBlocksByExactClass(html, className, maxBlocks) {
	const out = [];
	const s = String(html || "");

	const re = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${escapeRe(className)}\\b[^"']*["'][^>]*>`, "gi");

	let m;
	while ((m = re.exec(s))) {
		if (out.length >= maxBlocks) break;

		const startTagEnd = m.index + m[0].length;
		let i = startTagEnd;
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

/* ---------------- product tile field extraction ---------------- */

function kwmExtractProductLinkHref(block) {
	let m =
		block.match(/<a\b[^>]*class=["'][^"']*\bproduct-link\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>\s*<\/a>/i) ||
		block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bproduct-link\b[^"']*["'][^>]*>\s*<\/a>/i);

	if (m && m[1]) return m[1].trim();

	m =
		block.match(/<a\b[^>]*class=["'][^"']*\bproduct-link\b[^"']*["'][^>]*href=["']([^"']+)["']/i) ||
		block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bproduct-link\b[^"']*["']/i);

	return m && m[1] ? m[1].trim() : "";
}

function kwmExtractName(block) {
	const dataItem = extractHtmlAttr(block, "data-item");
	if (dataItem) return sanitizeName(dataItem);

	const m = block.match(/<h6\b[^>]*>\s*([\s\S]*?)\s*<\/h6>/i);
	if (m && m[1]) return sanitizeName(stripTags(m[1]));

	return "";
}

function kwmExtractFirstDivByClass(html, className) {
	const re = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${escapeRe(className)}\\b[^"']*["'][^>]*>`, "i");
	const m = re.exec(html);
	if (!m) return "";
	const start = m.index + m[0].length;

	let i = start;
	let depth = 1;
	while (i < html.length) {
		const nextOpen = html.indexOf("<div", i);
		const nextClose = html.indexOf("</div>", i);
		if (nextClose === -1) break;

		if (nextOpen !== -1 && nextOpen < nextClose) {
			depth++;
			i = nextOpen + 4;
			continue;
		}
		depth--;
		if (depth === 0) return html.slice(start, nextClose);
		i = nextClose + 6;
	}
	return "";
}

function kwmExtractPrice(block) {
	let m = block.match(/\bdata-price=["']([^"']+)["']/i);
	if (m && m[1]) {
		const raw = String(m[1]).trim();
		const n = raw.replace(/[^0-9.]/g, "");
		if (n) return `$${Number(n).toFixed(2)}`;
	}

	const priceDiv = kwmExtractFirstDivByClass(block, "product-price");
	if (!priceDiv) return "";

	const cleaned = String(priceDiv).replace(
		/<span\b[^>]*class=["'][^"']*\bstrike\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
		" ",
	);

	const txt = cleanText(decodeHtml(stripTags(cleaned)));
	const dollars = [...txt.matchAll(/\$\s*\d+(?:\.\d{2})?/g)];
	if (dollars.length) return dollars[0][0].replace(/\s+/g, "");

	return "";
}

/* ---------------- preorder / stock checks ---------------- */

function kwmProductContentHtml(block) {
	// IMPORTANT:
	// - Real status badges are in product-content (inventory-pre / inventory-out).
	// - Overlay also contains "inventory-out mt-3" for BOTH preorder and OOS, so ignore overlay.
	return kwmExtractFirstDivByClass(String(block || ""), "product-content") || "";
}

function kwmIsPreorder(block) {
	const content = kwmProductContentHtml(block);
	return /\binventory-pre\b/i.test(content) || /\bpre\s*order\b/i.test(content);
}

function kwmIsOutOfStock(block) {
	const content = kwmProductContentHtml(block);

	// This matches your example:
	// <span class="inventory-out">Out of Stock</span>
	if (/\binventory-out\b/i.test(content)) return true;
	if (/\bout\s*of\s*stock\b/i.test(content)) return true;

	return false;
}

/* ---------------- listing parse ---------------- */

function parseProductsKWM(html, ctx) {
	const s = String(html || "");
	const base = `https://${(ctx && ctx.store && ctx.store.host) || "kensingtonwinemarket.com"}/`;

	const blocks = extractDivBlocksByExactClass(s, "product-wrap", 5000);
	ctx.logger?.dbg?.(`parseProductsKWM: productWrapBlocks=${blocks.length} bytes=${s.length}`);

	const items = [];
	for (const block of blocks) {
		// keep preorder, drop OOS, keep everything else
		if (kwmIsOutOfStock(block)) continue;

		const href = kwmExtractProductLinkHref(block);
		if (!href) continue;

		let url;
		try {
			url = new URL(decodeHtml(href), base).toString();
		} catch {
			continue;
		}

		const name = kwmExtractName(block);
		if (!name) continue;

		const price = kwmExtractPrice(block);
		const sku = normalizeCspc(url);
		const img = extractFirstImgUrl(block, base);

		items.push({ name, price, url, sku, img });
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

/* ---------------- session filter toggles (no deps) ---------------- */

function kwmFilterPageParamFromStartUrl(startUrl) {
	const u = new URL(startUrl);
	const segs = u.pathname.split("/").filter(Boolean); // e.g. ["products","scotch"] or ["products","liqu","rum"]
	const i = segs.indexOf("products");
	return i >= 0 && segs[i + 1] ? segs[i + 1] : segs[0] || "";
}

function kwmAddCookie(jar, setCookieLine) {
	const s = String(setCookieLine || "");
	const first = s.split(";")[0] || "";
	const eq = first.indexOf("=");
	if (eq <= 0) return;
	const k = first.slice(0, eq).trim();
	const v = first.slice(eq + 1).trim();
	if (!k) return;
	jar.set(k, v);
}

function kwmExtractSetCookies(headers) {
	if (!headers) return [];
	if (typeof headers.getSetCookie === "function") return headers.getSetCookie(); // undici / node fetch
	const sc = headers.get && headers.get("set-cookie");
	if (!sc) return [];
	// best-effort: many sites set 1 cookie here (PHPSESSID). If multiple, may be imperfect.
	return [sc];
}

async function kwmFetchWithTimeout(url, opts, timeoutMs) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs || 15000));
	try {
		const res = await fetch(url, { ...opts, signal: ctrl.signal });
		return res;
	} finally {
		clearTimeout(t);
	}
}

async function kwmFetchRetry(url, opts, { maxRetries = 2, timeoutMs = 15000 } = {}) {
	let lastErr = null;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const res = await kwmFetchWithTimeout(url, opts, timeoutMs);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return res;
		} catch (e) {
			lastErr = e;
			if (attempt >= maxRetries) break;
			await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
		}
	}
	throw lastErr || new Error("fetch failed");
}

async function kwmPostFilter(ctx, jar, chk) {
	const base = `https://${ctx.store.host}`;
	const pageParam = kwmFilterPageParamFromStartUrl(ctx.cat.startUrl);
	const body = new URLSearchParams({ chk, page: pageParam, type: "include" });

	const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

	const res = await kwmFetchRetry(
		`${base}/includes/post/filter-chk.ajax.php`,
		{
			method: "POST",
			headers: {
				accept: "application/json, text/javascript, */*; q=0.01",
				"content-type": "application/x-www-form-urlencoded; charset=UTF-8",
				"x-requested-with": "XMLHttpRequest",
				origin: base,
				referer: makePageUrlKWM(ctx.cat.startUrl, 1),
				"user-agent": ctx.store.ua,
				cookie: cookieHeader(),
			},
			body,
		},
		{ maxRetries: ctx.config.maxRetries, timeoutMs: ctx.config.timeoutMs },
	);

	for (const sc of kwmExtractSetCookies(res.headers)) kwmAddCookie(jar, sc);
	await res.text().catch(() => {});
}

async function kwmInitSessionWithFilters(ctx) {
	const jar = new Map();

	// satisfy age gate / UX cookies
	jar.set("age_gate", "1");
	jar.set("kwm_newsletter", "1");

	const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

	// Seed session (get PHPSESSID)
	{
		const url = makePageUrlKWM(ctx.cat.startUrl, 1);
		const res = await kwmFetchRetry(
			url,
			{
				method: "GET",
				headers: {
					"user-agent": ctx.store.ua,
					accept: "text/html,application/xhtml+xml",
					cookie: cookieHeader(),
				},
			},
			{ maxRetries: ctx.config.maxRetries, timeoutMs: ctx.config.timeoutMs },
		);
		for (const sc of kwmExtractSetCookies(res.headers)) kwmAddCookie(jar, sc);
		await res.text().catch(() => {});
	}

	// IMPORTANT: set BOTH filters in the same session
	// Order: include preorder, then enforce in-stock-only.
	await kwmPostFilter(ctx, jar, "chk-inc-preorder");
	await kwmPostFilter(ctx, jar, "chk-instock-only");

	return cookieHeader();
}

/* ---------------- scanCategory (cookie-aware + logs) ---------------- */

function kwmLooksLikeListingHtml(html) {
	// fast/cheap existence check used for sanity + page discovery
	return /class=["'][^"']*\bproduct-wrap\b[^"']*["']/i.test(String(html || ""));
}

async function scanCategoryKWM(ctx, prevDb, report) {
	const t0 = Date.now();

	const cookie = await kwmInitSessionWithFilters(ctx);
	const perReqHeaders = {
		cookie,
		Referer: makePageUrlKWM(ctx.cat.startUrl, 1),
	};

	// sanity: page 1 should look like a listing; if not, preserve DB
	{
		const r1 = await ctx.http.fetchTextWithRetry(
			makePageUrlKWM(ctx.cat.startUrl, 1),
			`kwm:html:${ctx.cat.key}:p1`,
			ctx.store.ua,
			{ headers: perReqHeaders },
		);

		if (!kwmLooksLikeListingHtml(r1.text || "")) {
			ctx.logger.warn(
				`${ctx.catPrefixOut} | KWM page 1 did not look like a listing (age gate/session likely failed). Preserving DB.`,
			);
			const dbObj = buildDbObject(ctx, prevDb?.byUrl || new Map());
			writeJsonAtomic(ctx.dbFile, dbObj);
			return;
		}
	}

	// Find last page: probe from configured guess and binary search.
	// IMPORTANT: probe uses "listing exists" (product-wrap present), NOT "kept items > 0",
	// because KWM's in-stock filter can still show OOS tiles and our parser will drop them.
	const guess = Number.isFinite(ctx.cat.discoveryStartPage) ? ctx.cat.discoveryStartPage : ctx.config.discoveryGuess;
	const step = Number.isFinite(ctx.cat.discoveryStep) ? ctx.cat.discoveryStep : ctx.config.discoveryStep;

	async function pageLooksReal(p) {
		const url = makePageUrlKWM(ctx.cat.startUrl, p);
		const r = await ctx.http.fetchTextWithRetry(
			url,
			`kwm:probe:${ctx.cat.key}:p${p}`,
			ctx.store.ua,
			{ headers: perReqHeaders },
		);
		return kwmLooksLikeListingHtml(r.text || "");
	}

	async function binaryLastOk(loOk, hiMiss) {
		while (hiMiss - loOk > 1) {
			const mid = loOk + Math.floor((hiMiss - loOk) / 2);
			if (await pageLooksReal(mid)) loOk = mid;
			else hiMiss = mid;
		}
		return loOk;
	}

	let totalPages = 1;
	const g = Math.max(2, guess);

	if (!(await pageLooksReal(g))) {
		totalPages = await binaryLastOk(1, g);
	} else {
		let lastOk = g;
		while (true) {
			const probe = lastOk + step;
			if (!(await pageLooksReal(probe))) {
				totalPages = await binaryLastOk(lastOk, probe);
				break;
			}
			lastOk = probe;
			if (lastOk > 5000) {
				totalPages = lastOk;
				break;
			}
		}
	}

	const scanPages = ctx.config.maxPages === null ? totalPages : Math.min(ctx.config.maxPages, totalPages);
	ctx.logger.ok(`${ctx.catPrefixOut} | Pages: ${scanPages}${scanPages !== totalPages ? ` (cap from ${totalPages})` : ""}`);

	const pageUrls = [];
	for (let p = 1; p <= scanPages; p++) pageUrls.push(makePageUrlKWM(ctx.cat.startUrl, p));

	const pageConc = Number.isFinite(ctx.cat.pageConcurrency) ? ctx.cat.pageConcurrency : ctx.config.concurrency;
	const pageStagger = Number.isFinite(ctx.cat.pageStaggerMs) ? ctx.cat.pageStaggerMs : ctx.config.staggerMs;

	let donePages = 0;

	const perPageItems = await parallelMapStaggered(pageUrls, pageConc, pageStagger, async (pageUrl, idx) => {
		const pnum = idx + 1;

		const { text: html, ms, bytes, status, finalUrl } = await ctx.http.fetchTextWithRetry(
			pageUrl,
			`page:${ctx.store.key}:${ctx.cat.key}:${pnum}`,
			ctx.store.ua,
			{ headers: perReqHeaders },
		);

		const items = (ctx.store.parseProducts || parseProductsKWM)(html || "", ctx, finalUrl || "");

		donePages++;
		ctx.logger.ok(
			`${ctx.catPrefixOut} | Page ${padRight(pageStr(pnum, pageUrls.length), 20)} | ${String(status || "").padEnd(3)} | ${pctStr(
				donePages,
				pageUrls.length,
			)} | items=${padLeft(items.length, 3)} | bytes=${kbStr(bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(ms)}`,
		);

		return items;
	});

	const discovered = new Map();
	let dups = 0;
	for (const arr of perPageItems) {
		for (const it of arr || []) {
			if (!it?.url) continue;
			if (discovered.has(it.url)) dups++;
			discovered.set(it.url, it);
		}
	}

	ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}${dups ? ` (${dups} dups)` : ""}`);

	avoidMassRemoval(prevDb, discovered, ctx, "kwm partial scan");

	const { merged } = finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: scanPages });
	ctx.logger.ok(`${ctx.catPrefixOut} | DB saved: ${ctx.logger.dim(ctx.dbFile)} (${merged.size} items)`);
}

/* ---------------- store ---------------- */

function createStore(defaultUa) {
	return {
		key: "kwm",
		region: "AB",
		name: "Kensington Wine Market",
		host: "kensingtonwinemarket.com",
		ua: defaultUa,

		parseProducts: parseProductsKWM,
		makePageUrl: makePageUrlKWM,

		// Cookie/session-aware scan so we can enable filters (preorder + in-stock only)
		scanCategory: scanCategoryKWM,

		categories: [
			{
				key: "scotch",
				label: "Scotch",
				startUrl: "https://kensingtonwinemarket.com/products/scotch/",
				discoveryStartPage: 200,
			},
			{
				key: "rum",
				label: "Rum",
				startUrl: "https://kensingtonwinemarket.com/products/liqu/rum/",
				discoveryStartPage: 20,
			},
			{
				key: "gin",
				label: "Gin",
				startUrl: "https://kensingtonwinemarket.com/products/liqu/gin/",
				discoveryStartPage: 20,
			},
		],
	};
}

module.exports = { createStore };