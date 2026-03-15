"use strict";

const { decodeHtml, cleanText, extractFirstImgUrl } = require("../utils/html");
const { normalizeSkuKey } = require("../utils/sku");
const { extractPriceFromTmbBlock } = require("../utils/woocommerce");

// Tracker internals (store-only override; no global changes)
const { writeJsonAtomic, buildDbObject } = require("../tracker/db");
const { mergeDiscoveredIntoDb } = require("../tracker/merge");
const { addCategoryResultToReport } = require("../tracker/report");

function allowSierraUrlRumWhisky(item) {
	const u = item && item.url ? String(item.url) : "";
	const s = u.toLowerCase();
	if (!/^https?:\/\/sierraspringsliquor\.ca\//.test(s)) return false;
	return /\b(rum|whisk(?:e)?y)\b/.test(s);
}

// Keep old name referenced historically in this store config
const allowSierraSpiritsLiquorUrlRumWhisky = allowSierraUrlRumWhisky;

function allowSierraOtherWhiskyRescue(item) {
	const u = item && item.url ? String(item.url) : "";
	const n = item && item.name ? String(item.name) : "";
	const s = `${u} ${n}`.toLowerCase();
	if (!/^https?:\/\/sierraspringsliquor\.ca\//.test(s)) return false;

	if (/\b(whisk(?:e)?y|scotch|single\s*malt|bourbon|rye|campbeltown|islay|speyside|highland|lowland|irish|port\s*charlotte)\b/.test(s)) return true;

	if (/\b(springbank|hazelburn|longrow|kilkerran|ardbeg|laphroaig|lagavulin|bruichladdich|octomore|bunnahabhain|kilchoman|bowmore|caol\s*ila|kavalan|yamazaki|hakushu|hibiki|nikka|yoichi|miyagikyo|chichibu|mars\s*komagatake|glenfarclas|glenfiddich|glenlivet|glenmorangie|glendronach|glenallachie|glengoyne|glenrothes|glenburgie|glenlossie|glentauchers|glen\s*garioch|glen\s*grant|glen\s*keith|glen\s*spey|glen\s*scotia|benriach|benromach|ben\s*nevis|balvenie|balblair|blair\s*athol|clynelish|cragganmore|cardhu|dalmore|dalwhinnie|deanston|dailuaine|edradour|fettercairn|glen\s*elgin|glen\s*ord|inchgower|knockando|longmorn|linkwood|ledaig|tobermory|mannochmore|miltonduff|mortlach|oban|old\s*pulteney|an\s*cnoc|royal\s*brackla|royal\s*lochnagar|strathisla|strathmill|speyburn|talisker|teaninich|tamdhu|tomatin|tomintoul|tormore|tullibardine|auchroisk|aultmore|ardmore|ardnamurchan|arran|loch\s*lomond|lochlea|bladnoch|macallan|jura|highland\s*park|scapa|torabhaig|connemara|bushmills|redbreast|green\s*spot|yellow\s*spot|blue\s*spot|midleton|powers|teeling|roe\s*&?\s*co|jack\s*daniel'?s|woodford|maker'?s\s*mark|wild\s*turkey|buffalo\s*trace|eagle\s*rare|blanton'?s|elijah\s*craig|old\s*forester|four\s*roses|heaven\s*hill|knob\s*creek|basil\s*hayden|pike\s*creek|lot\s*40|lot40|forty\s*creek|crown\s*royal|alberta\s*premium|bearface|canadian\s*club|caribou\s*crossing|pendleton|orphan\s*barrel|cadenhead'?s|signatory(?:\s*vintage)?|gordon\s*&\s*macphail|connoisseurs?\s*choice|douglas\s*laing|old\s*particular|hunter\s*laing|old\s*malt\s*cask|adelphi|single\s*malts?\s*of\s*scotland|s\.?m\.?o\.?s\.?|scotch\s*malt\s*whisk(?:e)?y\s*society|s\.?m\.?w\.?s\.?|berry'?s(?:\s*own)?|berry\s*bros\.?\s*&\s*rudd|rest\s*&\s*be\s*thankful|wemyss|that\s*boutique-y\s*whisky\s*company|tbwc|elements\s*of\s*islay|blackadder|duncan\s*taylor|north\s*star|north\s*star\s*spirits|elixir\s*distillers|creative\s*whisky\s*company|chapter\s*7|single\s*cask\s*nation|whisky\s*agency|scotch\s*universe|hidden\s*spirits|liquid\s*treasures|archives|the\s*ultimate\s*whisky\s*company|brora|port\s*ellen|rosebank|littlemill|st\.?\s*magdalene|caperdonich|imperial|convalmore|coleburn|banff|dallas\s*dhu|pittyvaich|glenury\s*royal|port\s*dundas|cambus|carsebridge)\b/.test(s)) return true;

	if (/\b(vodka|gin|tequila|mezcal|pisco|ouzo|soju|beer|lager|ale|ipa|stout|porter|pilsner|cider|seltzer|cooler|radler|wine|cabernet|sauvignon|pinot|merlot|chardonnay|prosecco|rose|rosato|moscato|shiraz|grenache|malbec|rioja|chianti|amarone|cava|champagne|vermouth|liqueur|schnapps|bitters|syrup|mix(?:er|ology)?|cocktail|margarita|mojito|martini|caesar|lemonade|tea|mule|paloma|smash|4pk|6pk|8pk|12pk|15pk|18pk|24pk|30pk|36pk|355ml|330ml|341ml|458ml|473ml|500ml|710ml|king\s*can|tall\s*can)\b/.test(s)) return false;

	return false;
}

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

function parseWooStoreProductsJson(payload, ctx) {
	const items = [];

	let data = null;
	try {
		data = JSON.parse(payload);
	} catch (_) {
		return items;
	}

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

function parseWooProductsHtml(html, ctx) {
	const s = String(html || "");
	const items = [];

	const base = `https://${(ctx && ctx.store && ctx.store.host) || "sierraspringsliquor.ca"}/`;
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

		const url = new URL(decodeHtml(href), base).toString();

		const nameHtml =
			block.match(
				/<h2\b[^>]*class=["'][^"']*woocommerce-loop-product__title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
			)?.[1] ||
			block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ||
			"";
		const name = cleanText(decodeHtml(nameHtml));
		if (!name) continue;

		const price = extractPriceFromTmbBlock(block);

		const rawSku =
			block.match(/\bdata-product_sku=["']([^"']+)["']/i)?.[1] ||
			block.match(/\bdata-product_id=["']([^"']+)["']/i)?.[1] ||
			"";

		const taggedSku = /^\d{1,11}$/.test(String(rawSku).trim())
			? `id:${String(rawSku).trim()}`
			: String(rawSku || "").trim();

		const sku = normalizeSkuKey(taggedSku, { storeLabel: ctx?.store?.name, url });
		const img = extractFirstImgUrl(block, base);

		const item = { name, price, url, sku, img };

		const allowUrl = ctx?.cat?.allowUrl;
		if (typeof allowUrl === "function" && !allowUrl(item)) continue;

		items.push(item);
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

function parseProductsSierra(body, ctx) {
	const s = String(body || "");
	const t = s.trimStart();

	if (t.startsWith("[") || t.startsWith("{")) {
		const jsonItems = parseWooStoreProductsJson(s, ctx);
		ctx.logger?.dbg?.(`parseProductsSierra: storeApiItems=${jsonItems.length} bytes=${s.length}`);
		return jsonItems;
	}

	const blocks = s.split(/<div class="tmb\b/i);
	ctx.logger?.dbg?.(`parseProductsSierra: tmbBlocks=${Math.max(0, blocks.length - 1)} bytes=${s.length}`);

	const base = `https://${(ctx && ctx.store && ctx.store.host) || "sierraspringsliquor.ca"}/`;

	if (blocks.length > 1) {
		const items = [];
		for (let i = 1; i < blocks.length; i++) {
			const block = '<div class="tmb' + blocks[i];

			const titleMatch = block.match(
				/<h3\b[^>]*class=["'][^"']*t-entry-title[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i,
			);
			if (!titleMatch) continue;

			const url = new URL(decodeHtml(titleMatch[1]), base).toString();
			const name = cleanText(decodeHtml(titleMatch[2]));
			if (!name) continue;

			const price = extractPriceFromTmbBlock(block);

			const rawSku =
				block.match(/\bdata-product_sku=["']([^"']+)["']/i)?.[1] ||
				block.match(/\bSKU[:\s]*([0-9]{6})\b/i)?.[1] ||
				"";

			const taggedSku = /^\d{1,11}$/.test(String(rawSku).trim()) ? `id:${String(rawSku).trim()}` : rawSku;

			const sku = normalizeSkuKey(taggedSku, { storeLabel: ctx?.store?.name, url });
			const img = extractFirstImgUrl(block, base);

			const item = { name, price, url, sku, img };

			const allowUrl = ctx?.cat?.allowUrl;
			if (typeof allowUrl === "function" && !allowUrl(item)) continue;

			items.push(item);
		}

		const uniq = new Map();
		for (const it of items) uniq.set(it.url, it);
		return [...uniq.values()];
	}

	const woo = parseWooProductsHtml(s, ctx);
	ctx.logger?.dbg?.(`parseProductsSierra: wooItems=${woo.length} bytes=${s.length}`);
	return woo;
}

function extractProductCatTermId(html) {
	const s = String(html || "");
	// Typical body classes contain: "tax-product_cat term-<slug> term-1131 ..."
	const m = s.match(/tax-product_cat[^"']{0,400}\bterm-(\d{1,10})\b/i) || s.match(/\bterm-(\d{1,10})\b/i);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : null;
}

async function getWooCategoryIdForCat(ctx) {
	// allow manual override if you ever want it
	if (Number.isFinite(ctx?.cat?.wooCategoryId)) return ctx.cat.wooCategoryId;

	// cache per category object
	if (Number.isFinite(ctx?.cat?._wooCategoryId)) return ctx.cat._wooCategoryId;

	// infer from the HTML category page so startUrl stays stable (DB filenames stay stable)
	const { text, finalUrl } = await ctx.http.fetchTextWithRetry(ctx.cat.startUrl, "discover", ctx.store.ua);
	const id = extractProductCatTermId(text);

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
 * Sierra Springs: override scan to use Woo Store API pagination
 * while keeping original startUrl (so DB hashes and "source" stay unchanged).
 */
async function scanCategoryWooStoreApi(ctx, prevDb, report) {
	const { logger } = ctx;
	const t0 = Date.now();

	const perPage = Number.isFinite(ctx.cat.perPage) ? ctx.cat.perPage : 100;
	const discovered = new Map();

	const catId = await getWooCategoryIdForCat(ctx);
	if (!catId) return;

	const apiBase = new URL(`https://${ctx.store.host}/wp-json/wc/store/v1/products`);
	apiBase.searchParams.set("per_page", String(perPage));
	apiBase.searchParams.set("category", String(catId));

	const hardCap = 500;
	let page = 1;

	while (page <= hardCap) {
		apiBase.searchParams.set("page", String(page));
		const pageUrl = apiBase.toString();

		const { text, status, bytes, ms, finalUrl } = await ctx.http.fetchTextWithRetry(
			pageUrl,
			`page:${ctx.store.key}:${ctx.cat.key}:${page}`,
			ctx.store.ua,
		);

		// NEW: determine API page size BEFORE our parsing drops/normalizes items
		let apiCount = null;
		const trimmed = String(text || "").trimStart();
		if (trimmed.startsWith("[")) {
			try {
				const arr = JSON.parse(trimmed);
				if (Array.isArray(arr)) apiCount = arr.length;
			} catch (_) {
				// ignore; fall back to parsed length
			}
		}

		// IMPORTANT:
		// Parse WITHOUT allowUrl so pagination is based on real API page size
		const ctxNoFilter =
			typeof ctx?.cat?.allowUrl === "function" ? { ...ctx, cat: { ...ctx.cat, allowUrl: null } } : ctx;

		const itemsAll = (ctx.store.parseProducts || ctx.config.defaultParseProducts)(text, ctxNoFilter, finalUrl);

		// IMPORTANT:
		// Use API count for pagination; parsed count may be lower if we drop invalid items (e.g., missing name)
		const rawCount = Number.isFinite(apiCount) ? apiCount : itemsAll.length;

		// Now apply allowUrl AFTER pagination logic
		const items = [];
		const allow = ctx?.cat?.allowUrl;
		for (const it of itemsAll) {
			if (typeof allow === "function" && !allow(it)) continue;
			items.push(it);
		}

		logger.ok(
			`${ctx.catPrefixOut} | Page ${String(page).padStart(3, " ")} | ${String(status).padStart(3, " ")} | api=${String(
				rawCount,
			).padStart(3, " ")} parsed=${String(itemsAll.length).padStart(3, " ")} kept=${String(items.length).padStart(
				3,
				" ",
			)} | bytes=${String(bytes || 0).padStart(8, " ")} | ${(ms / 1000).toFixed(1).padStart(6, " ")}s`,
		);

		// Stop only when the API page itself is empty
		if (!rawCount) break;

		for (const it of items) discovered.set(it.url, it);

		// Last page if API returned fewer than perPage
		if (rawCount < perPage) break;

		page++;
	}

	logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);

	const { merged, newItems, updatedItems, removedItems, restoredItems, metaChangedItems } = mergeDiscoveredIntoDb(
		prevDb,
		discovered,
		{ storeLabel: ctx.store.name },
	);

	const dbObj = buildDbObject(ctx, merged);
	writeJsonAtomic(ctx.dbFile, dbObj);

	logger.ok(`${ctx.catPrefixOut} | DB saved: ${logger.dim(ctx.dbFile)} (${dbObj.count} items)`);

	const elapsedMs = Date.now() - t0;

	report.categories.push({
		store: ctx.store.name,
		label: ctx.cat.label,
		key: ctx.cat.key,
		dbFile: ctx.dbFile,
		scannedPages: Math.max(0, page),
		discoveredUnique: discovered.size,
		newCount: newItems.length,
		updatedCount: updatedItems.length,
		removedCount: removedItems.length,
		restoredCount: restoredItems.length,
		metaChangedCount: metaChangedItems.length,
		elapsedMs,
	});

	report.totals.newCount += newItems.length;
	report.totals.updatedCount += updatedItems.length;
	report.totals.removedCount += removedItems.length;
	report.totals.restoredCount += restoredItems.length;
	report.totals.metaChangedCount += metaChangedItems.length;

	addCategoryResultToReport(
		report,
		ctx.store.name,
		ctx.cat.label,
		newItems,
		updatedItems,
		removedItems,
		restoredItems,
	);
}

function createStore(defaultUa) {
	const ua = defaultUa;

	return {
		key: "sierrasprings",
		name: "Sierra Springs",
		host: "sierraspringsliquor.ca",
		ua,
		parseProducts: parseProductsSierra,

		// store-only override (no changes outside this file)
		scanCategory: scanCategoryWooStoreApi,

		// RESTORED: original 4 categories, unchanged startUrl so DB hashes match
		categories: [
			{
				key: "whisky",
				label: "Whisky",
				startUrl: "https://sierraspringsliquor.ca/product-category/whisky-2/",
				discoveryStartPage: 1,
				perPage: 100,
			},
			{
				key: "fine-rare",
				label: "Fine & Rare",
				startUrl: "https://sierraspringsliquor.ca/product-category/fine-rare/",
				discoveryStartPage: 1,
				perPage: 100,
			},
			{
				key: "spirits-liquor",
				label: "Spirits / Liquor",
				startUrl: "https://sierraspringsliquor.ca/product-category/spirits-liquor/",
				discoveryStartPage: 1,
				perPage: 100,
				allowUrl: allowSierraSpiritsLiquorUrlRumWhisky,
			},
			{
				key: "spirits",
				label: "Spirits",
				startUrl: "https://sierraspringsliquor.ca/product-category/spirits/",
				discoveryStartPage: 1,
				perPage: 100,
			},
			{
				key: "other",
				label: "Other",
				startUrl: "https://sierraspringsliquor.ca/product-category/other/",
				discoveryStartPage: 1,
				perPage: 100,
				allowUrl: allowSierraOtherWhiskyRescue,
			},
		],
	};
}

module.exports = { createStore, parseProductsSierra };