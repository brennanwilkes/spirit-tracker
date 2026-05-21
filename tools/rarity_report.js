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

function loadSkuFile(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); }
	catch { return null; }
}

// Per (canonical, store) compute listing periods.
// An event { ts, p } where p present = in-stock observation; p absent = OOS marker.
// A listing period starts on first in-stock event after either start-of-time or an OOS marker,
// and ends at the next OOS marker (or stays open if last event has p).
function computeStorePeriods(events) {
	const sorted = events.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
	const periods = [];
	const prices = [];
	let openStart = null;
	for (const ev of sorted) {
		const t = new Date(ev.ts).getTime();
		if (ev.p != null) {
			prices.push({ t, p: ev.p });
			if (openStart === null) openStart = t;
		} else {
			if (openStart !== null) {
				periods.push({ start: openStart, end: t });
				openStart = null;
			}
		}
	}
	const stillOpen = openStart !== null
		? { start: openStart, end: null }
		: null;
	const distinctPrices = new Set(prices.map(x => x.p)).size;
	return { periods, stillOpen, prices, distinctPrices };
}

function scoreSku(eventsByStore) {
	const stores = Object.keys(eventsByStore);
	let firstEverTs = Infinity, lastEverTs = -Infinity;
	let totalCompletedPeriods = [];
	let totalStillOpen = 0;
	let totalRestocks = 0;
	let totalPriceChanges = 0;
	let currentlyStockedStores = 0;
	let totalEvents = 0;

	for (const s of stores) {
		const evs = eventsByStore[s].events || [];
		totalEvents += evs.length;
		const { periods, stillOpen, distinctPrices } = computeStorePeriods(evs);
		// restocks within a store = number of completed-then-reopen transitions
		// Equivalent: max(0, (#periods including open) - 1)
		const totalListings = periods.length + (stillOpen ? 1 : 0);
		if (totalListings > 1) totalRestocks += (totalListings - 1);
		for (const p of periods) totalCompletedPeriods.push(p.end - p.start);
		if (stillOpen) totalStillOpen += 1;
		if (distinctPrices > 1) totalPriceChanges += (distinctPrices - 1);
		if (stillOpen) currentlyStockedStores += 1;

		const allTs = evs.map(e => new Date(e.ts).getTime()).filter(Number.isFinite);
		if (allTs.length) {
			firstEverTs = Math.min(firstEverTs, Math.min(...allTs));
			lastEverTs = Math.max(lastEverTs, Math.max(...allTs));
		}
	}

	const breadth = stores.length;
	const ageDays = firstEverTs === Infinity ? 0 : (NOW - firstEverTs) / 86400000;
	const lastSeenDaysAgo = lastEverTs === -Infinity ? Infinity : (NOW - lastEverTs) / 86400000;

	// Completed period stats (days)
	const completedDays = totalCompletedPeriods.map(ms => ms / 86400000);
	const meanCompleted = completedDays.length
		? completedDays.reduce((a, b) => a + b, 0) / completedDays.length
		: null;
	const medianCompleted = (() => {
		if (!completedDays.length) return null;
		const sorted = completedDays.slice().sort((a, b) => a - b);
		const m = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
	})();

	// --- Scores (each 0..1, higher = rarer) ---
	const breadth_score = 1 - Math.min(breadth, 6) / 6;

	// shelf life: prefer median when we have completed periods; if none, use age-of-current-listing
	// (i.e., item has been continuously stocked for ageDays at some store — that's NOT rare)
	let shelflife_score;
	if (medianCompleted !== null) {
		shelflife_score = 1 / (1 + medianCompleted / 14);
	} else if (ageDays > 0) {
		// never gone OOS yet — treat as not rare on this axis
		shelflife_score = 1 / (1 + ageDays / 14);
	} else {
		shelflife_score = 0.5;
	}

	const restock_score = 1 / (1 + totalRestocks / 3);
	const availability_score = breadth > 0
		? 1 - currentlyStockedStores / breadth
		: 1;

	const rarity = 0.35 * breadth_score
		+ 0.30 * shelflife_score
		+ 0.20 * restock_score
		+ 0.15 * availability_score;

	// Confidence: low when we have only 1 store with 1 still-open period and short age
	// Boost when there are completed periods (we've observed sellouts/restocks).
	const completedSignal = Math.min(completedDays.length / 3, 1);
	const ageSignal = Math.min(ageDays / 60, 1);
	const eventSignal = Math.min(totalEvents / 8, 1);
	const confidence = 0.5 * completedSignal + 0.3 * ageSignal + 0.2 * eventSignal;

	return {
		rarity,
		confidence,
		breadth,
		currentlyStockedStores,
		totalRestocks,
		totalPriceChanges,
		ageDays: +ageDays.toFixed(1),
		lastSeenDaysAgo: Number.isFinite(lastSeenDaysAgo) ? +lastSeenDaysAgo.toFixed(1) : null,
		meanCompletedDays: meanCompleted !== null ? +meanCompleted.toFixed(1) : null,
		medianCompletedDays: medianCompleted !== null ? +medianCompleted.toFixed(1) : null,
		completedPeriods: completedDays.length,
		totalEvents,
		scores: {
			breadth: +breadth_score.toFixed(3),
			shelflife: +shelflife_score.toFixed(3),
			restock: +restock_score.toFixed(3),
			availability: +availability_score.toFixed(3),
		}
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

console.log("rarity  conf   brd  cur  rst  prc  age   lastSeen  medShelf  name (canon)");
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
		(s.medianCompletedDays ?? "—").toString().padStart(8),
		`${s.name.slice(0, 50)} (${s.canon})`
	].join("  ");
	console.log(line);
}

console.log(`\n# Column legend`);
console.log(`brd=breadth  cur=currentlyStockedStores  rst=restocks  prc=priceChanges`);
console.log(`age=ageDays  lastSeen=daysSinceLastEvent  medShelf=medianCompletedPeriodDays`);
