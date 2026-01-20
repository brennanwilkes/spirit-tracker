"use strict";

const { cleanText } = require("../utils/html");
const { normalizeCspc } = require("../utils/sku");
const { padLeft, padRight } = require("../utils/string");
const { humanBytes } = require("../utils/bytes");

const { mergeDiscoveredIntoDb } = require("../tracker/merge");
const { buildDbObject, writeJsonAtomic } = require("../tracker/db");
const { addCategoryResultToReport } = require("../tracker/report");

const BSW_ALGOLIA_APP_ID = "25TO6MPUL0";
const BSW_ALGOLIA_API_KEY = "1aa0c19fe6a0931340570bd358c2c9d2";
const BSW_ALGOLIA_URL = `https://${BSW_ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;

function usd(n) {
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bswExtractCollectionIdFromHtml(html) {
  const s = String(html || "");
  const patterns = [
    /collection_ids%3A(\d{6,})/i,
    /collection_ids\s*:\s*(\d{6,})/i,
    /"collection_ids"\s*:\s*(\d{6,})/i,
    /"collection_id"\s*:\s*(\d{6,})/i,
    /collection_id\s*=\s*(\d{6,})/i,
    /collectionId["']?\s*[:=]\s*["']?(\d{6,})/i,
    /data-collection-id=["'](\d{6,})["']/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return Number.parseInt(m[1], 10);
  }
  return null;
}

function bswFormatPrice(value, hintCents) {
  if (value === null || value === undefined) return "";

  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return "";
    if (t.includes("$")) return t.replace(/\s+/g, "");
    const n = Number(t.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n)) return t;
    return usd(n);
  }

  if (typeof value === "number") {
    let n = value;

    if (hintCents) n = n / 100;
    else if (Number.isInteger(n) && n >= 100000) n = n / 100;

    return usd(n);
  }

  return "";
}

function bswPickPrice(hit) {
  const pick = (val, cents) => ({ val, cents });

  if (hit && hit.price_cents != null) return pick(hit.price_cents, true);
  if (hit && hit.compare_at_price_cents != null) return pick(hit.compare_at_price_cents, true);

  if (hit && hit.price != null) return pick(hit.price, false);
  if (hit && hit.price_min != null) return pick(hit.price_min, false);
  if (hit && hit.priceMin != null) return pick(hit.priceMin, false);
  if (hit && hit.min_price != null) return pick(hit.min_price, false);
  if (hit && hit.variants_min_price != null) return pick(hit.variants_min_price, false);

  if (hit && hit.variants && Array.isArray(hit.variants) && hit.variants[0]) {
    const v = hit.variants[0];
    if (v.price_cents != null) return pick(v.price_cents, true);
    if (v.compare_at_price_cents != null) return pick(v.compare_at_price_cents, true);
    if (v.price != null) return pick(v.price, false);
  }

  return pick(null, false);
}


function bswHitToItem(hit) {
  const name = cleanText(hit && (hit.title || hit.name || hit.product_title || hit.product_name || ""));
  const handle = hit && (hit.handle || hit.product_handle || hit.slug || "");
  const url =
    (hit && (hit.url || hit.product_url)) ||
    (handle ? `https://www.bswliquor.com/products/${String(handle).replace(/^\/+/, "")}` : "");

  const { val: priceVal, cents: hintCents } = bswPickPrice(hit);
  const price = bswFormatPrice(priceVal, hintCents);

  const sku = normalizeCspc(hit?.sku || hit?.SKU || hit?.cspc || hit?.CSPC || "");

  const img = bswPickImage(hit);

  if (!name || !url) return null;
  return { name, price, url, sku, img };
}

async function bswFetchAlgoliaPage(ctx, collectionId, ruleContext, page0, hitsPerPage) {
  const filtersExpr = `collection_ids:${collectionId} AND (inventory_available:"true")`;

  const params =
    `facets=%5B%22price%22%2C%22*%22%5D` +
    `&filters=${encodeURIComponent(filtersExpr)}` +
    `&hitsPerPage=${encodeURIComponent(String(hitsPerPage))}` +
    `&page=${encodeURIComponent(String(page0))}` +
    `&query=` +
    `&clickAnalytics=true` +
    `&maxValuesPerFacet=100` +
    (ruleContext ? `&ruleContexts=${encodeURIComponent(String(ruleContext))}` : "");

  const bodyObj = { requests: [{ indexName: "shopify_products", params }] };

  return await ctx.http.fetchJsonWithRetry(BSW_ALGOLIA_URL, `algolia:${ctx.cat.key}:p${page0}`, ctx.store.ua, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      Origin: "https://www.bswliquor.com",
      Referer: "https://www.bswliquor.com/",
      "x-algolia-api-key": BSW_ALGOLIA_API_KEY,
      "x-algolia-application-id": BSW_ALGOLIA_APP_ID,
    },
    body: JSON.stringify(bodyObj),
  });
}

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

function bswNormalizeAbsUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s, "https://www.bswliquor.com/").toString();
  } catch {
    return s;
  }
}

