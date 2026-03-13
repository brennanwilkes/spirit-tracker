// viz/app/linker/url_map.js
import { keySkuForRow } from "../sku.js";

function urlQuality(r) {
	const u = String(r?.url || "").trim();
	if (!u) return -1;
	let s = 0;
	s += u.length;
	if (/\bproduct\/\d+\//.test(u)) s += 50;
	if (/[a-z0-9-]{8,}/i.test(u)) s += 10;
	return s;
}

export function buildUrlBySkuStore(allRows) {
	const URL_BY_SKU_STORE = new Map(); // skuKey -> Map(storeLabel -> url)

	for (const r of allRows) {
		if (!r || r.removed) continue;

		const skuKey = String(keySkuForRow(r) || "").trim();
		if (!skuKey) continue;

		const storeLabel = String(r.storeLabel || r.store || "").trim();
		const url = String(r.url || "").trim();
		if (!storeLabel || !url) continue;

		let m = URL_BY_SKU_STORE.get(skuKey);
		if (!m) URL_BY_SKU_STORE.set(skuKey, (m = new Map()));

		const prevUrl = m.get(storeLabel);
		if (!prevUrl) {
			m.set(storeLabel, url);
			continue;
		}

		const prevScore = urlQuality({ url: prevUrl });
		const nextScore = urlQuality(r);

		if (nextScore > prevScore) {
			m.set(storeLabel, url);
		} else if (nextScore === prevScore && url < prevUrl) {
			m.set(storeLabel, url);
		}
	}

	return URL_BY_SKU_STORE;
}
