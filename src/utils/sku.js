// src/utils/sku.js
"use strict";

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function normalizeCspc(v) {
  const m = String(v ?? "").match(/\b(\d{6})\b/);
  return m ? m[1] : "";
}

function normalizeUpcDigits(v) {
  const m = String(v ?? "").match(/\b(\d{12,14})\b/);
  return m ? m[1] : "";
}

function normalizeIdDigits(v) {
  const m = String(v ?? "").match(/\b(\d{4,11})\b/);
  return m ? m[1] : "";
}

// IMPORTANT: keep old behavior exactly (no lowercasing, no url canonicalization)
function makeSyntheticSkuKey({ storeLabel, url }) {
  const store = String(storeLabel || "store");
  const u = String(url || "");
  if (!u) return "";
  return `u:${fnv1a32(`${store}|${u}`)}`;
}

/**
 * Behavior:
 * - CSPC 6-digit => "123456"
 * - explicit upc:id => "upc:012345678901"
 * - explicit id: => "id:12345"
 * - existing u: => keep
 * - else => u:<fnv(store|url)> (old recipe)
 */
function normalizeSkuKey(v, { storeLabel, url } = {}) {
  const raw = String(v ?? "").trim();

  const cspc = normalizeCspc(raw);
  if (cspc) return cspc;

  // NEW: only if explicitly tagged, so legacy behavior doesn't change
  if (/^upc:/i.test(raw)) {
    const upc = normalizeUpcDigits(raw);
    return upc ? `upc:${upc}` : "";
  }
  if (/^id:/i.test(raw)) {
    const id = normalizeIdDigits(raw);
    return id ? `id:${id}` : "";
  }

  if (raw.startsWith("u:")) return raw;

  const syn = makeSyntheticSkuKey({ storeLabel, url });
  return syn || "";
}

module.exports = { normalizeCspc, normalizeSkuKey, makeSyntheticSkuKey };