function bswNormalizeImg(v) {
  if (!v) return "";
  if (typeof v === "string") return bswNormalizeAbsUrl(v);
  if (typeof v === "object") {
    const cands = [
      v.src,
      v.url,
      v.originalSrc,
      v.original_src,
      v.original,
      v.secure_url,
      v.large,
      v.medium,
      v.small,
    ];
    for (const c of cands) {
      if (typeof c === "string" && c.trim()) return bswNormalizeAbsUrl(c);
    }
  }
  return "";
}

function bswPickImage(hit) {
  const cands = [
    hit?.image,
    hit?.image_url,
    hit?.imageUrl,
    hit?.imageURL,
    hit?.featured_image,
    hit?.featured_image_url,
    hit?.featuredImage,
    hit?.featuredImageUrl,
    hit?.product_image,
    hit?.product_image_url,
    hit?.productImage,
    hit?.productImageUrl,
    hit?.thumbnail,
    hit?.thumbnail_url,
    hit?.thumbnailUrl,
  ];

  for (const c of cands) {
    const s = bswNormalizeImg(c);
    if (s) return s;
  }

  if (Array.isArray(hit?.images)) {
    for (const im of hit.images) {
      const s = bswNormalizeImg(im);
      if (s) return s;
    }
  }

  if (Array.isArray(hit?.media)) {
    for (const im of hit.media) {
      const s = bswNormalizeImg(im);
      if (s) return s;
    }
  }

  return "";
}


async function scanCategoryBSWAlgolia(ctx, prevDb, report) {
  const t0 = Date.now();

  let collectionId = Number.isFinite(ctx.cat.bswCollectionId) ? ctx.cat.bswCollectionId : null;
  if (!collectionId) {
    try {
      const { text: html } = await ctx.http.fetchTextWithRetry(ctx.cat.startUrl, `bsw:html:${ctx.cat.key}`, ctx.store.ua);
      collectionId = bswExtractCollectionIdFromHtml(html);
      if (collectionId) ctx.logger.ok(`${ctx.catPrefixOut} | BSW discovered collectionId=${collectionId}`);
      else ctx.logger.warn(`${ctx.catPrefixOut} | BSW could not discover collectionId from HTML.`);
    } catch (e) {
      ctx.logger.warn(`${ctx.catPrefixOut} | BSW HTML fetch failed for collectionId discovery: ${e?.message || e}`);
    }
  }

  if (!collectionId) {
    ctx.logger.warn(`${ctx.catPrefixOut} | BSW missing collectionId; defaulting to 1 page with 0 items.`);

    const discovered = new Map();
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

  const ruleContext = ctx.cat.bswRuleContext || "";
  const hitsPerPage = 50;

  const first = await bswFetchAlgoliaPage(ctx, collectionId, ruleContext, 0, hitsPerPage);
  const result0 = first?.json?.results?.[0] || null;
  const nbPages = result0 && Number.isFinite(result0.nbPages) ? result0.nbPages : 1;

  const totalPages = Math.max(1, nbPages);
  const scanPages = ctx.config.maxPages === null ? totalPages : Math.min(ctx.config.maxPages, totalPages);
  ctx.logger.ok(`${ctx.catPrefixOut} | Pages: ${scanPages}${scanPages !== totalPages ? ` (cap from ${totalPages})` : ""}`);

  const pageIdxs = [];
  for (let p = 0; p < scanPages; p++) pageIdxs.push(p);

  let donePages = 0;

  const perPageItems = await require("../utils/async").parallelMapStaggered(pageIdxs, ctx.config.concurrency, ctx.config.staggerMs, async (page0, idx) => {
    const pnum = idx + 1;
    const r = page0 === 0 ? first : await bswFetchAlgoliaPage(ctx, collectionId, ruleContext, page0, hitsPerPage);

    const res0 = r?.json?.results?.[0] || null;
    const hits = res0 && Array.isArray(res0.hits) ? res0.hits : [];

    const items = [];
    for (const h of hits) {
      const it = bswHitToItem(h);
      if (it) items.push(it);
    }

    donePages++;
    ctx.logger.ok(
      `${ctx.catPrefixOut} | Page ${pageStr(pnum, pageIdxs.length)} | ${String(r.status || "").padEnd(3)} | ${pctStr(donePages, pageIdxs.length)} | items=${padLeft(
        items.length,
        3
      )} | bytes=${kbStr(r.bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`
    );

    return items;
  });

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
    key: "bsw",
    name: "BSW",
    host: "www.bswliquor.com",
    ua: defaultUa,
    scanCategory: scanCategoryBSWAlgolia,
    categories: [
      {
        key: "scotch-whisky",
        label: "Scotch Whisky",
        startUrl: "https://www.bswliquor.com/collections/scotch-whisky?page=1",
        bswRuleContext: "scotch-whisky",
      },
      {
        key: "rum",
        label: "Rum",
        startUrl: "https://www.bswliquor.com/collections/rum?page=1",
        bswRuleContext: "rum",
      },
    ],
  };
}

module.exports = { createStore };
