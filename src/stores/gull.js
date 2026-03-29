// src/stores/gull.js
"use strict";

const { decodeHtml, cleanText, extractFirstImgUrl, splitLiProductBlocks } = require("../utils/html");
const { normalizeCspc, pickBetterSku, needsSkuDetail } = require("../utils/sku");
const { makePageUrl } = require("../utils/url");
const { createMinIntervalLimiter } = require("../utils/async");

function looksInStock(block) {
	const s = String(block || "");
	if (/\boutofstock\b/i.test(s)) return false;
	if (/\bin-stock\b/i.test(s)) return true;
	if (/\binstock\b/i.test(s)) return true;
	if (/>\s*\d+\s+in\s+stock\s*</i.test(s)) return true;
	return /\bin-stock\b/i.test(s);
}

// Gull product tiles commonly contain two amounts:
//  - actual price (e.g. 24.05)
//  - deposit (e.g. 0.10) inside the "price suffix"
// We extract all amounts and pick the last one >= 1.00 (sale price if present).
function extractGullPriceFromBlock(block) {
	const s = String(block || "");
	const nums = [];

	// Match WooCommerce "Price amount" blocks, pull out the BDI contents,
	// then strip tags/entities and parse as float.
	const re =
		/<span\b[^>]*class=["'][^"']*\bwoocommerce-Price-amount\b[^"']*["'][^>]*>\s*<bdi\b[^>]*>([\s\S]*?)<\/bdi>/gi;

	for (const m of s.matchAll(re)) {
		const raw = cleanText(decodeHtml(m[1] || "")); // e.g. "$24.05"
		const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
		if (Number.isFinite(n)) nums.push(n);
	}

	// Filter out bottle deposits / tiny fees (usually 0.10, 0.20, etc.)
	const big = nums.filter((n) => n >= 1.0);

	if (!big.length) return "";

	// If sale price exists, Woo often renders old then new; taking the last >=1
	// typically yields the current price.
	const chosen = big[big.length - 1];

	// Normalize formatting
	return `$${chosen.toFixed(2)}`;
}

// Gull SKUs are often NOT 6 digits (e.g. 67424).
// If it's not 6 digits, represent as id:<digits> to avoid normalizeCspc turning it into u:SHA.
function normalizeGullSku(raw) {
	const s = cleanText(decodeHtml(String(raw || ""))).trim();

	// already in a stable prefixed form
	if (/^(id:|u:)/i.test(s)) return s;

	// digits-only SKU (from page / tile)
	const digits = s.match(/\b(\d{3,10})\b/)?.[1] || "";
	if (digits) {
		if (digits.length === 6) return normalizeCspc(digits);
		return `id:${digits}`;
	}

	// fall back to existing normalizer (may yield u:...)
	return normalizeCspc(s);
}

// When we fall back to normalizeCspc(url), we may end up with a generated u:XXXXXXXX.
function isGeneratedUrlSku(sku) {
	const s = String(sku || "");
	// you have u:8hex in the DB, so accept 8+
	return /^u:[0-9a-f]{8,128}$/i.test(s);
}

// Extract SKU from Gull product page HTML.
function extractGullSkuFromProductPage(html) {
	const s = String(html || "");

	// Most reliable: <span class="sku">67424</span>
	const m1 = s.match(/<span\b[^>]*class=["'][^"']*\bsku\b[^"']*["'][^>]*>\s*([0-9]{3,10})\s*<\/span>/i);
	if (m1?.[1]) return normalizeGullSku(m1[1]);

	// Fallback: "SKU: 67424" text
	const m2 = s.match(/\bSKU:\s*([0-9]{3,10})\b/i);
	if (m2?.[1]) return normalizeGullSku(m2[1]);

	return "";
}


async function fetchWith429Backoff(url, { fetchFn, headers, maxRetries = 2 }) {
	let attempt = 0;

	while (true) {
		const res = await fetchFn(url, { headers });

		if (res.status !== 429) {
			if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
			return await res.text();
		}

		if (attempt >= maxRetries) throw new Error(`HTTP 429 fetching ${url}`);

		// Respect Retry-After if present; otherwise progressive backoff.
		const ra = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;

		const waitSec = ra && /^\d+$/.test(ra) ? parseInt(ra, 10) : 15 * (attempt + 1);
		await new Promise((r) => setTimeout(r, waitSec * 1000));
		attempt++;
	}
}

/**
 * Only fetches product pages for items whose sku is a generated u:... (from URL fallback).
 * Runs serially + slowly to avoid Gull 429s.
 *
 * NEW: accepts prevDb so we can skip fetch if URL already has a good SKU cached.
 */
async function hydrateGullSkus(items, { fetchFn, ua, minIntervalMs = 12000, maxRetries = 2, prevDb } = {}) {
	if (!fetchFn) throw new Error("hydrateGullSkus requires opts.fetchFn");

	const schedule = createMinIntervalLimiter(minIntervalMs);

	const headers = {
		"user-agent": ua || "Mozilla/5.0",
		accept: "text/html,application/xhtml+xml",
	};

	for (const it of items || []) {
		if (!it || !it.url) continue;

		// NEW: if DB already has a good SKU, reuse it and skip fetch
		const prev = prevDb?.byUrl?.get(it.url) || null;
		if (prev?.sku && !needsSkuDetail(prev.sku)) {
			it.sku = pickBetterSku(it.sku, prev.sku);
			continue;
		}

		if (!isGeneratedUrlSku(it.sku)) continue; // only where required

		const html = await schedule(() => fetchWith429Backoff(it.url, { fetchFn, headers, maxRetries }));

		const realSku = extractGullSkuFromProductPage(html);
		if (realSku) it.sku = pickBetterSku(realSku, it.sku);
	}

	return items;
}

function parseProductsGull(html, ctx) {
	const blocks = splitLiProductBlocks(String(html || ""));
	if (!blocks.length) return [];

	const base = `https://${(ctx && ctx.store && ctx.store.host) || "gullliquorstore.com"}/`;
	const items = [];

	for (const block of blocks) {

		if (!looksInStock(block)) continue;

		const hrefM = block.match(
			/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bwoocommerce-LoopProduct-link\b/i,
		);
		if (!hrefM || !hrefM[1]) continue;

		let url;
		try {
			url = new URL(decodeHtml(hrefM[1]), base).toString();
		} catch {
			continue;
		}

		const titleM = block.match(
			/<h2\b[^>]*class=["'][^"']*\bwoocommerce-loop-product__title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
		);
		const name = cleanText(decodeHtml(titleM ? titleM[1] : ""));
		if (!name) continue;

		const price = extractGullPriceFromBlock(block);

		const skuRaw =
			block.match(/\bdata-product_sku=["']([^"']+)["']/i)?.[1] ||
			block.match(/\bSKU\b[^0-9]{0,30}(\d{3,10})\b/i)?.[1] ||
			url; // OK fallback; hydrateGullSkus will only re-fetch when this becomes u:...

		const sku = normalizeGullSku(skuRaw);

		const img = extractFirstImgUrl(block, base);

		items.push({ name, price, url, sku, img });
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

function createStore(defaultUa) {
	return {
		key: "gull",
		region: "BC",
		name: "Gull Liquor",
		host: "gullliquorstore.com",
		ua: defaultUa,
		parseProducts: parseProductsGull,

		// Optional hook callers can use to post-process items:
		// only hits product pages when sku is u:...
		hydrateSkus: hydrateGullSkus,
		productPageMinIntervalMs: 12000, // slow by default; Gull is strict

		makePageUrl, // enables /page/N/ paging
		categories: [
			{
				key: "whisky",
				label: "Whisky",
				startUrl: "https://gullliquorstore.com/product-category/spirits/?spirit_type=whisky",
				discoveryStartPage: 3,
				discoveryStep: 2,
				pageConcurrency: 1,
				pageStaggerMs: 10000,
				discoveryDelayMs: 10000,
			},
			{
				key: "rum",
				label: "Rum",
				startUrl: "https://gullliquorstore.com/product-category/spirits/?spirit_type=rum",
				discoveryStartPage: 3,
				discoveryStep: 2,
				pageConcurrency: 1,
				pageStaggerMs: 10000,
				discoveryDelayMs: 10000,
			},
			{
				key: "gin",
				label: "Gin",
				startUrl: "https://gullliquorstore.com/product-category/spirits/?spirit_type=gin",
				discoveryStartPage: 3,
				discoveryStep: 2,
				pageConcurrency: 1,
				pageStaggerMs: 10000,
				discoveryDelayMs: 10000,
			},
		],
	};
}

module.exports = {
	createStore,
	parseProductsGull,
	hydrateGullSkus,
	extractGullSkuFromProductPage,
	isGeneratedUrlSku,
	normalizeGullSku,
};
