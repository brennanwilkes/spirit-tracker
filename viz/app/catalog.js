import { normImg } from "./dom.js";
import { parsePriceToNumber, keySkuForRow, normSearchText } from "./sku.js";

// Build one row per *canonical* SKU (after applying sku map) + combined searchable text
export function aggregateBySku(listings, canonicalizeSkuFn) {
  const canon = typeof canonicalizeSkuFn === "function" ? canonicalizeSkuFn : (x) => x;

  const bySku = new Map();

  for (const r of listings) {
    const rawSku = keySkuForRow(r);
    const sku = canon(rawSku);

    const name = String(r?.name || "");
    const url = String(r?.url || "");
    const storeLabel = String(r?.storeLabel || r?.store || "");
    const removed = Boolean(r?.removed);

    const img = normImg(r?.img || r?.image || r?.thumb || "");

    const pNum = parsePriceToNumber(r?.price);
    const pStr = String(r?.price || "");

    let agg = bySku.get(sku);
    if (!agg) {
      agg = {
        sku, // canonical sku
        name: name || "",
        img: "",
        cheapestPriceStr: pStr || "",
        cheapestPriceNum: pNum,
        cheapestStoreLabel: storeLabel || "",
        stores: new Set(), // LIVE stores only
        storesEver: new Set(), // live + removed presence (history)
        sampleUrl: url || "",
        _searchParts: [],
        searchText: "",

        _imgByName: new Map(),
        _imgAny: "",
      };
      bySku.set(sku, agg);
    }

    if (storeLabel) {
      agg.storesEver.add(storeLabel);
      if (!removed) agg.stores.add(storeLabel);
    }
    if (!agg.sampleUrl && url) agg.sampleUrl = url;

    // Keep first non-empty name, but keep thumbnail aligned to chosen name
    if (!agg.name && name) {
      agg.name = name;
      if (img) agg.img = img;
    } else if (agg.name && name === agg.name && img && !agg.img) {
      agg.img = img;
    }

    if (img) {
      if (!agg._imgAny) agg._imgAny = img;
      if (name) agg._imgByName.set(name, img);
    }

    // cheapest across LIVE rows only (so removed history doesn't "win")
    if (!removed && pNum !== null) {
      if (agg.cheapestPriceNum === null || pNum < agg.cheapestPriceNum) {
        agg.cheapestPriceNum = pNum;
        agg.cheapestPriceStr = pStr || "";
        agg.cheapestStoreLabel = storeLabel || agg.cheapestStoreLabel;
      }
    }

    // search parts: include canonical + raw sku so searching either works
    agg._searchParts.push(sku);
    if (rawSku && rawSku !== sku) agg._searchParts.push(rawSku);
    if (name) agg._searchParts.push(name);
    if (url) agg._searchParts.push(url);
    if (storeLabel) agg._searchParts.push(storeLabel);
    if (removed) agg._searchParts.push("removed");
  }

  const out = [...bySku.values()];

  for (const it of out) {
    if (!it.img) {
      const m = it._imgByName;
      if (it.name && m && m.has(it.name)) it.img = m.get(it.name) || "";
      else it.img = it._imgAny || "";
    }

    delete it._imgByName;
    delete it._imgAny;

    it.storeCount = it.stores.size;
    it.storeCountEver = it.storesEver.size;
    it.removedEverywhere = it.storeCount === 0;

    it._searchParts.push(it.sku);
    it._searchParts.push(it.name || "");
    it._searchParts.push(it.sampleUrl || "");
    it._searchParts.push(it.cheapestStoreLabel || "");
    it.searchText = normSearchText(it._searchParts.join(" | "));
    delete it._searchParts;
  }

  out.sort((a, b) => (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku));
  return out;
}
