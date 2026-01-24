// src/tracker/merge.js
"use strict";

const { normalizeCspc } = require("../utils/sku");
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

function mergeDiscoveredIntoDb(prevDb, discovered) {
  const merged = new Map(prevDb.byUrl);

  const newItems = [];
  const updatedItems = [];
  const removedItems = [];
  const restoredItems = [];

  // If a product's URL changes but it has a *real* SKU, treat it as the same product:
  // update DB entry (and URL key) but do NOT count it as New/Removed.
  const prevByRealSku = new Map(); // sku6 -> { url, item }
  for (const [url, it] of prevDb.byUrl.entries()) {
    if (!it || it.removed) continue;
    const sku6 = normalizeCspc(it.sku);
    if (!sku6) continue;
    // If dup SKUs exist, keep the first one we saw (stable enough).
    if (!prevByRealSku.has(sku6)) prevByRealSku.set(sku6, { url, item: it });
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
          matchedPrevUrls.add(hit.url);

          // Move record key from old URL -> new URL in DB map (no New/Removed noise)
          if (merged.has(hit.url)) merged.delete(hit.url);
        }
      }
    }

    // Truly new (no URL match, no real-SKU match)
    if (!prev) {
      const now = {
        ...nowRaw,
        sku: normalizeCspc(nowRaw.sku),
        img: normImg(nowRaw.img),
        removed: false,
      };
      newItems.push(now);
      merged.set(url, now);
      continue;
    }

    // If the previous record was removed and we found it by the SAME URL, keep current behavior (restored).
    // Note: if it "came back" under a different URL, we only de-dupe New/Removed for URL changes on active items.
    if (prevUrlForThisItem === url && prev.removed) {
      const now = {
        ...nowRaw,
        sku: normalizeCspc(nowRaw.sku) || normalizeCspc(prev.sku),
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

    const prevSku = normalizeCspc(prev.sku);
    const nowSku = normalizeCspc(nowRaw.sku) || prevSku;

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
    if (matchedPrevUrls.has(url)) continue; // de-dupe URL changes for real-SKU items
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
