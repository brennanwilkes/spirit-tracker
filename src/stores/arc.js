// src/stores/arc.js
"use strict";

const { cleanText } = require("../utils/html");
const { normalizeCspc, normalizeSkuKey } = require("../utils/sku");
const { humanBytes } = require("../utils/bytes");
const { padLeft, padRight } = require("../utils/string");

const { mergeDiscoveredIntoDb } = require("../tracker/merge");
const { buildDbObject, writeJsonAtomic } = require("../tracker/db");
const { addCategoryResultToReport } = require("../tracker/report");

function kbStr(bytes) {
  return humanBytes(bytes || 0).padStart(8, " ");
}

function secStr(ms) {
  const s = Number.isFinite(ms) ? ms / 1000 : 0;
  const tenths = Math.round(s * 10) / 10;
  const out = tenths < 10 ? `${tenths.toFixed(1)}s` : `${Math.round(s)}s`;
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

function toNum(v) {
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function money(v) {
  const n = toNum(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `$${n.toFixed(2)}`;
}

function pickBestPrice(p) {
  const reg = toNum(p?.regular_price);
  const sale = toNum(p?.sale_price);
  const net = toNum(p?.net_price);

  // Prefer sale when it looks real (is_sale OR sale < regular), otherwise net, otherwise regular.
  if (Number.isFinite(sale) && sale > 0) {
    if (p?.is_sale === true) return money(sale);
    if (Number.isFinite(reg) && reg > 0 && sale < reg) return money(sale);
    // Some feeds put the current price in sale_price even without flags:
    if (!Number.isFinite(net) || net <= 0 || sale <= net) return money(sale);
  }

  if (Number.isFinite(net) && net > 0) return money(net);
  if (Number.isFinite(reg) && reg > 0) return money(reg);

  return "";
}

function normAbsUrl(raw, base) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("//")) return `https:${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s.replace(/^\/+/, ""), base).toString();
  } catch {
    return s;
  }
}

function isInStock(p) {
  // Keep this strict: user asked "only show in stock items".
  // available_for_sale is the strongest signal; on_hand is a good secondary signal.
  if (p && p.available_for_sale === false) return false;

  const onHand = Number(p?.on_hand);
  if (Number.isFinite(onHand)) return onHand > 0;

  // If on_hand is missing, fall back to available_for_sale truthiness.
  return Boolean(p?.available_for_sale);
}

function arcNormalizeImg(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
  
    // already public
    if (/^https?:\/\/s\.barnetnetwork\.com\/img\/m\//i.test(s)) return s;
  
    // site-relative -> public CDN
    const noProto = s.replace(/^https?:\/\/[^/]+/i, "");
    const rel = noProto.replace(/^\/+/, "");
  
    // common case: "custom/all/BC398280.png" OR "bc_lrs/000046/0000466854.jpg"
    if (/^(custom\/|bc_lrs\/)/i.test(rel)) {
      return `https://s.barnetnetwork.com/img/m/${rel}`;
    }
  
    // fallback: if it's any path, still try the CDN
    if (rel && !/^data:/i.test(rel)) return `https://s.barnetnetwork.com/img/m/${rel}`;
  
    return "";
  }
  
  function arcItemToTracked(p, ctx) {
    if (!p) return null;
    if (!isInStock(p)) return null;
  
    const url = normAbsUrl(p.url, `https://${ctx.store.host}/`);
    if (!url) return null;
  
    const name = cleanText(p.description || p.name || "");
    if (!name) return null;
  
    const price = pickBestPrice(p);
  
    const cspc = normalizeCspc(p.cspcid || "");
    const id = Number(p.id);
    const taggedSku = cspc ? cspc : Number.isFinite(id) ? `id:${id}` : "";
    const sku = normalizeSkuKey(taggedSku, { storeLabel: ctx?.store?.name, url }) || taggedSku || "";
  
    const img = arcNormalizeImg(p.image || p.image_url || p.img || "");
  
    return { name, price, url, sku, img };
  }
  

function parseCategoryParamsFromStartUrl(startUrl) {
  try {
    const u = new URL(startUrl);
    const category = u.searchParams.get("category") || "";
    const sub = u.searchParams.get("sub_category") || "";
    return { category, sub };
  } catch {
    return { category: "", sub: "" };
  }
}

