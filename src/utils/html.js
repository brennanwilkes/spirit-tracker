"use strict";

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, "");
}

function cleanText(s) {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»");
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHtmlAttr(html, attrName) {
  const re = new RegExp(
    `\\b${escapeRe(attrName)}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`,
    "i"
  );
  const m = re.exec(html);
  if (!m) return "";
  return m[1] ?? m[2] ?? m[3] ?? "";
}

function pickFirstUrlFromSrcset(srcset) {
  const s = String(srcset || "").trim();
  if (!s) return "";
  const first = (s.split(",")[0] || "").trim();
  const url = (first.split(/\s+/)[0] || "").trim();
  return url.replace(/^["']|["']$/g, "");
}

function normalizeMaybeRelativeUrl(raw, baseUrl) {
  const r = String(raw || "").trim();
  if (!r) return "";
  let u = r;
  if (u.startsWith("//")) u = `https:${u}`;
  try {
    return baseUrl ? new URL(u, baseUrl).toString() : new URL(u).toString();
  } catch {
    return u;
  }
}

/**
 * Best-effort thumbnail extractor for listing HTML blocks.
 * Returns absolute URL when baseUrl is provided.
 */
function extractFirstImgUrl(html, baseUrl) {
  const s = String(html || "");
  const m = s.match(/<img\b[^>]*>/i);
  if (!m) return "";

  const tag = m[0];

  const attrs = [
    "data-src",
    "data-lazy-src",
    "data-original",
    "data-srcset",
    "srcset",
    "src",
  ];

  for (const a of attrs) {
    let v = extractHtmlAttr(tag, a);
    if (!v) continue;

    v = decodeHtml(String(v)).trim();
    if (!v) continue;

    if (a.toLowerCase().includes("srcset")) v = pickFirstUrlFromSrcset(v);
    v = String(v || "").trim();
    if (!v) continue;

    // Skip data URIs
    if (/^data:/i.test(v)) continue;

    const abs = normalizeMaybeRelativeUrl(v, baseUrl);
    if (abs) return abs;
  }

  return "";
}

module.exports = {
  stripTags,
  cleanText,
  decodeHtml,
  escapeRe,
  extractHtmlAttr,
  extractFirstImgUrl,
};
