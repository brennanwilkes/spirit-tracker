#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function listJsonFiles(dir) {
	const out = [];
	try {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!ent.isFile()) continue;
			if (!String(ent.name || "").endsWith(".json")) continue;
			out.push(path.join(dir, ent.name));
		}
	} catch {
		// ignore
	}
	return out;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function readDbCommitsOrNull(repoRoot) {
	const p = path.join(repoRoot, "viz", "data", "db_commits.json");
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return null;
	}
}

function gitShowJson(sha, filePath) {
	try {
		const txt = execFileSync("git", ["show", `${sha}:${filePath}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"], // silence git fatal spam
		});
		return JSON.parse(txt);
	} catch {
		return null;
	}
}

function normalizeCspc(v) {
	const m = String(v ?? "").match(/\b(\d{6})\b/);
	return m ? m[1] : "";
}

function fnv1a32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function makeSyntheticSku(storeLabel, url) {
	const store = String(storeLabel || "store");
	const u = String(url || "");
	if (!u) return "";
	return `u:${fnv1a32(`${store}|${u}`)}`;
}

function keySkuForItem(it, storeLabel) {
	const real = normalizeCspc(it?.sku);
	if (real) return real;
	return makeSyntheticSku(storeLabel, it?.url);
}

// Returns Map(skuKey -> firstSeenAtISO) for this dbFile (store/category file).
function computeFirstSeenForDbFile({ repoRoot, relDbFile, storeLabel, wantSkuKeys, commitsArr, nowIso }) {
	const out = new Map();
	const want = new Set(wantSkuKeys);

	// No commit history available -> treat as new today
	if (!Array.isArray(commitsArr) || !commitsArr.length) {
		for (const k of want) out.set(k, nowIso);
		return out;
	}

	// commitsArr is oldest -> newest (from db_commits.json)
	for (const c of commitsArr) {
		const sha = String(c?.sha || "");
		const ts = String(c?.ts || "");
		if (!sha || !ts) continue;

		const obj = gitShowJson(sha, relDbFile);
		const items = Array.isArray(obj?.items) ? obj.items : [];
		const sLabel = String(obj?.storeLabel || obj?.store || storeLabel || "");

		for (const it of items) {
			if (!it) continue;
			if (Boolean(it.removed)) continue; // first time it existed LIVE in this file

			const k = keySkuForItem(it, sLabel);
			if (!k) continue;
			if (!want.has(k)) continue;
			if (out.has(k)) continue;

			out.set(k, ts);
			if (out.size >= want.size) break;
		}

		if (out.size >= want.size) break;
	}

	// Anything never seen historically -> new today
	for (const k of want) if (!out.has(k)) out.set(k, nowIso);

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
		const updatedAt = String(obj.updatedAt || "");

		const dbFile = path.relative(repoRoot, file).replace(/\\/g, "/"); // e.g. data/db/foo.json

		const arr = Array.isArray(obj.items) ? obj.items : [];

		// Build want keys from CURRENT file contents (includes removed rows too)
		const wantSkuKeys = [];
		for (const it of arr) {
			if (!it) continue;
			const k = keySkuForItem(it, storeLabel);
			if (k) wantSkuKeys.push(k);
		}

		const commitsArr = commitsManifest?.files?.[dbFile] || null;
		const firstSeenByKey = computeFirstSeenForDbFile({
			repoRoot,
			relDbFile: dbFile,
			storeLabel,
			wantSkuKeys,
			commitsArr,
			nowIso,
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

			const skuKey = keySkuForItem(it, storeLabel);
			const firstSeenAt = skuKey ? String(firstSeenByKey.get(skuKey) || nowIso) : nowIso;

			items.push({
				sku,
				name,
				price,
				url,
				img,
				removed, // NEW (additive): allows viz to show history / removed-only items
				store,
				storeLabel,
				category,
				categoryLabel,
				source,
				updatedAt,
				firstSeenAt, // NEW: first time this item appeared LIVE in this store/category db file (or now)
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
		// Additive metadata. Old readers can ignore.
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
