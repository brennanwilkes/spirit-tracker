"use strict";

const { decodeHtml, stripTags, cleanText, extractFirstImgUrl } = require("../utils/html");
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

function extractArticles(html) {
  const s = String(html || "");
  const parts = s.split(/<article\b/i);
  if (parts.length <= 1) return [];
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push("<article" + parts[i]);
  return out;
}

function normalizePrice(str) {
  const s = String(str || "");
  const m = s.match(/\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\$\s*\d+(?:\.\d{2})?/);
  if (!m) return "";
  const raw = m[0].replace(/\s+/g, "");
  return raw.replace(/,/g, "");
}

function pickPriceFromArticle(articleHtml) {
  const a = String(articleHtml || "");
  const noMember = a.replace(
    /<div\b[^>]*class=["'][^"']*\bwhiskyfolk-price\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    " "
  );

  const ins = noMember.match(/<ins\b[^>]*>[\s\S]*?(\$[\s\S]{0,32}?)<\/ins>/i);
  if (ins && ins[1]) return normalizePrice(ins[1]);

  const reg = noMember.match(/class=["'][^"']*\bregular-price-card\b[^"']*["'][^>]*>\s*([^<]+)/i);
  if (reg && reg[1]) return normalizePrice(reg[1]);

  const priceDiv = noMember.match(
    /<div\b[^>]*class=["'][^"']*\bproduct-price\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  );
  const scope = priceDiv && priceDiv[1] ? priceDiv[1] : noMember;

  return normalizePrice(scope);
}

function extractProductIdFromArticle(articleHtml) {
  const a = String(articleHtml || "");

  let m = a.match(/<article\b[^>]*\bid=["'](\d{1,10})["']/i);
  if (m && m[1]) return Number(m[1]);

  m = a.match(/\bpost-(\d{1,10})\b/i);
  if (m && m[1]) return Number(m[1]);

  m = a.match(/\bdata-product_id=["'](\d{1,10})["']/i);
  if (m && m[1]) return Number(m[1]);

  return 0;
}

function extractSkuFromArticle(articleHtml) {
  const a = String(articleHtml || "");

  let m = a.match(/\bdata-product_sku=["'](\d{6})["']/i);
  if (m && m[1]) return m[1];

  m = a.match(/\bSKU\b[^0-9]{0,20}(\d{6})\b/i);
  if (m && m[1]) return m[1];

  return "";
}

function looksInStock(articleHtml) {
  const a = String(articleHtml || "");

  if (/\boutofstock\b/i.test(a)) return false;
  if (/Currently\s+Unavailable/i.test(a)) return false;

  if (/\binstock\b/i.test(a)) return true;
  if (/\bBottles\s+(?:Remaining|Available)\b/i.test(a)) return true;
  if (/Only\s+\d+\s+Bottle\s+Left/i.test(a)) return true;
  if (/10\+\s*Bottles\s+Available/i.test(a)) return true;

  return /\binstock\b/i.test(a);
}

function parseProductFromArticle(articleHtml) {
  const a = String(articleHtml || "");

  if (!looksInStock(a)) return null;

  const hrefM = a.match(/<a\b[^>]*href=["']([^"']+)["']/i);
  if (!hrefM || !hrefM[1]) return null;

  let url;
  try {
    url = new URL(decodeHtml(hrefM[1]), "https://www.strathliquor.com/").toString();
  } catch {
    return null;
  }

  const t2 = a.match(/<h2\b[^>]*class=["'][^"']*\bproduct-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  const t3 = a.match(/<h3\b[^>]*class=["'][^"']*\bproduct-subtitle\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i);
  const title = cleanText(decodeHtml(stripTags((t2 && t2[1]) || "")));
  const sub = cleanText(decodeHtml(stripTags((t3 && t3[1]) || "")));
  const name = cleanText([title, sub].filter(Boolean).join(" - "));
  if (!name) return null;

  const price = pickPriceFromArticle(a);
  const productId = extractProductIdFromArticle(a);

  const skuFromHtml = extractSkuFromArticle(a);
  const fallbackSku = normalizeCspc(url) || "";

  const img = extractFirstImgUrl(a, "https://www.strathliquor.com/");

  return {
    name,
    price,
    url,
    sku: skuFromHtml || fallbackSku,
    productId,
    img,
  };
}


/* ---------------- Store API paging ---------------- */

function buildStoreApiBaseUrlFromCategoryUrl(startUrl) {
  const u = new URL(startUrl);
  const api = new URL(`https://${u.hostname}/wp-json/wc/store/v1/products`);

  api.searchParams.set("order", "desc");
  api.searchParams.set("orderby", "date");

  const stock = u.searchParams.get("_sfm__stock_status");
  if (stock && /instock/i.test(stock)) api.searchParams.set("stock_status", "instock");

  const pr = u.searchParams.get("_sfm__regular_price");
  if (pr) {
    const m = String(pr).match(/^\s*([0-9]+)\s*\+\s*([0-9]+)\s*$/);
    if (m) {
      api.searchParams.set("min_price", m[1]);
      api.searchParams.set("max_price", m[2]);
    }
  }

  return api;
}

function hasCategorySlug(p, wanted) {
  const w = String(wanted || "").trim().toLowerCase();
  if (!w) return true;

  const cats = Array.isArray(p?.categories) ? p.categories : [];
  for (const c of cats) {
    const slug = String(c?.slug || "").trim().toLowerCase();
    if (slug === w) return true;
  }
  return false;
}

function normalizeProductUrl(p) {
  const u = String(p?.permalink || p?.link || "").trim();
  return u && u.startsWith("http") ? u : "";
}

function normalizeProductName(p) {
  // Store API "name" can contain HTML entities like &#8211; and sometimes markup like <em>
  const raw = String(p?.name || "");
  return cleanText(decodeHtml(stripTags(raw)));
}

function normalizeProductImage(p) {
  const imgs = Array.isArray(p?.images) ? p.images : [];
  for (const im of imgs) {
    if (!im) continue;
    const raw =
      (typeof im === "string" ? im : "") ||
      (typeof im?.src === "string" ? im.src : "") ||
      (typeof im?.thumbnail === "string" ? im.thumbnail : "") ||
      (typeof im?.url === "string" ? im.url : "");
    const s = String(raw || "").trim();
    if (!s) continue;
    if (s.startsWith("//")) return `https:${s}`;
    return s;
  }

  const direct = String(p?.image || p?.image_url || p?.imageUrl || "").trim();
  if (!direct) return "";
  return direct.startsWith("//") ? `https:${direct}` : direct;
}



function toMoneyStringFromMinorUnits(valueStr, minorUnit) {
  const mu = Number(minorUnit);
  if (!Number.isFinite(mu) || mu < 0 || mu > 6) return "";
  const v = String(valueStr || "").trim();
  if (!/^\d+$/.test(v)) return "";

  // Use integer math to avoid float rounding issues
  const pad = "0".repeat(mu);
  const s = v.length <= mu ? pad.slice(0, mu - v.length) + v : v;
  const whole = s.length === mu ? "0" : s.slice(0, s.length - mu);
  const frac = mu === 0 ? "" : s.slice(s.length - mu);
  return mu === 0 ? whole : `${whole}.${frac}`;
}

function normalizeProductPrice(p) {
  const prices = p?.prices;

  // Woo store API commonly returns minor units (e.g., "11035" with minor_unit=2 => 110.35)
  if (prices && typeof prices === "object") {
    const minor = prices.currency_minor_unit;
    const sale = String(prices.sale_price || "").trim();
    const regular = String(prices.regular_price || "").trim();
    const chosen = sale || regular;

    if (chosen) {
      let numeric = chosen;

      if (/^\d+$/.test(chosen) && minor !== undefined && minor !== null) {
        const converted = toMoneyStringFromMinorUnits(chosen, minor);
        if (converted) numeric = converted;
      }

      const num = Number(numeric);
      if (Number.isFinite(num) && num >= 0) return `$${num.toFixed(2)}`;
    }
  }

  const raw = String(p?.price || p?.price_html || "").trim();
  const norm = normalizePrice(raw);
  return norm;
}

function normalizeProductSku(p) {
  const sku = String(p?.sku || "").trim();
  if (/^\d{6}$/.test(sku)) return sku;
  return "";
}

function normalizeProductId(p) {
  const id = Number(p?.id);
  return Number.isFinite(id) ? id : 0;
}

async function fetchStoreApiPage(ctx, apiBaseUrl, page, perPage) {
  const u = new URL(apiBaseUrl.toString());
  u.searchParams.set("page", String(page));
  u.searchParams.set("per_page", String(perPage));

  return await ctx.http.fetchJsonWithRetry(u.toString(), `strath:storeapi:${ctx.cat.key}:p${page}`, ctx.store.ua, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Referer: ctx.cat.startUrl,
    },
  });
}

function avoidMassRemoval(prevDb, discovered, ctx, reason) {
  const prevSize = prevDb && typeof prevDb.size === "number" ? prevDb.size : 0;
  const discSize = discovered && typeof discovered.size === "number" ? discovered.size : 0;

  if (prevSize <= 0 || discSize <= 0) return false;

  const ratio = discSize / Math.max(1, prevSize);
  if (ratio >= 0.6) return false;

  ctx.logger.warn?.(
    `${ctx.catPrefixOut} | Strath partial scan (${discSize}/${prevSize}); preserving DB to avoid removals (${reason}).`
  );

  if (prevDb && typeof prevDb.entries === "function") {
    for (const [k, v] of prevDb.entries()) {
      if (!discovered.has(k)) discovered.set(k, v);
    }
    return true;
  }

  return false;
}

async function scanCategoryStrath(ctx, prevDb, report) {
  const t0 = Date.now();

  // Listing HTML (seed + sanity)
  let html = "";
  let listingFinalUrl = ctx.cat.startUrl;
  let listingStatus = 0;
  let listingBytes = 0;
  let listingMs = 0;

  try {
    const r = await ctx.http.fetchTextWithRetry(ctx.cat.startUrl, `strath:html:${ctx.cat.key}`, ctx.store.ua);
    html = r.text || "";
    listingFinalUrl = r.finalUrl || ctx.cat.startUrl;
    listingStatus = r.status || 0;
    listingBytes = r.bytes || 0;
    listingMs = r.ms || 0;
  } catch (e) {
    ctx.logger.warn(`${ctx.catPrefixOut} | Strath listing HTML fetch failed: ${e?.message || e}`);
  }

  const discovered = new Map();

  const listingArticles = extractArticles(html);
  let listingItems = 0;
  for (const art of listingArticles) {
    const it = parseProductFromArticle(art);
    if (it) {
      discovered.set(it.url, it);
      listingItems++;
    }
  }

  ctx.logger.ok(
    `${ctx.catPrefixOut} | Page ${pageStr(1, 1)} | ${String(listingStatus || "").padEnd(3)} | ${pctStr(1, 1)} | items=${padLeft(
      listingItems,
      3
    )} | bytes=${kbStr(listingBytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(listingMs)}`
  );

  const apiBase = buildStoreApiBaseUrlFromCategoryUrl(listingFinalUrl || ctx.cat.startUrl);

  const perPage = 100;
  const maxPagesCap = ctx.config.maxPages === null ? 5000 : ctx.config.maxPages;

  const wantedSlug = String(ctx.cat.apiCategorySlug || "").trim().toLowerCase();

  let donePages = 0;
  let emptyMatchPages = 0;

  for (let page = 1; page <= maxPagesCap; page++) {
    let r;
    try {
      r = await fetchStoreApiPage(ctx, apiBase, page, perPage);
    } catch (e) {
      ctx.logger.warn?.(`${ctx.catPrefixOut} | Strath Store API page ${page} failed: ${e?.message || e}`);
      break;
    }

    const arr = Array.isArray(r?.json) ? r.json : [];
    donePages++;

    if (!arr.length) break;

    let kept = 0;

    for (const p of arr) {
      const stock = String(p?.stock_status || "").toLowerCase();
      if (stock && stock !== "instock") continue;

      if (wantedSlug && !hasCategorySlug(p, wantedSlug)) continue;

      const url = normalizeProductUrl(p);
      if (!url) continue;

      const name = normalizeProductName(p);
      if (!name) continue;

      const price = normalizeProductPrice(p);
      const sku = normalizeProductSku(p);
      const productId = normalizeProductId(p);

      const fallbackSku = sku || normalizeCspc(url) || "";

      const prev = discovered.get(url) || null;
      const img = normalizeProductImage(p) || (prev && prev.img) || "";

      discovered.set(url, {
        name,
        price,
        url,
        sku: sku || fallbackSku,
        productId,
        img,
      });
      kept++;
    }

    ctx.logger.ok(
      `${ctx.catPrefixOut} | API Page ${pageStr(donePages, donePages)} | ${(r?.status || "").toString().padEnd(3)} | kept=${padLeft(
        kept,
        3
      )} | bytes=${kbStr(r.bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(r.ms)}`
    );

    if (wantedSlug) {
      if (kept === 0) emptyMatchPages++;
      else emptyMatchPages = 0;

      // If filter is tight (rum), stop after 2 empty pages in a row.
      if (emptyMatchPages >= 2) break;
    }

    if (arr.length < perPage) break;
  }

  if (prevDb && typeof prevDb.size === "number") {
    avoidMassRemoval(prevDb, discovered, ctx, `storeapi pages=${donePages} slug=${wantedSlug || "none"}`);
  }

  ctx.logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}`);

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
    scannedPages: 1 + Math.max(0, donePages),
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
    key: "strath",
    name: "Strath Liquor",
    host: "www.strathliquor.com",
    ua: defaultUa,
    scanCategory: scanCategoryStrath,
    categories: [
      {
        key: "whisky",
        label: "Whisky",
        apiCategorySlug: "whisky",
        startUrl:
          "https://www.strathliquor.com/whisky/?_sfm__stock_status=instock&_sfm__regular_price=0+6000&_sfm_product_abv=20+75&orderby=date",
      },
      {
        key: "spirits-rum",
        label: "Spirits - Rum",
        apiCategorySlug: "rum",
        startUrl:
          "https://www.strathliquor.com/spirits/?_sfm__stock_status=instock&_sfm__regular_price=0+600&_sfm_product_type=Rum&_sfm_product_abv=10+75&orderby=date",
      },
    ],
  };
}

module.exports = { createStore };
