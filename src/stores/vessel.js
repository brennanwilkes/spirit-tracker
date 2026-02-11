"use strict";

const { decodeHtml, cleanText, extractFirstImgUrl } = require("../utils/html");
const { normalizeCspc } = require("../utils/sku");
const { normalizeBaseUrl } = require("../utils/url");

function normalizeAbsUrl(raw) {
	const s = String(raw || "").trim();
	if (!s) return "";
	if (s.startsWith("//")) return `https:${s}`;
	if (/^https?:\/\//i.test(s)) return s;
	try {
		return new URL(s, "https://vesselliquor.com/").toString();
	} catch {
		return s;
	}
}

// Strip noisy Shopify/tracking params so URLs stay stable.
// Keep only "variant" since it can represent a distinct product configuration.
function normalizeShopifyProductUrl(rawUrl) {
	try {
		const u = new URL(String(rawUrl || ""));
		u.hash = "";

		const keep = new Set(["variant"]);
		for (const k of [...u.searchParams.keys()]) {
			if (!keep.has(k)) u.searchParams.delete(k);
		}

		if ([...u.searchParams.keys()].length === 0) u.search = "";
		if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");

		return u.toString();
	} catch {
		return String(rawUrl || "");
	}
}

function makeVesselPageUrl(baseUrl, pageNum) {
	const u = new URL(normalizeBaseUrl(baseUrl));
	u.hash = "";
	if (pageNum <= 1) u.searchParams.delete("page");
	else u.searchParams.set("page", String(pageNum));
	u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : "";
	return u.toString();
}

function vesselLooksInStock(block) {
	const s = String(block || "").toLowerCase();
	if (s.includes("sold out") || s.includes("sold-out") || s.includes("out of stock")) return false;
	if (/\bdata-available=["']false["']/.test(s)) return false;
	return true;
}

function vesselExtractPrice(block) {
	const s = String(block || "");

	const saleTags = [...s.matchAll(/<sale-price\b[^>]*>([\s\S]*?)<\/sale-price>/gi)];
	for (let i = saleTags.length - 1; i >= 0; i--) {
		const txt = cleanText(decodeHtml(saleTags[i][1] || ""));
		const m = txt.match(/\$\s*\d+(?:\.\d{2})?/);
		if (m) return m[0].replace(/\s+/g, "");
	}

	// Fallback: read price-list but ignore compare-at (crossed-out)
	const withoutCompare = s.replace(/<compare-at-price\b[^>]*>[\s\S]*?<\/compare-at-price>/gi, "");
	const pl = withoutCompare.match(/<price-list\b[^>]*>([\s\S]*?)<\/price-list>/i);
	if (pl) {
		const txt = cleanText(decodeHtml(pl[1] || ""));
		const all = [...txt.matchAll(/\$\s*\d+(?:\.\d{2})?/g)];
		if (all.length) return all[all.length - 1][0].replace(/\s+/g, "");
	}

	return "";
}

function vesselExtractSkuFromImgOrBlock(imgUrl, block) {
	const cspc = normalizeCspc(imgUrl) || "";
	if (cspc) return cspc;

	try {
		const u = new URL(String(imgUrl || ""));
		const m = u.pathname.match(/\/(\d{1,11})\.(?:jpe?g|png|webp)$/i);
		if (m && m[1]) return `id:${m[1]}`;
	} catch {}

	const s = String(block || "");
	const m2 = s.match(/\/cdn\/shop\/(?:products|files)\/(\d{1,11})\.(?:jpe?g|png|webp)/i);
	if (m2 && m2[1]) return `id:${m2[1]}`;

	return "";
}

function vesselCardToItem(block, base) {
	if (!vesselLooksInStock(block)) return null;

	const hrefM = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
	if (!hrefM || !hrefM[1]) return null;

	let url = "";
	try {
		url = new URL(decodeHtml(hrefM[1]), base).toString();
		url = normalizeShopifyProductUrl(url);
	} catch {
		return null;
	}

	const titleM =
		block.match(/product-card__title[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i) ||
		block.match(/<img\b[^>]*\balt=["']([^"']+)["']/i);

	const name = cleanText(decodeHtml(titleM ? titleM[1] : ""));
	if (!name) return null;

	const img = normalizeAbsUrl(extractFirstImgUrl(block, base));
	const price = vesselExtractPrice(block);

	// Prefer numeric filename SKU like 67424.jpg (works for 5-digit too)
	const sku = vesselExtractSkuFromImgOrBlock(img, block);

	return { name, price, url, sku, img };
}

function parseProductsVessel(html, ctx) {
	const s = String(html || "");
	const base = `https://${(ctx && ctx.store && ctx.store.host) || "vesselliquor.com"}/`;

	const parts = s.split(/<product-card\b/i);
	if (parts.length <= 1) return [];

	const items = [];
	for (let i = 1; i < parts.length; i++) {
		const block = "<product-card" + parts[i];
		const it = vesselCardToItem(block, base);
		if (it) items.push(it);
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

function createStore(defaultUa) {
	return {
		key: "vessel",
		name: "Vessel Liquor",
		host: "vesselliquor.com",
		ua: defaultUa,

		parseProducts: parseProductsVessel,
		makePageUrl: makeVesselPageUrl, // Shopify ?page=N (preserves filter/sort params)

		categories: [
			{
				key: "whisky",
				label: "Whisky",
				startUrl: "https://vesselliquor.com/collections/whisky?sort_by=title-ascending&filter.v.availability=1",
				discoveryStartPage: 20,
				discoveryStep: 10,
			},
			{
				key: "rum-cane-spirit",
				label: "Rum / Cane Spirit",
				startUrl:
					"https://vesselliquor.com/collections/rum-cane-spirit?sort_by=title-ascending&filter.v.availability=1",
				discoveryStartPage: 20,
				discoveryStep: 10,
			},
		],
	};
}

module.exports = { createStore, parseProductsVessel };
