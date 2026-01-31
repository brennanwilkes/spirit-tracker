// src/stores/craftcellars.js
"use strict";

const { setTimeout: sleep } = require("timers/promises");

const { decodeHtml, stripTags, extractFirstImgUrl } = require("../utils/html");
const { sanitizeName } = require("../utils/text");
const { normalizeCspc, pickBetterSku, needsSkuDetail } = require("../utils/sku");
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
  const dollars = (txt) =>
    [...String(txt).matchAll(/\$\s*[\d,]+(?:\.\d{2})?/g)].map((m) =>
      m[0].replace(/\s+/g, "")
    );

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

  const g1 =
    s.match(
      /<div\b[^>]*id=["']ProductGridContainer["'][^>]*>[\s\S]*?<\/div>/i
    )?.[0] || "";
  const g2 =
    s.match(
      /<div\b[^>]*id=["']product-grid["'][^>]*>[\s\S]*?<\/div>/i
    )?.[0] || "";

  const gridCandidate = g1.length > g2.length ? g1 : g2;
  const grid = /\/products\//i.test(gridCandidate) ? gridCandidate : s;

  return parseProductsCraftCellarsInner(grid, ctx);
}

function parseProductsCraftCellarsInner(html, ctx) {
  const s = String(html || "");
  const items = [];

  let blocks = [...s.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)].map(
    (m) => m[0]
  );
  if (blocks.length < 5) {
    blocks = [
      ...s.matchAll(
        /<div\b[^>]*class=["'][^"']*\bcard\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi
      ),
    ].map((m) => m[0]);
  }

  const base = `https://${(ctx && ctx.store && ctx.store.host) || "craftcellars.ca"}/`;

  for (const block of blocks) {
    const href =
      block.match(
        /<a\b[^>]*href=["']([^"']*\/products\/[^"']+)["']/i
      )?.[1] ||
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
      block.match(
        /<a\b[^>]*href=["'][^"']*\/products\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i
      )?.[1];

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
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function cfgNum(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/* ---------- NEW: product page SKU extractor ---------- */
function extractCraftSkuFromProductPageHtml(html) {
  const s = String(html || "");

  const m =
    s.match(
      /<strong>\s*SKU:\s*<\/strong>\s*<span>\s*([^<]{1,80}?)\s*<\/span>/i
    ) ||
    s.match(/\bSKU:\s*<\/strong>\s*<span>\s*([^<]{1,80}?)\s*<\/span>/i) ||
    s.match(/\bSKU:\s*([A-Za-z0-9][A-Za-z0-9\-_/ ]{0,40})/i);

  const raw = m && m[1] ? stripTags(decodeHtml(m[1])) : "";
  return normalizeCspc(raw);
}

/**
 * Craft Cellars:
 * - HTML listing with ?filter.v.availability=1 is the allowlist
 * - products.json enriches SKU/price
 * - product page HTML is final SKU fallback
 */
async function scanCategoryCraftCellars(ctx, prevDb, report) {
  const t0 = Date.now();

  const perPageDelayMs =
    Math.max(
      0,
      cfgNum(ctx?.cat?.pageStaggerMs, cfgNum(ctx?.cat?.discoveryDelayMs, 0))
    ) || 0;

  const perJsonPageDelayMs = Math.max(
    0,
    cfgNum(ctx?.cat?.jsonPageDelayMs, perPageDelayMs)
  );

  const htmlMap = new Map();

  const maxPages =
    ctx.config.maxPages === null
      ? 200
      : Math.min(ctx.config.maxPages, 200);

  let htmlPagesFetched = 0;
  let emptyStreak = 0;

  for (let p = 1; p <= maxPages; p++) {
    if (p > 1 && perPageDelayMs > 0) await sleep(perPageDelayMs);

    const pageUrl = makePageUrlShopifyQueryPage(ctx.cat.startUrl, p);
    const { text: html } = await ctx.http.fetchTextWithRetry(
      pageUrl,
      `craft:html:${ctx.cat.key}:p${p}`,
      ctx.store.ua
    );
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
      htmlMap.set(url, {
        name: it.name || "",
        price: it.price || "",
        url,
        img: it.img || "",
      });
    }
  }

  if (!htmlMap.size) {
    ctx.logger.warn(
      `${ctx.catPrefixOut} | HTML listing returned 0 items; refusing JSON-only discovery`
    );
  }

  const jsonMap = new Map();

  if (htmlMap.size) {
    const start = new URL(ctx.cat.startUrl);
    const m = start.pathname.match(/^\/collections\/([^/]+)/i);
    if (!m)
      throw new Error(
        `CraftCellars: couldn't extract collection handle from ${ctx.cat.startUrl}`
      );
    const collectionHandle = m[1];

    const limit = 250;
    let jsonPage = 1;
    let jsonPagesFetched = 0;

    while (true) {
      if (jsonPage > 1 && perJsonPageDelayMs > 0)
        await sleep(perJsonPageDelayMs);

      const url = `https://${ctx.store.host}/collections/${collectionHandle}/products.json?limit=${limit}&page=${jsonPage}`;
      const r = await ctx.http.fetchJsonWithRetry(
        url,
        `craft:coljson:${ctx.cat.key}:p${jsonPage}`,
        ctx.store.ua
      );

      const products = Array.isArray(r?.json?.products)
        ? r.json.products
        : [];
      jsonPagesFetched++;

      if (!products.length) break;

      for (const p of products) {
        const handle = String(p?.handle || "");
        if (!handle) continue;

        const prodUrl = canonicalizeCraftProductUrl(
          `https://${ctx.store.host}/products/${handle}`
        );
        if (!htmlMap.has(prodUrl)) continue;

        const variants = Array.isArray(p?.variants) ? p.variants : [];
        const v =
          variants.find((x) => x && x.available === true) ||
          variants[0] ||
          null;

        const sku = normalizeCspc(v?.sku || "");
        const price = v?.price ? usdFromShopifyPriceStr(v.price) : "";

        let img = "";
        const images = Array.isArray(p?.images) ? p.images : [];
        if (images[0]) {
          img =
            typeof images[0] === "string"
              ? images[0]
              : String(images[0]?.src || images[0]?.url || "");
        }
        if (!img && p?.image)
          img = String(p.image?.src || p.image?.url || p.image || "");
        img = String(img || "").trim();
        if (img.startsWith("//")) img = `https:${img}`;

        jsonMap.set(prodUrl, { sku, price, img });
      }

      if (products.length < limit) break;
      if (++jsonPage > 200) break;
    }

    ctx.logger.ok(
      `${ctx.catPrefixOut} | HTML pages=${htmlPagesFetched} JSON pages=${jsonPagesFetched}`
    );
  }

  const discovered = new Map();
  for (const [url, it] of htmlMap.entries()) {
    const j = jsonMap.get(url);
    const prev = prevDb?.byUrl?.get(url) || null;

    discovered.set(url, {
      name: it.name,
      price: j?.price || it.price || "",
      url,
      // reuse cached SKU unless we found something better this run
      sku: pickBetterSku(j?.sku || "", prev?.sku || ""),
      // reuse cached image if we didn't find one
      img: (j?.img || it.img || prev?.img || ""),
    });
  }

  /* ---------- NEW: product page SKU fallback (cached; only when needed) ---------- */
  const perProductSkuDelayMs = Math.max(
    0,
    cfgNum(
      ctx?.cat?.skuPageDelayMs,
      cfgNum(ctx?.cat?.jsonPageDelayMs, perPageDelayMs)
    )
  );

  let skuPagesFetched = 0;

  for (const it of discovered.values()) {
    // only hit product pages when missing/synthetic
    if (!needsSkuDetail(it.sku)) continue;

    if (perProductSkuDelayMs > 0) await sleep(perProductSkuDelayMs);

    try {
      const { text } = await ctx.http.fetchTextWithRetry(
        it.url,
        `craft:prodpage:${ctx.cat.key}:${Buffer.from(it.url)
          .toString("base64")
          .slice(0, 24)}`,
        ctx.store.ua
      );
      skuPagesFetched++;

      const sku = extractCraftSkuFromProductPageHtml(text);
      if (sku) it.sku = sku;
    } catch {
      /* best effort */
    }
  }

  ctx.logger.ok(
    `${ctx.catPrefixOut} | SKU fallback pages=${skuPagesFetched}`
  );

  ctx.logger.ok(
    `${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`
  );

  const {
    merged,
    newItems,
    updatedItems,
    removedItems,
    restoredItems,
  } = mergeDiscoveredIntoDb(prevDb, discovered, {
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

  addCategoryResultToReport(
    report,
    ctx.store.name,
    ctx.cat.label,
    newItems,
    updatedItems,
    removedItems,
    restoredItems
  );
}

function createStore(defaultUa) {
  return {
    key: "craftcellars",
    name: "Craft Cellars",
    host: "craftcellars.ca",
    ua: defaultUa,

    scanCategory: scanCategoryCraftCellars,

    parseProducts: parseProductsCraftCellars,
    makePageUrl: makePageUrlShopifyQueryPage,
    isEmptyListingPage: craftCellarsIsEmptyListingPage,

    categories: [
      {
        key: "whisky",
        label: "Whisky",
        startUrl:
          "https://craftcellars.ca/collections/whisky?filter.v.availability=1",
        pageConcurrency: 1,
        pageStaggerMs: 10000,
        discoveryDelayMs: 10000,
        skuPageDelayMs: 12000,
      },
      {
        key: "rum",
        label: "Rum",
        startUrl:
          "https://craftcellars.ca/collections/rum?filter.v.availability=1",
        pageConcurrency: 1,
        pageStaggerMs: 10000,
        discoveryDelayMs: 10000,
        skuPageDelayMs: 12000,
      },
    ],
  };
}

module.exports = { createStore };
