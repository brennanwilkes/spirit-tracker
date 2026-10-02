"use strict";

// Cross-store sku collision splits (data/sku_collisions.json, docs/sku-collision-split-plan.md).
// A split re-keys chosen (storeId, sku[, url]) listings to a synthetic sku `c:<sku>:<tag>` at the
// point a data/db row is read, before canonical mapping. The result is terminal: never pass it
// through normalizeSkuKey / normalizeCspc / tools/lib/sku.js, which would strip it back to digits.

const fs = require("fs");
const path = require("path");
const { normalizeImplicitSkuKey } = require("./sku_canonical");

// Charset is load-bearing: spirit-tracker-api's SKU_RE is /^[A-Za-z0-9:]+$/ (favourites, email packs),
// so a tag with '-' or '_' would be rejected by the API.
const KEY_RE = /^c:([A-Za-z0-9]+):([a-z0-9]+)$/;
const STORE_RE = /^[a-z0-9]+$/;

// host + path, no scheme/query/hash/trailing slash. Same key shape as build_viz_index's url key.
function normalizeListingUrl(u) {
	const s = String(u ?? "").trim();
	let url;
	try {
		url = new URL(s);
	} catch {
		throw new Error(`sku_collisions: listing url ${JSON.stringify(u)} is not an absolute url`);
	}
	return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
}

function loadCollisionSplits(dataDir) {
	const file = path.join(dataDir, "sku_collisions.json");
	if (!fs.existsSync(file)) {
		throw new Error(`${file} not found: run against a data-branch checkout (an ad-hoc DATA_DIR needs a copy next to its db/)`);
	}
	const obj = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!Array.isArray(obj.collisions)) throw new Error(`${file}: expected {collisions:[]}`);

	const bySku = new Map();
	const splitKeys = new Set();
	const specByNorm = new Map();
	for (const c of obj.collisions) {
		const sku = normalizeImplicitSkuKey(c.sku);
		if (!sku) throw new Error(`${file}: entry without sku`);
		if (sku.startsWith("c:") || sku.startsWith("u:")) throw new Error(`${file}: ${c.sku} is not a store sku`);
		if (bySku.has(sku)) throw new Error(`${file}: duplicate entry for ${sku}`);
		if (!Array.isArray(c.split) || c.split.length === 0) throw new Error(`${file}: ${c.sku} has no split[]`);
		const e = { byStore: new Map(), byUrl: new Map(), urlStores: new Set() };
		for (const s of c.split) {
			const m = KEY_RE.exec(String(s.key));
			if (!m || m[1] !== sku) throw new Error(`${file}: split key ${s.key} must look like c:${sku}:<tag>`);
			if (splitKeys.has(s.key)) throw new Error(`${file}: duplicate split key ${s.key}`);
			splitKeys.add(s.key);
			if (!Array.isArray(s.listings) || s.listings.length === 0) throw new Error(`${file}: ${s.key} has no listings[]`);
			for (const l of s.listings) {
				if (typeof l.storeId !== "string" || !STORE_RE.test(l.storeId)) throw new Error(`${file}: ${s.key} bad storeId ${l.storeId}`);
				if (l.url === undefined) {
					if (e.byStore.has(l.storeId)) throw new Error(`${file}: ${c.sku} store ${l.storeId} listed twice`);
					e.byStore.set(l.storeId, s.key);
				} else {
					const k = `${l.storeId}|${normalizeListingUrl(l.url)}`;
					if (e.byUrl.has(k)) throw new Error(`${file}: ${c.sku} url ${l.url} listed twice`);
					e.byUrl.set(k, s.key);
					e.urlStores.add(l.storeId);
				}
			}
		}
		for (const st of e.urlStores) {
			if (e.byStore.has(st)) throw new Error(`${file}: ${c.sku} store ${st} has both a store-wide and a url matcher`);
		}
		bySku.set(sku, e);
		specByNorm.set(sku, JSON.stringify(c.split));
	}

	// storeId = db-file prefix. Returns `sku` unchanged (same form as passed) when not split.
	function resolve(storeId, sku, url) {
		if (typeof storeId !== "string" || !STORE_RE.test(storeId)) throw new Error(`sku_collisions.resolve: storeId ${JSON.stringify(storeId)} is not a db-file prefix`);
		const e = bySku.get(normalizeImplicitSkuKey(sku));
		if (e === undefined) return sku;
		const whole = e.byStore.get(storeId);
		if (whole !== undefined) return whole;
		if (!e.urlStores.has(storeId)) return sku;
		const byUrl = e.byUrl.get(`${storeId}|${normalizeListingUrl(url)}`);
		return byUrl !== undefined ? byUrl : sku;
	}

	return { resolve, splitKeys, specByNorm, collidedSkus: new Set(bySku.keys()) };
}

function storeIdFromDbPath(p) {
	return path.basename(String(p)).split("__")[0];
}

module.exports = { loadCollisionSplits, storeIdFromDbPath, normalizeListingUrl };
