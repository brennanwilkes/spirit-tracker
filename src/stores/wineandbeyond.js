"use strict";

// Wine and Beyond runs Shopify across 15 physical stores. Its data is split:
//
//   * /collections/{kind}/products.json — clean catalog (one row per bottle,
//     real SKU + title + image) but price is always 0.00 and availability is
//     a meaningless master flag. Used ONLY for the handle -> sku/title/img map
//     and the per-kind product list.
//   * /products.json (global) — only ~16% of the catalog is replicated per
//     location; the rest never appear. NOT a reliable stock source. Unused.
//   * The `filter.p.m.display.available_at={loc}` collection facet means
//     "CARRIED/listed at that location" — NOT "in stock". It returns items
//     with zero inventory (sold-out everywhere), so it cannot be used to
//     determine availability. (This was a prior bug.)
//   * The PRODUCT PAGE renders a per-location stock table server-side
//     (`<span class="font-semibold">{Location}:&nbsp;</span><span>{state}</span>`)
//     plus the real price. This is the ONLY accurate stock source.
//
// Strategy per category:
//   1. Build handle -> {sku,title,img} from products.json.
//   2. For each product, fetch its product page; parse the per-location table
//      (in stock if any location is "In Stock"/"Low Stock") and the price.
//   3. Emit only in-stock bottles.
//
// This is ~1 fetch per catalogued product (whisky ~1400). W&B tolerates a
// tight cadence, so we lower the per-host interval (see WNB_INTERVAL_MS).
// "Low Stock" counts as in stock.

const { sanitizeName } = require("../utils/text");
const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { normalizeShopifyProductUrl } = require("../utils/shopify");
const { finalizeCategoryScan } = require("../tracker/finalize");
const { parallelMapStaggered } = require("../utils/async");

const HOST = "www.wineandbeyond.ca";
// gin collection 500s at limit>=200; use a single safe ceiling everywhere.
const JSON_LIMIT = 150;
// W&B needs ~1 fetch per catalogued product (~1900 total) plus per-location
// price rescues, so it must run with real parallelism to finish in time. But
// W&B uses a token-bucket limiter: it allows a large fast burst (~600 reqs)
// then throttles hard. Bursting to 10/s drains the bucket and trips a cliff, so
// we pace to a sustainable ~4/s from the start (250ms interval ⇒ 4/s; 10
// concurrent connections cover the ~2s latency). The adaptive backoff in
// http.js is the safety net if W&B still pushes back.
const WNB_INTERVAL_MS = 250;
const WNB_CONCURRENCY = 10;

let _pacingSet = false;

function normalizeWnbSku(rawSku, ctx, url) {
	// W&B uses 7-digit SNDL IDs; wrap as id: so they bypass the 6-digit CSPC
	// regex and land as stable id: values rather than synthetic u: hashes.
	const sku = String(rawSku || "").trim();
	const input = /^\d+$/.test(sku) && !/^\d{6}$/.test(sku) ? `id:${sku}` : sku;
	return normalizeSkuKey(input, { storeLabel: ctx.store.name, url });
}

async function fetchCatalogMap(ctx, collectionHandle) {
	const byHandle = new Map();
	const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);
	let page = 1;
	while (true) {
		const url = `https://${HOST}/collections/${collectionHandle}/products.json?limit=${JSON_LIMIT}&page=${page}`;
		const r = await ctx.http.fetchJsonWithRetry(url, `${ctx.store.key}:catalog:${ctx.cat.key}:p${page}`, ctx.store.ua);
		const products = Array.isArray(r?.json?.products) ? r.json.products : [];
		if (!products.length) break;
		for (const p of products) {
			const handle = String(p?.handle || "").trim();
			if (!handle) continue;
			byHandle.set(handle, {
				sku: String(p?.variants?.[0]?.sku || "").trim(),
				title: sanitizeName(String(p?.title || "").trim()),
				img: (() => {
					const im = Array.isArray(p?.images) ? p.images[0] : null;
					let s = im ? (typeof im === "string" ? im : String(im.src || "")) : "";
					if (s.startsWith("//")) s = `https:${s}`;
					return s;
				})(),
			});
		}
		if (products.length < JSON_LIMIT) break;
		if (++page > maxPages) break;
	}
	return byHandle;
}

// Parse the product page: in stock if any location reports In/Low Stock; price
// from the data-block-type="price" block.
//
// The price block is rendered server-side for the cart's *currently selected*
// location only. The default location often doesn't carry a given bottle, so
// for ~20% of in-stock items no price renders at all (the block is absent) even
// though some other location stocks and prices it. resolvePriceForLocation()
// below recovers those by re-fetching under a carrying location.
const STOCK_RE = /font-semibold">([^<]+?):(?:&nbsp;|\s)*<\/span>\s*<span>([^<]+)<\/span>/g;
function parsePrice(text) {
	const pm = text.match(/data-block-type="price"[\s\S]*?\$([0-9][0-9.,]*)/);
	if (!pm) return "";
	const n = Number(pm[1].replace(/,/g, ""));
	return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : "";
}
function parseProductPage(text) {
	let inStock = false;
	STOCK_RE.lastIndex = 0;
	let m;
	while ((m = STOCK_RE.exec(text)) !== null) {
		const st = m[2].trim().toLowerCase();
		if (st === "low stock" || st === "in stock") { inStock = true; break; }
	}
	return { inStock, price: parsePrice(text) };
}

