#!/usr/bin/env node
"use strict";

/*
  Build a report of canonical SKUs and how many STORES carry each one.
  - Store = storeKey (stable id derived from db filename).
  - Canonicalizes via sku_map.
  - Includes per-store numeric price (min live price per store for that SKU).
  - Writes one output file (see --out).

  Stability upgrade (default ON):
  - Uses a persisted "cohort" file to keep the TOP-N membership stable across days,
    so bottles near the cutoff don't churn and make downstream charts bumpy.
  - Default hysteresis margin = 1 storeCount.
    (A SKU from yesterday stays in the cohort as long as it is within 1 store of today's cutoff.)

  Flags:
    --top N
    --min-stores N
    --require-all
    --group all|bc|ab
    --out path

    Cohort / stability:
    --no-cohort              Disable cohort stabilization (old behavior)
    --cohort path            Cohort file path (default: reports/common_listings_cohort_<group>_top<top>.json)
    --margin N               Hysteresis margin in storeCount (default: 1)
    --include-ties           Include all SKUs tied at the cutoff (size may exceed --top)
*/

const path = require("path");
const { getStoreRegions } = require("../src/stores/index");
const { ensureDir, readJson, listDbFiles: _listDbFiles, storeKeyFromDbPath } = require("./lib/db");
const { priceToNumber } = require("./lib/sku");

/* ---------------- helpers ---------------- */

function listDbFiles() {
	return _listDbFiles(path.join(process.cwd(), "data", "db"));
}

function hasRealSku6(s) {
	return /\b\d{6}\b/.test(String(s || ""));
}

function isSyntheticSkuKey(k) {
	return String(k || "").startsWith("u:");
}

function stableRowSort(a, b) {
	// storeCount desc, then canonSku asc (stable diffs over time)
	if (b.storeCount !== a.storeCount) return b.storeCount - a.storeCount;
	return String(a.canonSku).localeCompare(String(b.canonSku));
}

/* ---------------- sku helpers ---------------- */

function loadSkuMapOrNull() {
	try {
		// eslint-disable-next-line node/no-missing-require
		const { loadSkuMap } = require(path.join(process.cwd(), "src/utils/sku_map"));
		return loadSkuMap({ dbDir: path.join(process.cwd(), "data/db") });
	} catch {
		return null;
	}
}

function normalizeSkuKeyOrEmpty({ skuRaw, storeLabel, url }) {
	try {
		// eslint-disable-next-line node/no-missing-require
		const { normalizeSkuKey } = require(path.join(process.cwd(), "src/utils/sku"));
		const k = normalizeSkuKey(skuRaw, { storeLabel, url });
		return k ? String(k) : "";
	} catch {
		const m = String(skuRaw ?? "").match(/\b(\d{6})\b/);
		if (m) return m[1];
		if (url) return `u:${storeLabel}:${url}`;
		return "";
	}
}

function canonicalize(k, skuMap) {
	if (!k) return "";
	if (skuMap && typeof skuMap.canonicalSku === "function") {
		return String(skuMap.canonicalSku(k) || k);
	}
	return k;
}

/* ---------------- grouping ---------------- */

const _storeRegions = getStoreRegions();

function groupAllowsStore(group, storeKey) {
	if (group === "all") return true;
	const region = (_storeRegions[String(storeKey || "").toLowerCase()] || "").toUpperCase();
	return region === group.toUpperCase();
}

/* ---------------- args ---------------- */

function parseArgs(argv) {
	const out = {
		top: 50,
		minStores: 2,
		requireAll: false,
		group: "all",
		out: "",

		// stability defaults (best defaults)
		useCohort: true,
		cohort: "",
		margin: 1, // hysteresis
		includeTies: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];

		if (a === "--top" && argv[i + 1]) out.top = Number(argv[++i]) || 50;
		else if (a === "--min-stores" && argv[i + 1]) out.minStores = Number(argv[++i]) || 2;
		else if (a === "--require-all") out.requireAll = true;
		else if (a === "--group" && argv[i + 1]) out.group = String(argv[++i] || "all").toLowerCase();
		else if (a === "--out" && argv[i + 1]) out.out = String(argv[++i] || "");

		// stability flags
		else if (a === "--no-cohort") out.useCohort = false;
		else if (a === "--cohort" && argv[i + 1]) out.cohort = String(argv[++i] || "");
		else if (a === "--margin" && argv[i + 1]) out.margin = Number(argv[++i]) || 0;
		else if (a === "--include-ties") out.includeTies = true;
	}

	if (out.group !== "all" && out.group !== "bc" && out.group !== "ab") out.group = "all";
	out.top = Number.isFinite(out.top) && out.top > 0 ? Math.floor(out.top) : 50;
	out.minStores = Number.isFinite(out.minStores) && out.minStores > 0 ? Math.floor(out.minStores) : 2;
	out.margin = Number.isFinite(out.margin) && out.margin >= 0 ? Math.floor(out.margin) : 1;

	return out;
}

/* ---------------- cohort selection (stable membership) ---------------- */

