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

const { setTimeout: sleep } = require("timers/promises");
const { sanitizeName } = require("../utils/text");
const { normalizeSkuKey, pickBetterSku } = require("../utils/sku");
const { normalizeShopifyProductUrl } = require("../utils/shopify");
const { finalizeCategoryScan } = require("../tracker/finalize");
const { parallelMapStaggered } = require("../utils/async");

const HOST = "www.wineandbeyond.ca";
// gin collection 500s at limit>=200; use a single safe ceiling everywhere.
const JSON_LIMIT = 150;
// W&B needs ~1 fetch per catalogued product (~1900 total) plus per-location price
// rescues, and rate-limits plain product GETs (not just cart writes). There's an
// inherent throughput floor of ~0.5–0.7 req/s no matter how we pace — the store is
// just slow — so W&B is the run's long pole (~45–60 min). Measured across CI runs:
//   150ms  → 37× HTTP 429, 63 min total
//   250ms  → ~0.67/s, 35× 429, 52 min total (fastest)
//   1000ms → ~0.50/s,  0× 429, 68 min total (clean but ~15 min slower)
// We pick 300ms: near the fast end, with a little headroom over 250 for 429 margin.
// The 40s adaptive-backoff half-life in http.js (raised from 20s) damps the 429
// limit cycle so residual 429s don't thrash throughput like they used to.
// The only real wall-clock fix is splitting W&B into its own parallel CI job so it
// stops gating the rest (deferred); caching is out for data-freshness reasons.
const WNB_INTERVAL_MS = 300;
const WNB_CONCURRENCY = 10;
// W&B's /cart/update.js (the only way to pick a per-location price) is harshly
// rate-limited: ~100 calls then a multi-minute lockout. So price rescue runs as
// a second pass that selects each carrying location ONCE (not once per product)
// and prices every product at that location via cheap product-page GETs reusing
// the same cart cookie. cart/update calls are spaced and we bail out entirely
// the moment one is throttled, so it can never poison the main product sweep.
const WNB_CART_SPACING_MS = 1500;

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

// Mint a fresh cart with `locId` selected and return its cart token, or "" if
// throttled/failed. retries:0 → fail fast on the 429 we expect under load,
// rather than burning the default 6 long retries against a locked-out endpoint.
async function selectLocationCart(ctx, locId) {
	try {
		const up = await ctx.http.fetchJsonWithRetry(
			`https://${HOST}/cart/update.js`,
			`${ctx.store.key}:loc:${ctx.cat.key}:${locId}`,
			ctx.store.ua,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ attributes: { _selected_location_id: locId } }),
				cookies: false,
				retries: 0,
			},
		);
		return cartTokenFromSetCookie(up.setCookie);
	} catch (_) {
		return "";
	}
}

// Read the price the product page renders for whatever location the given cart
// token has selected. Plain GET (not rate-limited), explicit cookie, jar bypassed.
async function fetchPriceWithCart(ctx, url, handle, cartCookie) {
	try {
		const { text } = await ctx.http.fetchTextWithRetry(
			url,
			`${ctx.store.key}:prodloc:${ctx.cat.key}:${handle}`,
			ctx.store.ua,
			{ headers: { cookie: cartCookie }, cookies: false },
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
		const priceless = []; // in-stock, no default price → { url, handle, locId, item }
		let checked = 0;
		let outOfStock = 0;
		let lastLog = Date.now();

		// Pass 1: fetch every product page, paced by WNB_INTERVAL_MS (the http.js
		// host throttler serialises same-host reqs to ~4/s). Product GETs ARE now
		// rate-limited by W&B, so this pacing is what keeps us under the
		// token-bucket cliff. No cart writes here.
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
					`${ctx.catPrefixOut} | wineandbeyond progress checked=${checked}/${entries.length} inStock=${discovered.size}`,
				);
			}

			const { inStock } = parseProductPage(text);
			if (!inStock) { outOfStock++; return; }

			const price = parsePrice(text);
			const prev = prevDb?.byUrl?.get(url) || null;
			const finalSku = pickBetterSku(normalizeWnbSku(meta.sku, ctx, url), prev?.sku || "");

			const item = {
				name: meta.title,
				price: price || prev?.price || "",
				url,
				sku: finalSku,
				img: meta.img || prev?.img || "",
			};
			discovered.set(url, item);

			// Location-exclusive bottle: default location renders no price. Defer
			// to the batched rescue pass below.
			if (!price) {
				const locId = findCarryingLocationId(text);
				if (locId) priceless.push({ url, handle, locId, item });
			}
		});

		// Pass 2: batched price rescue. Group the priceless items by carrying
		// location, select each location ONCE via cart/update, then price its
		// whole group with plain GETs. Bail out the instant cart/update throttles.
		let rescued = 0;
		if (priceless.length) {
			const byLoc = new Map();
			for (const p of priceless) {
				if (!byLoc.has(p.locId)) byLoc.set(p.locId, []);
				byLoc.get(p.locId).push(p);
			}
			ctx.logger.ok(
				`${ctx.catPrefixOut} | wineandbeyond rescuing ${priceless.length} priceless items across ${byLoc.size} locations…`,
			);

			let throttled = false;
			let first = true;
			for (const [locId, group] of byLoc) {
				if (!first) await sleep(WNB_CART_SPACING_MS);
				first = false;

				const cartCookie = await selectLocationCart(ctx, locId);
				if (!cartCookie) {
					throttled = true;
					break; // cart endpoint is locked out; stop hitting it
				}

				await parallelMapStaggered(group, WNB_CONCURRENCY, 0, async (p) => {
					const price = await fetchPriceWithCart(ctx, p.url, p.handle, cartCookie);
					if (price) { p.item.price = price; rescued++; }
				});
			}

			if (throttled) {
				ctx.logger.warn(
					`${ctx.catPrefixOut} | wineandbeyond rescue throttled — priced ${rescued}/${priceless.length}; remainder keep last-known/blank price`,
				);
			}
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | wineandbeyond catalog=${catalog.size} checked=${checked} inStock=${discovered.size} oos=${outOfStock} priceless=${priceless.length} rescued=${rescued}`,
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
