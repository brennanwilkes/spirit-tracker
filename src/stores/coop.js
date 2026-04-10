"use strict";

const { randomUUID } = require("crypto");
const { normalizeSkuKey } = require("../utils/sku");
const { parallelMapStaggered } = require("../utils/async");
const { avoidMassRemoval } = require("../tracker/merge");
const { finalizeCategoryScan } = require("../tracker/finalize");

const BASE = "https://shoponlinewhisky-wine.coopwinespiritsbeer.com";
const GRAPHQL = `${BASE}/graphql`;
const SHOP_ID = "16689540";
const ZONE_ID = "856";
const POSTAL_CODE = "T2P3B6";
// Calgary coordinates — matched to the T2P3B6 postal code used for pricing zone
const LATITUDE = 51.048341;
const LONGITUDE = -114.069908;

const HASH_COLLECTION = "5573f6ef85bfad81463b431985396705328c5ac3283c4e183aa36c6aad1afafe";
const HASH_ITEMS = "5116339819ff07f207fd38f949a8a7f58e52cc62223b535405b087e3076ebf2f";
// DefaultShop — returns retailerInventorySessionToken required for SubjectProductsQuery
const HASH_DEFAULT_SHOP = "607e5aea2e2f7b3d8bf89bb7f657ce5c13bc12f89f70a7f7e6b2f1c13ded18a8";
// SubjectProductsQuery — fetches item IDs for a whisky subcategory (subject)
const HASH_SUBJECT = "d08c45dbb44fa9bd673f20b59cd17e23451c992a1e1c1dec06f994025c61965c";

const HEADERS = {
	"x-client-identifier": "web",
	accept: "*/*",
	"content-type": "application/json",
};

// GET the store page with ?unauth-refresh=1 to receive __Host-instacart_sid in Set-Cookie.
// Then call DefaultShop to obtain the retailerInventorySessionToken for subject queries.
async function ensureCoopSession(ctx) {
	if (ctx.store.coop.sessionBooted) return;
	ctx.store.coop.sessionBooted = true; // set before await — host throttler serialises same-host reqs
	await ctx.http.fetchTextWithRetry(
		`${BASE}/store/world-of-whisky?unauth-refresh=1`,
		"coop:session",
		ctx.store.ua,
	);
	const r = await ctx.http.fetchJsonWithRetry(
		graphqlUrl("DefaultShop", {
			postalCode: POSTAL_CODE,
			coordinates: { latitude: LATITUDE, longitude: LONGITUDE },
			addressId: null,
		}, HASH_DEFAULT_SHOP),
		"coop:token",
		ctx.store.ua,
		{ headers: HEADERS },
	);
	ctx.store.coop.inventoryToken = r?.json?.data?.defaultShop?.retailerInventorySessionToken || "";
}

function graphqlUrl(operationName, vars, hash) {
	const variables = encodeURIComponent(JSON.stringify(vars));
	const extensions = encodeURIComponent(
		JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }),
	);
	return `${GRAPHQL}?operationName=${operationName}&variables=${variables}&extensions=${extensions}`;
}

async function fetchCollectionIds(ctx, slug) {
	const vars = {
		shopId: SHOP_ID,
		postalCode: POSTAL_CODE,
		zoneId: ZONE_ID,
		slug,
		filters: [],
		pageViewId: randomUUID(),
		itemsDisplayType: "collections_items_grid",
		first: 1,
		pageSource: "browse",
	};
	const r = await ctx.http.fetchJsonWithRetry(
		graphqlUrl("CollectionProductsWithFeaturedProducts", vars, HASH_COLLECTION),
		`coop:ids:${slug}`,
		ctx.store.ua,
		{ headers: HEADERS },
	);
	return Array.isArray(r?.json?.data?.collectionProducts?.itemIds)
		? r.json.data.collectionProducts.itemIds
		: [];
}

// Subject pages (whisky subcategories) use SubjectProductsQuery.
// The subject id is the "n{digits}" prefix of the subject slug.
async function fetchSubjectIds(ctx, subjectSlug) {
	const subjectId = subjectSlug.match(/^(n\d+)/)?.[1] || subjectSlug;
	const vars = {
		retailerInventorySessionToken: ctx.store.coop.inventoryToken,
		id: subjectId,
		filters: [],
		first: 1,
		pageViewId: randomUUID(),
		pageSource: "browse_subject_items_grid",
		shopId: SHOP_ID,
		postalCode: POSTAL_CODE,
		zoneId: ZONE_ID,
	};
	const r = await ctx.http.fetchJsonWithRetry(
		graphqlUrl("SubjectProductsQuery", vars, HASH_SUBJECT),
		`coop:subj:${subjectSlug}`,
		ctx.store.ua,
		{ headers: HEADERS },
	);
	return Array.isArray(r?.json?.data?.collectionSubjectProducts?.itemIds)
		? r.json.data.collectionSubjectProducts.itemIds
		: [];
}

