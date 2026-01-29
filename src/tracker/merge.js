// src/tracker/merge.js
"use strict";

const { normalizeSkuKey, normalizeCspc } = require("../utils/sku");
const { normPrice } = require("../utils/price");

function normImg(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^data:/i.test(s)) return "";
  return s;
}

function isRealSku(v) {
  return Boolean(normalizeCspc(v));
}

function dbStoreLabel(prevDb) {
  return String(prevDb?.storeLabel || prevDb?.store || "").trim();
}

function itemStoreLabel(prevDb, it) {
  return String(it?.storeLabel || it?.store || dbStoreLabel(prevDb)).trim();
}

function normalizeSkuForDb(prevDb, raw, { storeLabel, url } = {}) {
  const lab = String(storeLabel || dbStoreLabel(prevDb)).trim();
  // IMPORTANT: if we still don't have a label, don't accidentally use "store"
  // (but in practice dbStoreLabel(prevDb) should always exist)
  return normalizeSkuKey(raw, { storeLabel: lab, url });
}


function mergeDiscoveredIntoDb(prevDb, discovered) {
  const merged = new Map(prevDb.byUrl);

  const newItems = [];
  const updatedItems = [];
  const removedItems = [];
  const restoredItems = [];

  // Choose a deterministic "best" record among dup active SKU rows.
  // Prefer: more complete fields, then lexicographically smallest URL.
  function scoreItem(it) {
    if (!it) return 0;
    const name = String(it.name || "").trim();
    const price = String(it.price || "").trim();
    const url = String(it.url || "").trim();
    const img = String(it.img || "").trim();
    return (name ? 1 : 0) + (price ? 1 : 0) + (url ? 1 : 0) + (img ? 1 : 0);
  }

  function pickBetter({ url: urlA, item: a }, { url: urlB, item: b }) {
    const sa = scoreItem(a);
    const sb = scoreItem(b);
    if (sa !== sb) return sa > sb ? { url: urlA, item: a } : { url: urlB, item: b };
    // tie-breaker: stable + deterministic
    return String(urlA || "") <= String(urlB || "") ? { url: urlA, item: a } : { url: urlB, item: b };
  }

  // Index active items by real SKU; also track *all* urls per SKU to cleanup dupes.
  const prevByRealSku = new Map(); // sku6 -> { url, item } (best)
  const prevUrlsByRealSku = new Map(); // sku6 -> Set(urls)

  for (const [url, it] of prevDb.byUrl.entries()) {
    if (!it || it.removed) continue;
    const sku6 = normalizeCspc(it.sku);
    if (!sku6) continue;

    let set = prevUrlsByRealSku.get(sku6);
    if (!set) prevUrlsByRealSku.set(sku6, (set = new Set()));
    set.add(url);

    const cur = prevByRealSku.get(sku6);
    const next = { url, item: it };
    if (!cur) prevByRealSku.set(sku6, next);
    else prevByRealSku.set(sku6, pickBetter(cur, next));
  }

  const matchedPrevUrls = new Set(); // old URLs we "found" via SKU even if URL changed

  for (const [url, nowRaw] of discovered.entries()) {
    let prev = prevDb.byUrl.get(url);
    let prevUrlForThisItem = url;

    // URL not found in previous DB: try to match by *real* SKU.
    if (!prev) {
      const nowSku6 = normalizeCspc(nowRaw.sku);
      if (nowSku6) {
        const hit = prevByRealSku.get(nowSku6);
        if (hit && hit.url && hit.url !== url) {
          prev = hit.item;
          prevUrlForThisItem = hit.url;

          // Mark ALL prior URLs for this SKU as matched, so we don't later "remove" them.
          const allOld = prevUrlsByRealSku.get(nowSku6);
          if (allOld) {
            for (const u of allOld) matchedPrevUrls.add(u);
          } else {
            matchedPrevUrls.add(hit.url);
          }

          // Cleanup: remove any existing active duplicates for this SKU from the merged map.
          // We'll re-add the chosen record at the new URL below.
          if (allOld) {
            for (const u of allOld) {
              if (u !== url && merged.has(u)) merged.delete(u);
            }
          } else {
            if (merged.has(hit.url)) merged.delete(hit.url);
          }
        }
      }
    }

    // Truly new (no URL match, no real-SKU match)
    if (!prev) {
      const now = {
        ...nowRaw,
        sku: normalizeSkuForDb(prevDb, nowRaw.sku, { storeLabel: itemStoreLabel(prevDb, nowRaw), url }),
        img: normImg(nowRaw.img),
        removed: false,
      };
      newItems.push(now);
      merged.set(url, now);
      continue;
    }

    // If the previous record was removed and we found it by the SAME URL, keep current behavior (restored).
    if (prevUrlForThisItem === url && prev.removed) {
      const now = {
        ...nowRaw,
        sku:
          normalizeSkuForDb(prevDb, nowRaw.sku, { storeLabel: itemStoreLabel(prevDb, nowRaw), url }) ||
          normalizeSkuForDb(prevDb, prev.sku, { storeLabel: itemStoreLabel(prevDb, prev), url: prev.url }),
        img: normImg(nowRaw.img) || normImg(prev.img),
        removed: false,
      };
      restoredItems.push({
        url,
        name: now.name || prev.name || "",
        price: now.price || prev.price || "",
        sku: now.sku || "",
      });
      merged.set(url, now);
      continue;
    }

    // Update-in-place (or URL-move-with-real-SKU): update DB, report price changes normally.
    const prevPrice = normPrice(prev.price);
    const nowPrice = normPrice(nowRaw.price);

    const prevSku = normalizeSkuForDb(prevDb, prev.sku, { storeLabel: itemStoreLabel(prevDb, prev), url: prev.url });
    const nowSku = normalizeSkuForDb(prevDb, nowRaw.sku, { storeLabel: itemStoreLabel(prevDb, nowRaw), url }) || prevSku;
            
    const prevImg = normImg(prev.img);
    let nowImg = normImg(nowRaw.img);
    if (!nowImg) nowImg = prevImg;

    const nameChanged = String(prev.name || "") !== String(nowRaw.name || "");
    const priceChanged = prevPrice !== nowPrice;
    const skuChanged = prevSku !== nowSku;
    const imgChanged = prevImg !== nowImg;

    if (nameChanged || priceChanged || skuChanged || imgChanged || prevUrlForThisItem !== url) {
      merged.set(url, { ...nowRaw, sku: nowSku, img: nowImg, removed: false });
    }

    if (priceChanged) {
      updatedItems.push({
        url,
        name: nowRaw.name || prev.name || "",
        sku: nowSku || "",
        oldPrice: prev.price || "",
        newPrice: nowRaw.price || "",
      });
    }
  }

  for (const [url, prev] of prevDb.byUrl.entries()) {
    if (discovered.has(url)) continue;
    if (matchedPrevUrls.has(url)) continue; // de-dupe URL changes for real-SKU items (and cleanup dupes)
    if (!prev.removed) {
      const removed = { ...prev, removed: true };
      merged.set(url, removed);
      removedItems.push({
        url,
        name: prev.name || "",
        price: prev.price || "",
        sku: normalizeCspc(prev.sku) || "",
      });
    }
  }

  return { merged, newItems, updatedItems, removedItems, restoredItems };
}

module.exports = { mergeDiscoveredIntoDb };