function loadPrevCohortList(cohortPath) {
	if (!cohortPath) return [];
	const prev = readJson(cohortPath);
	if (!prev) return [];
	if (Array.isArray(prev?.canonSkus)) return prev.canonSkus.map(String).filter(Boolean);
	if (Array.isArray(prev)) return prev.map(String).filter(Boolean);
	return [];
}

function pickStableMembership(rowsSorted, topN, { useCohort, cohortPath, margin, includeTies }) {
	const rows = Array.isArray(rowsSorted) ? rowsSorted : [];
	if (!rows.length) return { membership: new Set(), cutoff: 0, wroteCohort: false };

	const idx = Math.min(Math.max(topN - 1, 0), rows.length - 1);
	const cutoff = Number(rows[idx]?.storeCount || 0);

	// Option: include everyone tied at cutoff storeCount (size can exceed N)
	if (includeTies) {
		const membership = new Set(
			rows.filter((r) => Number(r?.storeCount || 0) >= cutoff).map((r) => String(r.canonSku)),
		);
		return { membership, cutoff, wroteCohort: false };
	}

	const membership = new Set();

	if (useCohort && cohortPath) {
		const prevList = loadPrevCohortList(cohortPath);
		const bySku = new Map(rows.map((r) => [String(r.canonSku), r]));

		// Keep previous cohort SKUs if still within hysteresis of cutoff
		for (const sku of prevList) {
			const r = bySku.get(sku);
			if (!r) continue;
			if (Number(r.storeCount || 0) >= cutoff - margin) {
				membership.add(sku);
				if (membership.size >= topN) break;
			}
		}
	}

	// Fill remaining slots from today's ranking
	for (const r of rows) {
		if (membership.size >= topN) break;
		membership.add(String(r.canonSku));
	}

	return { membership, cutoff, wroteCohort: false };
}

function writeCohortFile(cohortPath, { group, top, cutoff, margin, canonSkus }) {
	if (!cohortPath) return;
	ensureDir(path.dirname(cohortPath));
	fs.writeFileSync(
		cohortPath,
		JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				group,
				top,
				cutoffStoreCount: cutoff,
				margin,
				canonSkus,
			},
			null,
			2,
		) + "\n",
		"utf8",
	);
}

/* ---------------- main ---------------- */

