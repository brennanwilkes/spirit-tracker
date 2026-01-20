"use strict";

const { decodeHtml, stripTags, cleanText } = require("./html");

/**
 * Extracts the *effective* price from Woo price blocks.
 * - If sale <ins> exists, uses the last <ins> (sale price)
 * - Else uses the normal price bdi/span content.
 */
function extractPriceFromTmbBlock(block) {
  const span = matchFirstPriceSpan(block);
  if (!span) return "";

  const insMatches = [...span.matchAll(/<ins\b[^>]*>([\s\S]*?)<\/ins>/gi)];
  const scope = insMatches.length ? insMatches[insMatches.length - 1][1] : span;

  const bdis = [...scope.matchAll(/<bdi\b[^>]*>([\s\S]*?)<\/bdi>/gi)];
  if (bdis.length) {
    const raw = cleanText(decodeHtml(stripTags(bdis[bdis.length - 1][1]))).replace(/\s+/g, "");
    if (raw) return raw.startsWith("$") ? raw : `$${raw}`;
  }

  const sym = scope.match(/woocommerce-Price-currencySymbol[^>]*>\s*([^<\s]+)/i);
  const text = cleanText(decodeHtml(stripTags(scope)));
  const num = text.match(/(\d+(?:\.\d{2})?)/);
  if (sym && num) return `${sym[1].trim()}${num[1]}`;

  const m = cleanText(decodeHtml(stripTags(scope))).match(/\$\s*\d+(?:\.\d{2})?/);
  return m ? m[0].replace(/\s+/g, "") : "";
}

function matchFirstPriceSpan(html) {
  const re = /<span\b[^>]*class=["'][^"']*\bprice\b[^"']*["'][^>]*>/i;
  const m = re.exec(html);
  if (!m) return "";
  const start = m.index + m[0].length;

  let i = start;
  let depth = 1;
  while (i < html.length) {
    const nextOpen = html.indexOf("<span", i);
    const nextClose = html.indexOf("</span>", i);
    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 5;
      continue;
    }
    depth--;
    if (depth === 0) return html.slice(start, nextClose);
    i = nextClose + 7;
  }
  return "";
}

module.exports = { extractPriceFromTmbBlock };
