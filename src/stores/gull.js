"use strict";

const { decodeHtml, cleanText, extractFirstImgUrl } = require("../utils/html");
const { normalizeCspc } = require("../utils/sku");
const { extractPriceFromTmbBlock } = require("../utils/woocommerce");
const { makePageUrl } = require("../utils/url");

function looksInStock(block) {
  const s = String(block || "");
  if (/\boutofstock\b/i.test(s)) return false;
  // your sample has: <p class="stock in-stock">1 in stock</p>
  if (/\bin-stock\b/i.test(s)) return true;
  if (/\binstock\b/i.test(s)) return true;
  if (/>\s*\d+\s+in\s+stock\s*</i.test(s)) return true;
  return /\bin-stock\b/i.test(s);
}

function parseProductsGull(html, ctx) {
  const s = String(html || "");
  const items = [];

  // split on <li class="product ...">
  const parts = s.split(/<li\b[^>]*class=["'][^"']*\bproduct\b[^"']*["'][^>]*>/i);
  if (parts.length <= 1) return items;

  const base = `https://${(ctx && ctx.store && ctx.store.host) || "gullliquorstore.com"}/`;

  for (let i = 1; i < parts.length; i++) {
    const block = '<li class="product"' + parts[i];

    if (!looksInStock(block)) continue;

    const hrefM = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bwoocommerce-LoopProduct-link\b/i);
    if (!hrefM || !hrefM[1]) continue;

    let url;
    try {
      url = new URL(decodeHtml(hrefM[1]), base).toString();
    } catch {
      continue;
    }

    const titleM = block.match(/<h2\b[^>]*class=["'][^"']*\bwoocommerce-loop-product__title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
    const name = cleanText(decodeHtml(titleM ? titleM[1] : ""));
    if (!name) continue;

    // Price is in standard Woo <span class="price"> ... </span>
    const price = extractPriceFromTmbBlock(block) || "";

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
            discoveryDelayMs: 10000
          },
          {
            key: "rum",
            label: "Rum",
            startUrl: "https://gullliquorstore.com/product-category/spirits/?spirit_type=rum",
            discoveryStartPage: 3,
            discoveryStep: 2,
            pageConcurrency: 1,
            pageStaggerMs: 10000,
            discoveryDelayMs: 10000
          },
    ],
  };
}

module.exports = { createStore, parseProductsGull };