function avoidMassRemoval(prevDb, discovered, ctx, reason) {
  const prevSize = prevDb?.byUrl?.size || 0;
  const discSize = discovered?.size || 0;

  if (prevSize <= 0 || discSize <= 0) return false;

  const ratio = discSize / Math.max(1, prevSize);
  if (ratio >= 0.6) return false;

  ctx.logger.warn?.(
    `${ctx.catPrefixOut} | ARC partial scan (${discSize}/${prevSize}); preserving DB to avoid removals (${reason}).`
  );

  // Preserve prior active items not seen this run.
  for (const [u, it] of prevDb.byUrl.entries()) {
    if (!it || it.removed) continue;
    if (!discovered.has(u)) discovered.set(u, it);
  }
  return true;
}

async function scanCategoryArcApi(ctx, prevDb, report) {
    const t0 = Date.now();
  
    // Warm cookies / session (Barnet-based shops sometimes need this)
    try {
      await ctx.http.fetchTextWithRetry(ctx.cat.startUrl, `arc:warm:${ctx.cat.key}`, ctx.store.ua);
    } catch (_) {}
  
    const { category: urlCat, sub: urlSub } = parseCategoryParamsFromStartUrl(ctx.cat.startUrl);
    const category = String(ctx.cat.arcCategory || urlCat || "Spirits").trim();
    const subCategory = String(ctx.cat.arcSubCategory || urlSub || "").trim();
  
    if (!subCategory) {
      ctx.logger.warn(`${ctx.catPrefixOut} | ARC missing sub_category; skipping scan.`);
      return;
    }
  
    const apiBase = new URL(`https://${ctx.store.host}/api/shop/${ctx.store.shopId}/products`);
    const discovered = new Map();
  
    const maxPagesCap = ctx.config.maxPages === null ? 5000 : ctx.config.maxPages;
    const hardCap = Math.min(5000, Math.max(1, maxPagesCap));
  
    let donePages = 0;
    let aborted = false;
  
    // Pagination safety
    let pageSize = 0; // inferred from first non-empty page
    const seenPageFingerprints = new Set();
    let stagnantPages = 0;
  
    for (let page = 1; page <= hardCap; page++) {
      const u = new URL(apiBase.toString());
      u.searchParams.set("p", String(page));
      u.searchParams.set("show_on_web", "true");
      u.searchParams.set("sort_by", String(ctx.cat.sortBy || "price_desc"));
      u.searchParams.set("category", category);
      u.searchParams.set("sub_category", subCategory);
      u.searchParams.set("varital_name", "");
      u.searchParams.set("no_item_found", "No item found.");
      u.searchParams.set("avail_for_sale", "false");
      u.searchParams.set("_dc", String(Date.now()));
  
      let r;
      try {
        r = await ctx.http.fetchJsonWithRetry(u.toString(), `arc:api:${ctx.cat.key}:p${page}`, ctx.store.ua, {
          method: "GET",
          headers: {
            Accept: "application/json, */*",
            "X-Requested-With": "XMLHttpRequest",
            Referer: ctx.cat.startUrl,
          },
        });
      } catch (e) {
        ctx.logger.warn(`${ctx.catPrefixOut} | ARC API page ${page} failed: ${e?.message || e}`);
        aborted = true;
        break;
      }
  
      const arr = Array.isArray(r?.json?.items) ? r.json.items : [];
      donePages++;
  
      const rawCount = arr.length;
  
      // Log early (even for empty)
      ctx.logger.ok(
        `${ctx.catPrefixOut} | API Page ${pageStr(donePages, donePages)} | ${(r?.status || "").toString().padEnd(
          3
        )} | raw=${padLeft(rawCount, 3)} kept=${padLeft(0, 3)} | bytes=${kbStr(r.bytes)} | ${padRight(
          ctx.http.inflightStr(),
          11
        )} | ${secStr(r.ms)}`
      );
  
      if (!rawCount) break;
  
      // Infer page size from first non-empty page
      if (!pageSize) pageSize = rawCount;
  
      // Detect wrap/repeat: fingerprint by ids+urls (stable enough)
      const fp = arr.map((p) => `${p?.id || ""}:${p?.url || ""}`).join("|");
      if (fp && seenPageFingerprints.has(fp)) {
        ctx.logger.warn(`${ctx.catPrefixOut} | ARC pagination repeated at p=${page}; stopping.`);
        break;
      }
      if (fp) seenPageFingerprints.add(fp);
  
      const before = discovered.size;
  
      let kept = 0;
      for (const p of arr) {
        const it = arcItemToTracked(p, ctx);
        if (!it) continue;
        discovered.set(it.url, it);
        kept++;
      }
  
      // Re-log with kept filled in (overwrite-style isn’t possible; just emit a second line)
      ctx.logger.ok(
        `${ctx.catPrefixOut} | API Page ${pageStr(donePages, donePages)} | ${(r?.status || "").toString().padEnd(
          3
        )} | raw=${padLeft(rawCount, 3)} kept=${padLeft(kept, 3)} | bytes=${kbStr(r.bytes)} | ${padRight(
          ctx.http.inflightStr(),
          11
        )} | ${secStr(r.ms)}`
      );
  
      // Stop condition #1: last page (short page)
      if (pageSize && rawCount < pageSize) break;
  
      // Stop condition #2: no new uniques for 2 pages (safety)
      if (discovered.size === before) stagnantPages++;
      else stagnantPages = 0;
  
      if (stagnantPages >= 2) {
        ctx.logger.warn(`${ctx.catPrefixOut} | ARC pagination stalled (no new items); stopping.`);
        break;
      }
    }
  
    if (aborted) {
      avoidMassRemoval(prevDb, discovered, ctx, `api pages=${donePages} sub=${subCategory}`);
    }
  
    ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);
  
    const { merged, newItems, updatedItems, removedItems, restoredItems, metaChangedItems } =
      mergeDiscoveredIntoDb(prevDb, discovered, { storeLabel: ctx.store.name });
  
    const dbObj = buildDbObject(ctx, merged);
    writeJsonAtomic(ctx.dbFile, dbObj);
  
    ctx.logger.ok(`${ctx.catPrefixOut} | DB saved: ${ctx.logger.dim(ctx.dbFile)} (${dbObj.count} items)`);
  
    const elapsedMs = Date.now() - t0;
    ctx.logger.ok(
      `${ctx.catPrefixOut} | Done in ${secStr(elapsedMs)}. New=${newItems.length} Updated=${updatedItems.length} Removed=${removedItems.length} Restored=${restoredItems.length} Meta=${metaChangedItems.length} Total(DB)=${merged.size}`
    );
  
    report.categories.push({
      store: ctx.store.name,
      label: ctx.cat.label,
      key: ctx.cat.key,
      dbFile: ctx.dbFile,
      scannedPages: Math.max(1, donePages),
      discoveredUnique: discovered.size,
      newCount: newItems.length,
      updatedCount: updatedItems.length,
      removedCount: removedItems.length,
      restoredCount: restoredItems.length,
      metaChangedCount: metaChangedItems.length,
      elapsedMs,
    });
    report.totals.newCount += newItems.length;
    report.totals.updatedCount += updatedItems.length;
    report.totals.removedCount += removedItems.length;
    report.totals.restoredCount += restoredItems.length;
    report.totals.metaChangedCount += metaChangedItems.length;
  
    addCategoryResultToReport(report, ctx.store.name, ctx.cat.label, newItems, updatedItems, removedItems, restoredItems);
  }
  

function createStore(defaultUa) {
  return {
    key: "arc",
    name: "ARC Liquor",
    host: "kelownaharveyave.armstrong.coop",
    shopId: "644-290",
    ua: defaultUa,
    scanCategory: scanCategoryArcApi,
    categories: [
      {
        key: "spirits-rum",
        label: "Spirits - Rum",
        startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Rum",
        arcCategory: "Spirits",
        arcSubCategory: "Rum",
        sortBy: "price_desc",
      },
      {
        key: "spirits-scotch",
        label: "Spirits - Scotch",
        startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Scotch",
        arcCategory: "Spirits",
        arcSubCategory: "Scotch",
        sortBy: "price_desc",
      },
      {
        key: "spirits-whiskey",
        label: "Spirits - Whiskey",
        startUrl: "https://kelownaharveyave.armstrong.coop/products?category=Spirits&sub_category=Whiskey",
        arcCategory: "Spirits",
        arcSubCategory: "Whiskey",
        sortBy: "price_desc",
      },
    ],
  };
}

module.exports = { createStore };
