"use strict";

const { setTimeout: sleep } = require("timers/promises");
const { decodeHtml, cleanText, extractFirstImgUrl } = require("../utils/html");
const { normalizeSkuKey } = require("../utils/sku");
const {
	extractPriceFromTmbBlock,
	formatWooStorePrice,
	parseWooStoreProductsJson,
	getWooCategoryId,
} = require("../utils/woocommerce");

// Tracker internals (store-only override; no global changes)
const { finalizeCategoryScan } = require("../tracker/finalize");

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



/* ─────────────────────────────────────────────────────────────────────────
 * Sierra Springs: per-product shipping availability check
 *
 * Uses classic WooCommerce update_order_review AJAX to determine whether
 * a product has non-local-pickup shipping options for an AB address.
 * Runs after the WC Store API scan; non-shippable items are dropped from
 * discovered so they are marked removed in the DB.
 * ───────────────────────────────────────────────────────────────────────── */

const SS_WFACP_ID = "141983"; // WooFunnels checkout page ID — static for this store

function ssCookieJar() {
	const jar = new Map();
	function ingest(res) {
		const lines =
			typeof res.headers.getSetCookie === "function"
				? res.headers.getSetCookie()
				: res.headers.get("set-cookie")
				? [res.headers.get("set-cookie")]
				: [];
		for (const line of lines) {
			const pair = line.split(";")[0].trim();
			const eq = pair.indexOf("=");
			if (eq > 0) jar.set(pair.slice(0, eq), pair);
		}
	}
	function header() {
		return [...jar.values()].join("; ");
	}
	return { ingest, header };
}

function ssParseShippingMethods(orderTableHtml) {
	const row = orderTableHtml.match(/<tr[^>]*woocommerce-shipping-totals[^>]*>([\s\S]*?)<\/tr>/i)?.[0] || "";
	const methods = [];
	for (const m of row.matchAll(/<input[^>]+value=["']([^"']+)["'][^>]*>/gi)) {
		if (!methods.includes(m[1])) methods.push(m[1]);
	}
	return methods;
}

/**
 * Fetch the update_order_review security nonce once per category run.
 * WP nonces for guest users are time-based (12h window, user ID 0, no session
 * token), so the same nonce is valid for all per-product checks in a run.
 * Returns the nonce string or null on failure.
 */
