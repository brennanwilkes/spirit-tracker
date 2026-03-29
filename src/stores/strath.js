"use strict";

const { decodeHtml, stripTags, cleanText, extractFirstImgUrl } = require("../utils/html");
const { normalizeCspc, pickBetterSku } = require("../utils/sku");
const { padLeft, padRight } = require("../utils/string");
const { kbStr, secStr, pageStr, pctStr } = require("../utils/format");
const { extractPrice: normalizePrice } = require("../utils/price");
const {
	buildWooStoreApiUrl: buildStoreApiBaseUrlFromCategoryUrl,
	hasCategorySlug,
	normalizeWooProductUrl: normalizeProductUrl,
	normalizeWooProductName: normalizeProductName,
	normalizeWooProductImage: normalizeProductImage,
	toMoneyStringFromMinorUnits,
	normalizeWooProductPrice: normalizeProductPrice,
	normalizeWooProductSku: normalizeProductSku,
	normalizeWooProductId: normalizeProductId,
	fetchWooStoreApiPage: fetchStoreApiPage,
} = require("../utils/woocommerce");
const { extractDiviAjaxSecurity, extractDiviFilterVarQuery, fetchDiviLoadMore } = require("../utils/divi");

const { avoidMassRemoval } = require("../tracker/merge");
const { finalizeCategoryScan } = require("../tracker/finalize");


function extractArticles(html) {
	const s = String(html || "");
	const parts = s.split(/<article\b/i);
	if (parts.length <= 1) return [];
	const out = [];
	for (let i = 1; i < parts.length; i++) out.push("<article" + parts[i]);
	return out;
}


