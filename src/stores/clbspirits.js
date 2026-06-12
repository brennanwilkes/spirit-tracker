"use strict";

const { sanitizeName } = require("../utils/text");
const {
	normalizeCspc, normalizeSkuKey, pickBetterSku, needsSkuDetail,
} = require("../utils/sku");
const {
	normalizeShopifyProductUrl,
	shopifyPriceFromCents,
	pickShopifyInStockVariant,
} = require("../utils/shopify");
const { finalizeCategoryScan } = require("../tracker/finalize");
const {
	fetchCollectionProductsJson,
	fetchProductJs,
	resolveShopifyProductSku,
	shopifyPickImage,
	anyVariantAvailable,
	priceFromShopifyDollarsStr,
} = require("../platforms/shopify_collection");

const WHISKY_PATTERNS = [
	/^whisky(-\d+)?$/i, /^whiskey(-\d+)?$/i,
	/-whisky$/, /-whiskey$/,
	/scotch$/, /single.malt/, /blended.scotch/,
	/^bourbon$/i, /^rye$/i,
	/^highlands/, /^islay/, /^speyside/, /^campbletown/, /^lowlands/, /^islands/,
	/^independent.bottler$/i,
	/^canadian.whisky/, /^irish.whisky/, /^japanese.whisky/,
	/^australian.whisky/, /^english.whisky/, /^french.whisky/,
	/^indian.whisky/, /^taiwanese.whisky/, /^chinese.whisky/,
	/^italian.whisky/, /^swedish.whisky/, /^spanish.whisky/,
	/^welsh.whisky/, /^israeli.whisky/,
	/^flavoured.whisky/i,
];

const RUM_PATTERNS = [
	/^rum(-\d+)?$/i,
	/^(aged|amber|dark|flavoured|spiced|white).rum/i,
];

const GIN_PATTERNS = [
	/^gin(-\d+)?$/i,
	/^flavoured.gin/i,
];

const MIXED_HANDLES = new Set([
	"rare-limited-1",
]);

const WHISKY_POS_RE = /\b(whisk(?:e)?y|scotch|single.malt|blended|bourbon|rye|highlands|islay|speyside|islands|campbletown|lowlands|independent.bottler)\b/i;
const RUM_POS_RE = /\b(rum|rhum)\b/i;
const GIN_POS_RE = /\bgin\b/i;
const NEG_RE = /\b(tequila|mezcal|cognac|vodka|brandy|armagnac|calvados|grappa|liqueur|wine|champagne|beer|cider)\b/i;

function classifyCollection(handle) {
	handle = String(handle || "").trim();
	if (MIXED_HANDLES.has(handle)) return "mixed";
	for (const p of WHISKY_PATTERNS) if (p.test(handle)) return "whisky";
	for (const p of RUM_PATTERNS) if (p.test(handle)) return "rum";
	for (const p of GIN_PATTERNS) if (p.test(handle)) return "gin";
	return null;
}

function rejectProductForKind(p, kind) {
	const tags = Array.isArray(p?.tags) ? p.tags : [];
	const allTags = tags.join(" ");
	if (NEG_RE.test(allTags)) return true;
	switch (kind) {
		case "whisky": return !WHISKY_POS_RE.test(allTags);
		case "rum":    return !RUM_POS_RE.test(allTags);
		case "gin":    return !GIN_POS_RE.test(allTags);
	}
	return true;
}

async function discoverCollections(ctx) {
	const host = ctx.store.host;
	const out = { whisky: [], rum: [], gin: [], mixed: [] };
	for (let page = 1; page <= 10; page++) {
		const url = `https://${host}/collections.json?limit=250&page=${page}`;
		const r = await ctx.http.fetchJsonWithRetry(
			url, `${ctx.store.key}:collections:p${page}`, ctx.store.ua,
		);
		const collections = Array.isArray(r?.json?.collections) ? r.json.collections : [];
		if (!collections.length) break;
		for (const c of collections) {
			const handle = String(c?.handle || "").trim();
			if (!handle) continue;
			const cat = classifyCollection(handle);
			if (cat) out[cat].push(handle);
		}
		if (collections.length < 250) break;
	}
	return out;
}

