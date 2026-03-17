"use strict";

const { cleanText } = require("./html");
const { normalizeSkuKey } = require("./sku");
const { normalizeAbsUrl } = require("./url");

const BARNET_IMG_BASE = "https://s.barnetnetwork.com/img/m/";

function barnetPickBestPrice(p) {
	function toNum(v) {
		const n = Number(String(v ?? "").trim().replace(/[^0-9.]/g, ""));
		return Number.isFinite(n) ? n : NaN;
	}
	const reg = toNum(p?.regular_price);
	const sale = toNum(p?.sale_price);
	const net = toNum(p?.net_price);

	let n = NaN;
	if (Number.isFinite(sale) && sale > 0) {
		if (p?.is_sale === true) n = sale;
		else if (Number.isFinite(reg) && reg > 0 && sale < reg) n = sale;
		else if (!Number.isFinite(net) || net <= 0 || sale <= net) n = sale;
	}
	if (!Number.isFinite(n) && Number.isFinite(net) && net > 0) n = net;
	if (!Number.isFinite(n) && Number.isFinite(reg) && reg > 0) n = reg;
	return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
}

function barnetIsInStock(p) {
	if (p && p.available_for_sale === false) return false;
	const onHand = Number(p?.on_hand);
	if (Number.isFinite(onHand)) return onHand > 0;
	return Boolean(p?.available_for_sale);
}

/**
 * Normalize a Barnet API image path to a full CDN URL.
 * Already-absolute CDN URLs are returned as-is.
 * Relative paths are prepended with the Barnet CDN base.
 */
function barnetNormalizeImgUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	if (/^https?:\/\/s\.barnetnetwork\.com\/img\/m\//i.test(s)) return s;
	const noProto = s.replace(/^https?:\/\/[^/]+/i, "");
	const rel = noProto.replace(/^\/+/, "");
	if (rel && !/^data:/i.test(rel)) return `${BARNET_IMG_BASE}${rel}`;
	return "";
}

/**
 * Convert a Barnet API product object to a tracked item.
 * Returns null if the item is out of stock or missing required fields.
 */
function barnetItemToTracked(p, ctx) {
	if (!p) return null;
	if (!barnetIsInStock(p)) return null;

	const url = normalizeAbsUrl(p.url, `https://${ctx.store.host}/`);
	if (!url) return null;

	const name = cleanText(p.description || p.name || "");
	if (!name) return null;

	const price = barnetPickBestPrice(p);

	const rawCspcId = String(p?.cspcid ?? "").trim();
	const hasCspcId = /^\d{1,11}$/.test(rawCspcId);
	const id = Number(p?.id);
	const rawSku = hasCspcId ? `id:${rawCspcId}` : Number.isFinite(id) ? `id:${id}` : "";
	const sku = normalizeSkuKey(rawSku, { storeLabel: ctx?.store?.name, url }) || rawSku || "";

	const img = barnetNormalizeImgUrl(p.image || p.image_url || p.img || "");

	return { name, price, url, sku, img };
}

/**
 * Build a Barnet network API products request URL for a given page.
 * @param {string} host - store hostname (e.g. "shop.vintagespirits.ca")
 * @param {string} shopId - Barnet shop ID (e.g. "679-320")
 * @param {string} category - category name (e.g. "40 SPIRITS")
 * @param {string} subCategory - sub-category name (e.g. "RUM")
 * @param {number} page - 1-based page number
 * @param {string} [sortBy] - sort order (default "price_desc")
 */
function buildBarnetApiUrl(host, shopId, category, subCategory, page, sortBy = "price_desc") {
	const u = new URL(`https://${host}/api/shop/${shopId}/products`);
	u.searchParams.set("p", String(page));
	u.searchParams.set("show_on_web", "true");
	u.searchParams.set("sort_by", sortBy);
	u.searchParams.set("category", category);
	u.searchParams.set("sub_category", subCategory);
	u.searchParams.set("varital_name", "");
	u.searchParams.set("no_item_found", "No item found.");
	u.searchParams.set("avail_for_sale", "false");
	u.searchParams.set("_dc", String(Date.now()));
	return u.toString();
}

module.exports = { barnetPickBestPrice, barnetIsInStock, barnetNormalizeImgUrl, barnetItemToTracked, buildBarnetApiUrl };
