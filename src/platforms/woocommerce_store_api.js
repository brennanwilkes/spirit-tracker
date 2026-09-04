// src/platforms/woocommerce_store_api.js
"use strict";

const { decodeHtml, stripTags, cleanText, extractFirstImgUrl } = require("../utils/html");
const { sanitizeName } = require("../utils/text");
const { normalizeSkuKey, normalizeCspc, needsSkuDetail } = require("../utils/sku");
const {
	getWooCategoryId,
	parseWooStoreProductsJson,
	extractPriceFromTmbBlock,
} = require("../utils/woocommerce");
const { finalizeCategoryScan } = require("../tracker/finalize");
const { avoidMassRemoval } = require("../tracker/merge");

// Above this many previously-live listings, an empty/!much-smaller API response is treated as
// suspect and the DB is preserved (avoidMassRemoval). At or below it, the shrink is allowed
// through so a genuinely discontinued category retires honestly instead of showing stale stock
// forever. RMWSB is the motivating case: it dropped rum (8 live) and gin (8 live) entirely and
// the API now answers "[]" for both, so those really are out of stock — whereas Liberty's ~399
// whiskies going "[]" would be a glitch worth refusing.
const MASS_REMOVAL_GUARD_MIN_PREV = 25;

function countPrevActive(prevDb) {
	let n = 0;
	for (const it of prevDb?.byUrl?.values() || []) {
		if (it && !it.removed) n++;
	}
	return n;
}

// Apply the mass-removal guard only for categories big enough for a wipe to be implausible.
function guardLargeCategoryOnly(prevDb, discovered, ctx, reason, report) {
	if (countPrevActive(prevDb) < MASS_REMOVAL_GUARD_MIN_PREV) return false;
	return avoidMassRemoval(prevDb, discovered, ctx, reason, report);
}

class WooStoreApiUnavailable extends Error {
	constructor(status, url) {
		super(`Woo Store API unavailable (HTTP ${status}) at ${url}`);
		this.name = "WooStoreApiUnavailable";
		this.status = status;
		this.url = url;
	}
}

