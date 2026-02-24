// sha_min_index.js
const DB_NAME = "stviz";
const DB_VER = 1;
const STORE = "shaMinIndex";

function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VER);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function idbGet(key) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readonly");
		const req = tx.objectStore(STORE).get(key);
		req.onsuccess = () => resolve(req.result ?? null);
		req.onerror = () => reject(req.error);
	});
}

async function idbSet(key, val) {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(val, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export function buildMinIndex(obj, storeLabel, parsePriceToNumber, keySkuForRow) {
	const liveSku = Object.create(null);
	const removedSku = Object.create(null);
	const liveKey = Object.create(null);
	const removedKey = Object.create(null);
	const liveUrl = Object.create(null);
	const removedUrl = Object.create(null);

	const items = Array.isArray(obj?.items) ? obj.items : [];
	for (const it of items) {
		if (!it) continue;
		const p = parsePriceToNumber(it.price);
		if (p === null) continue;

		const isRemoved = !!it.removed;
		const sku = String(it.sku || "").trim();
		const url = String(it.url || "").trim();

		const row = { sku, url, storeLabel: storeLabel || "", store: "" };
		const kk = String(keySkuForRow(row) || "").trim();

		const mSku = isRemoved ? removedSku : liveSku;
		const mKey = isRemoved ? removedKey : liveKey;
		const mUrl = isRemoved ? removedUrl : liveUrl;

		if (sku) mSku[sku] = mSku[sku] == null ? p : Math.min(mSku[sku], p);
		if (kk) mKey[kk] = mKey[kk] == null ? p : Math.min(mKey[kk], p);
		if (url) mUrl[url] = mUrl[url] == null ? p : Math.min(mUrl[url], p);
	}

	return { liveSku, removedSku, liveKey, removedKey, liveUrl, removedUrl };
}

export async function getOrBuildMinIndex(key, buildFn) {
	const hit = await idbGet(key).catch(() => null);
	if (hit) return hit;
	const val = await buildFn();
	idbSet(key, val).catch(() => {});
	return val;
}

export function minForVariant(ix, vk, wantUrlsSet) {
	let live = null, removed = null;

	if (wantUrlsSet?.size) {
		for (const u of wantUrlsSet) {
			const a = ix.liveUrl[u];
			if (a != null) live = live == null ? a : Math.min(live, a);
			const b = ix.removedUrl[u];
			if (b != null) removed = removed == null ? b : Math.min(removed, b);
		}
	}

	const ls = ix.liveSku[vk]; if (ls != null) live = live == null ? ls : Math.min(live, ls);
	const rs = ix.removedSku[vk]; if (rs != null) removed = removed == null ? rs : Math.min(removed, rs);

	const lk = ix.liveKey[vk]; if (lk != null) live = live == null ? lk : Math.min(live, lk);
	const rk = ix.removedKey[vk]; if (rk != null) removed = removed == null ? rk : Math.min(removed, rk);

	return { liveMin: live, removedMin: removed };
}