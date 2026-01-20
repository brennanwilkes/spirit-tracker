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

function asNumber(n) {
  if (n == null) return NaN;
  if (typeof n === "number") return n;
  const t = String(n).trim();
  if (!t) return NaN;
  const x = Number(t.replace(/[^0-9.]/g, ""));
  return x;
}

function bclTotalHits(json) {
  const t = json?.hits?.total;
  if (typeof t === "number") return t;
  if (t && typeof t.value === "number") return t.value; // ES-style
  return 0;
}

function bclIsInStock(src) {
  const candidates = [
    src?.availability_override,     // <-- add this
    src?.availability,
    src?.availabilityText,
    src?.availabilityStatus,
    src?.availability_status,
    src?.stockStatus,
    src?.stock_status,
    src?.status,
    src?.statusText,
  ]
    .map((v) => (v == null ? "" : String(v)))
    .filter(Boolean);

  for (const s of candidates) {
    if (/out of stock/i.test(s)) return false;
    if (/\bin stock\b/i.test(s)) return true;
    if (/\bavailable\b/i.test(s)) return true; // "Available Feb 07"
  }

  const units = Number(src?.availableUnits);
  if (Number.isFinite(units)) return units > 0;

  return true;
}


function bclNormalizeAbsUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s, "https://www.bcliquorstores.com/").toString();
  } catch {
    return s;
  }
}

function bclPickImage(src) {
  const cands = [
    src?.imageUrl,
    src?.imageURL,
    src?.image,
    src?.thumbnail,
    src?.thumbnailUrl,
    src?.thumbnailURL,
    src?.primaryImage,
    src?.primaryImageUrl,
  ];

  for (const c of cands) {
    if (typeof c === "string" && c.trim()) return bclNormalizeAbsUrl(c);
  }

  const arrs = [src?.images, src?.imageUrls, src?.image_urls];
  for (const a of arrs) {
    if (!Array.isArray(a) || !a.length) continue;
    const v = a[0];
    if (typeof v === "string" && v.trim()) return bclNormalizeAbsUrl(v);
    if (v && typeof v === "object") {
      const s = String(v.src || v.url || "").trim();
      if (s) return bclNormalizeAbsUrl(s);
    }
  }

  return "";
}

function bclHitToItem(hit) {
  const src = hit?._source || null;
  if (!src) return null;

  const skuRaw = src.sku != null ? String(src.sku).trim() : "";
  if (!skuRaw) return null;

  // SKU in URL (requested)
  const url = `https://www.bcliquorstores.com/product/${encodeURIComponent(skuRaw)}`;

  const name = String(src.name || "").trim();
  if (!name) return null;

  // Sale support: pick currentPrice when present; otherwise regularPrice.
  const current = asNumber(src.currentPrice);
  const regular = asNumber(src.regularPrice);
  const price = cad(Number.isFinite(current) ? current : regular);

  const sku = normalizeCspc(url);

  const inStock = bclIsInStock(src);
  if (!inStock) return null;

  // ✅ Fix: BCL appears to serve .jpg (not .jpeg) for these imagecache URLs.
  // Also use https.
  const img = `https://www.bcliquorstores.com/sites/default/files/imagecache/height400px/${encodeURIComponent(
    skuRaw
  )}.jpg`;

  return { name, price, url, sku, img };
}



async function bclFetchBrowsePage(ctx, page1, size) {
  const type = ctx.cat.bclType; // e.g. "rum" or "whisky / whiskey"
  const category = "spirits";
  const sort = "featuredProducts:desc";

  const u = new URL("https://www.bcliquorstores.com/ajax/browse");
  u.searchParams.set("category", category);
  u.searchParams.set("type", type);
  u.searchParams.set("sort", sort);
  u.searchParams.set("size", String(size));
  u.searchParams.set("page", String(page1));

  const referer =
    `https://www.bcliquorstores.com/product-catalogue?` +
    `category=${encodeURIComponent(category)}` +
    `&type=${encodeURIComponent(type)}` +
    `&sort=${encodeURIComponent(sort)}` +
    `&page=${encodeURIComponent(String(page1))}`;

  return await ctx.http.fetchJsonWithRetry(u.toString(), `bcl:${ctx.cat.key}:p${page1}`, ctx.store.ua, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Referer: referer,
      Origin: "https://www.bcliquorstores.com",
    },
  });
}

