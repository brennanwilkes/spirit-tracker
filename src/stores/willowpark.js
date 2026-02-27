// src/stores/willowpark.js
"use strict";

const { decodeHtml, stripTags, extractFirstImgUrl, cleanText } = require("../utils/html");
const { makePageUrlShopifyQueryPage } = require("../utils/url");
const { needsSkuDetail, pickBetterSku, normalizeCspc } = require("../utils/sku");

function extractSkuFromUrlOrHref(hrefOrUrl) {
	const s = String(hrefOrUrl || "");
	// /products/<handle>-123456 or /collections/.../products/<handle>-123456
	const m = s.match(/-(\d{6})(?:\/)?(?:[?#].*)?$/);
	return m ? m[1] : "";
}

function extractSkuFromWillowBlock(block) {
	const b = String(block || "");

	// Image filename pattern:
	// /products/710296-Zaya-Gran-Reserva-16-Year_160x.png
	const m1 = b.match(/\/products\/(\d{6})[-_]/i);
	if (m1) return m1[1];

	// Generic fallback
	const m2 = b.match(/\b(\d{6})[-_][A-Za-z]/);
	if (m2) return m2[1];

	return "";
}

function canonicalizeWillowUrl(raw) {
	try {
		const u = new URL(String(raw));
		u.search = "";
		u.hash = "";
		const m = u.pathname.match(/^\/collections\/[^/]+\/products\/([^/]+)\/?$/i);
		if (m) u.pathname = `/products/${m[1]}`;
		return u.toString();
	} catch {
		return String(raw || "");
	}
}

// Prefer exact decimal from visually-hidden spans.
// Fallback: reconstruct from $39<sup>99</sup>.
function extractWillowCardPrice(block) {
	const b = String(block || "");

	function extractPriceFromSlice(slice) {
		const s = String(slice || "");

		// Prefer exact decimal
		const vh = s.match(
			/<span\b[^>]*class=["']visually-hidden["'][^>]*>\s*(\$\s*[\d,]+\.\d{2})\s*<\/span>/i,
		)?.[1];
		if (vh) return vh.replace(/\s+/g, "");

		const dec = s.match(/\$\s*[\d,]+\.\d{2}/)?.[0];
		if (dec) return dec.replace(/\s+/g, "");

		// Reconstruct from $84<sup>99</sup>
		const sup = s.match(/\$\s*([\d,]+)\s*<sup>\s*(\d{2})\s*<\/sup>/i);
		if (sup) return `$${sup[1].replace(/\s+/g, "")}.${sup[2]}`;

		const any = s.match(/\$\s*[\d,]+/)?.[0];
		return any ? any.replace(/\s+/g, "") : "";
	}

	// 1) Current price slice (prevents accidentally capturing original price)
	const iCur = b.search(/\bgrid-product__price--current\b/i);
	if (iCur >= 0) {
		let curSlice = b.slice(iCur);
		const stop = curSlice.search(/\bgrid-product__price--original\b/i);
		if (stop >= 0) curSlice = curSlice.slice(0, stop);

		const p = extractPriceFromSlice(curSlice);
		if (p) return p;
	}

	// 2) Original price slice (only if needed)
	const iOrig = b.search(/\bgrid-product__price--original\b/i);
	if (iOrig >= 0) {
		let origSlice = b.slice(iOrig);
		const stop = origSlice.search(/\bgrid-product__price--savings\b/i);
		if (stop >= 0) origSlice = origSlice.slice(0, stop);

		const p = extractPriceFromSlice(origSlice);
		if (p) return p;
	}

	// 3) Last resort
	return extractPriceFromSlice(b);
}

function parseProductsWillowPark(html, ctx, finalUrl) {
	const s = String(html || "");
	const items = [];

	const base = `https://${(ctx && ctx.store && ctx.store.host) || "www.willowpark.net"}/`;

	const starts = [...s.matchAll(/<div\b[^>]*class=["'][^"']*\bgrid-item\b[^"']*\bgrid-product\b[^"']*["'][^>]*>/gi)]
		.map((m) => m.index)
		.filter((i) => typeof i === "number");

	const blocks = [];
	for (let i = 0; i < starts.length; i++) {
		const a = starts[i];
		const b = i + 1 < starts.length ? starts[i + 1] : s.length;
		blocks.push(s.slice(a, b));
	}

	for (const block of blocks) {
		const href =
			block.match(/<a\b[^>]*href=["']([^"']*\/collections\/[^"']*\/products\/[^"']+)["']/i)?.[1] ||
			block.match(/<a\b[^>]*href=["']([^"']*\/products\/[^"']+)["']/i)?.[1];
		if (!href) continue;

		let url;
		try {
			url = new URL(decodeHtml(href), base).toString();
		} catch {
			continue;
		}
		url = canonicalizeWillowUrl(url);

		const titleHtml =
			block.match(/<div\b[^>]*class=["'][^"']*\bgrid-product__title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
			"";
		const name = cleanText(decodeHtml(stripTags(titleHtml)));
		if (!name) continue;

		const price = extractWillowCardPrice(block);
		const img = extractFirstImgUrl(block, base);
		const pid = block.match(/\bdata-product-id=["'](\d+)["']/i)?.[1] || "";

		const sku = extractSkuFromUrlOrHref(href) || extractSkuFromUrlOrHref(url) || extractSkuFromWillowBlock(block);

		items.push({ name, price, url, sku, img, pid });
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

function willowIsEmptyListingPage(html) {
	const s = String(html || "");
	if (/Sorry,\s+there are no products in this collection\./i.test(s)) return true;
	if (/No products found/i.test(s)) return true;
	if (/collection--empty\b/i.test(s)) return true;
	return false;
}

/* ---------------- Storefront GraphQL (token extracted from HTML) ---------------- */

const WILLOW_STOREFRONT_GQL_URL = "https://willow-park-wines.myshopify.com/api/2025-07/graphql.json";

const PRODUCT_BY_ID_QUERY = `
query ($id: ID!) @inContext(country: CA) {
  product(id: $id) {
    variants(first: 50) {
      nodes { sku availableForSale quantityAvailable }
    }
  }
}
`;

function pickBestVariantSku(product) {
	const vs = Array.isArray(product?.variants?.nodes) ? product.variants.nodes : [];
	if (!vs.length) return "";

	const inStock = vs.find((v) => Number(v?.quantityAvailable) > 0 && String(v?.sku || "").trim());
	if (inStock) return String(inStock.sku).trim();

	const forSale = vs.find((v) => Boolean(v?.availableForSale) && String(v?.sku || "").trim());
	if (forSale) return String(forSale.sku).trim();

	const any = vs.find((v) => String(v?.sku || "").trim());
	return any ? String(any.sku).trim() : "";
}

function extractStorefrontTokenFromHtml(html) {
	const s = String(html || "");

	// 1) script#shopify-features JSON: {"accessToken":"..."}
	const j = s.match(/<script[^>]+id=["']shopify-features["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
	if (j) {
		try {
			const obj = JSON.parse(j);
			const t = String(obj?.accessToken || "").trim();
			if (t) return t;
		} catch {}
	}

	// 2) meta name="shopify-checkout-api-token"
	const m = s.match(/<meta[^>]+name=["']shopify-checkout-api-token["'][^>]+content=["']([^"']+)["']/i)?.[1];
	return String(m || "").trim();
}

async function willowGetStorefrontToken(ctx) {
	if (ctx._willowStorefrontToken) return ctx._willowStorefrontToken;

	const r = await ctx.http.fetchTextWithRetry("https://www.willowpark.net/", "willow:token", ctx.store.ua);
	const t = extractStorefrontTokenFromHtml(r?.text || "");
	if (!t) throw new Error("Willow Park: could not find storefront token in homepage HTML");

	ctx._willowStorefrontToken = t;
	return t;
}

async function willowGql(ctx, label, query, variables) {
	const token = await willowGetStorefrontToken(ctx);

	const r = await ctx.http.fetchJsonWithRetry(WILLOW_STOREFRONT_GQL_URL, label, ctx.store.ua, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"content-type": "application/json",
			Origin: "https://www.willowpark.net",
			Referer: "https://www.willowpark.net/",
			"x-shopify-storefront-access-token": token,
		},
		body: JSON.stringify({ query, variables }),
	});

	// If token is rejected, clear so a future attempt re-fetches it once.
	if (r?.status === 401 || r?.status === 403) ctx._willowStorefrontToken = "";
	return r;
}

// If GQL returns a numeric SKU that isn't 6 digits, namespace it as id:<NUM>.
// Keep 6-digit CSPC as-is. For non-numeric / already-namespaced formats, return as-is.
function normalizeWillowGqlSku(rawSku) {
	const s = String(rawSku || "").trim();
	if (!s) return "";
	const cspc = normalizeCspc(s);
	if (cspc) return cspc; // 6-digit wins
	if (/^id:/i.test(s) || /^upc:/i.test(s) || /^u:/i.test(s)) return s;
	if (/^\d+$/.test(s)) return `id:${s}`;
	return s;
}

async function willowFetchSkuByPid(ctx, pid) {
	const id = String(pid || "").trim();
	if (!id) return "";

	if (!ctx._willowSkuCacheByPid) ctx._willowSkuCacheByPid = new Map();
	if (ctx._willowSkuCacheByPid.has(id)) return ctx._willowSkuCacheByPid.get(id);

	const gid = `gid://shopify/Product/${id}`;
	let sku = "";

	try {
		const r = await willowGql(ctx, `willow:gql:pid:${id}`, PRODUCT_BY_ID_QUERY, { id: gid });
		if (r?.status === 200) sku = normalizeWillowGqlSku(pickBestVariantSku(r?.json?.data?.product));
	} catch {
		sku = "";
	}

	ctx._willowSkuCacheByPid.set(id, sku);
	return sku;
}

/**
 * Second-pass repair: if SKU is missing/synthetic, use Storefront GQL by product id.
 * Budgeted to avoid exploding requests.
 */
async function willowRepairDiscoveredItems(ctx, discovered, prevDb) {
	const budget = Number.isFinite(ctx?.config?.willowparkGqlBudget) ? ctx.config.willowparkGqlBudget : 200;
	let used = 0;

	for (const [url, it] of discovered.entries()) {
		if (!it) continue;

		// Seed from prev DB so we don't repair repeatedly if we already learned a good SKU.
		const prev = prevDb?.byUrl?.get(url);
		if (prev) it.sku = pickBetterSku(it.sku, prev.sku);

		if (!needsSkuDetail(it.sku)) continue;
		if (used >= budget) break;

		const repaired = await willowFetchSkuByPid(ctx, it.pid);
		if (repaired) it.sku = pickBetterSku(repaired, it.sku);

		discovered.set(url, it);
		used++;
	}

	ctx.logger.ok(`${ctx.catPrefixOut} | Willow SKU repair (GQL): used=${used}/${budget}`);
}

function createStore(defaultUa) {
	return {
		key: "willowpark",
		name: "Willow Park",
		host: "www.willowpark.net",
		ua: defaultUa,

		parseProducts: parseProductsWillowPark,
		makePageUrl: makePageUrlShopifyQueryPage,
		isEmptyListingPage: willowIsEmptyListingPage,

		// Hook called by scanner (add 1-line call in scanner before merge)
		repairDiscoveredItems: willowRepairDiscoveredItems,

		categories: [
			{
				key: "scotch",
				label: "Scotch",
				startUrl: "https://www.willowpark.net/collections/scotch?filter.v.availability=1",
				discoveryStartPage: 5,
			},
			{
				key: "rum",
				label: "Rum",
				startUrl: "https://www.willowpark.net/collections/rum?filter.v.availability=1",
				discoveryStartPage: 3,
			},
		],
	};
}

module.exports = { createStore, parseProductsWillowPark };