function extractWhiskyFolkPriceBlock(articleHtml) {
	const a = String(articleHtml || "");
	const m = a.match(
		/<div\b[^>]*class=["'][^"']*\bwhiskyfolk-price\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
	);
	return m && m[1] ? m[1] : "";
}

function pickPriceFromArticle(articleHtml) {
	const a = String(articleHtml || "");

	// Prefer Whisky Folk/member price when present.
	const wfBlock = extractWhiskyFolkPriceBlock(a);
	if (wfBlock) {
		const p = normalizePrice(wfBlock);
		if (p) return p;
	}

	const ins = a.match(/<ins\b[^>]*>[\s\S]*?(\$[\s\S]{0,32}?)<\/ins>/i);
	if (ins && ins[1]) return normalizePrice(ins[1]);

	const reg = a.match(/class=["'][^"']*\bregular-price-card\b[^"']*["'][^>]*>\s*([^<]+)/i);
	if (reg && reg[1]) return normalizePrice(reg[1]);

	const priceDiv = a.match(/<div\b[^>]*class=["'][^"']*\bproduct-price\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
	const scope = priceDiv && priceDiv[1] ? priceDiv[1] : a;

	return normalizePrice(scope);
}

function extractProductIdFromArticle(articleHtml) {
	const a = String(articleHtml || "");

	let m = a.match(/<article\b[^>]*\bid=["'](\d{1,10})["']/i);
	if (m && m[1]) return Number(m[1]);

	m = a.match(/\bpost-(\d{1,10})\b/i);
	if (m && m[1]) return Number(m[1]);

	m = a.match(/\bdata-product_id=["'](\d{1,10})["']/i);
	if (m && m[1]) return Number(m[1]);

	return 0;
}

function extractSkuFromArticle(articleHtml) {
	const a = String(articleHtml || "");

	let m = a.match(/\bdata-product_sku=["'](\d{6})["']/i);
	if (m && m[1]) return m[1];

	m = a.match(/\bSKU\b[^0-9]{0,20}(\d{6})\b/i);
	if (m && m[1]) return m[1];

	return "";
}

function idFromImageUrl(imgUrl) {
	const s = String(imgUrl || "");
	// /1487-1_... or /1487_... or /1487-... => 1487
	const m = s.match(/\/(\d{1,11})(?=[-_])/);
	return m && m[1] ? `id:${m[1]}` : "";
}

function looksInStock(articleHtml) {
	const a = String(articleHtml || "");

	if (/\boutofstock\b/i.test(a)) return false;
	if (/Currently\s+Unavailable/i.test(a)) return false;

	if (/\binstock\b/i.test(a)) return true;
	if (/\bBottles\s+(?:Remaining|Available)\b/i.test(a)) return true;
	if (/Only\s+\d+\s+Bottle\s+Left/i.test(a)) return true;
	if (/10\+\s*Bottles\s+Available/i.test(a)) return true;

	return /\binstock\b/i.test(a);
}

function parseProductFromArticle(articleHtml) {
	const a = String(articleHtml || "");

	if (!looksInStock(a)) return null;

	const hrefM = a.match(/<a\b[^>]*href=["']([^"']+)["']/i);
	if (!hrefM || !hrefM[1]) return null;

	let url;
	try {
		url = new URL(decodeHtml(hrefM[1]), "https://www.strathliquor.com/").toString();
	} catch {
		return null;
	}

	const t2 = a.match(/<h2\b[^>]*class=["'][^"']*\bproduct-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
	const t3 = a.match(/<h3\b[^>]*class=["'][^"']*\bproduct-subtitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
	const title = cleanText(decodeHtml(stripTags((t2 && t2[1]) || "")));
	const sub = cleanText(decodeHtml(stripTags((t3 && t3[1]) || "")));
	const name = cleanText([title, sub].filter(Boolean).join(" - "));
	if (!name) return null;

	const wfBlock = extractWhiskyFolkPriceBlock(a);
	const wfPrice = Boolean(wfBlock && normalizePrice(wfBlock));
	const price = pickPriceFromArticle(a);

	const productId = extractProductIdFromArticle(a);
	const img = extractFirstImgUrl(a, "https://www.strathliquor.com/");

	const skuFromHtml = extractSkuFromArticle(a);
	const skuFromImg = idFromImageUrl(img);
	const fallbackSku = normalizeCspc(url) || "";

	return {
		name,
		price,
		url,
		sku: skuFromHtml || skuFromImg || fallbackSku,
		productId,
		img,
		wfPrice,
	};
}


function mergePreferWf(discovered, it) {
	if (!it || !it.url) return;

	const prev = discovered.get(it.url) || null;
	if (!prev) {
		discovered.set(it.url, it);
		return;
	}

	// If new has wfPrice, always prefer its price.
	const price = it.wfPrice ? it.price : prev.price || it.price;
	const wfPrice = Boolean(prev.wfPrice || it.wfPrice);

	discovered.set(it.url, {
		name: it.name || prev.name,
		price,
		url: it.url,
		sku: pickBetterSku(it.sku, prev.sku),
		productId: it.productId || prev.productId || 0,
		img: it.img || prev.img || "",
		wfPrice,
	});
}


async function scanCategoryStrath(ctx, prevDb, report) {
	const t0 = Date.now();

	// Listing HTML (nonce + data-filter-var)
	let html = "";
	let listingFinalUrl = ctx.cat.startUrl;
	let listingStatus = 0;
	let listingBytes = 0;
	let listingMs = 0;

	try {
		const r = await ctx.http.fetchTextWithRetry(ctx.cat.startUrl, `strath:html:${ctx.cat.key}`, ctx.store.ua);
		html = r.text || "";
		listingFinalUrl = r.finalUrl || ctx.cat.startUrl;
		listingStatus = r.status || 0;
		listingBytes = r.bytes || 0;
		listingMs = r.ms || 0;
	} catch (e) {
		ctx.logger.warn(`${ctx.catPrefixOut} | Strath listing HTML fetch failed: ${e?.message || e}`);
	}

	const discovered = new Map();

	// Parse first page HTML (cheap, but may not contain member pricing everywhere).
	const listingArticles = extractArticles(html);
	let listingItems = 0;
	for (const art of listingArticles) {
		const it = parseProductFromArticle(art);
		if (it) {
			mergePreferWf(discovered, it);
			listingItems++;
		}
	}

	ctx.logger.ok(
		`${ctx.catPrefixOut} | Page ${pageStr(1, 1)} | ${String(listingStatus || "").padEnd(3)} | ${pctStr(1, 1)} | items=${padLeft(
			listingItems,
			3,
		)} | bytes=${kbStr(listingBytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(listingMs)}`,
	);

	// Divi loadmore paging (use live query from data-filter-var so post__in stays current)
	const nonce = extractDiviAjaxSecurity(html);
	const baseQuery = extractDiviFilterVarQuery(html);
	const divi = ctx.cat.diviLoadMore;

	if (nonce && baseQuery && divi && divi.baseBody) {
		const endpoint = divi.endpoint || "https://www.strathliquor.com/wp-json/divi-ajax-filter/v1/loadmore";
		const maxPagesCap = ctx.config.maxPages === null ? 5000 : ctx.config.maxPages;

		const perPage = Number(divi.baseBody.postnumber) || Number(baseQuery.posts_per_page) || 50;

		for (let page = 1; page <= maxPagesCap; page++) {
			const q = { ...baseQuery, paged: page, posts_per_page: perPage };

			const body = {
				...divi.baseBody,
				security: nonce,
				page,
				postnumber: String(perPage),
				query: JSON.stringify(q),
			};

			let r;
			try {
				r = await fetchDiviLoadMore(ctx, endpoint, body);
			} catch (e) {
				ctx.logger.warn?.(`${ctx.catPrefixOut} | Divi loadmore page ${page} failed: ${e?.message || e}`);
				break;
			}

			const postsHtml = String(r?.json?.posts || "");
			if (!postsHtml.trim()) break;
			if (!/<article\b/i.test(postsHtml)) break;

			let added = 0;
			let wfUpgrades = 0;

			const arts = extractArticles(postsHtml);
			for (const art of arts) {
				const it = parseProductFromArticle(art);
				if (!it) continue;

				const prev = discovered.get(it.url) || null;
				const prevWf = Boolean(prev && prev.wfPrice);

				mergePreferWf(discovered, it);

				if (!prev) added++;
				else if (!prevWf && it.wfPrice) wfUpgrades++;
			}

			ctx.logger.ok(
				`${ctx.catPrefixOut} | Divi Page ${pageStr(page, page)} | ${(r?.status || "").toString().padEnd(3)} | items+=${padLeft(
					added,
					3,
				)} | wf+=${padLeft(wfUpgrades, 3)} | bytes=${kbStr(r.bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`,
			);

			if (arts.length < perPage) break;
		}
	} else {
		ctx.logger.warn?.(
			`${ctx.catPrefixOut} | Divi paging disabled (nonce=${nonce ? "ok" : "missing"} query=${baseQuery ? "ok" : "missing"}).`,
		);
	}

	// Store API scan (completeness). Preserve WF/member price when already present.
	const apiBase = buildStoreApiBaseUrlFromCategoryUrl(listingFinalUrl || ctx.cat.startUrl);

	const perPage = 100;
	const maxPagesCap = ctx.config.maxPages === null ? 5000 : ctx.config.maxPages;

	const wantedSlug = String(ctx.cat.apiCategorySlug || "")
		.trim()
		.toLowerCase();

	let donePages = 0;
	let emptyMatchPages = 0;

	for (let page = 1; page <= maxPagesCap; page++) {
		let r;
		try {
			r = await fetchStoreApiPage(ctx, apiBase, page, perPage);
		} catch (e) {
			ctx.logger.warn?.(`${ctx.catPrefixOut} | Strath Store API page ${page} failed: ${e?.message || e}`);
			break;
		}

		const arr = Array.isArray(r?.json) ? r.json : [];
		donePages++;

		if (!arr.length) break;

		let kept = 0;

		for (const p of arr) {
			const stock = String(p?.stock_status || "").toLowerCase();
			if (stock && stock !== "instock") continue;

			if (wantedSlug && !hasCategorySlug(p, wantedSlug)) continue;

			const url = normalizeProductUrl(p);
			if (!url) continue;

			const name = normalizeProductName(p);
			if (!name) continue;

			const apiPrice = normalizeProductPrice(p);
			const sku = normalizeProductSku(p);
			const productId = normalizeProductId(p);

			const prev = discovered.get(url) || null;
			const prevHasWf = Boolean(prev && prev.wfPrice);

			const apiImg = normalizeProductImage(p) || "";
			const img = apiImg || (prev && prev.img) || "";

			const skuFromApiImg = idFromImageUrl(apiImg);
			const fallbackSku = sku || skuFromApiImg || normalizeCspc(url) || "";

			const newSku = sku || fallbackSku;
			const mergedSku = pickBetterSku(newSku, prev && prev.sku);

			const mergedPrice = prevHasWf ? prev.price : (prev && prev.price) || apiPrice;

			discovered.set(url, {
				name: (prev && prev.name) || name,
				price: mergedPrice,
				url,
				sku: mergedSku,
				productId: (prev && prev.productId) || productId,
				img,
				wfPrice: prevHasWf,
			});
			kept++;
		}

		ctx.logger.ok(
			`${ctx.catPrefixOut} | API Page ${pageStr(donePages, donePages)} | ${(r?.status || "").toString().padEnd(3)} | kept=${padLeft(
				kept,
				3,
			)} | bytes=${kbStr(r.bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`,
		);

		if (wantedSlug) {
			if (kept === 0) emptyMatchPages++;
			else emptyMatchPages = 0;
			if (emptyMatchPages >= 2) break;
		}

		if (arr.length < perPage) break;
	}

	avoidMassRemoval(prevDb, discovered, ctx, `storeapi pages=${donePages} slug=${wantedSlug || "none"}`);

	ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);

	const { merged } = finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: 1 + Math.max(0, donePages) });
	ctx.logger.ok(`${ctx.catPrefixOut} | DB saved: ${ctx.logger.dim(ctx.dbFile)} (${merged.size} items)`);
}

function createStore(defaultUa) {
	return {
		key: "strath",
		region: "BC",
		name: "Strath Liquor",
		host: "www.strathliquor.com",
		ua: defaultUa,
		scanCategory: scanCategoryStrath,
		categories: [
			{
				key: "whisky",
				label: "Whisky",
				apiCategorySlug: "whisky",
				startUrl:
					"https://www.strathliquor.com/whisky/?_sfm__stock_status=instock&_sfm__regular_price=0+6000&_sfm_product_abv=20+75&orderby=date",
				diviLoadMore: {
					endpoint: "https://www.strathliquor.com/wp-json/divi-ajax-filter/v1/loadmore",
					// Keep only the non-query UI args here (query comes from data-filter-var).
					baseBody: {
						security: "",
						query: "",
						page: 1,
						layoutid: "none",
						posttype: "product",
						noresults: "none",
						sortorder: "title_asc",
						sortasc: "desc",
						gridstyle: "off",
						columnscount: "5",
						resultcount: "on",
						countposition: "top",
						shortcode_name: "[de_loop_template_shortcode]",
						postnumber: "50",
						loadmoretext: "Load More",
						link_wholegrid: "",
						is_loadmore: "on",
						loop_var:
							'{"loop_style":"on","loop_templates":"custom-template","show_variations":"off","show_excerpt_list_view":"off","enable_overlay":"on","show_featured_image":"on","show_read_more":"off","show_author":"on","show_date":"on","date_format":"F j, Y","show_categories":"on","show_categories_count":"off","show_content":"off","show_comments":"off","excerpt_length":"270","excerpt_more":"...","meta_separator":"|","read_more_text":"Read More","button_fullwidth":"off","custom_loop_template":"custom-template.php"}',
						show_rating: "on",
						show_price: "on",
						show_excerpt: "",
						show_add_to_cart: "on",
					},
				},
			},
			{
				key: "spirits-rum",
				label: "Spirits - Rum",
				apiCategorySlug: "rum",
				startUrl:
					"https://www.strathliquor.com/spirits/?_sfm__stock_status=instock&_sfm__regular_price=0+600&_sfm_product_type=Rum&_sfm_product_abv=10+75&orderby=date",
				diviLoadMore: {
					endpoint: "https://www.strathliquor.com/wp-json/divi-ajax-filter/v1/loadmore",
					baseBody: {
						security: "",
						query: "",
						page: 1,
						layoutid: "none",
						posttype: "product",
						noresults: "none",
						sortorder: "date ID",
						sortasc: "DESC",
						gridstyle: "off",
						columnscount: "5",
						resultcount: "on",
						countposition: "top",
						shortcode_name: "[de_loop_template_shortcode]",
						postnumber: "100",
						loadmoretext: "Load More",
						link_wholegrid: "",
						is_loadmore: "on",
						loop_var:
							'{"loop_style":"on","loop_templates":"custom-template","show_variations":"off","show_excerpt_list_view":"off","enable_overlay":"on","show_featured_image":"on","show_read_more":"off","show_author":"on","show_date":"on","date_format":"F j, Y","show_categories":"on","show_categories_count":"off","show_content":"off","show_comments":"off","excerpt_length":"270","excerpt_more":"...","meta_separator":"|","read_more_text":"Read More","button_fullwidth":"off","custom_loop_template":"custom-template.php"}',
						show_rating: "on",
						show_price: "on",
						show_excerpt: "",
						show_add_to_cart: "on",
					},
				},
			},
			{
				key: "spirits-gin",
				label: "Spirits - Gin",
				apiCategorySlug: "gin",
				startUrl:
					"https://www.strathliquor.com/spirits/?_sfm__stock_status=instock&_sfm__regular_price=0+600&_sfm_product_type=Gin&_sfm_product_abv=0+75&orderby=date",
				diviLoadMore: {
					endpoint: "https://www.strathliquor.com/wp-json/divi-ajax-filter/v1/loadmore",
					baseBody: {
						security: "",
						query: "",
						page: 1,
						layoutid: "none",
						posttype: "product",
						noresults: "none",
						sortorder: "date ID",
						sortasc: "DESC",
						gridstyle: "off",
						columnscount: "5",
						resultcount: "on",
						countposition: "top",
						shortcode_name: "[de_loop_template_shortcode]",
						postnumber: "100",
						loadmoretext: "Load More",
						link_wholegrid: "",
						is_loadmore: "on",
						loop_var:
							'{"loop_style":"on","loop_templates":"custom-template","show_variations":"off","show_excerpt_list_view":"off","enable_overlay":"on","show_featured_image":"on","show_read_more":"off","show_author":"on","show_date":"on","date_format":"F j, Y","show_categories":"on","show_categories_count":"off","show_content":"off","show_comments":"off","excerpt_length":"270","excerpt_more":"...","meta_separator":"|","read_more_text":"Read More","button_fullwidth":"off","custom_loop_template":"custom-template.php"}',
						show_rating: "on",
						show_price: "on",
						show_excerpt: "",
						show_add_to_cart: "on",
					},
				},
			},
		],
	};
}

module.exports = { createStore };