async function scanCategoryBCLAjax(ctx, prevDb, report) {
  const t0 = Date.now();
  const size = 24;

  let first;
  try {
    first = await bclFetchBrowsePage(ctx, 1, size);
  } catch (e) {
    ctx.logger.warn(`${ctx.catPrefixOut} | BCL browse fetch failed: ${e?.message || e}`);

    const discovered = new Map();
    const { merged, newItems, updatedItems, removedItems, restoredItems } = mergeDiscoveredIntoDb(prevDb, discovered);
    const dbObj = buildDbObject(ctx, merged);
    writeJsonAtomic(ctx.dbFile, dbObj);

    const elapsed = Date.now() - t0;
    report.categories.push({
      store: ctx.store.name,
      label: ctx.cat.label,
      key: ctx.cat.key,
      dbFile: ctx.dbFile,
      scannedPages: 1,
      discoveredUnique: 0,
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
    return;
  }

  const total = bclTotalHits(first?.json);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const scanPages = ctx.config.maxPages === null ? totalPages : Math.min(ctx.config.maxPages, totalPages);

  ctx.logger.ok(`${ctx.catPrefixOut} | Total=${total} Size=${size} Pages: ${scanPages}${scanPages !== totalPages ? ` (cap from ${totalPages})` : ""}`);

  const pageNums = [];
  for (let p = 1; p <= scanPages; p++) pageNums.push(p);

  let donePages = 0;

  const perPageItems = await require("../utils/async").parallelMapStaggered(
    pageNums,
    ctx.config.concurrency,
    ctx.config.staggerMs,
    async (page1, idx) => {
      const r = page1 === 1 ? first : await bclFetchBrowsePage(ctx, page1, size);
      const hits = Array.isArray(r?.json?.hits?.hits) ? r.json.hits.hits : [];

      const items = [];
      for (const h of hits) {
        const it = bclHitToItem(h);
        if (it) items.push(it);
      }

      donePages++;
      ctx.logger.ok(
        `${ctx.catPrefixOut} | Page ${pageStr(idx + 1, pageNums.length)} | ${String(r.status || "").padEnd(3)} | ${pctStr(donePages, pageNums.length)} | items=${padLeft(
          items.length,
          3
        )} | bytes=${kbStr(r.bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`
      );

      return items;
    }
  );

  const discovered = new Map();
  let dups = 0;
  for (const arr of perPageItems) {
    for (const it of arr) {
      if (discovered.has(it.url)) dups++;
      discovered.set(it.url, it);
    }
  }

  ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}${dups ? ` (${dups} dups)` : ""}`);

  const { merged, newItems, updatedItems, removedItems, restoredItems } = mergeDiscoveredIntoDb(prevDb, discovered);

  const dbObj = buildDbObject(ctx, merged);
  writeJsonAtomic(ctx.dbFile, dbObj);

  ctx.logger.ok(`${ctx.catPrefixOut} | DB saved: ${ctx.logger.dim(ctx.dbFile)} (${dbObj.count} items)`);

  const elapsed = Date.now() - t0;
  ctx.logger.ok(
    `${ctx.catPrefixOut} | Done in ${secStr(elapsed)}. New=${newItems.length} Updated=${updatedItems.length} Removed=${removedItems.length} Restored=${restoredItems.length} Total(DB)=${merged.size}`
  );

  report.categories.push({
    store: ctx.store.name,
    label: ctx.cat.label,
    key: ctx.cat.key,
    dbFile: ctx.dbFile,
    scannedPages: scanPages,
    discoveredUnique: discovered.size,
    newCount: newItems.length,
    updatedCount: updatedItems.length,
    removedCount: removedItems.length,
    restoredCount: removedItems.length,
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
    key: "bcl",
    name: "BCL",
    host: "www.bcliquorstores.com",
    ua: defaultUa,
    scanCategory: scanCategoryBCLAjax, // JSON-driven (async browse)
    categories: [
      {
        key: "whisky",
        label: "Whisky / Whiskey",
        // informational only; scan uses ajax/browse
        startUrl: "https://www.bcliquorstores.com/product-catalogue?category=spirits&type=whisky%20/%20whiskey&sort=featuredProducts:desc&page=1",
        bclType: "whisky / whiskey",
      },
      {
        key: "rum",
        label: "Rum",
        startUrl: "https://www.bcliquorstores.com/product-catalogue?category=spirits&type=rum&sort=featuredProducts:desc&page=1",
        bclType: "rum",
      },
    ],
  };
}

module.exports = { createStore };
