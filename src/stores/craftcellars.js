"use strict";

const { decodeHtml, stripTags, extractFirstImgUrl } = require("../utils/html");
const { sanitizeName } = require("../utils/text");
const { normalizeCspc } = require("../utils/sku");
const { makePageUrlShopifyQueryPage } = require("../utils/url");

const { mergeDiscoveredIntoDb } = require("../tracker/merge");
const { buildDbObject, writeJsonAtomic } = require("../tracker/db");
const { addCategoryResultToReport } = require("../tracker/report");

function craftCellarsIsEmptyListingPage(html) {
  const s = String(html || "");
  if (/collection--empty\b/i.test(s)) return true;
  if (/No products found/i.test(s)) return true;
  return false;
}

function canonicalizeCraftProductUrl(raw) {
  try {
    const u = new URL(String(raw));
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return String(raw || "");
  }
}

function extractShopifyCardPrice(block) {
  const b = String(block || "");
  const dollars = (txt) => [...String(txt).matchAll(/\$\s*[\d,]+(?:\.\d{2})?/g)].map((m) => m[0].replace(/\s+/g, ""));

  const saleRegion = b.split(/sale price/i)[1] || "";
  const saleD = dollars(saleRegion);
  if (saleD.length) return saleD[0];

  const regRegion = b.split(/regular price/i)[1] || "";
  const regD = dollars(regRegion);
  if (regD.length) return regD[0];

  const any = dollars(b);
  return any[0] || "";
}

