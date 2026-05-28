#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const DB_DIR = path.join(__dirname, "../data/db");
const LINKS_FILE = path.join(__dirname, "../data/sku_links.json");

const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");

// collect all valid SKUs from db files (normalized)
const validSkus = new Set();

for (const file of fs.readdirSync(DB_DIR)) {
	if (!file.endsWith(".json")) continue;
	const data = JSON.parse(fs.readFileSync(path.join(DB_DIR, file), "utf8"));
	if (!Array.isArray(data.items)) continue;
	for (const item of data.items) {
		if (!item || !item.sku) continue;
		const k = normalizeImplicitSkuKey(item.sku);
		if (k) validSkus.add(k);
	}
}

// load links
const linksData = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
const originalCount = Array.isArray(linksData.links) ? linksData.links.length : 0;

let prunedMissing = 0;
let prunedAuto = 0;
let prunedDup = 0;

const seen = new Set(); // dedupe after normalization
const nextLinks = [];

for (const x of Array.isArray(linksData.links) ? linksData.links : []) {
	const a = normalizeImplicitSkuKey(x?.fromSku);
	const b = normalizeImplicitSkuKey(x?.toSku);

	if (!a || !b) {
		prunedMissing++;
		continue;
	}

	// drop links that are now implicit (id:1234 <-> 001234 etc)
	if (a === b) {
		prunedAuto++;
		continue;
	}

	// keep only links where BOTH normalized skus exist in db
	if (!validSkus.has(a) || !validSkus.has(b)) {
		prunedMissing++;
		continue;
	}

	// dedupe (undirected) after normalization
	const key = a < b ? `${a}|${b}` : `${b}|${a}`;
	if (seen.has(key)) {
		prunedDup++;
		continue;
	}
	seen.add(key);

	nextLinks.push({ fromSku: a, toSku: b });
}

const ignores = Array.isArray(linksData.ignores) ? linksData.ignores : [];

// write back in place (compact, no timestamps)
fs.writeFileSync(LINKS_FILE, JSON.stringify({ links: nextLinks, ignores }) + "\n");

const totalPruned = originalCount - nextLinks.length;

console.log(`Pruned ${totalPruned} total links`);
console.log(`- ${prunedAuto} now-implicit (id:<1-6> ↔ CSPC)`);
console.log(`- ${prunedMissing} missing/invalid vs db`);
console.log(`- ${prunedDup} duplicates after normalization`);
console.log(`Remaining ${nextLinks.length}`);
