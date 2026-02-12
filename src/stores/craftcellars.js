// src/stores/craftcellars.js
"use strict";

const { setTimeout: sleep } = require("timers/promises");

const { decodeHtml, stripTags, extractFirstImgUrl } = require("../utils/html");
const { sanitizeName } = require("../utils/text");
const { normalizeCspc, normalizeSkuKey, pickBetterSku, needsSkuDetail } = require("../utils/sku");
const { makePageUrlShopifyQueryPage } = require("../utils/url");

const { mergeDiscoveredIntoDb } = require("../tracker/merge");
const { buildDbObject, writeJsonAtomic } = require("../tracker/db");
const { addCategoryResultToReport } = require("../tracker/report");

/* ---------------- Debug helpers ---------------- */

function isDebugEnabled(ctx) {
	// Try to honor any existing debug mode(s) without requiring changes elsewhere
	const env =
		String(process.env.DEBUG || "").toLowerCase() === "1" ||
		String(process.env.DEBUG || "").toLowerCase() === "true" ||
		String(process.env.TRACKER_DEBUG || "").toLowerCase() === "1" ||
		String(process.env.TRACKER_DEBUG || "").toLowerCase() === "true" ||
		String(process.env.CRAFTCELLARS_DEBUG || "").toLowerCase() === "1" ||
		String(process.env.CRAFTCELLARS_DEBUG || "").toLowerCase() === "true";
	const cfg = !!ctx?.config?.debug || !!ctx?.debug || !!ctx?.store?.debug;
	return !!(env || cfg);
}