// Find a location id (cart_form_<id>) whose stock table entry is In/Low Stock,
// so we can re-fetch the page with that location selected and read its price.
// Cart-form cards carry id+name; the stock table carries name+state — join on
// name.
function findCarryingLocationId(text) {
	const id2name = new Map();
	const chunks = text.split(/id="cart_form_(\d+)"/);
	for (let i = 1; i < chunks.length; i += 2) {
		const nm = chunks[i + 1].match(/font-semibold text-lg[^>]*>\s*([^<]+?)\s*<\/div>/);
		if (nm) id2name.set(chunks[i], nm[1].trim());
	}
	const state = new Map();
	STOCK_RE.lastIndex = 0;
	let m;
	while ((m = STOCK_RE.exec(text)) !== null) state.set(m[1].trim(), m[2].trim().toLowerCase());
	for (const [id, name] of id2name) {
		const st = state.get(name);
		if (st === "in stock" || st === "low stock") return id;
	}
	return "";
}

function cartTokenFromSetCookie(setCookie) {
	const line = (setCookie || []).find((c) => /^cart=/.test(String(c)));
	return line ? line.split(";")[0] : "";
}

// Select `locId` on a fresh cart, then re-fetch the product page to read the
// price that renders for that location. Each call uses its own throwaway cart
// (the POST with no cookie mints one) so concurrent rescues never clobber each
// other's selected location. Bypasses the shared cookie jar (cookies:false +
// explicit Cookie header) so the main pass is unaffected.
async function fetchPriceAtLocation(ctx, url, handle, locId) {
	try {
		const up = await ctx.http.fetchJsonWithRetry(
			`https://${HOST}/cart/update.js`,
			`${ctx.store.key}:loc:${ctx.cat.key}:${handle}`,
			ctx.store.ua,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ attributes: { _selected_location_id: locId } }),
				cookies: false,
			},
		);
		const token = cartTokenFromSetCookie(up.setCookie);
		if (!token) return "";

		const { text } = await ctx.http.fetchTextWithRetry(
			url,
			`${ctx.store.key}:prodloc:${ctx.cat.key}:${handle}`,
			ctx.store.ua,
			{ headers: { cookie: token }, cookies: false },
		);
		return parsePrice(text);
	} catch (_) {
		return "";
	}
}

function scanCategoryWnB(collectionHandle) {
	return async function scanCategory(ctx, prevDb, report) {
		const t0 = Date.now();

		if (!_pacingSet && typeof ctx.http.setHostInterval === "function") {
			ctx.http.setHostInterval(HOST, WNB_INTERVAL_MS);
			if (typeof ctx.http.setHostConcurrency === "function") ctx.http.setHostConcurrency(HOST, WNB_CONCURRENCY);
			_pacingSet = true;
		}

		const catalog = await fetchCatalogMap(ctx, collectionHandle);
		const entries = [...catalog].filter(([, meta]) => meta.title);
		ctx.logger.ok(`${ctx.catPrefixOut} | wineandbeyond catalog=${entries.length} — checking product pages…`);

		const discovered = new Map();
		let checked = 0;
		let outOfStock = 0;
		let rescued = 0;
		let lastLog = Date.now();

		await parallelMapStaggered(entries, WNB_CONCURRENCY, 0, async ([handle, meta]) => {
			const url = normalizeShopifyProductUrl(`https://${HOST}/products/${handle}`);
			let text;
			try {
				({ text } = await ctx.http.fetchTextWithRetry(url, `${ctx.store.key}:prod:${ctx.cat.key}:${handle}`, ctx.store.ua));
			} catch (_) {
				return; // skip on fetch failure; mass-removal protection guards history
			}
			checked++;

			// Lightweight heartbeat so a non-debug run shows it isn't frozen.
			if (Date.now() - lastLog >= 15000) {
				lastLog = Date.now();
				ctx.logger.ok(
					`${ctx.catPrefixOut} | wineandbeyond progress checked=${checked}/${entries.length} inStock=${discovered.size} rescued=${rescued}`,
				);
			}

			const { inStock } = parseProductPage(text);
			if (!inStock) { outOfStock++; return; }

			let price = parsePrice(text);
			if (!price) {
				// Default location doesn't carry this bottle; re-fetch under a
				// location that does to read its price.
				const locId = findCarryingLocationId(text);
				if (locId) {
					const p = await fetchPriceAtLocation(ctx, url, handle, locId);
					if (p) { price = p; rescued++; }
				}
			}

			const prev = prevDb?.byUrl?.get(url) || null;
			const finalSku = pickBetterSku(normalizeWnbSku(meta.sku, ctx, url), prev?.sku || "");

			discovered.set(url, {
				name: meta.title,
				price: price || prev?.price || "",
				url,
				sku: finalSku,
				img: meta.img || prev?.img || "",
			});
		});

		ctx.logger.ok(
			`${ctx.catPrefixOut} | wineandbeyond catalog=${catalog.size} checked=${checked} inStock=${discovered.size} oos=${outOfStock} rescued=${rescued}`,
		);

		finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 0 });
	};
}

function createStore(defaultUa) {
	return {
		key: "wineandbeyond",
		region: "AB",
		name: "Wine and Beyond",
		host: HOST,
		ua: defaultUa,
		scanCategory: (ctx, prev, rep) => ctx.cat._scan(ctx, prev, rep),
		categories: [
			{ key: "whiskey", label: "Whiskey", _scan: scanCategoryWnB("whiskey") },
			{ key: "rum",     label: "Rum",     _scan: scanCategoryWnB("rum")     },
			{ key: "gin",     label: "Gin",     _scan: scanCategoryWnB("gin")     },
		],
	};
}

module.exports = { createStore };
