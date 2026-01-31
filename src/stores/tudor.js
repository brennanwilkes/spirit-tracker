"use strict";

const { cleanText } = require("../utils/html");
const { normalizeCspc, pickBetterSku } = require("../utils/sku");
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

// Treat u:* as synthetic (URL-hash fallback) and eligible for repair.
function isSyntheticSku(sku) {
  const s = String(sku || "").trim();
  return !s || /^u:/i.test(s);
}

// If SKU is <6 chars, namespace it (per your request) to reduce collisions.
// Also: DO NOT run numeric SKUs through normalizeCspc (some normalizers hash arbitrary strings).
function normalizeTudorSku(rawSku) {
  const s = String(rawSku || "").trim();
  if (!s) return "";

  if (/^id:/i.test(s)) return s;
  if (/^u:/i.test(s)) return s;

  // numeric SKU like 67433
  if (/^\d+$/.test(s)) {
    return s.length < 6 ? `id:${s}` : s;
  }

  // short alnum SKU -> namespace
  if (s.length < 6) return `id:${s}`;

  // for other formats, keep your existing normalization
  // (if normalizeCspc returns empty, fall back to the raw string)
  return normalizeCspc(s) || s;
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

function pickAnySkuFromProduct(p) {
  const vs = Array.isArray(p?.variants) ? p.variants : [];
  for (const v of vs) {
    const s = String(v?.sku || "").trim();
    if (s) return s;
  }
  return "";
}

function pickInStockVariantWithFallback(p) {
  const vs = Array.isArray(p?.variants) ? p.variants : [];
  const inStock = vs.find((v) => Number(v?.quantity) > 0);
  return inStock || vs[0] || null;
}

/* ---------------- GraphQL ---------------- */

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

/* ---------------- GQL queries ---------------- */

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
      sortBy: $sortBy,
      sortOrder: $sortOrder,
      priceMin: $priceMin,
      priceMax: $priceMax,
      quantityMin: $quantityMin,
      regions: $regions,
      brandValue: $brandValue,
      searchValue: $searchValue,
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

// ONLY for limited image supplementation (within a small budget)
const PRODUCTS_BY_SKU_QUERY = `
  query(
    $sku: String!,
    $storeId: String
  ) {
    productsBySku(
      sku: $sku,
      storeId: $storeId
    ) {
      items {
        id
        slug
        imageIds
        posImages
        customImages
        gulpImages
        variants { id image price quantity sku deposit }
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

/* ---------------- GQL bySku helper (image-only within budget) ---------------- */

async function fetchProductBySku(ctx, sku) {
  const s = String(sku || "").trim();
  if (!s) return null;

  if (!ctx._tudorSkuCache) ctx._tudorSkuCache = new Map();
  if (ctx._tudorSkuCache.has(s)) return ctx._tudorSkuCache.get(s);

  const r = await tudorGql(ctx, `tudor:gql:bySku:${ctx.cat.key}:${s}`, PRODUCTS_BY_SKU_QUERY, {
    sku: s,
    storeId: STORE_ID,
  });

  let out = null;
  if (r?.status === 200 && r?.json?.data?.productsBySku?.items?.length) {
    out = r.json.data.productsBySku.items[0] || null;
  }

  ctx._tudorSkuCache.set(s, out);
  return out;
}

async function supplementImageFromSku(ctx, skuProbe) {
  const prod = await fetchProductBySku(ctx, skuProbe);
  if (!prod) return null;

  const v = pickInStockVariantWithFallback(prod);
  const img = normalizeAbsUrl(
    firstNonEmptyStr(v?.image, prod?.gulpImages, prod?.posImages, prod?.customImages, prod?.imageIds)
  );

  return img ? { img } : null;
}

/* ---------------- HTML product page fallback (SKU + optional image) ---------------- */

// Budgets (per category run). Override via ctx.config.tudorHtmlBudget / ctx.config.tudorGqlBudget.
const DETAIL_HTML_BUDGET_DEFAULT = 200;
const DETAIL_GQL_BUDGET_DEFAULT = 10;

function parseSkuFromHtml(html) {
  const s = String(html || "");

  // 1) Visible block: <div class="sku ...">SKU: 67433</div>
  const m1 =
    s.match(/>\s*SKU:\s*([A-Za-z0-9._-]+)\s*</i) ||
    s.match(/\bSKU:\s*([A-Za-z0-9._-]+)\b/i);
  if (m1 && m1[1]) return String(m1[1]).trim();

  // 2) Embedded SAPPER preloaded JSON has variants with `"sku":"67433"`
  const m2 = s.match(/"sku"\s*:\s*"([^"]+)"/i);
  return m2 && m2[1] ? String(m2[1]).trim() : "";
}

function parseOgImageFromHtml(html) {
  const s = String(html || "");
  const m =
    s.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    s.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  return m ? String(m[1] || "").trim() : "";
}

async function tudorFetchHtml(ctx, label, url) {
  // Use ctx.http so pacing/throttle is respected.
  if (ctx?.http?.fetchTextWithRetry) {
    return await ctx.http.fetchTextWithRetry(url, label, ctx.store.ua, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Referer: `${BASE}/`,
      },
    });
  }

  // Best-effort fallback if your wrapper has a generic fetchWithRetry.
  if (ctx?.http?.fetchWithRetry) {
    const r = await ctx.http.fetchWithRetry(url, label, ctx.store.ua, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        Referer: `${BASE}/`,
      },
    });

    const body = r?.text ?? r?.body ?? r?.data ?? "";
    const text =
      typeof body === "string"
        ? body
        : Buffer.isBuffer(body)
          ? body.toString("utf8")
          : body && typeof body === "object" && typeof body.toString === "function"
            ? body.toString()
            : "";

    return { status: r?.status, text, bytes: r?.bytes, ms: r?.ms };
  }

  throw new Error("No HTML fetch method available on ctx.http (need fetchTextWithRetry or fetchWithRetry).");
}

async function tudorDetailFromProductPage(ctx, url) {
  if (!ctx._tudorHtmlCache) ctx._tudorHtmlCache = new Map();
  if (ctx._tudorHtmlCache.has(url)) return ctx._tudorHtmlCache.get(url);

  let out = null;
  try {
    const r = await tudorFetchHtml(ctx, `tudor:html:${ctx.cat.key}`, url);
    if (r?.status === 200 && typeof r?.text === "string" && r.text.length) {
      const rawSku = parseSkuFromHtml(r.text);
      const sku = normalizeTudorSku(rawSku);
      const img = normalizeAbsUrl(parseOgImageFromHtml(r.text));
      out = { sku, img };
    }
  } catch {
    out = null;
  }

  ctx._tudorHtmlCache.set(url, out);
  return out;
}

/* ---------------- item builder (fast, no extra calls) ---------------- */

function tudorItemFromProductFast(p, ctx) {
  if (!p) return null;

  const name = cleanText(p?.name || "");
  const slug = String(p?.slug || "").trim();
  if (!name || !slug) return null;

  const v = tudorPickVariant(p);
  if (v && Number(v?.quantity) <= 0) return null; // only keep in-stock

  const url = tudorProductUrl(ctx, slug);
  const price = money(v?.price ?? p?.priceFrom ?? p?.priceTo);

  const skuRaw = String(v?.sku || "").trim() || pickAnySkuFromProduct(p);
  const sku = normalizeTudorSku(skuRaw);

  const img = normalizeAbsUrl(
    firstNonEmptyStr(v?.image, p?.gulpImages, p?.posImages, p?.customImages, p?.imageIds)
  );

  return { name, price, url, sku, img, _skuProbe: skuRaw };
}

/* ---------------- repair (second pass, budgeted) ---------------- */

async function tudorRepairItem(ctx, it) {
  // 1) Missing or synthetic SKU -> HTML product page (fastest path to real SKU)
  if (isSyntheticSku(it.sku)) {
    const d = await tudorDetailFromProductPage(ctx, it.url);
    if (d?.sku && !isSyntheticSku(d.sku)) it.sku = d.sku;
    if (!it.img && d?.img) it.img = d.img;
  }

  // 2) Missing image -> if we have a sku probe, do limited productsBySku
  if (!it.img) {
    const skuProbe = String(it._skuProbe || "").trim();
    if (skuProbe) {
      const supp = await supplementImageFromSku(ctx, skuProbe);
      if (supp?.img) it.img = supp.img;
    }
  }

  // Final fallback ONLY after repair attempts (stability)
  if (isSyntheticSku(it.sku)) it.sku = normalizeCspc(it.url) || "";

  return it;
}

/* ---------------- scanner ---------------- */

async function scanCategoryTudor(ctx, prevDb, report) {
  const t0 = Date.now();
  const discovered = new Map();

  const maxPages = ctx.config.maxPages === null ? 500 : Math.min(ctx.config.maxPages, 500);
  let cursor = null;
  let done = 0;

  const needsDetail = [];

  for (let page = 1; page <= maxPages; page++) {
    const tPage = Date.now();

    const prod = await fetchProductsPage(ctx, cursor);
    const arr = Array.isArray(prod?.items) ? prod.items : [];

    let kept = 0;
    for (const p of arr) {
      const it = tudorItemFromProductFast(p, ctx);
      if (!it) continue;

      // NEW: seed from cached DB to avoid repeating detail HTML
      const prev = prevDb?.byUrl?.get(it.url) || null;
      if (prev) {
        it.sku = pickBetterSku(it.sku, prev.sku);
        if (!it.img && prev.img) it.img = prev.img;
      }

      // queue only; do not do detail calls inline
      if (isSyntheticSku(it.sku) || !it.img) needsDetail.push(it);

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

  // second pass: repair with budgets
  const htmlBudget = Number.isFinite(ctx.config.tudorHtmlBudget)
    ? ctx.config.tudorHtmlBudget
    : DETAIL_HTML_BUDGET_DEFAULT;

  const gqlBudget = Number.isFinite(ctx.config.tudorGqlBudget)
    ? ctx.config.tudorGqlBudget
    : DETAIL_GQL_BUDGET_DEFAULT;

  let htmlUsed = 0;
  let gqlUsed = 0;

  for (const it of needsDetail) {
    const wantsHtml = isSyntheticSku(it.sku);
    const wantsGql = !it.img && String(it._skuProbe || "").trim();

    // enforce caps
    if (wantsHtml && htmlUsed >= htmlBudget && (!wantsGql || gqlUsed >= gqlBudget)) continue;
    if (wantsGql && gqlUsed >= gqlBudget && (!wantsHtml || htmlUsed >= htmlBudget)) continue;

    // count budgets pessimistically
    if (wantsHtml) htmlUsed++;
    if (wantsGql) gqlUsed++;

    await tudorRepairItem(ctx, it);
    discovered.set(it.url, it);
  }

  ctx.logger.ok(
    `${ctx.catPrefixOut} | Unique products: ${discovered.size} | detail(html=${htmlUsed}/${htmlBudget}, gql=${gqlUsed}/${gqlBudget})`
  );

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
