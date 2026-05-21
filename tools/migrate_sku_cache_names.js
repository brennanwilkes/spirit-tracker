#!/usr/bin/env node
"use strict";

// One-shot migration: rename SKU cache files whose name doesn't match the canonical
// normalized form used by the viz (viz/app/sku_canonical.js::normalizeImplicitSkuKey).
//
// Bug context: from 2026-05-08 to 2026-05-21, build_viz_sku_cache.js wrote files
// using the raw SKU from the DB (e.g. "id:1049995.json"). The viz item page,
// however, fetches by canonical SKU group members, which run through
// normalizeImplicitSkuKey first — so it looks for "1049995.json" and finds nothing,
// rendering "No historical points found" for ~13 days of accumulated history.
//
// This script walks viz/data/skus/, normalizes each filename, and either renames
// the file or merges its store/events into an existing canonical-named file.
//
// Run from inside the data worktree (.worktrees/data/):
//
//   node ../../tools/migrate_sku_cache_names.js [--dry-run]
//
// After this, run `node tools/build_viz_sku_cache.js` once to refresh `gen` and
// reconcile any current DB state, then commit + push.

const fs = require("fs");
const path = require("path");
const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");

const DRY_RUN = process.argv.includes("--dry-run");
const SKU_DIR = path.join(process.cwd(), "viz", "data", "skus");

if (!fs.existsSync(SKU_DIR)) {
	process.stderr.write(`No directory at ${SKU_DIR} — run me from the data worktree root.\n`);
	process.exit(2);
}

function readJsonSafe(fp) {
	try {
		const txt = fs.readFileSync(fp, "utf8");
		if (txt.startsWith("version https://git-lfs.github.com/spec/v1")) return null; // LFS pointer
		return JSON.parse(txt);
	} catch {
		return null;
	}
}

// Merge `src` cache contents into `dst`. Event arrays are deduped+sorted by ts.
// Within a store bucket, identical ts keeps the latest occurrence's price.
function mergeCache(dst, src) {
	if (!src || typeof src !== "object" || !src.stores) return dst;
	for (const [storeKey, srcStore] of Object.entries(src.stores)) {
		const srcEvents = Array.isArray(srcStore?.events) ? srcStore.events : [];
		if (!srcEvents.length) continue;
		if (!dst.stores[storeKey]) {
			dst.stores[storeKey] = { label: srcStore.label || "", events: [] };
		} else if (srcStore.label && !dst.stores[storeKey].label) {
			dst.stores[storeKey].label = srcStore.label;
		}
		const merged = [...dst.stores[storeKey].events, ...srcEvents];
		// Dedupe: identical ts collapses (keep last seen — caller responsibility);
		// keep stable order by ts ascending.
		const byTs = new Map();
		for (const e of merged) {
			if (!e || typeof e.ts !== "string") continue;
			byTs.set(e.ts, e);
		}
		dst.stores[storeKey].events = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
	}
	return dst;
}

const entries = fs.readdirSync(SKU_DIR, { withFileTypes: true });

let scanned = 0;
let renamed = 0;
let merged = 0;
let unchanged = 0;
let skipped = 0;

for (const ent of entries) {
	if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
	scanned++;

	const rawSku = ent.name.slice(0, -".json".length);
	const normalized = normalizeImplicitSkuKey(rawSku);

	if (!normalized) {
		skipped++;
		process.stdout.write(`SKIP (empty after normalize): ${ent.name}\n`);
		continue;
	}
	if (normalized === rawSku) {
		unchanged++;
		continue;
	}

	const srcFp = path.join(SKU_DIR, ent.name);
	const dstFp = path.join(SKU_DIR, `${normalized}.json`);

	if (!fs.existsSync(dstFp)) {
		if (DRY_RUN) {
			process.stdout.write(`RENAME (dry): ${ent.name} -> ${normalized}.json\n`);
		} else {
			fs.renameSync(srcFp, dstFp);
			// Patch the embedded sku field so it matches the new filename
			const data = readJsonSafe(dstFp);
			if (data && data.sku !== normalized) {
				data.sku = normalized;
				fs.writeFileSync(dstFp, JSON.stringify(data) + "\n", "utf8");
			}
			process.stdout.write(`RENAME: ${ent.name} -> ${normalized}.json\n`);
		}
		renamed++;
		continue;
	}

	// Collision — merge events into the canonical file, then delete the orphan
	const dstData = readJsonSafe(dstFp) || { sku: normalized, gen: "", stores: {} };
	const srcData = readJsonSafe(srcFp);
	if (!srcData) {
		skipped++;
		process.stdout.write(`SKIP (unreadable source): ${ent.name}\n`);
		continue;
	}

	if (DRY_RUN) {
		const srcStores = Object.keys(srcData.stores || {}).length;
		process.stdout.write(`MERGE (dry): ${ent.name} (${srcStores} stores) into ${normalized}.json\n`);
	} else {
		mergeCache(dstData, srcData);
		dstData.sku = normalized;
		dstData.gen = new Date().toISOString();
		fs.writeFileSync(dstFp, JSON.stringify(dstData) + "\n", "utf8");
		fs.unlinkSync(srcFp);
		const srcStores = Object.keys(srcData.stores || {}).length;
		process.stdout.write(`MERGE: ${ent.name} (${srcStores} stores) into ${normalized}.json\n`);
	}
	merged++;
}

process.stdout.write(
	`\nDone. scanned=${scanned} renamed=${renamed} merged=${merged} unchanged=${unchanged} skipped=${skipped}` +
		(DRY_RUN ? " (dry-run)" : "") +
		"\n",
);
