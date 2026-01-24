"use strict";

const { normalizeCspc } = require("../utils/sku");
const { humanBytes } = require("../utils/bytes");
const { padLeft, padRight } = require("../utils/string");

const { mergeDiscoveredIntoDb } = require("../tracker/merge");
const { buildDbObject, writeJsonAtomic } = require("../tracker/db");
const { addCategoryResultToReport } = require("../tracker/report");

function kbStr(bytes) {
  return humanBytes(bytes).padStart(8, " ");
}

function secStr(ms) {
  const s = Number.isFinite(ms) ? ms / 1000 : 0;
  const tenths = Math.round(s * 10) / 10;
  let out;
  if (tenths < 10) out = `${tenths.toFixed(1)}s`;
  else out = `${Math.round(s)}s`;
  return out.padStart(7, " ");
}

function pageStr(i, total) {
  const leftW = String(total).length;
  return `${padLeft(i, leftW)}/${total}`;
}

function pctStr(done, total) {
  const pct = total ? Math.floor((done / total) * 100) : 0;
  return `${padLeft(pct, 3)}%`;
}

function cad(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return `$${x.toFixed(2)}`;
}

function normalizeAbsUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s, "https://www.legacyliquorstore.com/").toString();
  } catch {
    return s;
  }
}

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
  // Matches observed pattern: /LL/product/spirits/<category>/<slug>
  const url = new URL(`/LL/product/spirits/${encodeURIComponent(ctx.cat.key)}/${encodeURIComponent(slug)}`, base).toString();

  const nameRaw =
    String(v?.fullName || "").trim() ||
    [String(p?.name || "").trim(), String(v?.shortName || "").trim()].filter(Boolean).join(" | ");
  const name = String(nameRaw || "").trim();
  if (!name) return null;

  const price =
    cad(v?.price) ||
    cad(p?.priceFrom) ||
    cad(p?.priceTo) ||
    "";

  const sku = normalizeCspc(v?.sku || "") || normalizeCspc(url) || "";
  const img = normalizeAbsUrl(v?.image || "");

  return { name, price, url, sku, img };
}

async function legacyFetchPage(ctx, pageCursor, pageLimit) {
  const body = {
    query: PRODUCTS_QUERY,
    variables: {
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
    },
  };

  return await ctx.http.fetchJsonWithRetry(LEGACY_GQL_URL, `legacy:${ctx.cat.key}:${pageCursor || "first"}`, ctx.store.ua, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "content-type": "application/json",
      Origin: "https://www.legacyliquorstore.com",
      Referer: "https://www.legacyliquorstore.com/",
    },
    body: JSON.stringify(body),
  });
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
        3
      )} | bytes=${kbStr(r.bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`
    );

    if (!next || !arr.length) break;
    if (next === cursor) break; // safety
    cursor = next;
  }

  const { merged, newItems, updatedItems, removedItems, restoredItems } = mergeDiscoveredIntoDb(prevDb, discovered);
  const dbObj = buildDbObject(ctx, merged);
  writeJsonAtomic(ctx.dbFile, dbObj);

  const elapsed = Date.now() - t0;
  ctx.logger.ok(
    `${ctx.catPrefixOut} | Done in ${secStr(elapsed)}. New=${newItems.length} Updated=${updatedItems.length} Removed=${removedItems.length} Restored=${restoredItems.length} Total(DB)=${merged.size}`
  );

  report.categories.push({
    store: ctx.store.name,
    label: ctx.cat.label,
    key: ctx.cat.key,
    dbFile: ctx.dbFile,
    scannedPages: Math.max(1, page),
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
    key: "legacyliquor",
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
    ],
  };
}

module.exports = { createStore };
