"use strict";

const { normalizeCspc, normalizeSkuKey } = require("../utils/sku");
const { padLeft, padRight } = require("../utils/string");
const { kbStr, secStr, pageStr, pctStr, cad } = require("../utils/format");
const { normalizeAbsUrl: _normUrl } = require("../utils/url");
const { shopifyGqlPost } = require("../utils/shopify");

const { finalizeCategoryScan } = require("../tracker/finalize");

function normalizeLegacySku(rawSku, { storeLabel, url }) {
	const raw = String(rawSku ?? "").trim();
	if (!raw) return "";

	const cspc = normalizeCspc(raw);
	if (cspc) return cspc;

	const m = raw.match(/\b(\d{1,11})\b/);
	if (m && m[1]) return `id:${m[1]}`;

	return normalizeSkuKey(raw, { storeLabel, url });
}

const normalizeAbsUrl = (raw) => _normUrl(raw, "https://www.legacyliquorstore.com/");

const LEGACY_GQL_URL = "https://production-storefront-api-hagnfhf3sq-uc.a.run.app/graphql";

// Keep it exactly a GraphQL string; variables are provided separately.
const PRODUCTS_QUERY = `
query(
  $allTags: [String],
  $anyTags: [String],
  $collectionSlug: String,
  $countries: [String],
  $isBestSeller: Boolean,
  $isNewArrival: Boolean,
  $isFeatured: Boolean,
  $isFeaturedOnHomepage: Boolean,
  $isOnSale: Boolean,
  $isStaffPick: Boolean,
  $pageCursor: String,
  $pageLimit: Int,
  $pointsMin: Int,
  $priceMin: Float,
  $priceMax: Float,
  $quantityMin: Float,
  $regions: [String],
  $brandValue: String,
  $searchValue: String,
  $sortOrder: String,
  $sortBy: String,
  $storeId: String!,
) {
  products(
    allTags: $allTags,
    anyTags: $anyTags,
    collectionSlug: $collectionSlug,
    countries: $countries,
    isBestSeller: $isBestSeller,
    isNewArrival: $isNewArrival,
    isFeatured: $isFeatured,
    isFeaturedOnHomepage: $isFeaturedOnHomepage,
    isOnSale: $isOnSale,
    isStaffPick: $isStaffPick,
    pageCursor: $pageCursor,
    pageLimit: $pageLimit,
    pointsMin: $pointsMin,
    priceMin: $priceMin,
    priceMax: $priceMax,
    quantityMin: $quantityMin,
    regions: $regions,
    brandValue: $brandValue,
    searchValue: $searchValue,
    sortOrder: $sortOrder,
    sortBy: $sortBy,
    storeId: $storeId,
  ) {
    items {
      id
      name
      slug
      priceFrom
      priceTo
      tags { id name slug }
      variants {
        id
        fullName
        shortName
        image
        price
        quantity
        sku
        alcoholByVolume
        deposit
      }
    }
    nextPageCursor
    totalCount
  }
}
`;

function pickInStockVariant(p) {
	const vars = Array.isArray(p?.variants) ? p.variants : [];
	for (const v of vars) {
		const q = Number(v?.quantity);
		if (Number.isFinite(q) && q > 0) return v;
	}
	return null;
}

function legacyProductToItem(p, ctx) {
	const v = pickInStockVariant(p);
	if (!v) return null;

	const slug = String(p?.slug || "").trim();
	if (!slug) return null;

	const base = "https://www.legacyliquorstore.com";
	const url = new URL(
		`/product/spirits/${encodeURIComponent(slug)}`,
		base,
	).toString();

	const nameRaw =
		String(v?.fullName || "").trim() ||
		[String(p?.name || "").trim(), String(v?.shortName || "").trim()].filter(Boolean).join(" | ");
	const name = String(nameRaw || "").trim();
	if (!name) return null;

	const price = cad(v?.price) || cad(p?.priceFrom) || cad(p?.priceTo) || "";

	const sku =
		normalizeLegacySku(v?.sku, { storeLabel: ctx.store.name, url }) ||
		normalizeLegacySku(url, { storeLabel: ctx.store.name, url }) ||
		"";
	const img = normalizeAbsUrl(v?.image || "");

	return { name, price, url, sku, img };
}

