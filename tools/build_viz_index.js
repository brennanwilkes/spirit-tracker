#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { gitShowJson } = require("./lib/git");
const { ensureDir, listJsonFiles, readJson } = require("./lib/db");
const { normalizeCspc, fnv1a32 } = require("./lib/sku");

function readDbCommitsOrNull(repoRoot) {
	const p = path.join(repoRoot, "viz", "data", "db_commits.json");
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

// Normalize URL to a stable key: host + path (no scheme/query/hash), no trailing slash
function normalizeUrlForKey(u) {
	const raw = String(u || "").trim();
	if (!raw) return "";
	try {
		const url = new URL(raw);
		const host = String(url.hostname || "").toLowerCase();
		let p = String(url.pathname || "");
		p = p.replace(/\/$/, ""); // strip trailing slash
		return host && p ? `${host}${p}` : "";
	} catch {
		return raw.replace(/\/$/, "");
	}
}

function makeSyntheticSkuFromUrl(url) {
	const k = normalizeUrlForKey(url);
	if (!k) return "";
	return `u:${fnv1a32(k)}`;
}

function looksLikeSyntheticSku(s) {
	return /^u:[0-9a-f]{8}$/i.test(String(s || "").trim());
}

// IMPORTANT: return *all* viable keys for this item so we can match across historical key schemes
function keyCandidatesForItem(it) {
	const out = [];
	const real = normalizeCspc(it?.sku);
	if (real) return [real];

	const sku = String(it?.sku || "").trim();
	if (looksLikeSyntheticSku(sku)) out.push(sku);

	const urlKey = makeSyntheticSkuFromUrl(it?.url);
	if (urlKey) out.push(urlKey);

	// uniq preserving order
	return Array.from(new Set(out));
}

function minIsoFromMapForKeys(map, keys) {
	let best = null;
	for (const k of keys) {
		const v = map.get(k);
		if (!v) continue;
		const ms = Date.parse(String(v));
		if (!Number.isFinite(ms)) continue;
		if (best === null || ms < best.ms) best = { ms, iso: String(v) };
	}
	return best ? best.iso : "";
}

function maxIsoFromMapForKeys(map, keys) {
	let best = null;
	for (const k of keys) {
		const v = map.get(k);
		if (!v) continue;
		const ms = Date.parse(String(v));
		if (!Number.isFinite(ms)) continue;
		if (best === null || ms > best.ms) best = { ms, iso: String(v) };
	}
	return best ? best.iso : "";
}

// Returns Map(key -> firstSeenAtISO) for this dbFile, based on when it first existed LIVE.
// NOTE: does NOT fill missing keys with nowIso.
function computeFirstSeenForDbFile({ relDbFile, wantKeys, commitsArr }) {
	const out = new Map();
	const want = new Set(wantKeys);

	if (!Array.isArray(commitsArr) || !commitsArr.length || !want.size) return out;

	// commitsArr is oldest -> newest
	for (const c of commitsArr) {
		const sha = String(c?.sha || "");
		const ts = String(c?.ts || "");
		if (!sha || !ts) continue;

		const obj = gitShowJson(sha, relDbFile);
		const items = Array.isArray(obj?.items) ? obj.items : [];

		for (const it of items) {
			if (!it) continue;
			if (Boolean(it.removed)) continue;

			for (const k of keyCandidatesForItem(it)) {
				if (!k) continue;
				if (!want.has(k)) continue;
				if (out.has(k)) continue;
				out.set(k, ts);
			}

			if (out.size >= want.size) break;
		}

		if (out.size >= want.size) break;
	}

	return out;
}

// Returns Map(key -> lastLiveAtISO) for this dbFile, based on latest commit where it existed LIVE.
function computeLastLiveForDbFile({ relDbFile, wantKeys, commitsArr }) {
	const out = new Map();
	const want = new Set(wantKeys);

	if (!Array.isArray(commitsArr) || !commitsArr.length || !want.size) return out;

	// scan newest -> oldest; first hit is last live
	for (let i = commitsArr.length - 1; i >= 0; i--) {
		const c = commitsArr[i];
		const sha = String(c?.sha || "");
		const ts = String(c?.ts || "");
		if (!sha || !ts) continue;

		const obj = gitShowJson(sha, relDbFile);
		const items = Array.isArray(obj?.items) ? obj.items : [];

		for (const it of items) {
			if (!it) continue;
			if (Boolean(it.removed)) continue;

			for (const k of keyCandidatesForItem(it)) {
				if (!k) continue;
				if (!want.has(k)) continue;
				if (out.has(k)) continue;
				out.set(k, ts);
			}

			if (out.size >= want.size) break;
		}

		if (out.size >= want.size) break;
	}

	return out;
}

function main() {
	const repoRoot = path.resolve(__dirname, "..");
	const dbDir = path.join(repoRoot, "data", "db");
	const outDir = path.join(repoRoot, "viz", "data");
	const outFile = path.join(outDir, "index.json");

	ensureDir(outDir);

	const nowIso = new Date().toISOString();
	const commitsManifest = readDbCommitsOrNull(repoRoot);

	const items = [];
	let liveCount = 0;

	for (const file of listJsonFiles(dbDir)) {
		const obj = readJson(file);
		if (!obj) continue;

		const store = String(obj.store || "");
		const storeLabel = String(obj.storeLabel || store || "");
		const category = String(obj.category || "");
		const categoryLabel = String(obj.categoryLabel || "");
		const source = String(obj.source || "");
		const fileUpdatedAt = String(obj.updatedAt || "");

		const dbFile = path.relative(repoRoot, file).replace(/\\/g, "/");
		const arr = Array.isArray(obj.items) ? obj.items : [];

		// Keys we want to resolve for this file (union of candidate keys for all rows)
		const wantKeys = [];
		const wantRemovedKeys = [];
		for (const it of arr) {
			if (!it) continue;
			const ks = keyCandidatesForItem(it);
			for (const k of ks) {
				wantKeys.push(k);
				if (Boolean(it.removed)) wantRemovedKeys.push(k);
			}
		}

		const commitsArr = commitsManifest?.files?.[dbFile] || null;

		const firstSeenByKey = computeFirstSeenForDbFile({
			relDbFile: dbFile,
			wantKeys,
			commitsArr,
		});

		const lastLiveByKey = computeLastLiveForDbFile({
			relDbFile: dbFile,
			wantKeys: wantRemovedKeys,
			commitsArr,
		});

		for (const it of arr) {
			if (!it) continue;

			const removed = Boolean(it.removed);
			if (!removed) liveCount++;

			const sku = String(it.sku || "").trim();
			const name = String(it.name || "").trim();
			const price = String(it.price || "").trim();
			const url = String(it.url || "").trim();
			const img = String(it.img || it.image || it.thumb || "").trim();

			const keys = keyCandidatesForItem(it);

			const firstSeenAtFound = minIsoFromMapForKeys(firstSeenByKey, keys);
			const lastLiveAt = maxIsoFromMapForKeys(lastLiveByKey, keys);

			// CRITICAL FIX:
			// - removed rows never get "now" for firstSeenAt
			// - live rows can fall back to now if genuinely unseen
			const firstSeenAt = removed ? firstSeenAtFound : (firstSeenAtFound || nowIso);

			// removed rows must not inherit file-level updatedAt
			const updatedAt = removed ? (lastLiveAt || "") : fileUpdatedAt;

			items.push({
				sku,
				name,
				price,
				url,
				img,
				removed,
				store,
				storeLabel,
				category,
				categoryLabel,
				source,
				updatedAt,
				firstSeenAt, // "" if removed+unknown
				dbFile,
			});
		}
	}

	items.sort((a, b) => {
		const ak = `${a.sku}|${a.storeLabel}|${a.removed ? 1 : 0}|${a.name}|${a.url}`;
		const bk = `${b.sku}|${b.storeLabel}|${b.removed ? 1 : 0}|${b.name}|${b.url}`;
		return ak.localeCompare(bk);
	});

	const outObj = {
		generatedAt: nowIso,
		includesRemoved: true,
		count: items.length,
		countLive: liveCount,
		items,
	};

	fs.writeFileSync(outFile, JSON.stringify(outObj, null, 2) + "\n", "utf8");
	process.stdout.write(`Wrote ${path.relative(repoRoot, outFile)} (${items.length} rows)\n`);
}

module.exports = { main };

if (require.main === module) {
	main();
}