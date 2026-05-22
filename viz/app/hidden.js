// viz/app/hidden.js
// Loads data/sku_hidden.json — the curated list of (storeId, rawSku) listings
// that should be hidden everywhere in the UI and in derived feeds.
import { fetchJson, isLocalWriteMode } from "./api.js";
import { normalizeStoreId } from "./stores.js";

let CACHED = null;

export function clearHiddenSetCache() {
	CACHED = null;
}

export function listingKey(storeId, sku) {
	const s = String(storeId || "").trim();
	const k = String(sku || "").trim();
	if (!s || !k) return "";
	return `${s}|${k}`;
}

export function isHiddenListing(set, storeId, sku) {
	if (!set || set.size === 0) return false;
	const k = listingKey(normalizeStoreId(storeId), sku);
	return Boolean(k && set.has(k));
}

async function tryFetchHidden(path) {
	try {
		const j = await fetchJson(path);
		return Array.isArray(j?.hidden) ? j.hidden : [];
	} catch {
		return null;
	}
}

async function readFromLocalServer() {
	try {
		const r = await fetch("/__stviz/sku-hidden", { cache: "no-store" });
		if (!r.ok) return null;
		const j = await r.json();
		return Array.isArray(j?.hidden) ? j.hidden : [];
	} catch {
		return null;
	}
}

export async function loadHiddenSet() {
	if (CACHED) return CACHED;

	let entries =
		(await tryFetchHidden("./data/sku_hidden.json")) ||
		(await tryFetchHidden("/data/sku_hidden.json"));

	if (entries === null && isLocalWriteMode()) {
		entries = await readFromLocalServer();
	}

	const set = new Set();
	for (const e of entries || []) {
		const k = listingKey(normalizeStoreId(e?.storeId), e?.sku);
		if (k) set.add(k);
	}

	CACHED = set;
	return set;
}
