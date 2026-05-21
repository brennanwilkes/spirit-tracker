#!/usr/bin/env node
"use strict";

// Builds viz/data/rarity.json: a per-canonical-SKU snapshot of rarity scoring.
// Run from .worktrees/data after build_viz_sku_cache.js so the per-SKU caches
// reflect the latest data branch state.
//
// Output schema:
//   {
//     "generatedAt": "<ISO>",
//     "version": 1,
//     "thresholds": { "stapleMax": 0.245, "rareMin": 0.625 },
//     "count": 7302,
//     "byCanon": {
//       "<canonicalSku>": { "r": 0.42, "c": 0.83 },
//       ...
//     }
//   }
//
// Consumers canonicalize their raw SKU first (via loadSkuMap / loadSkuRules),
// then look up byCanon[canonical]. Pair with tierFor(r, thresholds) to classify.

const fs = require("fs");
const path = require("path");

const { loadSkuMap } = require("../src/utils/sku_map");
const { scoreSku, computeTierThresholds } = require("../src/utils/rarity");

function main() {
	const repoRoot = process.cwd();
	const skuDir = path.join(repoRoot, "viz", "data", "skus");
	const dbDir = path.join(repoRoot, "data", "db");
	const outFile = path.join(repoRoot, "viz", "data", "rarity.json");

	if (!fs.existsSync(skuDir)) {
		process.stderr.write(`No per-SKU cache dir at ${skuDir} — run build_viz_sku_cache.js first.\n`);
		process.exit(1);
	}

	const skuMap = loadSkuMap({ dbDir });
	process.stdout.write(`[rarity] canonical map loaded\n`);

	const files = fs.readdirSync(skuDir).filter((f) => f.endsWith(".json"));
	process.stdout.write(`[rarity] reading ${files.length} per-SKU cache files...\n`);

	// canon -> { [storeFile]: { label, events: [] } }
	const aggByCanon = new Map();

	for (const f of files) {
		const sku = f.replace(/\.json$/, "");
		let data;
		try {
			data = JSON.parse(fs.readFileSync(path.join(skuDir, f), "utf8"));
		} catch {
			continue;
		}
		if (!data || !data.stores) continue;

		const canon = skuMap.canonicalSku(sku);
		let agg = aggByCanon.get(canon);
		if (!agg) {
			agg = {};
			aggByCanon.set(canon, agg);
		}
		for (const [storeFile, info] of Object.entries(data.stores)) {
			if (!agg[storeFile]) agg[storeFile] = { label: info.label || storeFile, events: [] };
			for (const ev of info.events || []) agg[storeFile].events.push(ev);
		}
	}

	process.stdout.write(`[rarity] scoring ${aggByCanon.size} canonical groups...\n`);

	const byCanon = {};
	const rarities = [];
	const NOW = Date.now();
	for (const [canon, eventsByStore] of aggByCanon.entries()) {
		const s = scoreSku(eventsByStore, NOW);
		// Compact representation — viz only needs rarity + confidence.
		byCanon[canon] = {
			r: +s.rarity.toFixed(4),
			c: +s.confidence.toFixed(3),
		};
		rarities.push(s.rarity);
	}

	const thresholds = computeTierThresholds(rarities);

	const out = {
		generatedAt: new Date().toISOString(),
		version: 1,
		thresholds: {
			stapleMax: +thresholds.stapleMax.toFixed(4),
			rareMin: +thresholds.rareMin.toFixed(4),
		},
		count: Object.keys(byCanon).length,
		byCanon,
	};

	const tmp = `${outFile}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(out) + "\n", "utf8");
	fs.renameSync(tmp, outFile);

	const sz = fs.statSync(outFile).size;
	process.stdout.write(
		`[rarity] wrote ${outFile} (${(sz / 1024).toFixed(1)} KB, ` +
			`${out.count} groups, stapleMax=${out.thresholds.stapleMax}, ` +
			`rareMin=${out.thresholds.rareMin})\n`,
	);
}

main();