async function ssGetNonce(base, ua, log) {
	try {
		// A bare fetch (no session cookie) is enough — guest nonce is session-independent
		log?.(`ssGetNonce: GET /checkouts/checkout/`);
		const t0 = Date.now();
		const res = await fetch(`${base}/checkouts/checkout/`, {
			headers: { "user-agent": ua, accept: "text/html" },
		});
		const nonce = (await res.text()).match(/nonce.*?["']([a-f0-9]{10})["']/i)?.[1];
		log?.(`ssGetNonce: HTTP ${res.status} (${Date.now() - t0}ms) nonce=${nonce ?? "NOT FOUND"}`);
		return nonce ?? null;
	} catch (e) {
		log?.(`ssGetNonce: ERROR ${e.message}`);
		return null;
	}
}

/**
 * Per-product shippability check using a fresh WC session each time.
 * Creates its own cookie jar → add_to_cart (establishes session) →
 * update_order_review with pre-fetched nonce → abandon session.
 * No cart cleanup needed; stale sessions expire server-side.
 */
async function ssCheckProductShippable(base, productId, nonce, ua, log, label) {
	const lbl = label ?? `id=${productId}`;
	const cookies = ssCookieJar();

	// Fresh session: add product to cart
	log?.(`ssCheck ${lbl}: add_to_cart`);
	const t0 = Date.now();
	const addRes = await fetch(`${base}/?wc-ajax=add_to_cart`, {
		method: "POST",
		headers: {
			"user-agent": ua,
			"content-type": "application/x-www-form-urlencoded",
			"x-requested-with": "XMLHttpRequest",
		},
		body: `product_id=${productId}&quantity=1`,
	});
	cookies.ingest(addRes);
	log?.(`ssCheck ${lbl}: add_to_cart HTTP ${addRes.status} (${Date.now() - t0}ms)`);
	if (!addRes.ok) throw new Error(`add_to_cart HTTP ${addRes.status}`);

	// Check shipping methods for AB address
	await sleep(150);
	const postData = [
		`security=${nonce}`,
		"payment_method=weeconnectpay",
		"country=CA", "state=AB", "postcode=T1X0L3", "city=Calgary",
		"s_country=CA", "s_state=AB", "s_postcode=T1X0L3", "s_city=Calgary",
		"has_full_address=true",
		"post_data=payment_method%3Dweeconnectpay",
		"shipping_method%5B0%5D=local_pickup%3A1",
	].join("&");

	log?.(`ssCheck ${lbl}: update_order_review`);
	const t2 = Date.now();
	const reviewRes = await fetch(
		`${base}/?wc-ajax=update_order_review&wfacp_id=${SS_WFACP_ID}&wfacp_is_checkout_override=yes`,
		{
			method: "POST",
			headers: {
				"user-agent": ua,
				"content-type": "application/x-www-form-urlencoded; charset=UTF-8",
				accept: "*/*",
				"x-requested-with": "XMLHttpRequest",
				origin: base,
				referer: `${base}/checkouts/checkout/`,
				cookie: cookies.header(),
			},
			body: postData,
		},
	);
	const reviewData = await reviewRes.json().catch(() => null);
	log?.(`ssCheck ${lbl}: update_order_review HTTP ${reviewRes.status} (${Date.now() - t2}ms)`);
	if (!reviewData) throw new Error(`update_order_review HTTP ${reviewRes.status}`);

	const orderTable = reviewData?.fragments?.[".woocommerce-checkout-review-order-table"] || "";
	const methods = ssParseShippingMethods(orderTable);
	const shippable = methods.length > 0 && methods.some((m) => !/^local.?pickup/i.test(m));
	log?.(`ssCheck ${lbl}: methods=[${methods.join(", ")}] shippable=${shippable}`);

	// Session abandoned — no cleanup needed; WC expires guest sessions server-side
	return { shippable, methods };
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

	const catId = await getWooCategoryId(ctx);
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

	// ── Shipping availability check ────────────────────────────────────────────
	// For each discovered item: if it's already removed in prevDb, skip (already
	// unavailable). Otherwise check if shippable; if not, drop from discovered so
	// it gets marked removed by finalizeCategoryScan.
	// Each check uses a fresh WC session — no shared cart state to manage.
	{
		const base = `https://${ctx.store.host}`;
		const dbg = (msg) => logger.dbg(msg);

		const nonce = await ssGetNonce(base, ctx.store.ua, dbg);
		if (!nonce) {
			logger.warn(`${ctx.catPrefixOut} | Could not fetch nonce; shippable checks skipped`);
		} else {
			let checked = 0, dropped = 0;

			for (const [url, it] of [...discovered.entries()]) {
				// Skip items already marked removed in prevDb — no need to recheck
				const prev = prevDb.byUrl.get(url);
				if (prev?.removed) continue;

				const productId = it._wooProductId
					?? (/^id:(\d+)$/.test(String(it.sku || "")) ? Number(it.sku.slice(3)) : null);
				if (!productId) continue; // synthetic u: SKU — skip

				await sleep(400);
				try {
					const { shippable } = await ssCheckProductShippable(base, productId, nonce, ctx.store.ua, dbg, it.sku);
					checked++;
					if (!shippable) {
						discovered.delete(url);
						dropped++;
					}
				} catch (e) {
					logger.warn(`${ctx.catPrefixOut} | shippable check failed ${it.sku}: ${e.message}`);
				}
			}
			logger.ok(`${ctx.catPrefixOut} | Shippable checks: ${checked} checked, ${dropped} in-store-only dropped`);
		}
	}

	const { merged, metaChangedItems } = finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: Math.max(0, page) });
	logger.ok(`${ctx.catPrefixOut} | DB saved: ${logger.dim(ctx.dbFile)} (${merged.size} items)`);
	report.totals.metaChangedCount += metaChangedItems.length;
}

function createStore(defaultUa) {
	const ua = defaultUa;

	return {
		key: "sierrasprings",
		region: "AB",
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
			{
				key: "gin",
				label: "Gin",
				startUrl: "https://sierraspringsliquor.ca/product-category/gin/",
				discoveryStartPage: 1,
				perPage: 100,
			},
		],
	};
}

module.exports = { createStore, parseProductsSierra };