"use strict";

const fs = require("fs");
const path = require("path");

const { dbPathFor, listDbFiles } = require("./db");

// Detect DB files on disk that belong to a store but no longer correspond to any
// category in that store's current config. This happens when a store's category
// URL or key changes (e.g., Sierra Springs site restructure: whisky-2 -> scotch-whisky-single-malt).
// Without intervention, items in the orphan file stay removed:false forever and
// the per-SKU cache forward-fills the last in-stock price indefinitely.
//
// Strategy:
// 1. Only operate on storeKeys that successfully ran >=1 category this run.
//    A store skipped via --stores filter or that failed completely is left alone.
// 2. For each such storeKey, compute the set of dbFiles its current categories expect.
// 3. Any dbFile on disk matching {storeKey}__*.json that's NOT in the expected set
//    is an orphan: flip every non-removed item to removed:true and bump updatedAt.

function storeKeyFromDbFile(file) {
	const base = path.basename(file);
	const i = base.indexOf("__");
	return i > 0 ? base.slice(0, i) : "";
}

function expectedDbFilesForStore(store, dbDir) {
	const out = new Set();
	for (const cat of store.categories || []) {
		const key = `${store.key}__${cat.key}`;
		const baseUrl = cat.startUrl || cat.url || "";
		if (!baseUrl) continue;
		out.add(path.resolve(dbPathFor(key, baseUrl, dbDir)));
	}
	return out;
}

function flipOrphanDbItems(file, nowIso) {
	let db;
	try {
		db = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return { ok: false, error: e?.message || String(e) };
	}
	if (!Array.isArray(db.items)) return { ok: false, error: "no items array" };

	let flipped = 0;
	let already = 0;
	for (const it of db.items) {
		if (it.removed === true) {
			already++;
			continue;
		}
		it.removed = true;
		flipped++;
	}
	if (flipped === 0) return { ok: true, flipped: 0, already, total: db.items.length };

	db.updatedAt = nowIso;
	db.count = db.items.length;
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, file);

	return { ok: true, flipped, already, total: db.items.length };
}

function detectAndFlipOrphanDbs({ stores, report, config, logger }) {
	const dbDir = config.dbDir;

	// Which storeKeys ran >= 1 successful category this run?
	const ranStoreKeys = new Set();
	for (const entry of report?.categories || []) {
		const k = storeKeyFromDbFile(entry?.dbFile || "");
		if (k) ranStoreKeys.add(k);
	}
	if (!ranStoreKeys.size) return { checked: 0, orphans: 0, flippedItems: 0 };

	const scannedDbFiles = new Set(
		(report.categories || [])
			.map((c) => (c?.dbFile ? path.resolve(c.dbFile) : ""))
			.filter(Boolean),
	);

	const storesByKey = new Map();
	for (const s of stores) storesByKey.set(s.key, s);

	const onDiskAll = listDbFiles(dbDir);
	const nowIso = new Date().toISOString();

	let orphansFound = 0;
	let flippedItems = 0;
	let checkedStores = 0;

	for (const storeKey of ranStoreKeys) {
		const store = storesByKey.get(storeKey);
		if (!store) continue;
		const expected = expectedDbFilesForStore(store, dbDir);
		// Be defensive: if a store has no current categories (config bug?), skip
		// rather than flipping every db file for that store.
		if (!expected.size) continue;
		checkedStores++;

		for (const file of onDiskAll) {
			if (storeKeyFromDbFile(file) !== storeKey) continue;
			const abs = path.resolve(file);
			if (expected.has(abs)) continue;
			if (scannedDbFiles.has(abs)) continue; // belt-and-suspenders

			const result = flipOrphanDbItems(file, nowIso);
			if (!result.ok) {
				logger.warn?.(`Orphan DB ${path.basename(file)}: ${result.error}`);
				continue;
			}
			orphansFound++;
			flippedItems += result.flipped;
			if (result.flipped > 0) {
				logger.warn?.(
					`Orphan DB ${path.basename(file)}: flipped ${result.flipped} items to removed (category no longer in ${storeKey} config; ${result.already} already removed)`,
				);
			}
		}
	}

	return { checked: checkedStores, orphans: orphansFound, flippedItems };
}

module.exports = { detectAndFlipOrphanDbs };
