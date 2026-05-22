"use strict";

// Parallel sibling of viz/app/hidden.js (ESM). Keep both in sync manually.
// Loads data/sku_hidden.json — curated (storeId, rawSku) listings to suppress
// from derived feeds (recent, common listings, email packs).

const fs = require("fs");
const path = require("path");

function listingKey(storeId, sku) {
	const s = String(storeId || "").trim();
	const k = String(sku || "").trim();
	if (!s || !k) return "";
	return `${s}|${k}`;
}

function isHiddenListing(set, storeId, sku) {
	if (!set || set.size === 0) return false;
	const k = listingKey(storeId, sku);
	return Boolean(k && set.has(k));
}

function loadHiddenSet(dataDir) {
	const file = path.join(dataDir || path.join(process.cwd(), "data"), "sku_hidden.json");
	const set = new Set();
	try {
		const raw = fs.readFileSync(file, "utf8");
		const obj = JSON.parse(raw);
		const entries = Array.isArray(obj?.hidden) ? obj.hidden : [];
		for (const e of entries) {
			const k = listingKey(e?.storeId, e?.sku);
			if (k) set.add(k);
		}
	} catch {}
	return set;
}

module.exports = { loadHiddenSet, isHiddenListing, listingKey };
