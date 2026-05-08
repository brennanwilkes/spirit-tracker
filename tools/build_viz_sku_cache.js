#!/usr/bin/env node
"use strict";

// Generates viz/data/skus/{sku}.json — one file per raw SKU with a change-only event log.
//
// Run from within .worktrees/data/ (same as all other build_viz_*.js tools).
//
// Modes:
//   node tools/build_viz_sku_cache.js             — incremental: compare disk vs last cached event
//   node tools/build_viz_sku_cache.js --full-reindex — walk full git history per db file

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { listDbFiles } = require("./lib/db");
const { dateOnly } = require("./lib/sku");

const FULL_REINDEX = process.argv.includes("--full-reindex");

// ---- git helpers ----

function gitShowJson(sha, relPath) {
	try {
		const txt = execFileSync("git", ["show", `${sha}:${relPath}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 32 * 1024 * 1024,
		});
		if (txt.trimStart().startsWith("version https://git-lfs.github.com/spec/v1")) return null;
		return JSON.parse(txt);
	} catch {
		return null;
	}
}

function getCommitsForFile(relPath) {
	// Returns oldest-first array of { sha, ts }
	try {
		const txt = execFileSync("git", ["log", "--format=%H %cI", "--", relPath], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trimEnd();
		if (!txt) return [];
		return txt
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				const m = line.match(/^([0-9a-f]{7,40})\s+(.+)$/i);
				return m ? { sha: m[1], ts: m[2].trim() } : null;
			})
			.filter(Boolean)
			.reverse(); // git log is newest-first; we want oldest-first
	} catch {
		return [];
	}
}

// ---- cache helpers ----

function loadCache(skuCacheDir, sku) {
	const fp = path.join(skuCacheDir, `${sku}.json`);
	try {
		return JSON.parse(fs.readFileSync(fp, "utf8"));
	} catch {
		return { sku, gen: "", stores: {} };
	}
}

function writeCache(skuCacheDir, sku, data) {
	// Drop store entries with no events (item only seen as removed, no history to show)
	for (const key of Object.keys(data.stores)) {
		if (!data.stores[key].events.length) delete data.stores[key];
	}
	if (!Object.keys(data.stores).length) return; // nothing to write
	data.gen = new Date().toISOString();
	const fp = path.join(skuCacheDir, `${sku}.json`);
	fs.writeFileSync(fp, JSON.stringify(data) + "\n", "utf8");
}

function getOrInitStore(cacheData, dbFile, storeLabel) {
	if (!cacheData.stores[dbFile]) {
		cacheData.stores[dbFile] = { label: storeLabel, events: [] };
	} else if (storeLabel && cacheData.stores[dbFile].label !== storeLabel) {
		cacheData.stores[dbFile].label = storeLabel;
	}
	return cacheData.stores[dbFile];
}

// Derives the last known state from the events array. Returns null if no events yet.
function getLastState(events) {
	if (!Array.isArray(events) || !events.length) return null;
	const last = events[events.length - 1];
	return {
		price: "p" in last ? last.p : null,
		removed: !("p" in last),
	};
}

// Appends an event if the state changed. Returns true if an event was added.
function addEventIfChanged(events, prevState, curPrice, curRemoved, ts) {
	if (prevState === null) {
		if (!curRemoved) {
			events.push({ ts, p: curPrice });
			return true;
		}
		return false;
	}
	if (!prevState.removed && curRemoved) {
		events.push({ ts });
		return true;
	}
	if (prevState.removed && !curRemoved) {
		events.push({ ts, p: curPrice });
		return true;
	}
	if (!prevState.removed && !curRemoved && prevState.price !== curPrice) {
		events.push({ ts, p: curPrice });
		return true;
	}
	return false;
}

// Collapses an items array from a db snapshot into a per-sku map of { price, removed }.
// When a sku appears multiple times: live wins over removed; among live entries, min price wins.
function itemsToSkuMap(items) {
	const result = new Map();
	for (const item of Array.isArray(items) ? items : []) {
		if (!item?.sku) continue;
		const sku = String(item.sku);
		const isRemoved = Boolean(item.removed);
		const existing = result.get(sku);
		if (!existing) {
			result.set(sku, { price: item.price, removed: isRemoved });
		} else if (!isRemoved && existing.removed) {
			// live wins over removed
			result.set(sku, { price: item.price, removed: false });
		} else if (!isRemoved && !existing.removed) {
			// both live: keep whichever price comes first (db is stable per run)
			// (price comparison would require parsing; keep first entry for simplicity)
		}
	}
	return result;
}

// ---- Incremental mode ----
// Compares current on-disk db files against the last event in each SKU's cache.

function runIncremental(skuCacheDir, dbFilePaths) {
	const caches = new Map(); // sku -> cache object (batched writes)
	let totalEvents = 0;

	for (const relPath of dbFilePaths) {
		const absPath = path.join(process.cwd(), relPath);
		let diskData;
		try {
			diskData = JSON.parse(fs.readFileSync(absPath, "utf8"));
		} catch {
			continue;
		}

		const storeLabel = diskData.storeLabel || diskData.store || "";
		const ts = diskData.updatedAt || new Date().toISOString();
		const skuMap = itemsToSkuMap(diskData.items);

		for (const [sku, { price, removed }] of skuMap) {
			if (!caches.has(sku)) caches.set(sku, loadCache(skuCacheDir, sku));
			const cache = caches.get(sku);
			const store = getOrInitStore(cache, relPath, storeLabel);
			const prevState = getLastState(store.events);

			if (addEventIfChanged(store.events, prevState, price, removed, ts)) totalEvents++;
		}
	}

	for (const [sku, data] of caches) writeCache(skuCacheDir, sku, data);
	process.stdout.write(
		`Incremental: ${totalEvents} events across ${caches.size} SKUs (${dbFilePaths.length} store files)\n`,
	);
}

// ---- Full-reindex mode ----
// Walks git history per db file, then applies current disk state on top.

function runFullReindex(skuCacheDir, dbFilePaths) {
	const caches = new Map(); // sku -> cache object

	const totalFiles = dbFilePaths.length;
	let totalEvents = 0;

	for (let fi = 0; fi < totalFiles; fi++) {
		const relPath = dbFilePaths[fi];
		const basename = path.basename(relPath);
		const absPath = path.join(process.cwd(), relPath);

		const commits = getCommitsForFile(relPath);
		process.stdout.write(`[${fi + 1}/${totalFiles}] ${basename} — ${commits.length} commits\n`);

		// Get storeLabel from disk file (fastest) or first commit
		let storeLabel = "";
		try {
			const diskData = JSON.parse(fs.readFileSync(absPath, "utf8"));
			storeLabel = diskData.storeLabel || diskData.store || "";
		} catch {
			if (commits.length) {
				const first = gitShowJson(commits[0].sha, relPath);
				storeLabel = first?.storeLabel || first?.store || "";
			}
		}

		// Walk commits oldest-to-newest, tracking state changes
		let prevSkuMap = new Map();

		for (let ci = 0; ci < commits.length; ci++) {
			const { sha, ts } = commits[ci];

			if ((ci + 1) % 25 === 0 || ci === commits.length - 1) {
				process.stdout.write(
					`  commit ${ci + 1}/${commits.length} (${totalEvents} events so far)\r`,
				);
			}

			const data = gitShowJson(sha, relPath);
			if (!data) continue;

			const curSkuMap = itemsToSkuMap(data.items);
			const allSkus = new Set([...prevSkuMap.keys(), ...curSkuMap.keys()]);

			for (const sku of allSkus) {
				const prev = prevSkuMap.get(sku) || null;
				const cur = curSkuMap.get(sku);

				// sku absent from cur snapshot = treat as removed
				const curRemoved = cur === undefined ? true : cur.removed;
				const curPrice = cur ? cur.price : null;

				const prevState = prev ? { price: prev.price, removed: prev.removed } : null;

				if (!caches.has(sku)) caches.set(sku, { sku, gen: "", stores: {} });
				const store = getOrInitStore(caches.get(sku), relPath, storeLabel);

				if (addEventIfChanged(store.events, prevState, curPrice, curRemoved, ts)) totalEvents++;
			}

			prevSkuMap = curSkuMap;
		}

		if (commits.length) process.stdout.write("\n");

		// Apply current disk state against last-known git state
		try {
			const diskData = JSON.parse(fs.readFileSync(absPath, "utf8"));
			const diskTs = diskData.updatedAt || new Date().toISOString();
			const diskSkuMap = itemsToSkuMap(diskData.items);
			const diskStoreLabel = diskData.storeLabel || diskData.store || storeLabel;

			const allDiskSkus = new Set([...prevSkuMap.keys(), ...diskSkuMap.keys()]);
			for (const sku of allDiskSkus) {
				const prev = prevSkuMap.get(sku) || null;
				const cur = diskSkuMap.get(sku);
				const curRemoved = cur === undefined ? true : cur.removed;
				const curPrice = cur ? cur.price : null;
				const prevState = prev ? { price: prev.price, removed: prev.removed } : null;

				if (!caches.has(sku)) caches.set(sku, { sku, gen: "", stores: {} });
				const store = getOrInitStore(caches.get(sku), relPath, diskStoreLabel);

				if (addEventIfChanged(store.events, prevState, curPrice, curRemoved, diskTs)) totalEvents++;
			}
		} catch {}
	}

	process.stdout.write(`Writing ${caches.size} SKU cache files...\n`);
	for (const [sku, data] of caches) writeCache(skuCacheDir, sku, data);
	process.stdout.write(
		`Full reindex complete: ${totalEvents} events across ${caches.size} SKUs\n`,
	);
}

// ---- Main ----

function main() {
	const repoRoot = process.cwd();
	const skuCacheDir = path.join(repoRoot, "viz", "data", "skus");
	fs.mkdirSync(skuCacheDir, { recursive: true });

	const dbFilePaths = listDbFiles(path.join(repoRoot, "data", "db")).map((abs) =>
		path.posix.join("data/db", path.basename(abs)),
	);

	if (!dbFilePaths.length) {
		process.stderr.write("No db files found in data/db/\n");
		process.exit(1);
	}

	if (FULL_REINDEX) {
		process.stdout.write(`Full reindex: ${dbFilePaths.length} store files\n`);
		runFullReindex(skuCacheDir, dbFilePaths);
	} else {
		runIncremental(skuCacheDir, dbFilePaths);
	}
}

main();
