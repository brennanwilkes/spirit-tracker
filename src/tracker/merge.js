"use strict";

const { normalizeCspc } = require("../utils/sku");
const { normPrice } = require("../utils/price");

function normImg(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^data:/i.test(s)) return "";
  return s;
}

function mergeDiscoveredIntoDb(prevDb, discovered) {
  const merged = new Map(prevDb.byUrl);

  const newItems = [];
  const updatedItems = [];
  const removedItems = [];
  const restoredItems = [];

  for (const [url, nowRaw] of discovered.entries()) {
    const prev = prevDb.byUrl.get(url);

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

    if (prev.removed) {
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

    if (nameChanged || priceChanged || skuChanged || imgChanged) {
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