async function legacyFetchPage(ctx, pageCursor, pageLimit) {
	const variables = {
		allTags: ctx.cat.allTags || null,
		anyTags: null,
		collectionSlug: null,
		countries: null,
		isBestSeller: null,
		isNewArrival: null,
		isFeatured: null,
		isFeaturedOnHomepage: null,
		isOnSale: null,
		isStaffPick: null,
		pageCursor: pageCursor || null,
		pageLimit: pageLimit,
		pointsMin: null,
		priceMin: null,
		priceMax: null,
		quantityMin: null,
		regions: null,
		brandValue: null,
		searchValue: null,
		sortOrder: "asc",
		sortBy: "name",
		storeId: "LL",
	};

	return await shopifyGqlPost(ctx, LEGACY_GQL_URL, `legacy:${ctx.cat.key}:${pageCursor || "first"}`, PRODUCTS_QUERY, variables);
}

function upgradeOldLegacyUrls(prevDb) {
	const hasOld = prevDb?.byUrl && [...prevDb.byUrl.keys()].some(
		u => /\/LL\/product\/spirits\//.test(u)
	);
	if (!hasOld) return prevDb;

	const newByUrl = new Map();
	for (const [url, item] of prevDb.byUrl.entries()) {
		const upgraded = url.replace(
			/^(https?:\/\/[^/]+)\/LL\/product\/spirits\/[^/]+\/(.+)$/,
			"$1/product/spirits/$2"
		);
		newByUrl.set(upgraded, upgraded !== url ? { ...item, url: upgraded } : item);
	}
	return { ...prevDb, byUrl: newByUrl };
}

async function scanCategoryLegacyLiquor(ctx, prevDb, report) {
	const t0 = Date.now();
	const pageLimit = 100;

	const discovered = new Map();

	let cursor = null;
	let page = 0;
	let done = 0;
	const maxPagesCap = ctx.config.maxPages === null ? 5000 : ctx.config.maxPages;

	while (page < maxPagesCap) {
		page++;

		let r;
		try {
			r = await legacyFetchPage(ctx, cursor, pageLimit);
		} catch (e) {
			ctx.logger.warn(`${ctx.catPrefixOut} | LegacyLiquor fetch failed p${page}: ${e?.message || e}`);
			break;
		}

		const items = r?.json?.data?.products?.items;
		const next = r?.json?.data?.products?.nextPageCursor;

		const arr = Array.isArray(items) ? items : [];
		let kept = 0;

		for (const p of arr) {
			const it = legacyProductToItem(p, ctx);
			if (!it) continue;
			discovered.set(it.url, it);
			kept++;
		}

		done++;
		ctx.logger.ok(
			`${ctx.catPrefixOut} | Page ${pageStr(done, done)} | ${String(r.status || "").padEnd(3)} | ${pctStr(done, done)} | kept=${padLeft(
				kept,
				3,
			)} | bytes=${kbStr(r.bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`,
		);

		if (!next || !arr.length) break;
		if (next === cursor) break; // safety
		cursor = next;
	}

	finalizeCategoryScan(ctx, upgradeOldLegacyUrls(prevDb), discovered, report, { t0, scannedPages: Math.max(1, page) });
}

function createStore(defaultUa) {
	return {
		key: "legacyliquor",
		region: "BC",
		name: "Legacy Liquor",
		host: "www.legacyliquorstore.com",
		ua: defaultUa,
		scanCategory: scanCategoryLegacyLiquor,
		categories: [
			{
				key: "whisky",
				label: "Whisky",
				startUrl: "https://www.legacyliquorstore.com/LL/category/spirits/whisky",
				allTags: ["spirits", "whisky"],
			},
			{
				key: "rum",
				label: "Rum",
				startUrl: "https://www.legacyliquorstore.com/LL/category/spirits/rum",
				allTags: ["spirits", "rum"],
			},
			{
				key: "gin",
				label: "Gin",
				startUrl: "https://www.legacyliquorstore.com/LL/category/spirits/gin",
				allTags: ["spirits", "gin"],
			},
		],
	};
}

module.exports = { createStore };
