"use strict";

const { decodeHtml, stripTags, cleanText, extractHtmlAttr, extractFirstImgUrl } = require("../utils/html");
const { normalizeCspc } = require("../utils/sku");
const { extractPriceFromTmbBlock } = require("../utils/woocommerce");

function allowMaltsExcludeGinTequilaMezcal(item) {
  if (item && item.inStock === false) return false;

  const cats = Array.isArray(item?.cats) ? item.cats : [];
  const has = (re) => cats.some((c) => re.test(String(c || "")));

  if (has(/\bgin\b/i)) return false;
  if (has(/\btequila\b/i) || has(/\bmezcal\b/i)) return false;

  return true;
}

function parseProductsMaltsAndGrains(html, ctx) {
  const s = String(html || "");
  const items = [];

  const re = /<li\b[^>]*class=["'][^"']*\bproduct\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi;
  const blocks = [...s.matchAll(re)].map((m) => m[0] || "");
  ctx.logger?.dbg?.(`parseProductsMaltsAndGrains: li.product blocks=${blocks.length} bytes=${s.length}`);

  const base = `https://${(ctx && ctx.store && ctx.store.host) || "maltsandgrains.store"}/`;

  for (const block of blocks) {
    const classAttr = extractHtmlAttr(block, "class");

    const isOut =
      /\boutofstock\b/i.test(classAttr) ||
      /ast-shop-product-out-of-stock/i.test(block) ||
      />\s*out of stock\s*</i.test(block);
    if (isOut) continue;

    const cats = [];
    for (const m of String(classAttr || "").matchAll(/\bproduct_cat-([a-z0-9_-]+)\b/gi)) {
      const v = String(m[1] || "").trim().toLowerCase();
      if (v) cats.push(v);
    }

    let href =
      block.match(
        /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\b(woocommerce-LoopProduct-link|woocommerce-loop-product__link|ast-loop-product__link)\b/i
      )?.[1] ||
      block.match(
        /<a\b[^>]*class=["'][^"']*\b(woocommerce-LoopProduct-link|woocommerce-loop-product__link|ast-loop-product__link)\b[^"']*["'][^>]*href=["']([^"']+)["']/i
      )?.[2] ||
      block.match(/<a\b[^>]*href=["']([^"']*\/product\/[^"']+)["']/i)?.[1];

    if (!href) continue;

    let url = "";
    try {
      url = new URL(decodeHtml(href), base).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;

    const mTitle = block.match(
      /<h2\b[^>]*class=["'][^"']*\bwoocommerce-loop-product__title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i
    );
    const name = mTitle && mTitle[1] ? cleanText(decodeHtml(stripTags(mTitle[1]))) : "";
    if (!name) continue;

    const price = extractPriceFromTmbBlock(block);

    const sku = normalizeCspc(
      block.match(/\bdata-product_sku=["']([^"']+)["']/i)?.[1] ||
        block.match(/\bSKU[:\s]*([0-9]{6})\b/i)?.[1] ||
        ""
    );

    const img = extractFirstImgUrl(block, base);

    items.push({ name, price, url, sku, img, cats, inStock: true });
  }

  const uniq = new Map();
  for (const it of items) uniq.set(it.url, it);
  return [...uniq.values()];
}


function createStore(defaultUa) {
  return {
    key: "maltsandgrains",
    name: "Malts & Grains",
    host: "maltsandgrains.store",
    ua: defaultUa,
    parseProducts: parseProductsMaltsAndGrains,
    categories: [
      {
        key: "all-minus-gin-tequila-mezcal",
        label: "All Spirits",
        startUrl: "https://maltsandgrains.store/shop/page/1/",
        discoveryStartPage: 15,
        allowUrl: allowMaltsExcludeGinTequilaMezcal,
      },
    ],
  };
}

module.exports = { createStore };
