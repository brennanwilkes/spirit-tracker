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
  const t = Math.round(s * 10) / 10;
  return (t < 10 ? `${t.toFixed(1)}s` : `${Math.round(s)}s`).padStart(7, " ");
}
function pageStr(i, total) {
  const w = String(total).length;
  return `${padLeft(i, w)}/${total}`;
}
function pctStr(done, total) {
  const pct = total ? Math.floor((done / total) * 100) : 0;
  return `${padLeft(pct, 3)}%`;
}

const BASE = "https://shop.vintagespirits.ca";
const SHOP_ID = "679-320"; // from your curl; can be made dynamic later
const IMG_BASE = "https://s.barnetnetwork.com/img/m/";

function asMoneyFromApi(it) {
  // prefer explicit sale price when present
  const sale = Number(it?.sale_price);
  const regular = Number(it?.regular_price);
  const net = Number(it?.net_price);

  const n =
    (Number.isFinite(sale) && sale > 0 ? sale : NaN) ||
    (Number.isFinite(net) && net > 0 ? net : NaN) ||
    (Number.isFinite(regular) && regular > 0 ? regular : NaN);

  if (!Number.isFinite(n)) return "";
  return `$${n.toFixed(2)}`;
}

function imgUrlFromApi(it) {
  const p = String(it?.image || "").trim();
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith("//")) return `https:${p}`;
  // API provides "custom/goods/..."
  return `${IMG_BASE}${p.replace(/^\/+/, "")}`;
}

function vintageItemFromApi(it) {
  if (!it) return null;

  // stock gate
  if (!it.available_for_sale) return null;
  const onHand = Number(it.on_hand);
  if (Number.isFinite(onHand) && onHand <= 0) return null;

  const url = String(it.url || "").trim();
  const name = String(it.description || "").trim();
  if (!url || !name) return null;

  const sku = normalizeCspc(it.cspcid || "");
  const price = asMoneyFromApi(it);
  const img = imgUrlFromApi(it);

  return { name, price, url, sku, img };
}

function makeApiUrl(cat, page) {
  const u = new URL(`${BASE}/api/shop/${SHOP_ID}/products`);
  u.searchParams.set("p", String(page));
  u.searchParams.set("show_on_web", "true");
  u.searchParams.set("sort_by", "desc");
  u.searchParams.set("category", cat.vsCategory); // e.g. "40 SPIRITS"
  u.searchParams.set("sub_category", cat.vsSubCategory); // e.g. "RUM"
  u.searchParams.set("varital_name", "");
  u.searchParams.set("no_item_found", "No item found.");
  u.searchParams.set("avail_for_sale", "false");
  u.searchParams.set("_dc", String(Math.floor(Math.random() * 1e10)));
  return u.toString();
}

async function fetchVintagePage(ctx, page) {
  const url = makeApiUrl(ctx.cat, page);
  return await ctx.http.fetchJsonWithRetry(url, `vintage:api:${ctx.cat.key}:p${page}`, ctx.store.ua, {
    method: "GET",
    headers: {
      Accept: "*/*",
      Referer: ctx.cat.startUrl,
      Origin: BASE,
    },
    // cookies not required in my testing; enable if you hit 403/empty
    cookies: true,
  });
}

async function scanCategoryVintageApi(ctx, prevDb, report) {
  const t0 = Date.now();

  let first;
  try {
    first = await fetchVintagePage(ctx, 1);
  } catch (e) {
    ctx.logger.warn(`${ctx.catPrefixOut} | Vintage API fetch failed: ${e?.message || e}`);

    const discovered = new Map();
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

  const totalPages = Math.max(1, Number(first?.json?.paginator?.pages) || 1);
  const scanPages = ctx.config.maxPages === null ? totalPages : Math.min(ctx.config.maxPages, totalPages);

  ctx.logger.ok(
    `${ctx.catPrefixOut} | Pages: ${scanPages}${scanPages !== totalPages ? ` (cap from ${totalPages})` : ""}`
  );

  const pages = [];
  for (let p = 1; p <= scanPages; p++) pages.push(p);

  let donePages = 0;

  const perPageItems = await require("../utils/async").parallelMapStaggered(
    pages,
    ctx.config.concurrency,
    ctx.config.staggerMs,
    async (page, idx) => {
      const r = page === 1 ? first : await fetchVintagePage(ctx, page);
      const arr = Array.isArray(r?.json?.items) ? r.json.items : [];

      const items = [];
      for (const raw of arr) {
        const it = vintageItemFromApi(raw);
        if (it) items.push(it);
      }

      donePages++;
      ctx.logger.ok(
        `${ctx.catPrefixOut} | Page ${pageStr(idx + 1, pages.length)} | ${String(r.status || "").padEnd(
          3
        )} | ${pctStr(donePages, pages.length)} | items=${padLeft(items.length, 3)} | bytes=${kbStr(
          r.bytes
        )} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`
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

  const { merged, newItems, updatedItems, removedItems, restoredItems } = mergeDiscoveredIntoDb(prevDb, discovered, {
    storeLabel: ctx.store.name,
  });

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
    key: "vintage",
    name: "Vintage Spirits",
    host: "shop.vintagespirits.ca",
    ua: defaultUa,
    scanCategory: scanCategoryVintageApi,
    categories: [
      {
        key: "whisky-whiskey",
        label: "Whisky & Whiskey",
        startUrl: "https://shop.vintagespirits.ca/products?category=40+SPIRITS&sub_category=WHISKY+%26+WHISKEY",
        vsCategory: "40 SPIRITS",
        vsSubCategory: "WHISKY & WHISKEY",
      },
      {
        key: "single-malt-whisky",
        label: "Single Malt Whisky",
        startUrl: "https://shop.vintagespirits.ca/products?category=40+SPIRITS&sub_category=SINGLE+MALT+WHISKY",
        vsCategory: "40 SPIRITS",
        vsSubCategory: "SINGLE MALT WHISKY",
      },
      {
        key: "rum",
        label: "Rum",
        startUrl: "https://shop.vintagespirits.ca/products?category=40+SPIRITS&sub_category=RUM",
        vsCategory: "40 SPIRITS",
        vsSubCategory: "RUM",
      },
    ],
  };
}

module.exports = { createStore };
