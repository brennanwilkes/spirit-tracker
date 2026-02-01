// viz/app/linker/size.js
import { keySkuForRow } from "../sku.js";

const SIZE_TOLERANCE_ML = 8;

export function parseSizesMlFromText(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return [];

  const out = new Set();
  const re = /\b(\d+(?:\.\d+)?)\s*(ml|cl|l|litre|litres|liter|liters)\b/g;

  let m;
  while ((m = re.exec(s))) {
    const val = parseFloat(m[1]);
    const unit = m[2];
    if (!isFinite(val) || val <= 0) continue;

    let ml = 0;
    if (unit === "ml") ml = Math.round(val);
    else if (unit === "cl") ml = Math.round(val * 10);
    else ml = Math.round(val * 1000);

    if (ml >= 50 && ml <= 5000) out.add(ml);
  }

  return Array.from(out);
}

function sizeSetsMatch(aSet, bSet) {
  if (!aSet?.size || !bSet?.size) return false;
  for (const a of aSet) {
    for (const b of bSet) {
      if (Math.abs(a - b) <= SIZE_TOLERANCE_ML) return true;
    }
  }
  return false;
}

export function sizePenalty(aSet, bSet) {
  if (!aSet?.size || !bSet?.size) return 1.0;
  if (sizeSetsMatch(aSet, bSet)) return 1.0;
  return 0.08;
}

/**
 * Builds caches and returns a function (aSku,bSku)=>penalty.
 * This keeps linker_page.js clean and makes cache rebuild explicit when rules change.
 */
export function buildSizePenaltyForPair({ allRows, allAgg, rules }) {
  const SKU_SIZE_CACHE = new Map(); // skuKey -> Set<int ml>

  function ensureSkuSet(k) {
    let set = SKU_SIZE_CACHE.get(k);
    if (!set) SKU_SIZE_CACHE.set(k, (set = new Set()));
    return set;
  }

  for (const r of allRows) {
    if (!r || r.removed) continue;
    const skuKey = String(keySkuForRow(r) || "").trim();
    if (!skuKey) continue;

    const name = r.name || r.title || r.productName || "";
    const sizes = parseSizesMlFromText(name);
    if (!sizes.length) continue;

    const set = ensureSkuSet(skuKey);
    for (const x of sizes) set.add(x);
  }

  for (const it of allAgg) {
    const skuKey = String(it?.sku || "").trim();
    if (!skuKey || !it?.name) continue;
    const sizes = parseSizesMlFromText(it.name);
    if (!sizes.length) continue;

    const set = ensureSkuSet(skuKey);
    for (const x of sizes) set.add(x);
  }

  const CANON_SIZE_CACHE = new Map(); // canon -> Set<int ml>

  function ensureCanonSet(k) {
    let set = CANON_SIZE_CACHE.get(k);
    if (!set) CANON_SIZE_CACHE.set(k, (set = new Set()));
    return set;
  }

  for (const it of allAgg) {
    const skuKey = String(it?.sku || "").trim();
    if (!skuKey) continue;

    const canon = String(rules.canonicalSku(skuKey) || skuKey);
    const canonSet = ensureCanonSet(canon);

    const skuSet = SKU_SIZE_CACHE.get(skuKey);
    if (skuSet) for (const x of skuSet) canonSet.add(x);
  }

  return function sizePenaltyForPair(aSku, bSku) {
    const aCanon = String(rules.canonicalSku(String(aSku || "")) || "");
    const bCanon = String(rules.canonicalSku(String(bSku || "")) || "");
    const A = aCanon ? (CANON_SIZE_CACHE.get(aCanon) || new Set()) : new Set();
    const B = bCanon ? (CANON_SIZE_CACHE.get(bCanon) || new Set()) : new Set();
    return sizePenalty(A, B);
  };
}
