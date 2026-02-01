// viz/app/linker/store_cache.js

function canonKeyForSku(rules, skuKey) {
    const s = String(skuKey || "").trim();
    if (!s) return "";
    return String(rules.canonicalSku(s) || s);
  }
  
  export function buildCanonStoreCache(allAgg, rules) {
    const m = new Map(); // canonSku -> Set<storeLabel>
  
    for (const it of allAgg) {
      if (!it) continue;
  
      const skuKey = String(it.sku || "").trim();
      if (!skuKey) continue;
  
      const canon = String(rules.canonicalSku(skuKey) || skuKey);
      let set = m.get(canon);
      if (!set) m.set(canon, (set = new Set()));
  
      const stores = it.stores;
      if (stores && stores.size) for (const s of stores) set.add(s);
    }
  
    return m;
  }
  
  function canonStoresForSku(rules, canonStoreCache, skuKey) {
    const canon = canonKeyForSku(rules, skuKey);
    return canon ? canonStoreCache.get(canon) || new Set() : new Set();
  }
  
  export function makeSameStoreCanonFn(rules, canonStoreCache) {
    return function sameStoreCanon(aSku, bSku) {
      const A = canonStoresForSku(rules, canonStoreCache, String(aSku || ""));
      const B = canonStoresForSku(rules, canonStoreCache, String(bSku || ""));
      if (!A.size || !B.size) return false;
      for (const s of A) if (B.has(s)) return true;
      return false;
    };
  }
  