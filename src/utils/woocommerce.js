"use strict";

const { decodeHtml, stripTags, cleanText } = require("./html");
const { normalizeSkuKey } = require("./sku");
const { extractPrice } = require("./price");

/**
 * Extracts the *effective* price from Woo price blocks.
 * - If sale <ins> exists, uses the last <ins> (sale price)
 * - Else uses the normal price bdi/span content.
 */
function extractPriceFromTmbBlock(block) {
	const span = matchFirstPriceSpan(block);
	if (!span) return "";

	const insMatches = [...span.matchAll(/<ins\b[^>]*>([\s\S]*?)<\/ins>/gi)];
	const scope = insMatches.length ? insMatches[insMatches.length - 1][1] : span;

	const bdis = [...scope.matchAll(/<bdi\b[^>]*>([\s\S]*?)<\/bdi>/gi)];
	if (bdis.length) {
		const raw = cleanText(decodeHtml(stripTags(bdis[bdis.length - 1][1]))).replace(/\s+/g, "");
		if (raw) return raw.startsWith("$") ? raw : `$${raw}`;
	}

	const sym = scope.match(/woocommerce-Price-currencySymbol[^>]*>\s*([^<\s]+)/i);
	const text = cleanText(decodeHtml(stripTags(scope)));
	const num = text.match(/(\d+(?:\.\d{2})?)/);
	if (sym && num) return `${sym[1].trim()}${num[1]}`;

	const m = cleanText(decodeHtml(stripTags(scope))).match(/\$\s*\d+(?:\.\d{2})?/);
	return m ? m[0].replace(/\s+/g, "") : "";
}

