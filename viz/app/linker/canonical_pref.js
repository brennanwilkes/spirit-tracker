// viz/app/linker/canonical_pref.js
import { keySkuForRow } from "../sku.js";

function isRealSkuKey(skuKey) {
	const s = String(skuKey || "").trim();
	return /^\d{6}$/.test(s);
}

function isSoftSkuKey(k) {
	const s = String(k || "");
	return s.startsWith("upc:") || s.startsWith("id:");
}

function isUnknownSkuKey2(k) {
	return String(k || "")
		.trim()
		.startsWith("u:");
}

function isBCStoreLabel(label) {
	const s = String(label || "").toLowerCase();
	return (
		s.includes("bcl") ||
		s.includes("strath") ||
		s.includes("gull") ||
		s.includes("legacy") ||
		s.includes("tudor") ||
		s.includes("vessel") ||
		s.includes("arc") ||
		s.includes("vintagespirits")
	);
}

function skuIsBC(allRows, skuKey) {
	for (const r of allRows) {
		if (keySkuForRow(r) !== skuKey) continue;
		const lab = String(r.storeLabel || r.store || "");
		if (isBCStoreLabel(lab)) return true;
	}
	return false;
}

function isABStoreLabel(label) {
	const s = String(label || "").toLowerCase();
	return s.includes("alberta") || s.includes("calgary") || s.includes("edmonton") || /\bab\b/.test(s);
}

function skuIsAB(allRows, skuKey) {
	for (const r of allRows) {
		if (keySkuForRow(r) !== skuKey) continue;
		const lab = String(r.storeLabel || r.store || "");
		if (isABStoreLabel(lab)) return true;
	}
	return false;
}

function scoreCanonical(allRows, skuKey) {
	const s = String(skuKey || "");
	const real = isRealSkuKey(s) ? 1 : 0;
	const ab = skuIsAB(allRows, s) ? 1 : 0;
	const bc = skuIsBC(allRows, s) ? 1 : 0;
	const soft = isSoftSkuKey(s) ? 1 : 0;
	const unk = isUnknownSkuKey2(s) ? 1 : 0;

	let base = 0;
	if (real) base = 1000;
	else if (soft) base = 200;
	else if (!unk) base = 100;
	else base = -1000;

	return base + ab * 25 - bc * 10;
}

export function pickPreferredCanonical(allRows, skuKeys) {
	let best = "";
	let bestScore = -Infinity;
	for (const k of skuKeys) {
		const s = String(k || "").trim();
		if (!s) continue;
		const sc = scoreCanonical(allRows, s);
		if (sc > bestScore) {
			bestScore = sc;
			best = s;
		} else if (sc === bestScore && s && best && s < best) {
			best = s;
		}
	}
	return best;
}
