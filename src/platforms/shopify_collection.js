// src/platforms/shopify_collection.js
"use strict";

const { setTimeout: sleep } = require("timers/promises");

const { sanitizeName } = require("../utils/text");
const { normalizeCspc, normalizeSkuKey, pickBetterSku, needsSkuDetail } = require("../utils/sku");
const {
	normalizeShopifyProductUrl,
	shopifyPriceFromCents,
	extractShopifySkuFromImgPath,
	pickShopifyInStockVariant,
} = require("../utils/shopify");
const { finalizeCategoryScan } = require("../tracker/finalize");

// Per-host caches shared across categories of the same store within one run.
const _allProductsJsonCache = new Map(); // host -> Promise<{products}>
const _productJsCache = new Map();       // `${host}|${handle}` -> Promise<json>

function priceFromShopifyDollarsStr(s) {
	const n = Number(String(s || "").replace(/[^0-9.]/g, ""));
	if (!Number.isFinite(n)) return "";
	return `$${n.toFixed(2)}`;
}

function shopifyPickImage(p) {
	const images = Array.isArray(p?.images) ? p.images : [];
	let img = "";
	if (images[0]) img = typeof images[0] === "string" ? images[0] : String(images[0]?.src || images[0]?.url || "");
	if (!img && p?.image) img = String(p?.image?.src || p?.image?.url || p?.image || "");
	img = String(img || "").trim();
	if (img.startsWith("//")) img = `https:${img}`;
	return img;
}

function variantsHaveAvailableField(variants) {
	return Array.isArray(variants) && variants.some((v) => v && typeof v.available === "boolean");
}

function anyVariantAvailable(variants) {
	const vs = Array.isArray(variants) ? variants : [];
	if (!variantsHaveAvailableField(vs)) return null;
	return vs.some((v) => v && v.available === true);
}

async function fetchCollectionProductsJson(ctx, collectionHandle, opts) {
	const host = String(ctx?.store?.host || "").trim();
	const out = [];
	const limit = Math.min(250, Math.max(1, Number(opts.jsonPageLimit) || 250));
	let page = 1;
	let pagesFetched = 0;
	const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);

	while (true) {
		if (page > 1 && opts.perPageDelayMs > 0) await sleep(opts.perPageDelayMs);

		const url = `https://${host}/collections/${collectionHandle}/products.json?limit=${limit}&page=${page}`;
		const r = await ctx.http.fetchJsonWithRetry(
			url,
			`${ctx.store.key}:coljson:${ctx.cat.key}:p${page}`,
			ctx.store.ua,
		);
		const products = Array.isArray(r?.json?.products) ? r.json.products : [];
		pagesFetched++;

		if (!products.length) break;
		out.push(...products);

		if (products.length < limit) break;
		if (++page > maxPages) break;
	}

	return { products: out, pagesFetched };
}

async function fetchGlobalProductsJson(ctx, opts) {
	const host = String(ctx?.store?.host || "").trim();

	let p = _allProductsJsonCache.get(host);
	if (p) return await p;

	p = (async () => {
		const out = [];
		const limit = Math.min(250, Math.max(1, Number(opts.jsonPageLimit) || 250));
		let page = 1;
		let pagesFetched = 0;
		const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);

		while (true) {
			if (page > 1 && opts.perPageDelayMs > 0) await sleep(opts.perPageDelayMs);

			const url = `https://${host}/products.json?limit=${limit}&page=${page}`;
			const r = await ctx.http.fetchJsonWithRetry(
				url,
				`${ctx.store.key}:alljson:p${page}`,
				ctx.store.ua,
			);
			const products = Array.isArray(r?.json?.products) ? r.json.products : [];
			pagesFetched++;

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
		try {
			const r = await ctx.http.fetchJsonWithRetry(url, `${ctx.store.key}:prodjs:${h}`, ctx.store.ua);
			return r?.json || null;
		} catch {
			return null;
		}
	})();

	_productJsCache.set(key, p);
	return await p;
}

function extractSkuFromProductPageHtml(html) {
	const s = String(html || "");
	const cspc = normalizeCspc(s.match(/\bSKU[:\s]*([A-Za-z0-9][A-Za-z0-9\-_/ ]{0,40})/i)?.[1] || "");
	return cspc;
}

/**
 * Resolve a SKU for a Shopify product given a hierarchy:
 *  1. variant.sku
 *  2. image filename (id:NN extracted from CDN url)
 *  3. id:{numeric product id}
 *  4. u:{hash} synthetic (via normalizeSkuKey)
 */
function resolveShopifyProductSku(p, variant, url, ctx) {
	const candidates = [];

	const vSku = String(variant?.sku || "").trim();
	if (vSku) {
		// Non-6-digit numeric SKUs (Liquor Warehouse's 3-5 digit BCLDB,
		// Wine and Beyond's 7-digit SNDL IDs) miss the 6-digit CSPC regex
		// and fall to synthetic. Prefix with id: so short ones zero-pad
		// through idToCspc6 ("331" → "000331") and longer ones land as
		// stable id:N values — same path BCL uses.
		if (/^\d+$/.test(vSku) && !/^\d{6}$/.test(vSku)) {
			candidates.push(`id:${vSku}`);
		}
		candidates.push(vSku);
	}

	const img = shopifyPickImage(p);
	if (img) {
		const fromImg = extractShopifySkuFromImgPath(img);
		if (fromImg) candidates.push(fromImg);
	}

	const pid = p?.id;
	if (pid !== undefined && pid !== null && String(pid).match(/^\d+$/)) {
		candidates.push(`id:${pid}`);
	}

	for (const c of candidates) {
		const norm = normalizeSkuKey(c, { storeLabel: ctx.store.name, url });
		if (norm && !/^u:/.test(norm)) return norm;
	}
	return normalizeSkuKey("", { storeLabel: ctx.store.name, url });
}