function matchFirstPriceSpan(html) {
	const re = /<span\b[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>/i;
	const m = re.exec(html);
	if (!m) return "";
	const start = m.index + m[0].length;

	let i = start;
	let depth = 1;
	while (i < html.length) {
		const nextOpen = html.indexOf("<span", i);
		const nextClose = html.indexOf("</span>", i);
		if (nextClose === -1) break;

		if (nextOpen !== -1 && nextOpen < nextClose) {
			depth++;
			i = nextOpen + 5;
			continue;
		}
		depth--;
		if (depth === 0) return html.slice(start, nextClose);
		i = nextClose + 7;
	}
	return "";
}

/* ─────────────────────────────────────────────────────────────────────────
 * WooCommerce Store REST API helpers
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Convert a WC Store API `prices` object to a "$X.XX" string.
 * Handles currency_minor_unit (cents vs dollars), prefix, and suffix.
 */
function formatWooStorePrice(prices) {
	if (!prices) return null;
	const minor = Number.isFinite(prices.currency_minor_unit) ? prices.currency_minor_unit : 2;
	const raw = prices.price ?? prices.regular_price ?? prices.sale_price;
	if (raw == null) return null;
	const n = Number(String(raw).replace(/[^\d]/g, ""));
	if (!Number.isFinite(n)) return null;
	const value = (n / Math.pow(10, minor)).toFixed(minor);
	const prefix = prices.currency_prefix ?? prices.currency_symbol ?? "$";
	const suffix = prices.currency_suffix ?? "";
	return `${prefix}${value}${suffix}`;
}

/**
 * Parse a WC Store API JSON product array (text payload) into tracked items.
 * Respects ctx.cat.allowUrl if defined.
 */
function parseWooStoreProductsJson(payload, ctx) {
	const items = [];
	let data = null;
	try { data = JSON.parse(payload); } catch (_) { return items; }
	if (!Array.isArray(data)) return items;

	for (const p of data) {
		const url = p && p.permalink ? String(p.permalink) : "";
		if (!url) continue;

		const name = p && p.name ? cleanText(decodeHtml(String(p.name))) : "";
		if (!name) continue;

		const price = formatWooStorePrice(p.prices);

		const rawSku =
			typeof p?.sku === "string" && p.sku.trim() ? p.sku.trim() : p && (p.id ?? p.id === 0) ? String(p.id) : "";
		const taggedSku = /^\d{1,11}$/.test(rawSku) ? `id:${rawSku}` : rawSku;
		const sku = normalizeSkuKey(taggedSku, { storeLabel: ctx?.store?.name, url });

		const img =
			p.images && Array.isArray(p.images) && p.images[0] && p.images[0].src ? String(p.images[0].src) : null;

		const item = { name, price, url, sku, img };
		const allowUrl = ctx?.cat?.allowUrl;
		if (typeof allowUrl === "function" && !allowUrl(item)) continue;
		items.push(item);
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

/**
 * Extract the numeric WooCommerce product_cat term id from a category page's HTML.
 * The body class typically contains "tax-product_cat term-<slug> term-1131 ...".
 */
function extractWooCategoryTermId(html) {
	const s = String(html || "");
	const m = s.match(/tax-product_cat[^"']{0,400}\bterm-(\d{1,10})\b/i) || s.match(/\bterm-(\d{1,10})\b/i);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : null;
}

/**
 * Fetch and cache the WC product_cat term id for ctx.cat.
 * Falls back gracefully with a warning if the id cannot be inferred.
 */
async function getWooCategoryId(ctx) {
	if (Number.isFinite(ctx?.cat?.wooCategoryId)) return ctx.cat.wooCategoryId;
	if (Number.isFinite(ctx?.cat?._wooCategoryId)) return ctx.cat._wooCategoryId;

	const { text, finalUrl } = await ctx.http.fetchTextWithRetry(ctx.cat.startUrl, "discover", ctx.store.ua);
	const id = extractWooCategoryTermId(text);

	if (!id) {
		ctx.logger.warn(
			`${ctx.catPrefixOut} | Could not infer product_cat term id from category page; falling back to HTML parsing only.`,
		);
		ctx.cat._wooCategoryId = null;
		return null;
	}

	ctx.logger.ok(`${ctx.catPrefixOut} | Woo category id: ${id} (${finalUrl || ctx.cat.startUrl})`);
	ctx.cat._wooCategoryId = id;
	return id;
}

/**
 * Build a wp-json/wc/store/v1/products API base URL from a category startUrl.
 * Carries over stock_status and price range filters from Divi Search & Filter Pro (_sfm_*) params.
 */
function buildWooStoreApiUrl(startUrl) {
	const u = new URL(startUrl);
	const api = new URL(`https://${u.hostname}/wp-json/wc/store/v1/products`);
	api.searchParams.set("order", "desc");
	api.searchParams.set("orderby", "date");

	const stock = u.searchParams.get("_sfm__stock_status");
	if (stock && /instock/i.test(stock)) api.searchParams.set("stock_status", "instock");

	const pr = u.searchParams.get("_sfm__regular_price");
	if (pr) {
		const m = String(pr).match(/^\s*([0-9]+)\s*\+\s*([0-9]+)\s*$/);
		if (m) {
			api.searchParams.set("min_price", m[1]);
			api.searchParams.set("max_price", m[2]);
		}
	}

	return api;
}

/** Return true if the product item belongs to the given category slug. */
function hasCategorySlug(p, wanted) {
	const w = String(wanted || "").trim().toLowerCase();
	if (!w) return true;
	const cats = Array.isArray(p?.categories) ? p.categories : [];
	for (const c of cats) {
		if (String(c?.slug || "").trim().toLowerCase() === w) return true;
	}
	return false;
}

function normalizeWooProductUrl(p) {
	const u = String(p?.permalink || p?.link || "").trim();
	return u && u.startsWith("http") ? u : "";
}

function normalizeWooProductName(p) {
	return cleanText(decodeHtml(stripTags(String(p?.name || ""))));
}

function normalizeWooProductImage(p) {
	const imgs = Array.isArray(p?.images) ? p.images : [];
	for (const im of imgs) {
		if (!im) continue;
		const raw =
			(typeof im === "string" ? im : "") ||
			(typeof im?.src === "string" ? im.src : "") ||
			(typeof im?.thumbnail === "string" ? im.thumbnail : "") ||
			(typeof im?.url === "string" ? im.url : "");
		const s = String(raw || "").trim();
		if (!s) continue;
		return s.startsWith("//") ? `https:${s}` : s;
	}
	const direct = String(p?.image || p?.image_url || p?.imageUrl || "").trim();
	if (!direct) return "";
	return direct.startsWith("//") ? `https:${direct}` : direct;
}

/**
 * Convert a WC Store API minor-unit integer string to a decimal string.
 * e.g. toMoneyStringFromMinorUnits("2499", 2) → "24.99"
 */
function toMoneyStringFromMinorUnits(valueStr, minorUnit) {
	const mu = Number(minorUnit);
	if (!Number.isFinite(mu) || mu < 0 || mu > 6) return "";
	const v = String(valueStr || "").trim();
	if (!/^\d+$/.test(v)) return "";
	const pad = "0".repeat(mu);
	const s = v.length <= mu ? pad.slice(0, mu - v.length) + v : v;
	const whole = s.length === mu ? "0" : s.slice(0, s.length - mu);
	const frac = mu === 0 ? "" : s.slice(s.length - mu);
	return mu === 0 ? whole : `${whole}.${frac}`;
}

function normalizeWooProductPrice(p) {
	const prices = p?.prices;
	if (prices && typeof prices === "object") {
		const minor = prices.currency_minor_unit;
		const sale = String(prices.sale_price || "").trim();
		const regular = String(prices.regular_price || "").trim();
		const chosen = sale || regular;
		if (chosen) {
			let numeric = chosen;
			if (/^\d+$/.test(chosen) && minor !== undefined && minor !== null) {
				const converted = toMoneyStringFromMinorUnits(chosen, minor);
				if (converted) numeric = converted;
			}
			const num = Number(numeric);
			if (Number.isFinite(num) && num >= 0) return `$${num.toFixed(2)}`;
		}
	}
	return extractPrice(String(p?.price || p?.price_html || "").trim());
}

function normalizeWooProductSku(p) {
	const sku = String(p?.sku || "").trim();
	return /^\d{6}$/.test(sku) ? sku : "";
}

function normalizeWooProductId(p) {
	const id = Number(p?.id);
	return Number.isFinite(id) ? id : 0;
}

/**
 * Fetch one page from a WC Store API endpoint.
 * apiBaseUrl should already have category/filter params set.
 */
async function fetchWooStoreApiPage(ctx, apiBaseUrl, page, perPage) {
	const u = new URL(apiBaseUrl.toString());
	u.searchParams.set("page", String(page));
	u.searchParams.set("per_page", String(perPage));
	return await ctx.http.fetchJsonWithRetry(
		u.toString(),
		`${ctx.store.key}:storeapi:${ctx.cat.key}:p${page}`,
		ctx.store.ua,
		{ method: "GET", headers: { Accept: "application/json", Referer: ctx.cat.startUrl } },
	);
}

module.exports = {
	extractPriceFromTmbBlock,
	formatWooStorePrice,
	parseWooStoreProductsJson,
	extractWooCategoryTermId,
	getWooCategoryId,
	buildWooStoreApiUrl,
	hasCategorySlug,
	normalizeWooProductUrl,
	normalizeWooProductName,
	normalizeWooProductImage,
	toMoneyStringFromMinorUnits,
	normalizeWooProductPrice,
	normalizeWooProductSku,
	normalizeWooProductId,
	fetchWooStoreApiPage,
};