async function fetchItemBatch(ctx, ids) {
	const vars = { ids, shopId: SHOP_ID, zoneId: ZONE_ID, postalCode: POSTAL_CODE };
	const r = await ctx.http.fetchJsonWithRetry(
		graphqlUrl("Items", vars, HASH_ITEMS),
		`coop:items:b${ids.length}`,
		ctx.store.ua,
		{ headers: HEADERS },
	);
	return Array.isArray(r?.json?.data?.items) ? r.json.data.items : [];
}

function itemFromApi(raw) {
	if (!raw?.name || !raw?.productId) return null;
	if (raw.availability?.available === false) return null;

	const name = String(raw.name).trim();
	if (!name) return null;

	const url = `${BASE}/store/world-of-whisky/products/${raw.evergreenUrl || raw.productId}`;
	const price = raw.price?.viewSection?.itemCard?.priceString || "";

	const lookupStr = String(raw.viewSection?.retailerLookupCodeString || "");
	const upcMatch = lookupStr.match(/UPC:\s*(\d+)/);
	const rawKey = upcMatch ? `upc:${upcMatch[1]}` : `id:${raw.productId}`;
	const sku = normalizeSkuKey(rawKey, { storeLabel: "Co-op World of Whisky", url });

	const img = raw.viewSection?.itemImage?.url || "";

	return { name, price, url, sku, img };
}

async function scanCategoryCoop(ctx, prevDb, report) {
	const t0 = Date.now();
	await ensureCoopSession(ctx);
	const discovered = new Map();

	const itemIds = ctx.cat.coopSubject
		? await fetchSubjectIds(ctx, ctx.cat.coopSubject)
		: await fetchCollectionIds(ctx, ctx.cat.coopSlug);
	ctx.logger.ok(`${ctx.catPrefixOut} | IDs fetched: ${itemIds.length}`);

	const batches = [];
	for (let i = 0; i < itemIds.length; i += 24) batches.push(itemIds.slice(i, i + 24));

	const batchResults = await parallelMapStaggered(
		batches,
		ctx.config.concurrency,
		ctx.config.staggerMs,
		(ids) => fetchItemBatch(ctx, ids),
	);

	for (const items of batchResults) {
		for (const raw of items) {
			const it = itemFromApi(raw);
			if (it) discovered.set(it.url, it);
		}
	}

	avoidMassRemoval(prevDb, discovered, ctx, "coop graphql");
	ctx.logger.ok(`${ctx.catPrefixOut} | Unique products: ${discovered.size}`);
	finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages: batches.length });
}

function createStore(defaultUa) {
	return {
		key: "coop",
		region: "AB",
		name: "Co-op World of Whisky",
		host: "shoponlinewhisky-wine.coopwinespiritsbeer.com",
		ua: defaultUa,
		scanCategory: scanCategoryCoop,
		coop: { sessionBooted: false, inventoryToken: "" },
		categories: [
			{
				key: "canadian-whisky",
				label: "Canadian Whisky",
				coopSlug: "n-whiskey-64174",
				coopSubject: "n19049482045000700-canadian-72112",
				startUrl: `${BASE}/store/world-of-whisky/collections/n-whiskey-64174/subjects/n19049482045000700-canadian-72112`,
			},
			{
				key: "bourbon-whiskey",
				label: "Bourbon Whiskey",
				coopSlug: "n-whiskey-64174",
				coopSubject: "n19049482149000724-bourbon-96052",
				startUrl: `${BASE}/store/world-of-whisky/collections/n-whiskey-64174/subjects/n19049482149000724-bourbon-96052`,
			},
			{
				key: "scottish-single-malts",
				label: "Scottish Single Malts",
				coopSlug: "n-whiskey-64174",
				coopSubject: "n19049482132000720-scotch-54519",
				startUrl: `${BASE}/store/world-of-whisky/collections/n-whiskey-64174/subjects/n19049482132000720-scotch-54519`,
			},
			{
				key: "american-whiskey",
				label: "American Whiskey",
				coopSlug: "n-whiskey-64174",
				coopSubject: "n19049482064000704-american-89138",
				startUrl: `${BASE}/store/world-of-whisky/collections/n-whiskey-64174/subjects/n19049482064000704-american-89138`,
			},
			{
				key: "rum",
				label: "Rum",
				coopSlug: "n-rum-66987",
				startUrl: `${BASE}/store/world-of-whisky/collections/n-rum-66987`,
			},
			{
				key: "gin",
				label: "Gin",
				coopSlug: "n-gin-88900",
				startUrl: `${BASE}/store/world-of-whisky/collections/n-gin-88900`,
			},
		],
	};
}

module.exports = { createStore };
