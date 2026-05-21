#!/usr/bin/env node
// Rarity report: scores each canonical SKU 0..1 and prints distribution + a sample.
// Run from the data worktree: node ../../tools/rarity_report.js  (or pass --root)

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
function arg(name, def) {
	const i = argv.indexOf(`--${name}`);
	if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
	return def;
}

const ROOT = path.resolve(arg("root", process.cwd()));
const SKU_DIR = path.join(ROOT, "viz", "data", "skus");
const INDEX_PATH = path.join(ROOT, "viz", "data", "index.json");
const DB_DIR = path.join(ROOT, "data", "db");
const SAMPLE = parseInt(arg("sample", "100"), 10);
const NOW = new Date(arg("now", new Date().toISOString())).getTime();

// ---------------- Canonical SKU map ----------------
// Use the central Node loader so manual AND auto-generated links both feed
// the same union-find. Don't roll your own DSU here.

const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");
const { loadSkuMap } = require("../src/utils/sku_map");

function loadCanonicalMap(dbDir) {
	const m = loadSkuMap({ dbDir });
	// Internally we want canonBySku for the lookup table; loadSkuMap exposes
	// it as _canonBySku alongside canonicalSku().
	return m._canonBySku || new Map();
}

function canonical(sku, map) {
	const s = normalizeImplicitSkuKey(sku);
	return map.get(s) || s;
}

// ---------------- Build per-canonical event aggregate ----------------

const { scoreSku: scoreSkuShared } = require("../src/utils/rarity");

function loadSkuFile(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); }
	catch { return null; }
}

function scoreSku(eventsByStore) {
	const s = scoreSkuShared(eventsByStore, NOW);
	return {
		rarity: s.rarity,
		confidence: s.confidence,
		breadth: s.breadth,
		currentlyStockedStores: s.currentlyStockedStores,
		totalRestocks: s.totalRestocks,
		totalPriceChanges: s.totalPriceChanges,
		ageDays: +s.ageDays.toFixed(1),
		lastSeenDaysAgo: s.lastSeenDaysAgo !== null ? +s.lastSeenDaysAgo.toFixed(1) : null,
		meanPeriodDays: +s.meanPeriodDays.toFixed(1),
		completedPeriods: s.completedPeriods,
		totalInStockDays: +s.totalInStockDays.toFixed(1),
		totalEvents: s.totalEvents,
		scores: {
			breadth: +s.scores.breadth.toFixed(3),
			avail: +s.scores.avail.toFixed(3),
			velocity: +s.scores.velocity.toFixed(3),
			restockLow: +s.scores.restockLow.toFixed(3),
			persistenceLow: +s.scores.persistenceLow.toFixed(3),
		},
	};
}


// ---------------- Load names from index.json ----------------

function loadNames(indexPath, canonMap) {
	const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
	const byCanon = new Map();
	for (const it of raw.items || []) {
		const c = canonical(it.sku, canonMap);
		const existing = byCanon.get(c);
		// prefer longer name; arbitrary but stable
		if (!existing || (it.name && it.name.length > existing.name.length)) {
			byCanon.set(c, { name: it.name || "(unnamed)", price: it.price || "" });
		}
	}
	return byCanon;
}

// ---------------- Main ----------------

console.error(`[rarity] loading from ${ROOT}`);
const canonMap = loadCanonicalMap(DB_DIR);
console.error(`[rarity] canonical map: ${canonMap.size} mapped SKUs`);

// Aggregate per-canonical events across all member SKU files
const aggByCanon = new Map(); // canon -> { [storeFile]: { label, events: [] } }

const files = fs.readdirSync(SKU_DIR).filter(f => f.endsWith(".json"));
console.error(`[rarity] reading ${files.length} per-SKU files...`);

for (const f of files) {
	const sku = f.replace(/\.json$/, "");
	const data = loadSkuFile(path.join(SKU_DIR, f));
	if (!data || !data.stores) continue;
	const c = canonical(sku, canonMap);
	let agg = aggByCanon.get(c);
	if (!agg) { agg = {}; aggByCanon.set(c, agg); }
	for (const [storeFile, info] of Object.entries(data.stores)) {
		if (!agg[storeFile]) {
			agg[storeFile] = { label: info.label || storeFile, events: [] };
		}
		for (const ev of info.events || []) agg[storeFile].events.push(ev);
	}
}

console.error(`[rarity] ${aggByCanon.size} canonical SKUs`);
const names = loadNames(INDEX_PATH, canonMap);

const scored = [];
for (const [canon, eventsByStore] of aggByCanon.entries()) {
	const s = scoreSku(eventsByStore);
	const meta = names.get(canon) || { name: "(no index entry)", price: "" };
	scored.push({ canon, name: meta.name, price: meta.price, ...s });
}

scored.sort((a, b) => a.rarity - b.rarity);

// Distribution histogram
const buckets = new Array(10).fill(0);
const buckLowConf = new Array(10).fill(0);
for (const s of scored) {
	const b = Math.min(9, Math.floor(s.rarity * 10));
	buckets[b]++;
	if (s.confidence < 0.3) buckLowConf[b]++;
}

console.log(`\n# Rarity distribution (${scored.length} canonical SKUs)\n`);
console.log("bucket           count   low-conf   bar");
for (let i = 0; i < 10; i++) {
	const lo = (i / 10).toFixed(2), hi = ((i + 1) / 10).toFixed(2);
	const bar = "#".repeat(Math.round(buckets[i] / Math.max(...buckets) * 50));
	console.log(`${lo}-${hi}    ${String(buckets[i]).padStart(6)}   ${String(buckLowConf[i]).padStart(8)}   ${bar}`);
}

// Sample 100 spread across spectrum
console.log(`\n# Sample of ${SAMPLE} items across the rarity spectrum\n`);
const step = scored.length / SAMPLE;
const sample = [];
for (let i = 0; i < SAMPLE; i++) {
	const idx = Math.min(scored.length - 1, Math.floor(i * step));
	sample.push(scored[idx]);
}

console.log("rarity  conf   brd  cur  rst  prc  age   lastSeen  meanPer  inStockD  name (canon)");
console.log("------  -----  ---  ---  ---  ---  ----  --------  --------  --------------------------");
for (const s of sample) {
	const line = [
		s.rarity.toFixed(3),
		s.confidence.toFixed(2),
		String(s.breadth).padStart(3),
		String(s.currentlyStockedStores).padStart(3),
		String(s.totalRestocks).padStart(3),
		String(s.totalPriceChanges).padStart(3),
		String(s.ageDays.toFixed(0)).padStart(4),
		(s.lastSeenDaysAgo ?? "—").toString().padStart(8),
		s.meanPeriodDays.toString().padStart(7),
		s.totalInStockDays.toString().padStart(8),
		`${s.name.slice(0, 50)} (${s.canon})`
	].join("  ");
	console.log(line);
}

console.log(`\n# Column legend`);
console.log(`brd=breadth  cur=currentlyStockedStores  rst=restocks  prc=priceChanges`);
console.log(`age=ageDays  lastSeen=daysSinceLastEvent  meanPer=meanPeriodDays(completed+open)  inStockD=totalInStockDays`);