async function scanClbCategory(ctx, prevDb, report) {
	const t0 = Date.now();
	if (!ctx.store._clbCollections) {
		ctx.store._clbCollections = await discoverCollections(ctx);
		const c = ctx.store._clbCollections;
		ctx.logger.ok(
			`CLB: discovered ${c.whisky.length} whisky, ${c.rum.length} rum, ${c.gin.length} gin, ${c.mixed.length} mixed collections`,
		);
	}
	const kind = ctx.cat.key;
	const colls = ctx.store._clbCollections;
	const handles = [...(colls[kind] || []), ...(colls.mixed || [])];
	if (!handles.length) {
		ctx.logger.warn(`CLB: no collections found for ${kind}`);
		finalizeCategoryScan(ctx, prevDb, new Map(), report, { t0, scannedPages: 0 });
		return;
	}
	ctx.logger.ok(`CLB ${kind}: scraping ${handles.length} collections: ${handles.join(", ")}`);
	const discovered = new Map();
	let totalPages = 0;
	let totalProducts = 0;
	let skippedNonTarget = 0;
	const mixedSet = new Set(colls.mixed);
	for (const handle of handles) {
		const opts = { perPageDelayMs: 0, jsonPageLimit: 250 };
		const { products, pagesFetched } = await fetchCollectionProductsJson(ctx, handle, opts);
		totalPages += pagesFetched;
		for (const p of products) {
			totalProducts++;
			const h = String(p?.handle || "");
			if (!h) continue;
			const title = sanitizeName(String(p?.title || "").trim());
			if (!title) continue;
			if (mixedSet.has(handle) && rejectProductForKind(p, kind)) {
				skippedNonTarget++;
				continue;
			}
			let variant = pickShopifyInStockVariant(p?.variants);
			let available = anyVariantAvailable(p?.variants);
			let priceRaw = variant?.price || "";
			if (available === null) {
				const js = await fetchProductJs(ctx, h);
				if (!js || js.available !== true) continue;
				const jv = pickShopifyInStockVariant(js?.variants);
				if (jv) {
					variant = jv;
					priceRaw = jv.price;
				}
				available = true;
			}
			if (available !== true) continue;
			const url = normalizeShopifyProductUrl(`https://${ctx.store.host}/products/${h}`);
			if (!url || discovered.has(url)) continue;
			const img = shopifyPickImage(p);
			let price = "";
			if (typeof priceRaw === "number") price = shopifyPriceFromCents(priceRaw);
			else if (priceRaw) price = priceFromShopifyDollarsStr(priceRaw);
			const prev = prevDb?.byUrl?.get(url) || null;
			let sku = resolveShopifyProductSku(p, variant, url, ctx);
			sku = pickBetterSku(sku, prev?.sku || "");
			discovered.set(url, {
				name: title,
				price: price || prev?.price || "",
				url,
				sku,
				img: img || prev?.img || "",
			});
		}
	}
	ctx.logger.ok(
		`CLB ${kind} | collections=${handles.length} pages=${totalPages} raw=${totalProducts} kept=${discovered.size} mixedFiltered=${skippedNonTarget}`,
	);
	finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: totalPages });
}

function createStore(defaultUa) {
	return {
		key: "clbspirits",
		region: "AB",
		name: "CLB Spirits",
		host: "clbspirits.com",
		ua: defaultUa,
		scanCategory: scanClbCategory,
		categories: [
			{ key: "whisky", label: "Whisky" },
			{ key: "rum",    label: "Rum" },
			{ key: "gin",    label: "Gin" },
		],
	};
}

module.exports = { createStore };
