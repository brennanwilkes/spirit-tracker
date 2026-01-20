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

function makeSyntheticSkuKey({ storeLabel, url }) {
  const store = String(storeLabel || "store");
  const u = String(url || "");
  if (!u) return "";
  return `u:${fnv1a32(`${store}|${u}`)}`;
}

/**
 * For DB + comparisons:
 * - If we can extract a real 6-digit SKU, use it.
 * - Else if v already looks like u:xxxx, keep it.
 * - Else if sku missing, generate u:hash(store|url) if possible.
 */
function normalizeSkuKey(v, { storeLabel, url } = {}) {
  const raw = String(v ?? "").trim();
  const cspc = normalizeCspc(raw);
  if (cspc) return cspc;

  if (raw.startsWith("u:")) return raw;

  const syn = makeSyntheticSkuKey({ storeLabel, url });
  return syn || "";
}

module.exports = { normalizeCspc, normalizeSkuKey, makeSyntheticSkuKey };
