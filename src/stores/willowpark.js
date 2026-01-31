// src/stores/willowpark.js
"use strict";

const { decodeHtml, stripTags, extractFirstImgUrl, cleanText } = require("../utils/html");
const { makePageUrlShopifyQueryPage } = require("../utils/url");

function extractSkuFromUrlOrHref(hrefOrUrl) {
  const s = String(hrefOrUrl || "");
  // /products/<handle>-123456 or /collections/.../products/<handle>-123456
  const m = s.match(/-(\d{6})(?:\/)?(?:[?#].*)?$/);
  return m ? m[1] : "";
}

function extractSkuFromWillowBlock(block) {
  const b = String(block || "");

  // Image filename pattern:
  // /products/710296-Zaya-Gran-Reserva-16-Year_160x.png
  const m1 = b.match(/\/products\/(\d{6})[-_]/i);
  if (m1) return m1[1];

  // Generic fallback
  const m2 = b.match(/\b(\d{6})[-_][A-Za-z]/);
  if (m2) return m2[1];

  return "";
}

function canonicalizeWillowUrl(raw) {
  try {
    const u = new URL(String(raw));
    u.search = "";
    u.hash = "";
    const m = u.pathname.match(/^\/collections\/[^/]+\/products\/([^/]+)\/?$/i);
    if (m) u.pathname = `/products/${m[1]}`;
    return u.toString();
  } catch {
    return String(raw || "");
  }
}

// Prefer exact decimal from visually-hidden spans.
// Fallback: reconstruct from $39<sup>99</sup>.
function extractWillowCardPrice(block) {
  const b = String(block || "");

  const current =
    b.match(
      /grid-product__price--current[\s\S]*?<span\b[^>]*class=["']visually-hidden["'][^>]*>\s*(\$\s*[\d,]+\.\d{2})\s*<\/span>/i
    )?.[1] ||
    b.match(/<span\b[^>]*class=["']visually-hidden["'][^>]*>\s*(\$\s*[\d,]+\.\d{2})\s*<\/span>/i)?.[1];

  if (current) return current.replace(/\s+/g, "");

  const sup = b.match(/\$\s*([\d,]+)\s*<sup>\s*(\d{2})\s*<\/sup>/i);
  if (sup) return `$${sup[1].replace(/,/g, "")}.${sup[2]}`;

  const any = b.match(/\$\s*[\d,]+(?:\.\d{2})?/);
  return any ? any[0].replace(/\s+/g, "") : "";
}

function parseProductsWillowPark(html, ctx, finalUrl) {
  const s = String(html || "");
  const items = [];

  const base = `https://${(ctx && ctx.store && ctx.store.host) || "www.willowpark.net"}/`;

  const starts = [...s.matchAll(/<div\b[^>]*class=["'][^"']*\bgrid-item\b[^"']*\bgrid-product\b[^"']*["'][^>]*>/gi)]
    .map(m => m.index)
    .filter(i => typeof i === "number");

  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i];
    const b = i + 1 < starts.length ? starts[i + 1] : s.length;
    blocks.push(s.slice(a, b));
  }

  for (const block of blocks) {
    const href =
      block.match(/<a\b[^>]*href=["']([^"']*\/collections\/[^"']*\/products\/[^"']+)["']/i)?.[1] ||
      block.match(/<a\b[^>]*href=["']([^"']*\/products\/[^"']+)["']/i)?.[1];
    if (!href) continue;

    let url;
    try {
      url = new URL(decodeHtml(href), base).toString();
    } catch {
      continue;
    }
    url = canonicalizeWillowUrl(url);

    const titleHtml =
      block.match(/<div\b[^>]*class=["'][^"']*\bgrid-product__title\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
    const name = cleanText(decodeHtml(stripTags(titleHtml)));
    if (!name) continue;

    const price = extractWillowCardPrice(block);
    const img = extractFirstImgUrl(block, base);
    const pid = block.match(/\bdata-product-id=["'](\d+)["']/i)?.[1] || "";

    const sku =
      extractSkuFromUrlOrHref(href) ||
      extractSkuFromUrlOrHref(url) ||
      extractSkuFromWillowBlock(block);

    items.push({ name, price, url, sku, img, pid });
  }

  const uniq = new Map();
  for (const it of items) uniq.set(it.url, it);
  return [...uniq.values()];
}

function willowIsEmptyListingPage(html) {
  const s = String(html || "");
  if (/Sorry,\s+there are no products in this collection\./i.test(s)) return true;
  if (/No products found/i.test(s)) return true;
  if (/collection--empty\b/i.test(s)) return true;
  return false;
}

function createStore(defaultUa) {
  return {
    key: "willowpark",
    name: "Willow Park",
    host: "www.willowpark.net",
    ua: defaultUa,

    parseProducts: parseProductsWillowPark,
    makePageUrl: makePageUrlShopifyQueryPage,
    isEmptyListingPage: willowIsEmptyListingPage,

    categories: [
      {
        key: "scotch",
        label: "Scotch",
        startUrl: "https://www.willowpark.net/collections/scotch?filter.v.availability=1",
        discoveryStartPage: 5,
      },
      {
        key: "rum",
        label: "Rum",
        startUrl: "https://www.willowpark.net/collections/rum?filter.v.availability=1",
        discoveryStartPage: 3,
      },
    ],
  };
}

module.exports = { createStore, parseProductsWillowPark };