function parseProductsCraftCellars(html, ctx) {
  const s = String(html || "");

  const g1 = s.match(/<div\b[^>]*id=["']ProductGridContainer["'][^>]*>[\s\S]*?<\/div>/i)?.[0] || "";
  const g2 = s.match(/<div\b[^>]*id=["']product-grid["'][^>]*>[\s\S]*?<\/div>/i)?.[0] || "";

  const gridCandidate = g1.length > g2.length ? g1 : g2;
  const grid = /\/products\//i.test(gridCandidate) ? gridCandidate : s;

  return parseProductsCraftCellarsInner(grid, ctx);
}

function parseProductsCraftCellarsInner(html, ctx) {
  const s = String(html || "");
  const items = [];

  let blocks = [...s.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].map((m) => m[0]);
  if (blocks.length < 5) {
    blocks = [...s.matchAll(/<div\b[^>]*class=["'][^"']*\bcard\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi)].map(
      (m) => m[0]
    );
  }

  const base = `https://${(ctx && ctx.store && ctx.store.host) || "craftcellars.ca"}/`;

  for (const block of blocks) {
    const href =
      block.match(/<a\b[^>]*href=["']([^"']*\/products\/[^"']+)["']/i)?.[1] ||
      block.match(/href=["']([^"']*\/products\/[^"']+)["']/i)?.[1];
    if (!href) continue;

    let url = "";
    try {
      url = new URL(decodeHtml(href), base).toString();
    } catch {
      continue;
    }
    url = canonicalizeCraftProductUrl(url);

    const nameHtml =
      block.match(
        /<a\b[^>]*href=["'][^"']*\/products\/[^"']+["'][^>]*>\s*<[^>]*>\s*([^<]{2,200}?)\s*</i
      )?.[1] ||
      block.match(
        /<h[23]\b[^>]*>[\s\S]*?<a\b[^>]*\/products\/[^"']+[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[23]>/i
      )?.[1] ||
      block.match(/<a\b[^>]*href=["'][^"']*\/products\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i)?.[1];

    const name = sanitizeName(stripTags(decodeHtml(nameHtml || "")));
    if (!name) continue;

    const price = extractShopifyCardPrice(block);
    const img = extractFirstImgUrl(block, base);

    items.push({ name, price, url, img });
  }

  const uniq = new Map();
  for (const it of items) uniq.set(it.url, it);
  return [...uniq.values()];
}


function usdFromShopifyPriceStr(s) {
  const n = Number(String(s || "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Craft Cellars:
 * - HTML listing with ?filter.v.availability=1 is the allowlist (prevents OOS leaking in)
 * - Shopify products.json is used only to enrich SKU (and optionally price) for those allowed URLs
 */
async function scanCategoryCraftCellars(ctx, prevDb, report) {
  const t0 = Date.now();

  // 1) HTML scan: allowlist of in-stock listing URLs
  const htmlMap = new Map(); // url -> {name, price, url, img}

  const maxPages = ctx.config.maxPages === null ? 200 : Math.min(ctx.config.maxPages, 200);
  let htmlPagesFetched = 0;
  let emptyStreak = 0;

  for (let p = 1; p <= maxPages; p++) {
    const pageUrl = makePageUrlShopifyQueryPage(ctx.cat.startUrl, p);
    const { text: html } = await ctx.http.fetchTextWithRetry(pageUrl, `craft:html:${ctx.cat.key}:p${p}`, ctx.store.ua);
    htmlPagesFetched++;

    if (craftCellarsIsEmptyListingPage(html)) break;

    const items = parseProductsCraftCellars(html, ctx);
    if (!items.length) {
      emptyStreak++;
      if (emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;

    for (const it of items) {
      const url = canonicalizeCraftProductUrl(it.url);
      if (!url) continue;
      htmlMap.set(url, { name: it.name || "", price: it.price || "", url, img: it.img || "" });
    }
  }

  // If HTML returns nothing, don't let JSON invent a category
  if (!htmlMap.size) {
    ctx.logger.warn(
      `${ctx.catPrefixOut} | HTML listing returned 0 items; refusing to use products.json as source of truth.`
    );
  }

  // 2) JSON scan: build SKU index (but do NOT add new URLs from JSON)
  const jsonMap = new Map(); // url -> { sku, price, img }

  if (htmlMap.size) {
    const start = new URL(ctx.cat.startUrl);
    const m = start.pathname.match(/^\/collections\/([^/]+)/i);
    if (!m) throw new Error(`CraftCellars: couldn't extract collection handle from ${ctx.cat.startUrl}`);
    const collectionHandle = m[1];

    const limit = 250;
    let jsonPage = 1;
    let jsonPagesFetched = 0;

    while (true) {
      const url = `https://${ctx.store.host}/collections/${collectionHandle}/products.json?limit=${limit}&page=${jsonPage}`;
      const r = await ctx.http.fetchJsonWithRetry(url, `craft:coljson:${ctx.cat.key}:p${jsonPage}`, ctx.store.ua);

      const products = Array.isArray(r?.json?.products) ? r.json.products : [];
      jsonPagesFetched++;

      if (!products.length) break;

      for (const p of products) {
        const handle = String(p?.handle || "");
        if (!handle) continue;

        const prodUrl = canonicalizeCraftProductUrl(`https://${ctx.store.host}/products/${handle}`);

        // Only enrich if it's on the HTML allowlist
        if (!htmlMap.has(prodUrl)) continue;

        const variants = Array.isArray(p?.variants) ? p.variants : [];
        const v = variants.find((x) => x && x.available === true) || variants[0] || null;

        const sku = normalizeCspc(v?.sku || "");
        const price = v?.price ? usdFromShopifyPriceStr(v.price) : "";

        // Product image (best effort)
        let img = "";
        const images = Array.isArray(p?.images) ? p.images : [];
        if (images[0]) {
          if (typeof images[0] === "string") img = images[0];
          else img = String(images[0]?.src || images[0]?.url || "");
        }
        if (!img && p?.image) img = String(p.image?.src || p.image?.url || p.image || "");
        img = String(img || "").trim();
        if (img.startsWith("//")) img = `https:${img}`;
        if (img && !/^https?:\/\//i.test(img)) {
          try {
            img = new URL(img, `https://${ctx.store.host}/`).toString();
          } catch {
            // keep as-is
          }
        }

        jsonMap.set(prodUrl, { sku, price, img });
      }

      if (products.length < limit) break;
      jsonPage++;
      if (jsonPage > 200) break; // safety
    }

    ctx.logger.ok(`${ctx.catPrefixOut} | HTML pages=${htmlPagesFetched} JSON pages=${jsonPagesFetched}`);
  } else {
    ctx.logger.ok(`${ctx.catPrefixOut} | HTML pages=${htmlPagesFetched} JSON pages=0`);
  }

  // 3) Final discovered: HTML allowlist, enriched by JSON
  const discovered = new Map();
  for (const [url, it] of htmlMap.entries()) {
    const j = jsonMap.get(url);
    discovered.set(url, {
      name: it.name || "",
      // Prefer JSON price (normalized) when present, else keep HTML price (already formatted)
      price: j?.price || it.price || "",
      url,
      sku: j?.sku || "",
      img: j?.img || it.img || "",
    });
  }

  ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);

  const { merged, newItems, updatedItems, removedItems, restoredItems } = mergeDiscoveredIntoDb(prevDb, discovered);

  const dbObj = buildDbObject(ctx, merged);
  writeJsonAtomic(ctx.dbFile, dbObj);

  ctx.logger.ok(`${ctx.catPrefixOut} | DB saved: ${ctx.logger.dim(ctx.dbFile)} (${dbObj.count} items)`);

  const elapsed = Date.now() - t0;

  report.categories.push({
    store: ctx.store.name,
    label: ctx.cat.label,
    key: ctx.cat.key,
    dbFile: ctx.dbFile,
    scannedPages: htmlPagesFetched,
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
    key: "craftcellars",
    name: "Craft Cellars",
    host: "craftcellars.ca",
    ua: defaultUa,

    // ✅ Custom scan (HTML allowlist + JSON enrichment)
    scanCategory: scanCategoryCraftCellars,

    // Keep HTML parser for debugging
    parseProducts: parseProductsCraftCellars,
    makePageUrl: makePageUrlShopifyQueryPage,
    isEmptyListingPage: craftCellarsIsEmptyListingPage,

    categories: [
      {
        key: "whisky",
        label: "Whisky",
        startUrl: "https://craftcellars.ca/collections/whisky?filter.v.availability=1",
        discoveryStartPage: 10,
      },
      {
        key: "rum",
        label: "Rum",
        startUrl: "https://craftcellars.ca/collections/rum?filter.v.availability=1",
        discoveryStartPage: 5,
      },
    ],
  };
}

module.exports = { createStore };
