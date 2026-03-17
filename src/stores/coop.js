"use strict";

const { normalizeSkuKey } = require("../utils/sku");
const { padLeft, padRight } = require("../utils/string");
const { kbStr, secStr, pageStr, pctStr } = require("../utils/format");

const { avoidMassRemoval } = require("../tracker/merge");
const { finalizeCategoryScan } = require("../tracker/finalize");


/* ---------------- co-op specifics ---------------- */

const BASE = "https://shoponlinewhisky-wine.coopwinespiritsbeer.com";
const REFERER = `${BASE}/worldofwhisky`;

function coopHeaders(ctx, sourcepage) {
	const coop = ctx.store.coop;
	return {
		Accept: "application/json, text/javascript, */*; q=0.01",
		"Content-Type": "application/json",
		Origin: BASE,
		Referer: REFERER,

		// these 4 are required on their API calls (matches browser)
		SessionKey: coop.sessionKey,
		chainID: coop.chainId,
		storeID: coop.storeId,
		appVersion: coop.appVersion,

		AUTH_TOKEN: "null",
		CONNECTION_ID: "null",
		SESSION_ID: coop.sessionId || "null",
		TIMESTAMP: String(Date.now()),
		sourcepage,
	};
}

async function coopFetchText(ctx, url, label, { headers } = {}) {
	return await ctx.http.fetchTextWithRetry(url, label, ctx.store.ua, {
		method: "GET",
		headers: headers || {},
	});
}

function extractVar(html, re) {
	const m = String(html || "").match(re);
	return m ? String(m[1] || "").trim() : "";
}

async function ensureCoopBootstrap(ctx) {
	const coop = ctx.store.coop;
	if (coop.sessionKey && coop.chainId && coop.storeId && coop.appVersion) return;

	const r = await coopFetchText(ctx, REFERER, "coop:bootstrap", {
		headers: {
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			Referer: REFERER,
		},
	});

	const html = r?.text || "";
	if (r?.status !== 200 || !html) {
		throw new Error(`coop bootstrap failed: GET ${REFERER} => ${r.status}`);
	}

	// Values are in <script> var SESSIONKEY = "..."; etc.
	coop.sessionKey = extractVar(html, /var\s+SESSIONKEY\s*=\s*"([^"]+)"/i);
	coop.chainId = extractVar(html, /var\s+chainID\s*=\s*"([^"]+)"/i);
	coop.storeId = extractVar(html, /var\s+store_unique_id\s*=\s*"([^"]+)"/i);
	coop.appVersion = extractVar(html, /var\s+CLIENTVERSION\s*=\s*"([^"]+)"/i);

	if (!coop.sessionKey || !coop.chainId || !coop.storeId || !coop.appVersion) {
		throw new Error(
			`coop bootstrap missing values: sessionKey=${!!coop.sessionKey} chainId=${!!coop.chainId} storeId=${!!coop.storeId} appVersion=${!!coop.appVersion}`,
		);
	}
}

async function ensureCoopSession(ctx) {
	const coop = ctx.store.coop;
	if (coop.sessionId) return;
	await ensureCoopBootstrap(ctx);

	const r = await ctx.http.fetchJsonWithRetry(
		`${BASE}/api/account/createsession`,
		`coop:createsession`,
		ctx.store.ua,
		{
			method: "POST",
			headers: coopHeaders(ctx, "/worldofwhisky"),
			// browser sends Content-Length: 0; easiest equivalent:
			body: "",
		},
	);

	const sid = r?.json?.SessionID || r?.json?.sessionID || r?.json?.sessionId || r?.json?.SessionId || "";

	if (!sid) {
		throw new Error(`createSession: missing SessionID (status=${r?.status})`);
	}

	coop.sessionId = sid;
	coop.anonymousUserId = r?.json?.AnonymousUserID ?? null;
}

function normalizeAbsUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	if (s.startsWith("//")) return `https:${s}`;
	if (/^https?:\/\//i.test(s)) return s;
	try {
		return new URL(s, `${BASE}/`).toString();
	} catch {
		return s;
	}
}

function productUrlFromId(productId) {
	return `${REFERER}#/product/${encodeURIComponent(String(productId))}`;
}

function productFromApi(p) {
	if (!p || p.IsActive === false) return null;

	const name = String(p.Name || "").trim();
	if (!name) return null;

	const productId = p.ProductID;
	if (!productId) return null;

	const url = productUrlFromId(productId);

	const price = p?.CountDetails?.PriceText || (Number.isFinite(p?.Price) ? `$${Number(p.Price).toFixed(2)}` : "");

	const upc = String(p.UPC || "").trim();

	let rawKey = "";
	if (upc) rawKey = `upc:${upc}`;
	else if (p.ProductStoreID) rawKey = `id:${String(p.ProductStoreID).trim()}`;
	else if (p.ProductID) rawKey = `id:${String(p.ProductID).trim()}`;

	const sku = normalizeSkuKey(rawKey, { storeLabel: "Co-op World of Whisky", url });

	const img = normalizeAbsUrl(p.ImageURL);

	return {
		name,
		price,
		url,
		sku,
		upc,
		productId,
		productStoreId: p.ProductStoreID || null,
		img,
	};
}

