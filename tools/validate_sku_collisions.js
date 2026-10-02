#!/usr/bin/env node
"use strict";

// Hard gate for data/sku_collisions.json (docs/sku-collision-split-plan.md §3.3). Run after every edit:
//   node tools/validate_sku_collisions.js [--root <worktree>]   (default .worktrees/data)
// Exits 1 on any ERROR. The build tools only WARN on a stale matcher, so this is where it fails.

const fs = require("fs");
const path = require("path");
const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");
const { loadCollisionSplits, storeIdFromDbPath, normalizeListingUrl } = require("../src/utils/sku_collisions");

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validate(root) {
	const errors = [];
	const warnings = [];
	const notes = [];

	const dataDir = path.join(root, "data");
	const splits = loadCollisionSplits(dataDir);
	const entries = readJson(path.join(dataDir, "sku_collisions.json")).collisions;

	// Every data/db row whose normalized sku is collided, with what it resolves to.
	const rows = [];
	const dbDir = path.join(dataDir, "db");
	for (const f of fs.readdirSync(dbDir).filter((x) => x.endsWith(".json")).sort()) {
		const storeId = storeIdFromDbPath(f);
		for (const it of readJson(path.join(dbDir, f)).items) {
			const norm = normalizeImplicitSkuKey(String(it.sku ?? ""));
			if (!splits.collidedSkus.has(norm)) continue;
			rows.push({ dbFile: `data/db/${f}`, storeId, norm, rawSku: String(it.sku), url: it.url, name: it.name, removed: Boolean(it.removed), key: splits.resolve(storeId, String(it.sku), it.url) });
		}
	}

	// 2 + 3: matchers must match, and something must stay bare.
	for (const c of entries) {
		const norm = normalizeImplicitSkuKey(c.sku);
		const mine = rows.filter((r) => r.norm === norm);
		for (const s of c.split) {
			for (const l of s.listings) {
				const hit = mine.some((r) => r.storeId === l.storeId && (l.url === undefined || normalizeListingUrl(r.url) === normalizeListingUrl(l.url)));
				if (!hit) errors.push(`stale matcher: ${s.key} ${JSON.stringify(l)} matches no data/db row with sku ${norm}`);
			}
		}
		if (!mine.some((r) => r.key === r.rawSku)) warnings.push(`${c.sku}: every listing is split — the bare sku is dead`);
	}

	// 4: hides follow the resolved key (D8).
	const hidden = readJson(path.join(dataDir, "sku_hidden.json")).hidden;
	for (const h of hidden) {
		const sku = String(h.sku);
		if (sku.startsWith("c:")) {
			if (!splits.splitKeys.has(sku)) errors.push(`sku_hidden.json: ${h.storeId}|${sku} names no split key in sku_collisions.json`);
			else if (!rows.some((r) => r.storeId === h.storeId && r.key === sku)) errors.push(`sku_hidden.json: ${h.storeId}|${sku} matches no listing of that store`);
			continue;
		}
		const norm = normalizeImplicitSkuKey(sku);
		for (const r of rows) {
			if (r.storeId === h.storeId && r.norm === norm && r.key !== r.rawSku) {
				errors.push(`sku_hidden.json: ${h.storeId}|${sku} hides a split listing (${r.url}); name ${r.key} instead`);
			}
		}
	}

	// 5: auto links (both ends; an upgrade can start from a real number). A WARN, not an ERROR: the
	// tracker re-points these itself at the end of every scrape (src/tracker/sku_auto_links.js).
	for (const l of readJson(path.join(dataDir, "sku_links_auto.json")).links) {
		// The tracker only ever re-points onto a split, never back, so a removed or renamed split key
		// would dangle here for good.
		for (const side of ["fromSku", "toSku"]) {
			if (String(l[side]).startsWith("c:") && !splits.splitKeys.has(l[side])) {
				errors.push(`sku_links_auto.json: ${l.fromSku} -> ${l.toSku}: ${l[side]} names no split key (re-point it to the bare sku by hand)`);
			}
		}
		if (!l.dbFile || !l.url) continue;
		const storeId = storeIdFromDbPath(l.dbFile);
		for (const side of ["fromSku", "toSku"]) {
			const r = splits.resolve(storeId, l[side], l.url);
			if (r !== l[side]) warnings.push(`sku_links_auto.json: ${l.fromSku} -> ${l.toSku} (${l.dbFile}): the next scrape re-points ${side} to ${r}`);
		}
	}

	// 6: links/ignores on a collided sku, for a human to check they name the kept side.
	const names = new Map();
	for (const it of readJson(path.join(root, "viz", "data", "index.json")).items) {
		const k = normalizeImplicitSkuKey(it.sku);
		if (!names.has(k) || (!it.removed && names.get(k).removed)) names.set(k, { name: it.name, removed: it.removed });
	}
	const nameOf = (s) => (names.get(normalizeImplicitSkuKey(s)) || { name: "(not in index.json)" }).name;
	const links = readJson(path.join(dataDir, "sku_links.json"));
	const touching = (a, b) => [a, b].some((s) => splits.collidedSkus.has(normalizeImplicitSkuKey(s)) || String(s).startsWith("c:"));
	for (const [kind, list, fa, fb] of [["link", links.links, "fromSku", "toSku"], ["ignore", links.ignores || [], "skuA", "skuB"]]) {
		for (const l of list) {
			const a = l[fa];
			const b = l[fb];
			for (const s of [a, b]) {
				if (String(s).startsWith("c:") && !splits.splitKeys.has(s)) errors.push(`sku_links.json ${kind} ${a} ~ ${b}: ${s} names no split key`);
			}
			if (touching(a, b)) notes.push(`${kind.padEnd(6)} ${a} [${nameOf(a)}]  ~  ${b} [${nameOf(b)}]`);
		}
	}

	const rekeyed = rows.filter((r) => r.key !== r.rawSku).length;
	const summary = `${entries.length} collisions, ${splits.splitKeys.size} split keys, ${rekeyed} data/db rows re-keyed`;
	return { errors, warnings, notes, summary, rows };
}

const i = process.argv.indexOf("--root");
const root = i >= 0 ? process.argv[i + 1] : path.join(__dirname, "..", ".worktrees", "data");
const { errors, warnings, notes, summary } = validate(path.resolve(root));
if (notes.length) {
	console.log(`links/ignores on a collided or split sku (check each names the right side):`);
	for (const n of notes) console.log(`  ${n}`);
}
for (const w of warnings) console.log(`WARN: ${w}`);
for (const e of errors) console.log(`ERROR: ${e}`);
console.log(summary);
process.exitCode = errors.length ? 1 : 0;