function dbg(ctx, ...args) {
	if (!isDebugEnabled(ctx)) return;
	if (ctx?.logger?.dbg) return ctx.logger.dbg(...args);
	// If logger has no debug, emit as ok/warn prefixed
	if (ctx?.logger?.ok) return ctx.logger.ok(`[DBG] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
	// last resort
	// eslint-disable-next-line no-console
	console.error("[DBG]", ...args);
}

function dbgKV(ctx, label, obj) {
	if (!isDebugEnabled(ctx)) return;
	dbg(ctx, `${label}: ${JSON.stringify(obj)}`);
}

/* ---------------- Legacy listing parsing (kept as fallback) ---------------- */

function craftCellarsIsEmptyListingPage(html) {
	const s = String(html || "");
	if (/collection--empty\b/i.test(s)) return true;
	if (/No products found/i.test(s)) return true;
	return false;
}

function canonicalizeCraftProductUrl(raw) {
	try {
		const u = new URL(String(raw));
		u.search = "";
		u.hash = "";
		return u.toString();
	} catch {
		return String(raw || "");
	}
}

function extractShopifyCardPrice(block) {
	const b = String(block || "");
	const dollars = (txt) =>
		[...String(txt).matchAll(/\$\s*[\d,]+(?:\.\d{2})?/g)].map((m) => m[0].replace(/\s+/g, ""));

	const saleRegion = b.split(/sale price/i)[1] || "";
	const saleD = dollars(saleRegion);
	if (saleD.length) return saleD[0];

	const regRegion = b.split(/regular price/i)[1] || "";
	const regD = dollars(regRegion);
	if (regD.length) return regD[0];

	const any = dollars(b);
	return any[0] || "";
}

function parseProductsCraftCellars(html, ctx) {
	const s = String(html || "");

	const g1 = s.match(/<div\b[^>]*id=["']ProductGridContainer["'][^>]*>[\s\S]*?<\/div>/i)?.[0] || "";
	const g2 = s.match(/<div\b[^>]*id=["']product-grid["'][^>]*>[\s\S]*?<\/div>/i)?.[0] || "";

	const gridCandidate = g1.length > g2.length ? g1 : g2;
	const grid = /\/products\//i.test(gridCandidate) ? gridCandidate : s;

	return parseProductsCraftCellarsInner(grid, ctx);
}

function parseProductsCraftCellarsInner(html, ctx) {
	const s = String(html || "");
	const items = [];

	let blocks = [...s.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].map((m) => m[0]);
	if (blocks.length < 5) {
		blocks = [...s.matchAll(/<div\b[^>]*class=["'][^"']*\bcard\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi)].map(
			(m) => m[0],
		);
	}

	const base = `https://${(ctx && ctx.store && ctx.store.host) || "craftcellars.ca"}/`;

	for (const block of blocks) {
		const href =
			block.match(/<a\b[^>]*href=["']([^"']*\/products\/[^"']+)["']/i)?.[1] ||
			block.match(/href=["']([^"']*\/products\/[^"']+)["']/i)?.[1];
		if (!href) continue;

		let url = "";
		try {
			url = new URL(decodeHtml(href), base).toString();
		} catch {
			continue;
		}
		url = canonicalizeCraftProductUrl(url);

		const nameHtml =
			block.match(/<a\b[^>]*href=["'][^"']*\/products\/[^"']+["'][^>]*>\s*<[^>]*>\s*([^<]{2,200}?)\s*</i)?.[1] ||
			block.match(
				/<h[23]\b[^>]*>[\s\S]*?<a\b[^>]*\/products\/[^"']+[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[23]>/i,
			)?.[1] ||
			block.match(/<a\b[^>]*href=["'][^"']*\/products\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i)?.[1];

		const name = sanitizeName(stripTags(decodeHtml(nameHtml || "")));
		if (!name) continue;

		const price = extractShopifyCardPrice(block);
		const img = extractFirstImgUrl(block, base);

		items.push({ name, price, url, img });
	}

	const uniq = new Map();
	for (const it of items) uniq.set(it.url, it);
	return [...uniq.values()];
}

function usdFromShopifyPriceStr(s) {
	const n = Number(String(s || "").replace(/[^0-9.]/g, ""));
	if (!Number.isFinite(n)) return "";
	return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usdFromCents(cents) {
	const n = Number(cents);
	if (!Number.isFinite(n)) return "";
	return usdFromShopifyPriceStr(String(n / 100));
}

function cfgNum(v, fallback) {
	return Number.isFinite(v) ? v : fallback;
}

/* ---------------- Product page SKU fallback (rare) ---------------- */

function extractCraftSkuFromProductPageHtml(html) {
	const s = String(html || "");
	const m =
		s.match(/<strong>\s*SKU:\s*<\/strong>[\s\S]{0,200}?<span>\s*([^<]{1,80}?)\s*<\/span>/i) ||
		s.match(/\bSKU:\s*([A-Za-z0-9][A-Za-z0-9\-_/ ]{0,40})/i);
	const raw = m && m[1] ? stripTags(decodeHtml(m[1])) : "";
	return normalizeCspc(raw);
}

/* ---------------- NEW: global discovery (/products.json) ---------------- */

// host -> Promise<{ products, pagesFetched }>
const _allProductsJsonCache = new Map();
// host|handle -> Promise<productJsJson>
const _productJsCache = new Map();

function normalizeTagsToArray(tags) {
	// Shopify:
	// - products.json => "tag1, tag2"
	// - product.js    => ["tag1","tag2"]
	if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
	if (!tags) return [];
	return String(tags)
		.split(",")
		.map((t) => String(t).trim())
		.filter(Boolean);
}

function normalizeTagsExpanded(tags) {
	// Also split taxonomy tags like:
	// "New Arrivals | Scotch Whisky | Scotch Whisky" -> ["New Arrivals", "Scotch Whisky", "Scotch Whisky", ...]
	const base = normalizeTagsToArray(tags);
	const out = new Set();
	for (const t of base) {
		const tt = String(t).trim();
		if (!tt) continue;
		out.add(tt);
		if (tt.includes("|")) {
			for (const seg of tt.split("|").map((s) => String(s).trim()).filter(Boolean)) out.add(seg);
		}
	}
	return [...out];
}

function craftTagText(tagsArr) {
	return normalizeTagsExpanded(tagsArr).join(" | ");
}

// Broad: prefer NOT missing whisky/rum; exclude obvious non-targets by title/tag keywords.
function productTextForClassification(p) {
	const title = String(p?.title || "");
	const tags = craftTagText(p?.tags);

	// products.json => body_html
	// product.js    => description
	const bodyHtml = String(p?.body_html || "");
	const desc = String(p?.description || "");
	const body = sanitizeName(stripTags(decodeHtml(bodyHtml || desc)));

	const variants = Array.isArray(p?.variants) ? p.variants : [];
	const vtxt = variants
		.map((v) => `${v?.title || ""} ${v?.option1 || ""} ${v?.option2 || ""} ${v?.option3 || ""}`)
		.join(" ");

	// include handle/type/vendor if present (helps when tags/body are sparse)
	const handle = String(p?.handle || "");
	const vendor = String(p?.vendor || "");
	const type = String(p?.type || "");

	return `${title}\n${handle}\n${vendor}\n${type}\n${tags}\n${body}\n${vtxt}`;
}

function classifyCraftProduct(p, ctx) {
	const blob = productTextForClassification(p);
	const t = blob.toLowerCase();

	// For rum-vs-whisky tie-breaking, ONLY trust title+tags (descriptions often mention "bourbon/whiskey barrels")
	const titleTags = `${String(p?.title || "")}\n${craftTagText(p?.tags)}`.toLowerCase();

	// Hard negatives (but allow strong rum/whisky overrides below)
	const NEG =
		/\b(wine|bubbles|champagne|prosecco|beer|cider|sake|non-alcoholic|mezcal|tequila|vodka|gin|grappa|cognac|brandy|armagnac|calvados|liqueur|cream|syrup|vermouth|mixer|tonic|soda|yearbook|advent calendar)\b/i;

	// Rum signals
	const RUM = /\b(rum|rhum)\b/i;
	const RUM_FINISH = /\b(rum|rhum)\b\s*(cask|cask finish|finish|barrel|barrique)\b/i;
	// Brand rescue for sparse-tag rum products (eg Appleton Hearts Collection)
	const RUM_BRANDS = /\b(appleton|mount gay)\b/i;

	// Whisky signals
	const WORLD_WHISKY = /\bworld whisky\b/i;
	const WHISKY_SPECIFIC =
		/\b(scotch|single malt|blended malt|single grain|irish whiskey|american whiskey|canadian whisky|japanese whisky|indian whisky|taiwanese whisky|dutch whisky|english whisky|welsh whisky)\b/i;
	const WHISKY_ANY = /\bwhisk(?:e)?y\b/i;
	const WHISKY_WEAK = /\b(bourbon|rye)\b/i;

	// Brand rescue for Craft pages that omit whisky words/tags
	const WHISKY_BRANDS =
		/\b(kavalan|redbreast|caribou crossing|ichiro|ichiro'?s|the lakes|whiskymaker'?s reserve|breckenridge)\b/i;

	const negHit = NEG.test(t);

	const rumHit = RUM.test(t) || RUM_BRANDS.test(t);

	const worldWhiskyHit = WORLD_WHISKY.test(t);
	const whiskySpecificHit = WHISKY_SPECIFIC.test(t);
	const whiskyAnyHit = WHISKY_ANY.test(t);
	const whiskyWeakHit = WHISKY_WEAK.test(t);
	const whiskyBrandHit = WHISKY_BRANDS.test(t);

	// Only suppress "rum" when it's clearly talking about rum-cask-finish AND the product looks whisky-ish.
	const rumFinishOnly =
		rumHit && RUM_FINISH.test(t) && (whiskySpecificHit || whiskyAnyHit || whiskyWeakHit || worldWhiskyHit || whiskyBrandHit);

	if (isDebugEnabled(ctx)) {
		dbgKV(ctx, "classifyCraftProduct", {
			handle: p?.handle || "",
			title: p?.title || "",
			tagsType: Array.isArray(p?.tags) ? "array" : typeof p?.tags,
			negHit,
			rumHit,
			rumFinishOnly,
			worldWhiskyHit,
			whiskySpecificHit,
			whiskyAnyHit,
			whiskyWeakHit,
			whiskyBrandHit,
		});
	}

	// 0) Hard negative unless we have strong rum OR strong whisky evidence
	if (negHit) {
		const strongWhisky = whiskySpecificHit || whiskyAnyHit || whiskyWeakHit || whiskyBrandHit;
		const strongRum = rumHit && !rumFinishOnly;
		if (!strongWhisky && !strongRum) return "other";
	}

	// 1) Rum first.
	// IMPORTANT: Don't let barrel/cask chatter ("american whiskey", "bourbon", etc.) in descriptions flip rum to whisky.
	// Only override rum->whisky if TITLE/TAGS clearly indicate whisky.
	if (rumHit && !rumFinishOnly) {
		const titleTagsWhisky =
			/\b(whisk(?:e)?y|world whisky|scotch|single malt|blended malt|single grain|irish whiskey|japanese whisky|canadian whisky|bourbon|rye)\b/i.test(
				titleTags,
			) || WHISKY_BRANDS.test(titleTags);
		if (!titleTagsWhisky) return "rum";
	}

	// 2) Whisky if brand rescue hits
	if (whiskyBrandHit) return "whisky";

	// 3) Whisky if specific markers
	if (whiskySpecificHit) return "whisky";

	// 4) Whisky if the word whisky/whiskey appears anywhere (including via "World Whisky" tags)
	if (whiskyAnyHit) return "whisky";

	// 5) Allow weak whisky signals
	if (whiskyWeakHit) return "whisky";

	// 6) Last-resort heuristic for whisky-ish products: age + abv
	const AGE = /\b\d{1,2}\s*(?:year|yo)\b|\byear old\b/i;
	const ABV = /\b\d{1,2}(?:\.\d)?%\s*abv\b/i;
	if (AGE.test(t) && ABV.test(t)) return "whisky";

	return "other";
}


function anyVariantHasAvailField(variants) {
	return Array.isArray(variants) && variants.some((v) => v && typeof v.available === "boolean");
}

function isAvailableFromProductsJson(p) {
	const variants = Array.isArray(p?.variants) ? p.variants : [];
	if (!variants.length) return null;
	if (!anyVariantHasAvailField(variants)) return null;
	return variants.some((v) => v && v.available === true);
}

function pickVariantFromProductsJson(p) {
	const variants = Array.isArray(p?.variants) ? p.variants : [];
	return variants.find((v) => v && v.available === true) || variants[0] || null;
}

function pickImageFromProductsJson(p) {
	let img = "";
	const images = Array.isArray(p?.images) ? p.images : [];
	if (images[0]) img = typeof images[0] === "string" ? images[0] : String(images[0]?.src || images[0]?.url || "");
	if (!img && p?.image) img = String(p.image?.src || p.image?.url || p.image || "");
	img = String(img || "").trim();
	if (img.startsWith("//")) img = `https:${img}`;
	return img;
}

async function fetchAllCraftProductsJson(ctx, perJsonPageDelayMs, maxPages) {
	const host = String(ctx?.store?.host || "").trim();
	if (!host) return { products: [], pagesFetched: 0 };

	let p = _allProductsJsonCache.get(host);
	if (p) return await p;

	p = (async () => {
		const out = [];
		const limit = 250;
		let page = 1;
		let pagesFetched = 0;

		while (true) {
			if (page > 1 && perJsonPageDelayMs > 0) await sleep(perJsonPageDelayMs);

			const url = `https://${host}/products.json?limit=${limit}&page=${page}`;
			const r = await ctx.http.fetchJsonWithRetry(url, `craft:alljson:p${page}`, ctx.store.ua);
			const products = Array.isArray(r?.json?.products) ? r.json.products : [];
			pagesFetched++;

			if (isDebugEnabled(ctx)) {
				dbgKV(ctx, "products.json page", {
					page,
					url,
					count: products.length,
					pagesFetched,
				});
			}

			if (!products.length) break;
			out.push(...products);

			if (products.length < limit) break;
			if (++page > maxPages) break;
		}

		return { products: out, pagesFetched };
	})();

	_allProductsJsonCache.set(host, p);
	return await p;
}

async function fetchProductJs(ctx, handle) {
	const host = String(ctx?.store?.host || "").trim();
	const h = String(handle || "").trim();
	if (!host || !h) return null;

	const key = `${host}|${h}`;
	let p = _productJsCache.get(key);
	if (p) return await p;

	p = (async () => {
		const url = `https://${host}/products/${h}.js`;
		const r = await ctx.http.fetchJsonWithRetry(url, `craft:prodjs:${h}`, ctx.store.ua);
		return r?.json || null;
	})();

	_productJsCache.set(key, p);
	return await p;
}

function pickVariantFromProductJs(js) {
	const variants = Array.isArray(js?.variants) ? js.variants : [];
	return variants.find((v) => v && v.available === true) || variants[0] || null;
}

/**
 * Craft Cellars:
 * Goal: track ALL in-stock whisky + rum across site.
 *
 * Strategy:
 * 1) Discover via global /products.json (includes "orphans")
 * 2) Filter to whisky/rum (broad)
 * 3) Keep only in-stock.
 *    - Prefer products.json variant.available when present
 *    - Fallback to /products/<handle>.js when available fields are missing
 * 4) SKU fallback (rare): product page HTML only for NEW items with synthetic sku
 */
async function scanCategoryCraftCellars(ctx, prevDb, report) {
	const t0 = Date.now();

	const perJsonPageDelayMs = Math.max(0, cfgNum(ctx?.cat?.jsonPageDelayMs, cfgNum(ctx?.cat?.discoveryDelayMs, 0))) || 0;
	const perSkuPageDelayMs = Math.max(0, cfgNum(ctx?.cat?.skuPageDelayMs, perJsonPageDelayMs)) || 0;

	const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);

	// ---------- NEW: global mode ----------
	if (ctx?.cat?.mode === "global_products_json") {
		const kind = String(ctx?.cat?.kind || "").trim(); // "whisky" | "rum"
		const { products, pagesFetched } = await fetchAllCraftProductsJson(ctx, perJsonPageDelayMs, maxPages);

		const discovered = new Map();
		let jsFetched = 0;
		let considered = 0;
		let bucketOther = 0;
		let bucketKind = 0;
		let skippedNotAvail = 0;

		for (const p of products) {
			considered++;

			const handle = String(p?.handle || "");
			if (!handle) continue;

			const title = sanitizeName(String(p?.title || "").trim());
			if (!title) continue;

			const bucket = classifyCraftProduct(p, ctx);
			if (bucket !== kind) {
				bucketOther++;
				if (isDebugEnabled(ctx) && (considered <= 25 || considered % 500 === 0)) {
					dbgKV(ctx, "skip bucket!=kind", { kind, bucket, handle, title });
				}
				continue;
			}
			bucketKind++;

			// in-stock check:
			// - use products.json if variants include `available`
			// - else fallback to product.js
			let available = isAvailableFromProductsJson(p);
			let v = pickVariantFromProductsJson(p);
			let sku = normalizeCspc(v?.sku || "");
			let price = v?.price ? usdFromShopifyPriceStr(v.price) : "";

			let availabilitySource = "products.json";
			if (available === null) {
				availabilitySource = "product.js";
				const js = await fetchProductJs(ctx, handle);
				jsFetched++;
				if (!js || js.available !== true) {
					skippedNotAvail++;
					if (isDebugEnabled(ctx)) dbgKV(ctx, "skip unavailable (product.js)", { handle, title });
					continue;
				}

				const jv = pickVariantFromProductJs(js);
				sku = normalizeCspc(jv?.sku || sku);
				price = jv?.price ? usdFromCents(jv.price) : price;
				available = true;
			}

			if (available !== true) {
				skippedNotAvail++;
				if (isDebugEnabled(ctx)) dbgKV(ctx, "skip unavailable (products.json)", { handle, title, available });
				continue;
			}

			const url = canonicalizeCraftProductUrl(`https://${ctx.store.host}/products/${handle}`);
			const img = pickImageFromProductsJson(p);

			const prev = prevDb?.byUrl?.get(url) || null;

			const better = pickBetterSku(sku, prev?.sku || "");
			const normalizedSku = normalizeSkuKey(better, { storeLabel: ctx.store.name, url });

			if (isDebugEnabled(ctx) && (discovered.size < 20 || discovered.size % 300 === 0)) {
				dbgKV(ctx, "keep", {
					kind,
					bucket,
					handle,
					title,
					availabilitySource,
					skuRaw: sku,
					skuNorm: normalizedSku,
					price,
					url,
				});
			}

			discovered.set(url, {
				name: title,
				price: price || prev?.price || "",
				url,
				sku: normalizedSku,
				img: img || prev?.img || "",
			});
		}

		// Rare SKU fallback: only for NEW items that still have synthetic sku
		let skuPagesFetched = 0;
		for (const it of discovered.values()) {
			const prev = prevDb?.byUrl?.get(it.url) || null;
			const isNewItem = !prev;
			if (!isNewItem) continue;
			if (!needsSkuDetail(it.sku)) continue;

			if (perSkuPageDelayMs > 0) await sleep(perSkuPageDelayMs);
			try {
				const { text } = await ctx.http.fetchTextWithRetry(
					it.url,
					`craft:prodpage:${ctx.cat.key}:${Buffer.from(it.url).toString("base64").slice(0, 24)}`,
					ctx.store.ua,
				);
				skuPagesFetched++;
				const sku2 = extractCraftSkuFromProductPageHtml(text);
				if (sku2) it.sku = normalizeSkuKey(sku2, { storeLabel: ctx.store.name, url: it.url });

				if (isDebugEnabled(ctx)) dbgKV(ctx, "sku fallback", { url: it.url, sku2: sku2 || "", skuFinal: it.sku });
			} catch (e) {
				if (isDebugEnabled(ctx)) dbgKV(ctx, "sku fallback error", { url: it.url, err: String(e?.message || e || "") });
			}
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | products.json pages=${pagesFetched} items=${products.length} prod.js fetched=${jsFetched} sku pages=${skuPagesFetched}`,
		);
		ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);

		if (isDebugEnabled(ctx)) {
			dbgKV(ctx, "global summary", {
				kind,
				considered,
				matchedKind: bucketKind,
				skippedBucket: bucketOther,
				skippedNotAvail,
				discovered: discovered.size,
			});
		}

		const { merged, newItems, updatedItems, removedItems, restoredItems } = mergeDiscoveredIntoDb(prevDb, discovered, {
			storeLabel: ctx.store.name,
		});

		// Extra debug: show why things got removed (first N)
		if (isDebugEnabled(ctx) && removedItems?.length) {
			for (const it of removedItems.slice(0, 50)) {
				const url = it?.url || it;
				const prev = prevDb?.byUrl?.get(url) || null;
				dbgKV(ctx, "REMOVED candidate", {
					kind,
					url,
					prevName: prev?.name || "",
					prevSku: prev?.sku || "",
					prevPrice: prev?.price || "",
				});
			}
		}

		const dbObj = buildDbObject(ctx, merged);
		writeJsonAtomic(ctx.dbFile, dbObj);

		const elapsed = Date.now() - t0;

		report.categories.push({
			store: ctx.store.name,
			label: ctx.cat.label,
			key: ctx.cat.key,
			dbFile: ctx.dbFile,
			scannedPages: pagesFetched,
			discoveredUnique: discovered.size,
			newCount: newItems.length,
			updatedCount: updatedItems.length,
			removedCount: removedItems.length,
			restoredCount: restoredItems.length,
			elapsedMs: elapsed,
		});

		report.totals.newCount += newItems.length;
		report.totals.updatedCount += updatedItems.length;
		report.totals.removedCount += removedItems.length;
		report.totals.restoredCount += restoredItems.length;

		addCategoryResultToReport(
			report,
			ctx.store.name,
			ctx.cat.label,
			newItems,
			updatedItems,
			removedItems,
			restoredItems,
		);
		return;
	}

	/* ---------------- Fallback: old collection HTML/JSON scan (unchanged) ---------------- */

	const perPageDelayMs = Math.max(0, cfgNum(ctx?.cat?.pageStaggerMs, cfgNum(ctx?.cat?.discoveryDelayMs, 0))) || 0;
	const htmlMap = new Map();

	const maxPagesFallback = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);
	let htmlPagesFetched = 0;
	let emptyStreak = 0;

	for (let p = 1; p <= maxPagesFallback; p++) {
		if (p > 1 && perPageDelayMs > 0) await sleep(perPageDelayMs);

		const pageUrl = makePageUrlShopifyQueryPage(ctx.cat.startUrl, p);
		const { text: html } = await ctx.http.fetchTextWithRetry(pageUrl, `craft:html:${ctx.cat.key}:p${p}`, ctx.store.ua);
		htmlPagesFetched++;

		if (craftCellarsIsEmptyListingPage(html)) break;

		const items = parseProductsCraftCellars(html, ctx);
		if (!items.length) {
			emptyStreak++;
			if (emptyStreak >= 2) break;
			continue;
		}
		emptyStreak = 0;

		for (const it of items) {
			const url = canonicalizeCraftProductUrl(it.url);
			if (!url) continue;
			htmlMap.set(url, { name: it.name || "", price: it.price || "", url, img: it.img || "" });
		}
	}

	if (!htmlMap.size) {
		ctx.logger.warn(`${ctx.catPrefixOut} | HTML listing returned 0 items; refusing JSON-only discovery`);
	}

	const jsonMap = new Map();

	if (htmlMap.size) {
		const start = new URL(ctx.cat.startUrl);
		const m = start.pathname.match(/^\/collections\/([^/]+)/i);
		if (!m) throw new Error(`CraftCellars: couldn't extract collection handle from ${ctx.cat.startUrl}`);
		const collectionHandle = m[1];

		const limit = 250;
		let jsonPage = 1;
		let jsonPagesFetched = 0;

		while (true) {
			if (jsonPage > 1 && perJsonPageDelayMs > 0) await sleep(perJsonPageDelayMs);

			const url = `https://${ctx.store.host}/collections/${collectionHandle}/products.json?limit=${limit}&page=${jsonPage}`;
			const r = await ctx.http.fetchJsonWithRetry(url, `craft:coljson:${ctx.cat.key}:p${jsonPage}`, ctx.store.ua);

			const products = Array.isArray(r?.json?.products) ? r.json.products : [];
			jsonPagesFetched++;

			if (!products.length) break;

			for (const p of products) {
				const handle = String(p?.handle || "");
				if (!handle) continue;

				const prodUrl = canonicalizeCraftProductUrl(`https://${ctx.store.host}/products/${handle}`);
				if (!htmlMap.has(prodUrl)) continue;

				const variants = Array.isArray(p?.variants) ? p.variants : [];
				const v = variants.find((x) => x && x.available === true) || variants[0] || null;

				const sku = normalizeCspc(v?.sku || "");
				const price = v?.price ? usdFromShopifyPriceStr(v.price) : "";

				let img = "";
				const images = Array.isArray(p?.images) ? p.images : [];
				if (images[0]) img = typeof images[0] === "string" ? images[0] : String(images[0]?.src || images[0]?.url || "");
				if (!img && p?.image) img = String(p.image?.src || p.image?.url || p.image || "");
				img = String(img || "").trim();
				if (img.startsWith("//")) img = `https:${img}`;

				jsonMap.set(prodUrl, { sku, price, img });
			}

			if (products.length < limit) break;
			if (++jsonPage > 200) break;
		}

		ctx.logger.ok(`${ctx.catPrefixOut} | HTML pages=${htmlPagesFetched} JSON pages=${jsonPagesFetched}`);
	}

	const discovered = new Map();
	for (const [url, it] of htmlMap.entries()) {
		const j = jsonMap.get(url);
		const prev = prevDb?.byUrl?.get(url) || null;

		const better = pickBetterSku(j?.sku || "", prev?.sku || "");
		const normalizedSku = normalizeSkuKey(better, { storeLabel: ctx.store.name, url });

		discovered.set(url, {
			name: it.name,
			price: j?.price || it.price || "",
			url,
			sku: normalizedSku,
			img: j?.img || it.img || prev?.img || "",
		});
	}

	// SKU page fallback (only when missing/synthetic)
	const perProductSkuDelayMs = Math.max(0, cfgNum(ctx?.cat?.skuPageDelayMs, perJsonPageDelayMs));
	let skuPagesFetched = 0;

	for (const it of discovered.values()) {
		if (!needsSkuDetail(it.sku)) continue;
		if (perProductSkuDelayMs > 0) await sleep(perProductSkuDelayMs);

		try {
			const { text } = await ctx.http.fetchTextWithRetry(
				it.url,
				`craft:prodpage:${ctx.cat.key}:${Buffer.from(it.url).toString("base64").slice(0, 24)}`,
				ctx.store.ua,
			);
			skuPagesFetched++;

			const sku2 = extractCraftSkuFromProductPageHtml(text);
			if (sku2) it.sku = normalizeSkuKey(sku2, { storeLabel: ctx.store.name, url: it.url });
		} catch {}
	}

	ctx.logger.ok(`${ctx.catPrefixOut} | SKU fallback pages=${skuPagesFetched}`);
	ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);

	const { merged, newItems, updatedItems, removedItems, restoredItems } = mergeDiscoveredIntoDb(prevDb, discovered, {
		storeLabel: ctx.store.name,
	});

	const dbObj = buildDbObject(ctx, merged);
	writeJsonAtomic(ctx.dbFile, dbObj);

	const elapsed = Date.now() - t0;

	report.categories.push({
		store: ctx.store.name,
		label: ctx.cat.label,
		key: ctx.cat.key,
		dbFile: ctx.dbFile,
		scannedPages: htmlPagesFetched,
		discoveredUnique: discovered.size,
		newCount: newItems.length,
		updatedCount: updatedItems.length,
		removedCount: removedItems.length,
		restoredCount: restoredItems.length,
		elapsedMs: elapsed,
	});

	report.totals.newCount += newItems.length;
	report.totals.updatedCount += updatedItems.length;
	report.totals.removedCount += removedItems.length;
	report.totals.restoredCount += restoredItems.length;

	addCategoryResultToReport(report, ctx.store.name, ctx.cat.label, newItems, updatedItems, removedItems, restoredItems);
}

function createStore(defaultUa) {
	return {
		key: "craftcellars",
		name: "Craft Cellars",
		host: "craftcellars.ca",
		ua: defaultUa,

		scanCategory: scanCategoryCraftCellars,

		// kept for fallback parsing / debugging
		parseProducts: parseProductsCraftCellars,
		makePageUrl: makePageUrlShopifyQueryPage,
		isEmptyListingPage: craftCellarsIsEmptyListingPage,

		categories: [
			{
				key: "whisky",
				label: "Whisky",
				mode: "global_products_json",
				kind: "whisky",
				startUrl: "https://craftcellars.ca/collections/whisky?filter.v.availability=1",
				pageConcurrency: 1,
				jsonPageDelayMs: 0,
				skuPageDelayMs: 0,
			},
			{
				key: "rum",
				label: "Rum",
				startUrl: "https://craftcellars.ca/collections/rum?filter.v.availability=1",
				mode: "global_products_json",
				kind: "rum",
				pageConcurrency: 1,
				jsonPageDelayMs: 0,
				skuPageDelayMs: 0,
			},
		],
	};
}

module.exports = { createStore };
