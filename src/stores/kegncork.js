"use strict";

const { decodeHtml, cleanText, stripTags, extractFirstImgUrl } = require("../utils/html");
const { makePageUrlQueryParam } = require("../utils/url");

function makePageUrlKegNCork(baseUrl, pageNum) {
  return makePageUrlQueryParam(baseUrl, "page", pageNum);
}

function parseProductsKegNCork(html, ctx) {
  const s = String(html || "");
  const items = [];

  const base = `https://${(ctx && ctx.store && ctx.store.host) || "kegncork.com"}/`;

  const blocks = s.split(/<li\b[^>]*class=["'][^"']*\bproduct\b[^"']*["'][^>]*>/i);
  ctx.logger?.dbg?.(`parseProductsKegNCork: li.product blocks=${Math.max(0, blocks.length - 1)} bytes=${s.length}`);

  for (let i = 1; i < blocks.length; i++) {
    const block = "<li" + blocks[i];

    const mTitle = block.match(
      /<h4\b[^>]*class=["'][^"']*\bcard-title\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
    );
    if (!mTitle) continue;

    const url = decodeHtml(mTitle[1]).trim();
    const name = cleanText(decodeHtml(mTitle[2]));
    if (!url || !/^https?:\/\//i.test(url) || !name) continue;

    let price = "";
    const mPrice = block.match(/data-product-price-without-tax[^>]*>\s*([^<]+)\s*</i);
    if (mPrice && mPrice[1]) {
      const p = cleanText(decodeHtml(mPrice[1])).replace(/\s+/g, "");
      if (p) price = p.startsWith("$") ? p : `$${p}`;
    } else {
      const priceSection = block.match(/data-test-info-type=["']price["'][\s\S]*?<\/div>\s*<\/div>/i)?.[0] || "";
      const mDollar = cleanText(decodeHtml(stripTags(priceSection))).match(/\$\s*\d+(?:\.\d{2})?/);
      if (mDollar) price = mDollar[0].replace(/\s+/g, "");
    }

    const img = extractFirstImgUrl(block, base);

    items.push({ name, price, url, img });
  }

  const uniq = new Map();
  for (const it of items) uniq.set(it.url, it);
  return [...uniq.values()];
}


function createStore(defaultUa) {
  return {
    key: "kegncork",
    name: "Keg N Cork",
    host: "kegncork.com",
    ua: defaultUa,
    parseProducts: parseProductsKegNCork,
    makePageUrl: makePageUrlKegNCork,
    categories: [
      {
        key: "whisky",
        label: "Whisky",
        startUrl: "https://kegncork.com/whisky/?page=1",
        discoveryStartPage: 5,
      },
      {
        key: "rum",
        label: "Rum",
        startUrl: "https://kegncork.com/rum/?page=1",
        discoveryStartPage: 1,
      },
    ],
  };
}

module.exports = { createStore };
