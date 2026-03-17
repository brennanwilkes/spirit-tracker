"use strict";

const { normalizeCspc } = require("./sku");

/**
 * Normalize a Shopify product URL.
 * - Strips hash and all query params (optionally keeps "variant").
 * - Optionally converts /collections/<coll>/products/<handle> → /products/<handle>.
 * - Strips trailing path slashes.
 */
function normalizeShopifyProductUrl(rawUrl, opts) {
	const keepVariant = opts?.keepVariant === true;
	const collectionsToProducts = opts?.collectionsToProducts === true;
	try {
		const u = new URL(String(rawUrl || ""));
		u.hash = "";
		const keep = keepVariant ? new Set(["variant"]) : new Set();
		for (const k of [...u.searchParams.keys()]) {
			if (!keep.has(k)) u.searchParams.delete(k);
		}
		if ([...u.searchParams.keys()].length === 0) u.search = "";
		if (collectionsToProducts) {
			const m = u.pathname.match(/^\/collections\/[^/]+\/products\/([^/]+)\/?$/i);
			if (m) u.pathname = `/products/${m[1]}`;
		}
		if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
		return u.toString();
	} catch {
		return String(rawUrl || "");
	}
}

/**
 * Convert a Shopify integer "cents" price (from product.js / Storefront API) to "$X.XX".
 */
function shopifyPriceFromCents(cents) {
	const n = Number(cents);
	if (!Number.isFinite(n)) return "";
	return `$${(n / 100).toFixed(2)}`;
}

/**
 * Extract a SKU from a Shopify product image URL.
 * Tries: 6-digit CSPC, then id:<num> from filename, then CDN path.
 * Optionally pass the containing HTML block as second arg to search CDN paths within it.
 */
function extractShopifySkuFromImgPath(imgUrl, block) {
	const cspc = normalizeCspc(String(imgUrl || "")) || "";
	if (cspc) return cspc;
	try {
		const u = new URL(String(imgUrl || ""));
		const m = u.pathname.match(/\/(\d{1,11})\.(?:jpe?g|png|webp|gif)$/i);
		if (m && m[1]) return `id:${m[1]}`;
	} catch {}
	if (block) {
		const s = String(block);
		const m2 = s.match(/\/cdn\/shop\/(?:products|files)\/(\d{1,11})\.(?:jpe?g|png|webp|gif)/i);
		if (m2 && m2[1]) return `id:${m2[1]}`;
	}
	return "";
}

/**
 * Pick the best in-stock variant from a Shopify products.json / product.js variants array.
 * Returns first with available===true, or the first variant as fallback.
 */
function pickShopifyInStockVariant(variants) {
	const vs = Array.isArray(variants) ? variants : [];
	return vs.find((v) => v && v.available === true) || vs[0] || null;
}

/**
 * POST a GraphQL query to a custom Shopify-style GQL endpoint.
 * Used by stores (tudor, legacyliquor) that share this pattern.
 */
async function shopifyGqlPost(ctx, endpoint, label, query, variables) {
	return ctx.http.fetchJsonWithRetry(endpoint, label, ctx.store.ua, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"content-type": "application/json",
			Origin: `https://${ctx.store.host}`,
			Referer: `https://${ctx.store.host}/`,
		},
		body: JSON.stringify({ query, variables }),
	});
}

module.exports = {
	normalizeShopifyProductUrl,
	shopifyPriceFromCents,
	extractShopifySkuFromImgPath,
	pickShopifyInStockVariant,
	shopifyGqlPost,
};
