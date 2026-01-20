import { normImg } from "./dom.js";
import { parsePriceToNumber, keySkuForRow, normSearchText } from "./sku.js";

// Build one row per SKU + combined searchable text across all listings of that SKU
export function aggregateBySku(listings) {
  const bySku = new Map();

  for (const r of listings) {
    const sku = keySkuForRow(r);

    const name = String(r?.name || "");
    const url = String(r?.url || "");
    const storeLabel = String(r?.storeLabel || r?.store || "");

    const img = normImg(r?.img || r?.image || r?.thumb || "");
    const pNum = parsePriceToNumber(r?.price);
    const pStr = String(r?.price || "");

    let agg = bySku.get(sku);
    if (!agg) {
      agg = {
        sku,
        name: name || "",
        img: "",
        cheapestPriceStr: pStr || "",
        cheapestPriceNum: pNum,
        cheapestStoreLabel: storeLabel || "",
        stores: new Set(),
        sampleUrl: url || "",
        _searchParts: [],
        searchText: "",

        _imgByName: new Map(), // name -> img
        _imgAny: "",
      };
      bySku.set(sku, agg);
    }

    if (storeLabel) agg.stores.add(storeLabel);
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

    // cheapest
    if (pNum !== null) {
      if (agg.cheapestPriceNum === null || pNum < agg.cheapestPriceNum) {
        agg.cheapestPriceNum = pNum;
        agg.cheapestPriceStr = pStr || "";
        agg.cheapestStoreLabel = storeLabel || agg.cheapestStoreLabel;
      }
    }

    // search parts
    agg._searchParts.push(sku);
    if (name) agg._searchParts.push(name);
    if (url) agg._searchParts.push(url);
    if (storeLabel) agg._searchParts.push(storeLabel);
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