function main() {
	const args = parseArgs(process.argv.slice(2));
	const repoRoot = process.cwd();
	const reportsDir = path.join(repoRoot, "reports");
	ensureDir(reportsDir);

	const outPath = args.out ? path.join(repoRoot, args.out) : path.join(reportsDir, "common_listings.json");
	ensureDir(path.dirname(outPath));

	const cohortPath = args.cohort
		? path.join(repoRoot, args.cohort)
		: path.join(reportsDir, `common_listings_cohort_${args.group}_top${args.top}.json`);

	const dbFiles = listDbFiles();
	if (!dbFiles.length) {
		console.error("No DB files found");
		process.exitCode = 2;
		return;
	}

	const skuMap = loadSkuMapOrNull();
	console.log(`[debug] skuMap: ${skuMap ? "loaded" : "missing"}`);
	console.log(`[debug] scanning ${dbFiles.length} db files`);

	const storeToCanon = new Map(); // storeKey -> Set(canonSku)
	const canonAgg = new Map(); // canonSku -> { stores:Set, listings:[], cheapest, storeMin:Map }

	let liveRows = 0;
	let removedRows = 0;

	for (const abs of dbFiles.sort()) {
		const obj = readJson(abs);
		if (!obj) continue;

		const storeLabel = String(obj.storeLabel || obj.store || "").trim();
		if (!storeLabel) continue;

		const storeKey = storeKeyFromDbPath(abs);
		if (!groupAllowsStore(args.group, storeKey)) continue;

		if (!storeToCanon.has(storeKey)) storeToCanon.set(storeKey, new Set());

		const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
		const items = Array.isArray(obj.items) ? obj.items : [];

		console.log(`[debug] ${rel} storeKey="${storeKey}" storeLabel="${storeLabel}" items=${items.length}`);

		for (const it of items) {
			if (!it) continue;
			if (it.removed) {
				removedRows++;
				continue;
			}
			liveRows++;

			const skuKey = normalizeSkuKeyOrEmpty({
				skuRaw: it.sku,
				storeLabel,
				url: it.url,
			});
			if (!skuKey) continue;

			const canonSku = canonicalize(skuKey, skuMap);
			if (!canonSku) continue;

			storeToCanon.get(storeKey).add(canonSku);

			let agg = canonAgg.get(canonSku);
			if (!agg) {
				agg = { stores: new Set(), listings: [], cheapest: null, storeMin: new Map() };
				canonAgg.set(canonSku, agg);
			}

			agg.stores.add(storeKey);

			const priceNum = priceToNumber(it.price);
			if (priceNum !== null) {
				const prev = agg.storeMin.get(storeKey);
				if (prev === undefined || priceNum < prev) agg.storeMin.set(storeKey, priceNum);
			}

			const listing = {
				canonSku,
				skuKey,
				skuRaw: String(it.sku || ""),
				name: String(it.name || ""),
				price: String(it.price || ""),
				priceNum,
				url: String(it.url || ""),
				storeKey,
				storeLabel,
				categoryLabel: String(obj.categoryLabel || obj.category || ""),
				dbFile: rel,
				hasRealSku6: hasRealSku6(it.sku) && !isSyntheticSkuKey(skuKey),
			};

			agg.listings.push(listing);

			if (priceNum !== null) {
				if (!agg.cheapest || priceNum < agg.cheapest.priceNum) {
					agg.cheapest = { priceNum, item: listing };
				}
			}
		}
	}

	const stores = [...storeToCanon.keys()].sort();
	const storeCount = stores.length;

	console.log(`[debug] group="${args.group}" stores(${storeCount}): ${stores.join(", ")}`);
	console.log(`[debug] liveRows=${liveRows} removedRows=${removedRows} canonSkus=${canonAgg.size}`);

	function pickRepresentative(agg) {
		const preferred = agg.listings
			.filter((l) => l.hasRealSku6)
			.sort((a, b) => (a.priceNum ?? Infinity) - (b.priceNum ?? Infinity));

		if (preferred.length) return preferred[0];
		if (agg.cheapest) return agg.cheapest.item;
		return agg.listings[0] || null;
	}

	const rows = [];

	for (const [canonSku, agg] of canonAgg.entries()) {
		const rep = pickRepresentative(agg);
		const missingStores = stores.filter((s) => !agg.stores.has(s));

		const storePrices = {};
		for (const s of stores) {
			const p = agg.storeMin.get(s);
			if (Number.isFinite(p)) storePrices[s] = p;
		}

		rows.push({
			canonSku,
			storeCount: agg.stores.size,
			stores: [...agg.stores].sort(),
			missingStores,
			storePrices, // { [storeKey]: number } min live price per store
			representative: rep
				? {
						name: rep.name,
						price: rep.price,
						priceNum: rep.priceNum,
						storeKey: rep.storeKey,
						storeLabel: rep.storeLabel,
						skuRaw: rep.skuRaw,
						skuKey: rep.skuKey,
						url: rep.url,
						categoryLabel: rep.categoryLabel,
						dbFile: rep.dbFile,
					}
				: null,
			cheapest: agg.cheapest
				? {
						price: agg.cheapest.item.price,
						priceNum: agg.cheapest.priceNum,
						storeKey: agg.cheapest.item.storeKey,
						url: agg.cheapest.item.url,
					}
				: null,
		});
	}

	// Base stable sort
	rows.sort(stableRowSort);

	const filtered = args.requireAll
		? rows.filter((r) => r.storeCount === storeCount)
		: rows.filter((r) => r.storeCount >= args.minStores);

	// Ensure filtered stays in stable order
	filtered.sort(stableRowSort);

	// Pick stable membership and then output rows in stable order
	let top = [];
	let cohortSkus = [];
	let cutoff = 0;

	if (!filtered.length) {
		top = [];
		cohortSkus = [];
		cutoff = 0;
	} else if (args.includeTies) {
		const idx = Math.min(Math.max(args.top - 1, 0), filtered.length - 1);
		cutoff = Number(filtered[idx]?.storeCount || 0);
		top = filtered.filter((r) => Number(r?.storeCount || 0) >= cutoff);
		top.sort(stableRowSort);
		cohortSkus = top.map((r) => String(r.canonSku));
	} else {
		const sel = pickStableMembership(filtered, args.top, {
			useCohort: args.useCohort,
			cohortPath: args.useCohort ? cohortPath : "",
			margin: args.margin,
			includeTies: false,
		});
		cutoff = sel.cutoff;

		top = filtered.filter((r) => sel.membership.has(String(r.canonSku)));
		top.sort(stableRowSort);

		// Persist cohort as the stable-sorted output order (min diffs, deterministic)
		cohortSkus = top.map((r) => String(r.canonSku));

		if (args.useCohort) {
			writeCohortFile(cohortPath, {
				group: args.group,
				top: args.top,
				cutoff,
				margin: args.margin,
				canonSkus: cohortSkus,
			});
		}
	}

	const payload = {
		generatedAt: new Date().toISOString(),
		args: {
			top: args.top,
			minStores: args.minStores,
			requireAll: args.requireAll,
			group: args.group,
			out: path.relative(repoRoot, outPath).replace(/\\/g, "/"),

			// extra info (non-breaking)
			stability: {
				enabled: !!args.useCohort && !args.includeTies,
				includeTies: !!args.includeTies,
				margin: args.margin,
				cohortFile: args.useCohort ? path.relative(repoRoot, cohortPath).replace(/\\/g, "/") : "",
				cutoffStoreCount: cutoff,
			},
		},
		storeCount,
		stores,
		totals: {
			liveRows,
			removedRows,
			canonSkus: canonAgg.size,
			outputCount: top.length,
		},
		rows: top,
	};

	fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
	console.log(`Wrote ${path.relative(repoRoot, outPath)} (${top.length} rows)`);
}

main();