/* ---------------- scanner ---------------- */

async function fetchCategoryPage(ctx, categoryId, page) {
	await ensureCoopSession(ctx);

	const doReq = () =>
		ctx.http.fetchJsonWithRetry(
			`${BASE}/api/v2/products/category/${categoryId}`,
			`coop:${ctx.cat.key}:p${page}`,
			ctx.store.ua,
			{
				method: "POST",
				headers: coopHeaders(ctx, `/category/${ctx.cat.coopSlug}`),
				body: JSON.stringify({
					page,
					Filters: {
						Filters: [],
						LastSelectedFilter: null,
						SearchWithinTerm: null,
					},
					orderby: null,
				}),
			},
		);

	let r = await doReq();

	// one fast retry on invalid_session: refresh SessionID and repeat
	if (r?.json?.type === "invalid_session") {
		ctx.store.coop.sessionId = "";
		await ensureCoopSession(ctx);
		r = await doReq();
	}

	return r;
}


async function scanCategoryCoop(ctx, prevDb, report) {
	const t0 = Date.now();
	const discovered = new Map();

	const maxPages = ctx.config.maxPages === null ? 500 : Math.min(ctx.config.maxPages, 500);

	let done = 0;

	for (let page = 1; page <= maxPages; page++) {
		let r;
		try {
			r = await fetchCategoryPage(ctx, ctx.cat.coopCategoryId, page);
		} catch (e) {
			ctx.logger.warn(`${ctx.catPrefixOut} | page ${page} failed: ${e?.message || e}`);
			break;
		}

		const arr = Array.isArray(r?.json?.Products?.Result) ? r.json.Products.Result : [];

		done++;

		let kept = 0;
		for (const p of arr) {
			const it = productFromApi(p);
			if (!it) continue;
			discovered.set(it.url, it);
			kept++;
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | Page ${padLeft(page, 3)} | ${String(r.status || "").padEnd(
				3,
			)} | items=${padLeft(kept, 3)} | bytes=${kbStr(
				r.bytes,
			)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`,
		);

		if (!arr.length) break;
	}

	avoidMassRemoval(prevDb, discovered, ctx, "coop api");

	ctx.logger.ok(`${ctx.catPrefixOut} | Unique products: ${discovered.size}`);

	finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: done });
}

/* ---------------- store ---------------- */

function createStore(defaultUa) {
	return {
		key: "coop",
		region: "AB",
		name: "Co-op World of Whisky",
		host: "shoponlinewhisky-wine.coopwinespiritsbeer.com",
		ua: defaultUa,
		scanCategory: scanCategoryCoop,

		// put your captured values here (or pull from env)
		coop: {
			sessionKey: "",
			chainId: "",
			storeId: "",
			appVersion: "",
			sessionId: "", // set by ensureCoopSession()
			anonymousUserId: null,
		},

		categories: [
			{
				key: "canadian-whisky",
				label: "Canadian Whisky",
				coopSlug: "canadian_whisky",
				coopCategoryId: 4,
				startUrl: `${REFERER}#/category/canadian_whisky`,
			},
			{
				key: "bourbon-whiskey",
				label: "Bourbon Whiskey",
				coopSlug: "bourbon_whiskey",
				coopCategoryId: 9,
				startUrl: `${REFERER}#/category/bourbon_whiskey`,
			},
			{
				key: "scottish-single-malts",
				label: "Scottish Single Malts",
				coopSlug: "scottish_single_malts",
				coopCategoryId: 6,
				startUrl: `${REFERER}#/category/scottish_single_malts`,
			},
			{
				key: "scottish-blends",
				label: "Scottish Whisky Blends",
				coopSlug: "scottish_whisky_blends",
				coopCategoryId: 5,
				startUrl: `${REFERER}#/category/scottish_whisky_blends`,
			},
			{
				key: "american-whiskey",
				label: "American Whiskey",
				coopSlug: "american_whiskey",
				coopCategoryId: 8,
				startUrl: `${REFERER}#/category/american_whiskey`,
			},
			{
				key: "world-whisky",
				label: "World Whisky",
				coopSlug: "world_international",
				coopCategoryId: 10,
				startUrl: `${REFERER}#/category/world_international`,
			},
			{
				key: "rum",
				label: "Rum",
				coopSlug: "spirits_rum",
				coopCategoryId: 24,
				startUrl: `${REFERER}#/category/spirits_rum`,
			},
		],
	};
}

module.exports = { createStore };
