#!/usr/bin/env node
// Find canonical SKUs that have per-SKU event data but no entry in viz/data/index.json.
// Dump what we know: which store DB files reference them, event counts, last seen, raw SKU members.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || process.cwd());
const SKU_DIR = path.join(ROOT, "viz", "data", "skus");
const INDEX_PATH = path.join(ROOT, "viz", "data", "index.json");
const LINKS_PATH = path.join(ROOT, "data", "sku_links.json");
const DB_DIR = path.join(ROOT, "data", "db");

const { loadSkuMap } = require("../src/utils/sku_map");

function loadCanonical() {
	const m = loadSkuMap({ dbDir: path.join(ROOT, "data", "db") });
	return m.canonicalSku;
}

const canonical = loadCanonical();

// Skus present in index
const indexed = new Set();
const idx = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
for (const it of idx.items || []) indexed.add(canonical(it.sku));

// Walk per-SKU files; build per-canonical aggregate of unnamed ones
const orphans = new Map(); // canon -> { members:Set, storeFiles:Set, eventCount, firstTs, lastTs, sampleEvents:[] }

const files = fs.readdirSync(SKU_DIR).filter(f => f.endsWith(".json"));
for (const f of files) {
	const sku = f.replace(/\.json$/, "");
	const c = canonical(sku);
	if (indexed.has(c)) continue;
	const data = JSON.parse(fs.readFileSync(path.join(SKU_DIR, f), "utf8"));
	let o = orphans.get(c);
	if (!o) {
		o = { canon: c, members: new Set(), storeFiles: new Set(), eventCount: 0, firstTs: Infinity, lastTs: -Infinity, sampleEvents: [] };
		orphans.set(c, o);
	}
	o.members.add(sku);
	for (const [storeFile, info] of Object.entries(data.stores || {})) {
		o.storeFiles.add(storeFile);
		for (const ev of info.events || []) {
			o.eventCount++;
			const t = new Date(ev.ts).getTime();
			if (t < o.firstTs) o.firstTs = t;
			if (t > o.lastTs) o.lastTs = t;
			if (o.sampleEvents.length < 3) o.sampleEvents.push({ ...ev, store: info.label || storeFile });
		}
	}
}

// For each orphan, try to find the raw entry inside the store DB JSON to recover name/url.
// DB files are large arrays of items keyed differently per store; we'll do a simple text scan.
function tryFindInDb(storeFile, rawSku) {
	const full = path.join(ROOT, storeFile);
	if (!fs.existsSync(full)) return null;
	let txt;
	try { txt = fs.readFileSync(full, "utf8"); } catch { return null; }
	// Quick check first
	if (!txt.includes(rawSku)) return null;
	try {
		const data = JSON.parse(txt);
		const items = Array.isArray(data) ? data : (data.items || []);
		for (const it of items) {
			const skus = [it.sku, it.SKU, it.id, it.productId, it.code, ...(Array.isArray(it.skus) ? it.skus : [])].filter(Boolean).map(String);
			if (skus.some(s => s === rawSku || s.includes(rawSku) || rawSku.endsWith(s))) {
				return { name: it.name || it.title || "", url: it.url || it.link || "", removed: !!it.removed };
			}
		}
	} catch {}
	return null;
}

console.log(`Found ${orphans.size} canonical SKUs with event history but NO entry in index.json\n`);

const sorted = Array.from(orphans.values()).sort((a, b) => b.lastTs - a.lastTs);

console.log(`Top 40 most-recently-seen orphans:\n`);
for (const o of sorted.slice(0, 40)) {
	const ageDays = Math.round((Date.now() - o.firstTs) / 86400000);
	const lastSeenDays = Math.round((Date.now() - o.lastTs) / 86400000);
	console.log(`canon=${o.canon}`);
	console.log(`  members:    ${Array.from(o.members).join(", ")}`);
	console.log(`  stores:     ${Array.from(o.storeFiles).join(", ")}`);
	console.log(`  events:     ${o.eventCount}   age=${ageDays}d   lastSeen=${lastSeenDays}d ago`);
	for (const m of o.members) {
		for (const sf of o.storeFiles) {
			const hit = tryFindInDb(sf, m);
			if (hit) {
				console.log(`  found:      [${sf}] name="${hit.name}" url=${hit.url} removed=${hit.removed}`);
				break;
			}
		}
	}
	const ev = o.sampleEvents[0];
	if (ev) console.log(`  sample ev:  ${JSON.stringify(ev)}`);
	console.log("");
}

// Bucket by store file to see if a particular store/category accounts for most
const byStore = new Map();
for (const o of orphans.values()) {
	for (const sf of o.storeFiles) {
		byStore.set(sf, (byStore.get(sf) || 0) + 1);
	}
}
console.log(`\nOrphans by store DB file:`);
const stArr = Array.from(byStore.entries()).sort((a, b) => b[1] - a[1]);
for (const [sf, n] of stArr) console.log(`  ${String(n).padStart(5)}  ${sf}`);
