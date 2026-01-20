"use strict";

const { decodeHtml, stripTags, cleanText, extractHtmlAttr, escapeRe, extractFirstImgUrl } = require("../utils/html");
const { sanitizeName } = require("../utils/text");
const { normalizeCspc } = require("../utils/sku");
const { normalizeBaseUrl } = require("../utils/url");

function makePageUrlKWM(baseUrl, pageNum) {
  const u = new URL(normalizeBaseUrl(baseUrl));
  u.hash = "";
  if (pageNum <= 1) {
    u.searchParams.delete("page");
    u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : "";
    return u.toString();
  }
  u.searchParams.set("page", String(pageNum));
  u.search = `?${u.searchParams.toString()}`;
  return u.toString();
}

function extractDivBlocksByExactClass(html, className, maxBlocks) {
  const out = [];
  const s = String(html || "");

  const re = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${escapeRe(className)}\\b[^"']*["'][^>]*>`, "gi");

  let m;
  while ((m = re.exec(s))) {
    if (out.length >= maxBlocks) break;

    const startTagEnd = m.index + m[0].length;
    let i = startTagEnd;
    let depth = 1;

    while (i < s.length) {
      const nextOpen = s.indexOf("<div", i);
      const nextClose = s.indexOf("</div>", i);
      if (nextClose === -1) break;

      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 4;
        continue;
      }
      depth--;
      if (depth === 0) {
        out.push(s.slice(m.index, nextClose + 6));
        re.lastIndex = nextClose + 6;
        break;
      }
      i = nextClose + 6;
    }
  }
  return out;
}

function kwmExtractProductLinkHref(block) {
  let m =
    block.match(/<a\b[^>]*class=["'][^"']*\bproduct-link\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>\s*<\/a>/i) ||
    block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bproduct-link\b[^"']*["'][^>]*>\s*<\/a>/i);

  if (m && m[1]) return m[1].trim();

  m =
    block.match(/<a\b[^>]*class=["'][^"']*\bproduct-link\b[^"']*["'][^>]*href=["']([^"']+)["']/i) ||
    block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*\bproduct-link\b[^"']*["']/i);

  return m && m[1] ? m[1].trim() : "";
}

function kwmExtractName(block) {
  const dataItem = extractHtmlAttr(block, "data-item");
  if (dataItem) return sanitizeName(dataItem);

  const m = block.match(/<h6\b[^>]*>\s*([\s\S]*?)\s*<\/h6>/i);
  if (m && m[1]) return sanitizeName(stripTags(m[1]));

  return "";
}

function kwmExtractFirstDivByClass(html, className) {
  const re = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${escapeRe(className)}\\b[^"']*["'][^>]*>`, "i");
  const m = re.exec(html);
  if (!m) return "";
  const start = m.index + m[0].length;

  let i = start;
  let depth = 1;
  while (i < html.length) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
      continue;
    }
    depth--;
    if (depth === 0) return html.slice(start, nextClose);
    i = nextClose + 6;
  }
  return "";
}

function kwmExtractPrice(block) {
  let m = block.match(/\bdata-price=["']([^"']+)["']/i);
  if (m && m[1]) {
    const raw = String(m[1]).trim();
    const n = raw.replace(/[^0-9.]/g, "");
    if (n) return `$${Number(n).toFixed(2)}`;
  }

  const priceDiv = kwmExtractFirstDivByClass(block, "product-price");
  if (!priceDiv) return "";

  const cleaned = String(priceDiv).replace(/<span\b[^>]*class=["'][^"']*\bstrike\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, " ");

  const txt = cleanText(decodeHtml(stripTags(cleaned)));
  const dollars = [...txt.matchAll(/\$\s*\d+(?:\.\d{2})?/g)];
  if (dollars.length) return dollars[0][0].replace(/\s+/g, "");

  return "";
}

function parseProductsKWM(html, ctx) {
  const s = String(html || "");
  const base = `https://${(ctx && ctx.store && ctx.store.host) || "kensingtonwinemarket.com"}/`;

  const blocks = extractDivBlocksByExactClass(s, "product-wrap", 5000);
  ctx.logger?.dbg?.(`parseProductsKWM: productWrapBlocks=${blocks.length} bytes=${s.length}`);

  const items = [];
  for (const block of blocks) {
    if (/OUT OF STOCK/i.test(block)) continue;

    const href = kwmExtractProductLinkHref(block);
    if (!href) continue;

    let url;
    try {
      url = new URL(decodeHtml(href), base).toString();
    } catch {
      continue;
    }

    const name = kwmExtractName(block);
    if (!name) continue;

    const price = kwmExtractPrice(block);
    const sku = normalizeCspc(url);

    const img = extractFirstImgUrl(block, base);

    items.push({ name, price, url, sku, img });
  }

  const uniq = new Map();
  for (const it of items) uniq.set(it.url, it);
  return [...uniq.values()];
}


function createStore(defaultUa) {
  return {
    key: "kwm",
    name: "Kensington Wine Market",
    host: "kensingtonwinemarket.com",
    ua: defaultUa,
    parseProducts: parseProductsKWM,
    makePageUrl: makePageUrlKWM,
    categories: [
      {
        key: "scotch",
        label: "Scotch",
        startUrl: "https://kensingtonwinemarket.com/products/scotch/",
        discoveryStartPage: 200,
      },
      {
        key: "rum",
        label: "Rum",
        startUrl: "https://kensingtonwinemarket.com/products/liqu/rum/",
        discoveryStartPage: 20,
      },
    ],
  };
}

module.exports = { createStore };
