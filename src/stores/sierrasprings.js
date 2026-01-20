"use strict";

const { decodeHtml, cleanText, extractFirstImgUrl } = require("../utils/html");
const { normalizeCspc } = require("../utils/sku");
const { extractPriceFromTmbBlock } = require("../utils/woocommerce");

function allowSierraSpiritsLiquorUrlRumWhisky(item) {
  const u = item && item.url ? item.url : "";
  const s = String(u || "").toLowerCase();
  if (!/^https?:\/\/sierraspringsliquor\.ca\/shop\/spirits-liquor\/.+\/$/.test(s)) return false;
  return /\/shop\/spirits-liquor\/.*(rum|whisk(?:e)?y).*/.test(s);
}

function parseProductsSierra(html, ctx) {
  const items = [];
  const blocks = String(html || "").split(/<div class="tmb\b/i);
  ctx.logger?.dbg?.(
    `parseProductsSierra: tmbBlocks=${Math.max(0, blocks.length - 1)} bytes=${String(html || "").length}`
  );

  const base = `https://${(ctx && ctx.store && ctx.store.host) || "sierraspringsliquor.ca"}/`;

  for (let i = 1; i < blocks.length; i++) {
    const block = '<div class="tmb' + blocks[i];

    const titleMatch = block.match(
      /<h3\b[^>]*class=["'][^"']*t-entry-title[^"']*["'][^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i
    );
    if (!titleMatch) continue;

    const url = new URL(decodeHtml(titleMatch[1]), base).toString();
    const name = cleanText(decodeHtml(titleMatch[2]));
    if (!name) continue;

    const price = extractPriceFromTmbBlock(block);

    const sku = normalizeCspc(
      block.match(/\bdata-product_sku=["']([^"']+)["']/i)?.[1] ||
        block.match(/\bSKU[:\s]*([0-9]{6})\b/i)?.[1] ||
        ""
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
    key: "sierrasprings",
    name: "Sierra Springs",
    host: "sierraspringsliquor.ca",
    ua: defaultUa,
    parseProducts: parseProductsSierra,
    categories: [
      {
        key: "whisky",
        label: "Whisky",
        startUrl: "https://sierraspringsliquor.ca/product-category/whisky-2/",
        discoveryStartPage: 20,
      },
      {
        key: "fine-rare",
        label: "Fine & Rare",
        startUrl: "https://sierraspringsliquor.ca/product-category/fine-rare/",
        discoveryStartPage: 1,
      },
      {
        key: "spirits-liquor",
        label: "Spirits / Liquor",
        startUrl: "https://sierraspringsliquor.ca/product-category/spirits-liquor/page/2/",
        discoveryStartPage: 15,
        allowUrl: allowSierraSpiritsLiquorUrlRumWhisky,
      },
      {
        key: "spirits",
        label: "Spirits",
        startUrl: "https://sierraspringsliquor.ca/product-category/spirits/",
        discoveryStartPage: 1,
      },
    ],
  };
}

module.exports = { createStore, parseProductsSierra };
