"use strict";

// Alberta CSPC / product code is 6 digits. Some stores label it "SKU".
function normalizeCspc(v) {
  const m = String(v ?? "").match(/\b(\d{6})\b/);
  return m ? m[1] : "";
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function normalizeUpc(v) {
  const m = String(v ?? "").match(/\b(\d{12,14})\b/);
  return m ? m[1] : "";
}

// Other stable-ish numeric IDs (e.g. ProductStoreID), keep bounded
function normalizeNumericId(v) {
  const m = String(v ?? "").match(/\b(\d{4,11})\b/);
  return m ? m[1] : "";
}
  

function makeSyntheticSkuKey({ storeLabel, url }) {
  const store = String(storeLabel || "store").trim().toLowerCase();
  let u = String(url || "").trim();
  if (!u) return "";

  // Normalize common "same product, different slug" cases.
  // This is intentionally conservative and forward-only: it only changes the
  // *synthetic* ID when we otherwise have no real SKU.
  try {
    const U = new URL(u);
    // drop query/hash
    U.search = "";
    U.hash = "";

    // normalize path
    let p = U.pathname || "";

    // Common pattern: /product/preorder-<slug>/ becomes /product/<slug>/
    p = p.replace(/\/product\/preorder-([a-z0-9-]+)\/?$/i, "/product/$1/");

    // also normalize trailing slash
    if (!p.endsWith("/")) p += "/";

    U.pathname = p;
    u = U.toString();
  } catch {
    // If URL() parsing fails, do a minimal string normalize.
    u = u.replace(/\/product\/preorder-([a-z0-9-]+)\/?$/i, "/product/$1/");
  }

  return `u:${fnv1a32(`${store}|${u}`)}`;
}

/**
 * For DB + comparisons:
 * - If we can extract a real 6-digit SKU, use it.
 * - Else if UPC-ish digits exist, store as upc:<digits> (low priority but stable)
 * - Else if other numeric id exists, store as id:<digits>
 * - Else if v already looks like u:xxxx, keep it.
 * - Else if sku missing, generate u:hash(store|url) if possible.
 */
function normalizeSkuKey(v, { storeLabel, url } = {}) {
  const raw = String(v ?? "").trim();
  const cspc = normalizeCspc(raw);
  if (cspc) return cspc;

  const upc = normalizeUpc(raw);
  if (upc) return `upc:${upc}`;

  const nid = normalizeNumericId(raw);
  if (nid) return `id:${nid}`;
  
  

  if (raw.startsWith("u:")) return raw;

  const syn = makeSyntheticSkuKey({ storeLabel, url });
  return syn || "";
}

module.exports = { normalizeCspc, normalizeUpc, normalizeSkuKey, makeSyntheticSkuKey };
