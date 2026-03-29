"use strict";

const { decodeHtml, cleanText, stripTags, extractFirstImgUrl, splitLiProductBlocks } = require("../utils/html");
const { makePageUrlQueryParam } = require("../utils/url");
const { normalizeSkuKey } = require("../utils/sku");

function makePageUrlKegNCork(baseUrl, pageNum) {
	return makePageUrlQueryParam(baseUrl, "page", pageNum);
}

function parseProductsKegNCork(html, ctx) {
	const s = String(html || "");
	const items = [];

	const base = `https://${(ctx && ctx.store && ctx.store.host) || "kegncork.com"}/`;

	const blocks = splitLiProductBlocks(s);
	ctx.logger?.dbg?.(`parseProductsKegNCork: li.product blocks=${blocks.length} bytes=${s.length}`);

	for (const block of blocks) {

		const mTitle = block.match(
			/<h4\b[^>]*class=["'][^"']*\bcard-title\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
		);
		if (!mTitle) continue;

		const url = decodeHtml(mTitle[1]).trim();
		const name = cleanText(decodeHtml(mTitle[2]));
		if (!url || !/^https?:\/\//i.test(url) || !name) continue;

		let price = "";
		const mPrice = block.match(/data-product-price-without-tax[^>]*>\s*([^<]+)\s*</i);
		if (mPrice && mPrice[1]) {
			const p = cleanText(decodeHtml(mPrice[1])).replace(/\s+/g, "");
			if (p) price = p.startsWith("$") ? p : `$${p}`;
		} else {
			const priceSection = block.match(/data-test-info-type=["']price["'][\s\S]*?<\/div>\s*<\/div>/i)?.[0] || "";
			const mDollar = cleanText(decodeHtml(stripTags(priceSection))).match(/\$\s*\d+(?:\.\d{2})?/);
			if (mDollar) price = mDollar[0].replace(/\s+/g, "");
		}

		const img = extractFirstImgUrl(block, base);

		const rawSku = block.match(/\bdata-product_sku=["']([^"']+)["']/i)?.[1] || "";
		const sku = normalizeSkuKey(rawSku, { storeLabel: "Keg N Cork", url });

		items.push({ name, price, url, sku, img });
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

function createStore(defaultUa) {
	return {
		key: "kegncork",
		region: "AB",
		name: "Keg N Cork",
		host: "kegncork.com",
		ua: defaultUa,
		parseProducts: parseProductsKegNCork,
		makePageUrl: makePageUrlKegNCork,
		categories: [
			{
				key: "whisky",
				label: "Whisky",
				startUrl: "https://kegncork.com/whisky/?page=1",
				discoveryStartPage: 5,
			},
			{
				key: "rum",
				label: "Rum",
				startUrl: "https://kegncork.com/rum/?page=1",
				discoveryStartPage: 1,
			},
			{
				key: "gin",
				label: "Gin",
				startUrl: "https://kegncork.com/gin/?page=1",
				discoveryStartPage: 1,
			},
		],
	};
}

module.exports = { createStore };
