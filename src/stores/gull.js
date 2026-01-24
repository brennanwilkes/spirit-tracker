"use strict";

const { decodeHtml, cleanText, extractFirstImgUrl } = require("../utils/html");
const { normalizeCspc } = require("../utils/sku");
const { makePageUrl } = require("../utils/url");

function looksInStock(block) {
  const s = String(block || "");
  if (/\boutofstock\b/i.test(s)) return false;
  if (/\bin-stock\b/i.test(s)) return true;
  if (/\binstock\b/i.test(s)) return true;
  if (/>\s*\d+\s+in\s+stock\s*</i.test(s)) return true;
  return /\bin-stock\b/i.test(s);
}

// Gull product tiles commonly contain two amounts:
//  - actual price (e.g. 24.05)
//  - deposit (e.g. 0.10) inside the "price suffix"
// We extract all amounts and pick the last one >= 1.00 (sale price if present).
function extractGullPriceFromBlock(block) {
  const s = String(block || "");
  const nums = [];

  // Match WooCommerce "Price amount" blocks, pull out the BDI contents,
  // then strip tags/entities and parse as float.
  const re =
    /<span\b[^>]*class=["'][^"']*\bwoocommerce-Price-amount\b[^"']*["'][^>]*>\s*<bdi\b[^>]*>([\s\S]*?)<\/bdi>/gi;

  for (const m of s.matchAll(re)) {
    const raw = cleanText(decodeHtml(m[1] || "")); // e.g. "$24.05"
    const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) nums.push(n);
  }

  // Filter out bottle deposits / tiny fees (usually 0.10, 0.20, etc.)
  const big = nums.filter((n) => n >= 1.0);

  if (!big.length) return "";

  // If sale price exists, Woo often renders old then new; taking the last >=1
  // typically yields the current price.
  const chosen = big[big.length - 1];

  // Normalize formatting
  return `$${chosen.toFixed(2)}`;
}

function parseProductsGull(html, ctx) {
  const s = String(html || "");
  const items = [];

  // split on <li class="product ...">
  const parts = s.split(
    /<li\b[^>]*class=["'][^"']*\bproduct\b[^"']*["'][^>]*>/i
  );
  if (parts.length <= 1) return items;

  const base = `https://${(ctx && ctx.store && ctx.store.host) || "gullliquorstore.com"}/`;

  for (let i = 1; i < parts.length; i++) {
    const block = '<li class="product"' + parts[i];

    if (!looksInStock(block)) continue;

    const hrefM = block.match(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bwoocommerce-LoopProduct-link\b/i
    );
    if (!hrefM || !hrefM[1]) continue;

    let url;
    try {
      url = new URL(decodeHtml(hrefM[1]), base).toString();
    } catch {
      continue;
    }

    const titleM = block.match(
      /<h2\b[^>]*class=["'][^"']*\bwoocommerce-loop-product__title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i
    );
    const name = cleanText(decodeHtml(titleM ? titleM[1] : ""));
    if (!name) continue;

    const price = extractGullPriceFromBlock(block);

    const sku = normalizeCspc(
      block.match(/\bdata-product_sku=["']([^"']+)["']/i)?.[1] ||
        block.match(/\bSKU\b[^0-9]{0,20}(\d{6})\b/i)?.[1] ||
        url
    );

    const img = extractFirstImgUrl(block, base);

    items.push({ name, price, url, sku, img });
  }

  const uniq = new Map();
  for (const it of items) uniq.set(it.url, it);
  return [...uniq.values()];
}


function createStore(defaultUa) {
  return {
    key: "gull",
    name: "Gull Liquor",
    host: "gullliquorstore.com",
    ua: defaultUa,
    parseProducts: parseProductsGull,
    makePageUrl, // enables /page/N/ paging
    categories: [
      {
        key: "whisky",
        label: "Whisky",
        startUrl: "https://gullliquorstore.com/product-category/spirits/?spirit_type=whisky",
        discoveryStartPage: 3,
        discoveryStep: 2,
        pageConcurrency: 1,
        pageStaggerMs: 10000,
        discoveryDelayMs: 10000,
      },
      {
        key: "rum",
        label: "Rum",
        startUrl: "https://gullliquorstore.com/product-category/spirits/?spirit_type=rum",
        discoveryStartPage: 3,
        discoveryStep: 2,
        pageConcurrency: 1,
        pageStaggerMs: 10000,
        discoveryDelayMs: 10000,
      },
    ],
  };
}

module.exports = { createStore, parseProductsGull };