function parseWooHtmlListing(html, ctx) {
	const s = String(html || "");
	const items = [];
	const base = `https://${ctx?.store?.host || ""}/`;

	const parts = s.split(/<li\b/i);
	for (let i = 1; i < parts.length; i++) {
		const chunk = "<li" + parts[i];
		if (!/class=["'][^"']*\bproduct\b/i.test(chunk)) continue;
		if (/class=["'][^"']*\bproduct-category\b/i.test(chunk)) continue;
		const endIdx = chunk.search(/<\/li>/i);
		const block = endIdx >= 0 ? chunk.slice(0, endIdx + 5) : chunk;

		const hrefs = [...block.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((m) => m[1]);
		const href = hrefs.find((h) => !/add-to-cart=|\/cart\/|\/checkout\//i.test(h)) || "";
		if (!href) continue;

		let url = "";
		try { url = new URL(decodeHtml(href), base).toString(); } catch { continue; }

		const nameHtml =
			block.match(/<h2\b[^>]*class=["'][^"']*woocommerce-loop-product__title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1] ||
			block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || "";
		const name = sanitizeName(cleanText(decodeHtml(stripTags(nameHtml))));
		if (!name) continue;

		const price = extractPriceFromTmbBlock(block);

		const rawSku =
			block.match(/\bdata-product_sku=["']([^"']+)["']/i)?.[1] ||
			block.match(/\bdata-product_id=["']([^"']+)["']/i)?.[1] || "";
		const tagged = /^\d{1,11}$/.test(String(rawSku).trim()) ? `id:${String(rawSku).trim()}` : String(rawSku || "").trim();
		const sku = normalizeSkuKey(tagged, { storeLabel: ctx?.store?.name, url });

		const img = extractFirstImgUrl(block, base);
		items.push({ name, price, url, sku, img });
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

function extractOgMetaSku(html) {
	const s = String(html || "");
	const og = s.match(/<meta\b[^>]*property=["']product:retailer_item_id["'][^>]*content=["']([^"']+)["']/i)?.[1] || "";
	const cspc = normalizeCspc(og);
	if (cspc) return cspc;
	const inline = s.match(/<meta\b[^>]*itemprop=["']sku["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
		s.match(/\bSKU[:\s]*([A-Za-z0-9][A-Za-z0-9\-_/ ]{0,40})/i)?.[1] || "";
	return normalizeCspc(inline);
}

/**
 * createWooStoreApiAdapter
 *
 * opts:
 *  - categoryUrl: string (optional) — used to discover term-id from page HTML body class
 *  - wooCategoryId: number (optional) — skip discovery
 *  - perPage: number (default 100)
 *  - stockStatusFilter: "instock" | null (default "instock")
 *  - allowProduct: (product) => boolean (post-fetch filter; e.g. skip gin)
 *  - htmlFallback: boolean (default false) — walk HTML listing if /wp-json is restricted
 *  - ogMetaFallback: boolean (default false) — for NEW items with synthetic SKU, GET the
 *      product page and read OpenGraph/itemprop SKU
 */
function createWooStoreApiAdapter(opts) {
	const {
		categoryUrl = null,
		wooCategoryId = null,
		categorySlug = null,
		perPage = 100,
		stockStatusFilter = "instock",
		allowProduct = null,
		htmlFallback = false,
		ogMetaFallback = false,
	} = opts || {};

	if (!categoryUrl && !Number.isFinite(wooCategoryId) && !categorySlug) {
		throw new Error("woocommerce_store_api: categoryUrl, wooCategoryId, or categorySlug is required");
	}

	async function resolveCategoryId(ctx) {
		if (Number.isFinite(wooCategoryId)) return wooCategoryId;
		// Reuse helper; it expects ctx.cat.startUrl. Bridge through a shallow ctx clone.
		const bridge = { ...ctx, cat: { ...ctx.cat, startUrl: ctx.cat.startUrl || categoryUrl } };
		return await getWooCategoryId(bridge);
	}

	async function fetchAllPagesViaApi(ctx, catId) {
		const apiBase = new URL(`https://${ctx.store.host}/wp-json/wc/store/v1/products`);
		apiBase.searchParams.set("per_page", String(perPage));
		if (catId) apiBase.searchParams.set("category", String(catId));
		if (stockStatusFilter) apiBase.searchParams.set("stock_status", stockStatusFilter);

		const discovered = new Map();
		let page = 1;
		const hardCap = 500;

		while (page <= hardCap) {
			const u = new URL(apiBase.toString());
			u.searchParams.set("page", String(page));
			const label = `${ctx.store.key}:storeapi:${ctx.cat.key}:p${page}`;
			const { text, status } = await ctx.http.fetchTextWithRetry(u.toString(), label, ctx.store.ua, {
				headers: { Accept: "application/json", Referer: ctx.cat.startUrl || categoryUrl || "" },
				// "[]" (4 bytes) is this API's honest answer for an empty/absent category; without
				// this it trips the generic short-body guard and the category reports as FAILED.
				// Safe because avoidMassRemoval below stops an unexpectedly-empty page from wiping
				// a populated DB.
				allowShortBody: true,
			});

			if (status === 401 || status === 403 || status === 404) {
				throw new WooStoreApiUnavailable(status, u.toString());
			}

			const items = parseWooStoreProductsJson(text, ctx);

			// raw API count is what determines pagination
			let apiCount = items.length;
			try {
				const arr = JSON.parse(text);
				if (Array.isArray(arr)) apiCount = arr.length;
			} catch {}

			if (!apiCount) break;

			for (const it of items) {
				if (typeof allowProduct === "function" && !allowProduct(it)) continue;
				discovered.set(it.url, it);
			}

			if (apiCount < perPage) break;
			page++;
		}

		return { discovered, pagesFetched: page };
	}

	async function fetchAllPagesViaHtml(ctx) {
		const startUrl = ctx.cat.startUrl || categoryUrl;
		if (!startUrl) throw new Error("woocommerce_store_api: htmlFallback requires categoryUrl or ctx.cat.startUrl");

		const discovered = new Map();
		let page = 1;
		const hardCap = 50;

		while (page <= hardCap) {
			const u = new URL(startUrl);
			if (page > 1) {
				const path = u.pathname.replace(/\/+$/, "");
				u.pathname = `${path}/page/${page}/`;
			}
			const { text, status } = await ctx.http.fetchTextWithRetry(
				u.toString(),
				`${ctx.store.key}:htmlfallback:${ctx.cat.key}:p${page}`,
				ctx.store.ua,
			);

			if (status === 404) break;

			const items = parseWooHtmlListing(text, ctx);
			if (!items.length) break;

			for (const it of items) {
				if (typeof allowProduct === "function" && !allowProduct(it)) continue;
				discovered.set(it.url, it);
			}
			page++;
		}

		return { discovered, pagesFetched: page };
	}

	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();

		let discovered;
		let pagesFetched;
		let mode = "store-api";

		try {
			// categorySlug is passed straight through to the API `category`
			// param (this store's WC Store API resolves category slugs).
			if (categorySlug) {
				({ discovered, pagesFetched } = await fetchAllPagesViaApi(ctx, categorySlug));
				ctx.logger.ok(`${ctx.catPrefixOut} | woo mode=store-api pages=${pagesFetched} kept=${discovered.size}`);
				guardLargeCategoryOnly(prevDb, discovered, ctx, `woo store-api cat=${categorySlug}`, report);
				finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: pagesFetched });
				return;
			}
			const catId = await resolveCategoryId(ctx);
			const haveCatId = catId !== null && Number.isFinite(catId) && catId > 0;
			if (!haveCatId) {
				if (htmlFallback) {
					ctx.logger.warn(`${ctx.catPrefixOut} | could not resolve Woo category id; using HTML listing`);
					mode = "html";
					({ discovered, pagesFetched } = await fetchAllPagesViaHtml(ctx));
				} else {
					ctx.logger.warn(`${ctx.catPrefixOut} | could not resolve Woo category id; aborting`);
					return;
				}
			} else {
				({ discovered, pagesFetched } = await fetchAllPagesViaApi(ctx, catId));
			}
		} catch (e) {
			if (e instanceof WooStoreApiUnavailable && htmlFallback) {
				ctx.logger.warn(`${ctx.catPrefixOut} | ${e.message}; falling back to HTML listing`);
				mode = "html";
				({ discovered, pagesFetched } = await fetchAllPagesViaHtml(ctx));
			} else if (e instanceof WooStoreApiUnavailable) {
				ctx.logger.warn(`${ctx.catPrefixOut} | ${e.message}; htmlFallback not enabled, aborting`);
				return;
			} else {
				throw e;
			}
		}

		// Optional OG meta SKU hydration for NEW synthetic items
		let ogFetched = 0;
		if (ogMetaFallback) {
			for (const it of discovered.values()) {
				const prev = prevDb?.byUrl?.get(it.url) || null;
				if (prev) continue;
				if (!needsSkuDetail(it.sku)) continue;
				try {
					const { text } = await ctx.http.fetchTextWithRetry(
						it.url,
						`${ctx.store.key}:og:${ctx.cat.key}:${Buffer.from(it.url).toString("base64").slice(0, 24)}`,
						ctx.store.ua,
					);
					ogFetched++;
					const sku2 = extractOgMetaSku(text);
					if (sku2) it.sku = normalizeSkuKey(sku2, { storeLabel: ctx.store.name, url: it.url });
				} catch {}
			}
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | woo mode=${mode} pages=${pagesFetched} kept=${discovered.size}${ogFetched ? ` ogPages=${ogFetched}` : ""}`,
		);

		// Now that an empty API response is accepted rather than retried into a failure, a
		// WAF/outage that answers "[]" for a populated category could otherwise mark the whole
		// category out of stock. This is the same guard the hand-written store scanners use.
		guardLargeCategoryOnly(prevDb, discovered, ctx, `woo mode=${mode} pages=${pagesFetched}`, report);

		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: pagesFetched });
	};
}

module.exports = { createWooStoreApiAdapter, WooStoreApiUnavailable };
