"use strict";

const { cleanText } = require("../utils/html");
const { normalizeCspc } = require("../utils/sku");
const { humanBytes } = require("../utils/bytes");
const { padLeft, padRight } = require("../utils/string");

const { mergeDiscoveredIntoDb } = require("../tracker/merge");
const { buildDbObject, writeJsonAtomic } = require("../tracker/db");
const { addCategoryResultToReport } = require("../tracker/report");

/* ---------------- constants ---------------- */

const HOST = "www.tudorhouseliquorstore.com";
const BASE = `https://${HOST}`;
const STORE_ID = "TUDOR_HOUSE_0";
const GQL_URL = "https://production-storefront-api-mlwv4nj3rq-uc.a.run.app/graphql";

/* ---------------- formatting ---------------- */

function kbStr(bytes) {
  return humanBytes(bytes).padStart(8, " ");
}
function secStr(ms) {
  const s = Number.isFinite(ms) ? ms / 1000 : 0;
  const t = Math.round(s * 10) / 10;
  return (t < 10 ? `${t.toFixed(1)}s` : `${Math.round(s)}s`).padStart(7, " ");
}
function pageStr(i, total) {
  const w = String(total).length;
  return `${padLeft(i, w)}/${total}`;
}

/* ---------------- helpers ---------------- */

function money(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `$${x.toFixed(2)}` : "";
}

function firstNonEmptyStr(...vals) {
  for (const v of vals) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) return s;
    if (Array.isArray(v)) {
      for (const a of v) {
        if (typeof a === "string" && a.trim()) return a.trim();
        if (a && typeof a === "object") {
          const u = String(a.url || a.src || a.image || "").trim();
          if (u) return u;
        }
      }
    }
  }
  return "";
}

function normalizeAbsUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s, `${BASE}/`).toString();
  } catch {
    return s;
  }
}

function tudorProductUrl(ctx, slug) {
  // Site URLs look like: /TUDOR_HOUSE_0/product/spirits/<subcat>/<slug>
  const root = ctx?.cat?.tudorRootSlug || "spirits";
  const sub = ctx?.cat?.tudorSubSlug || "";
  const path = `/${STORE_ID}/product/${encodeURIComponent(root)}/${encodeURIComponent(sub)}/${encodeURIComponent(slug)}`;
  return new URL(path, BASE).toString();
}

function tudorPickVariant(p) {
  const vs = Array.isArray(p?.variants) ? p.variants : [];
  // prefer in-stock variant
  const inStock = vs.find((v) => Number(v?.quantity) > 0);
  return inStock || vs[0] || null;
}

function tudorItemFromProduct(p, ctx) {
  if (!p) return null;

  const name = cleanText(p?.name || "");
  const slug = String(p?.slug || "").trim();
  if (!name || !slug) return null;

  const v = tudorPickVariant(p);
  if (v && Number(v?.quantity) <= 0) return null; // only keep in-stock

  const url = tudorProductUrl(ctx, slug);

  const price = money(v?.price ?? p?.priceFrom ?? p?.priceTo);
  const sku = normalizeCspc(v?.sku || "");
  const img = normalizeAbsUrl(
    firstNonEmptyStr(
      v?.image,
      p?.gulpImages,
      p?.posImages,
      p?.customImages,
      p?.imageIds
    )
  );

  return { name, price, url, sku, img };
}

async function tudorGql(ctx, label, query, variables) {
  return await ctx.http.fetchJsonWithRetry(GQL_URL, label, ctx.store.ua, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "content-type": "application/json",
      Origin: BASE,
      Referer: `${BASE}/`,
    },
    body: JSON.stringify({ query, variables }),
  });
}

function pickConnection(json) {
  const data = json?.data;
  if (!data || typeof data !== "object") return null;
  for (const v of Object.values(data)) {
    if (v && typeof v === "object" && Array.isArray(v.items)) return v;
  }
  return null;
}


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
        isOnSale
        variants { id price retailPrice quantity sku volume image deposit }
        gulpImages
        posImages
        customImages
      }
      nextPageCursor
      totalCount
    }
  }
`;

async function fetchProductsPage(ctx, cursor) {
  const vars = {
    storeId: STORE_ID,
    allTags: ctx.cat.tudorAllTags || ["spirits", ctx.cat.tudorSubSlug],
    anyTags: null,
    pageCursor: cursor || null,
    pageLimit: 100,
    sortBy: "name",
    sortOrder: "asc",
    priceMin: null,
    priceMax: null,
    quantityMin: null,
  };

  const r = await tudorGql(ctx, `tudor:gql:products:${ctx.cat.key}`, PRODUCTS_QUERY, vars);

  if (r?.status !== 200 || !r?.json?.data?.products) {
    const errs = Array.isArray(r?.json?.errors) ? r.json.errors : [];
    const msg = errs.length ? errs.map((e) => e?.message || String(e)).join(" | ") : `HTTP ${r?.status}`;
    throw new Error(`Tudor products query failed: ${msg}`);
  }

  return r.json.data.products;
}


/* ---------------- scanner ---------------- */

async function scanCategoryTudor(ctx, prevDb, report) {
    const t0 = Date.now();
    const discovered = new Map();
  
    const maxPages = ctx.config.maxPages === null ? 500 : Math.min(ctx.config.maxPages, 500);
    let cursor = null;
    let done = 0;
  
    for (let page = 1; page <= maxPages; page++) {
      const tPage = Date.now();
  
      const prod = await fetchProductsPage(ctx, cursor);
      const arr = Array.isArray(prod?.items) ? prod.items : [];
  
      let kept = 0;
      for (const p of arr) {
        const it = tudorItemFromProduct(p, ctx);
        if (!it) continue;
        discovered.set(it.url, it);
        kept++;
      }
  
      done++;
  
      const ms = Date.now() - tPage;
      ctx.logger.ok(
        `${ctx.catPrefixOut} | Page ${pageStr(page, maxPages)} | 200 | items=${padLeft(
          kept,
          3
        )} | bytes=${kbStr(0)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(ms)}`
      );
  
      cursor = prod?.nextPageCursor || null;
      if (!cursor || !arr.length) break;
    }
  
    ctx.logger.ok(`${ctx.catPrefixOut} | Unique products: ${discovered.size}`);
  
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
      scannedPages: done,
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
  

/* ---------------- store ---------------- */

function createStore(defaultUa) {
  return {
    key: "tudor",
    name: "Tudor House",
    host: HOST,
    ua: defaultUa,
    scanCategory: scanCategoryTudor,
    categories: [
      {
        key: "rum",
        label: "Rum",
        startUrl: `${BASE}/${STORE_ID}/category/spirits/rum`,
        tudorRootSlug: "spirits",
        tudorSubSlug: "rum",
        tudorAllTags: ["spirits", "rum"],
      },
      {
        key: "whiskey-scotch",
        label: "Whiskey / Scotch",
        startUrl: `${BASE}/${STORE_ID}/category/spirits/whiskey-scotch`,
        tudorRootSlug: "spirits",
        tudorSubSlug: "whiskey-scotch",
        tudorAllTags: ["spirits", "whiskey-scotch"],
      },
      {
        key: "scotch-selections",
        label: "Scotch Selections",
        startUrl: `${BASE}/${STORE_ID}/category/spirits/scotch-selections`,
        tudorRootSlug: "spirits",
        tudorSubSlug: "scotch-selections",
        tudorAllTags: ["spirits", "scotch-selections"],
      },
    ],
  };
}

module.exports = { createStore };