/**
 * createShopifyCollectionAdapter
 *
 * opts:
 *  - collectionHandle: string (required if not using global products.json)
 *  - useGlobalProductsJson: boolean (default false)
 *  - classify: (product) => "whisky"|"rum"|"gin"|"other" (required if global mode)
 *      In global mode, only products whose classify() === ctx.cat.kind are kept.
 *  - productUrlNormalize: (rawUrl) => string (default: normalizeShopifyProductUrl)
 *  - skuFallback: "product-page" | "product.js" | "image-filename" | "none" (default "none")
 *      Triggered only for NEW items whose resolved sku is still synthetic.
 *      "image-filename" is built into the priority order, so passing it here is a no-op.
 *  - ageGate: boolean (default false) — currently advisory; not yet enforced via cookies.
 *  - perPageDelayMs: number (default 0)
 *  - jsonPageLimit: number (default 250)
 */
function createShopifyCollectionAdapter(opts) {
	const {
		collectionHandle = "",
		useGlobalProductsJson = false,
		classify = null,
		productUrlNormalize = (raw) => normalizeShopifyProductUrl(raw),
		skuFallback = "none",
		ageGate = false,
		perPageDelayMs = 0,
		jsonPageLimit = 250,
		allowProduct = null,
	} = opts || {};

	void ageGate; // reserved; some Shopify stores may need cookie handshake in future

	if (!useGlobalProductsJson && !collectionHandle) {
		throw new Error("shopify_collection: collectionHandle required when useGlobalProductsJson=false");
	}
	if (useGlobalProductsJson && typeof classify !== "function") {
		throw new Error("shopify_collection: classify(product) required when useGlobalProductsJson=true");
	}

	const adapterOpts = { perPageDelayMs, jsonPageLimit };

	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();

		const { products, pagesFetched } = useGlobalProductsJson
			? await fetchGlobalProductsJson(ctx, adapterOpts)
			: await fetchCollectionProductsJson(ctx, collectionHandle, adapterOpts);

		const wantedKind = useGlobalProductsJson ? String(ctx?.cat?.kind || "").trim() : null;

		const discovered = new Map();
		let jsFetched = 0;
		let skippedNotAvail = 0;

		for (const p of products) {
			const handle = String(p?.handle || "");
			if (!handle) continue;

			const title = sanitizeName(String(p?.title || "").trim());
			if (!title) continue;

			if (useGlobalProductsJson && wantedKind) {
				const bucket = classify(p);
				if (bucket !== wantedKind) continue;
			}

			if (typeof allowProduct === "function" && !allowProduct(p)) continue;

			let variant = pickShopifyInStockVariant(p?.variants);
			let available = anyVariantAvailable(p?.variants);
			let priceRaw = variant?.price || "";

			if (available === null) {
				const js = await fetchProductJs(ctx, handle);
				jsFetched++;
				if (!js || js.available !== true) {
					skippedNotAvail++;
					continue;
				}
				const jv = pickShopifyInStockVariant(js?.variants);
				if (jv) {
					variant = jv;
					// product.js prices are integer cents
					priceRaw = jv.price;
				}
				available = true;
			}

			if (available !== true) {
				skippedNotAvail++;
				continue;
			}

			const url = productUrlNormalize(`https://${ctx.store.host}/products/${handle}`);
			const img = shopifyPickImage(p);

			// Price formatting: products.json gives "$X.XX" string; product.js gives cents.
			let price = "";
			if (typeof priceRaw === "number") price = shopifyPriceFromCents(priceRaw);
			else if (priceRaw) price = priceFromShopifyDollarsStr(priceRaw);

			const prev = prevDb?.byUrl?.get(url) || null;
			let sku = resolveShopifyProductSku(p, variant, url, ctx);
			const better = pickBetterSku(sku, prev?.sku || "");
			sku = better;

			discovered.set(url, {
				name: title,
				price: price || prev?.price || "",
				url,
				sku,
				img: img || prev?.img || "",
			});
		}

		// Optional SKU hydration pass — only NEW items still synthetic.
		let skuPagesFetched = 0;
		if (skuFallback === "product-page" || skuFallback === "product.js") {
			for (const it of discovered.values()) {
				const prev = prevDb?.byUrl?.get(it.url) || null;
				if (prev) continue;
				if (!needsSkuDetail(it.sku)) continue;

				try {
					if (skuFallback === "product.js") {
						// derive handle from url
						const m = it.url.match(/\/products\/([^/?#]+)/i);
						const handle = m ? m[1] : "";
						if (!handle) continue;
						const js = await fetchProductJs(ctx, handle);
						skuPagesFetched++;
						const variant = pickShopifyInStockVariant(js?.variants);
						const sku2 = normalizeSkuKey(variant?.sku || "", { storeLabel: ctx.store.name, url: it.url });
						if (sku2 && !/^u:/.test(sku2)) it.sku = sku2;
					} else {
						const { text } = await ctx.http.fetchTextWithRetry(
							it.url,
							`${ctx.store.key}:prodpage:${ctx.cat.key}:${Buffer.from(it.url).toString("base64").slice(0, 24)}`,
							ctx.store.ua,
						);
						skuPagesFetched++;
						const sku2 = extractSkuFromProductPageHtml(text);
						if (sku2) it.sku = normalizeSkuKey(sku2, { storeLabel: ctx.store.name, url: it.url });
					}
				} catch {}
			}
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | shopify pages=${pagesFetched} products=${products.length} prod.js=${jsFetched} skuPages=${skuPagesFetched} kept=${discovered.size} oos=${skippedNotAvail}`,
		);

		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: pagesFetched });
	};
}

module.exports = { createShopifyCollectionAdapter };
