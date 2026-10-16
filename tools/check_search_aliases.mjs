#!/usr/bin/env node
// Acceptance check for viz/app/search_aliases.js against a real index.json, through the live
// catalog aggregation and query matcher. Spec: docs/gm-search-aliasing.md §"Acceptance check".
//
//   node tools/check_search_aliases.mjs [--index <index.json>] [--data <data worktree>] [--list]
//
// Exits 1 on any failed assertion. --list prints every group the G&M alias returns that the
// explicit-marker yardstick does not, for review.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { aggregateBySku } from "../viz/app/catalog.js";
import { tokenizeQuery, matchesAllTokens } from "../viz/app/sku.js";

const require = createRequire(import.meta.url);
const { loadSkuMap } = require("../src/utils/sku_map.js");
const { loadHiddenSet } = require("../src/utils/sku_hidden.js");

const args = process.argv.slice(2);
function argVal(flag, dflt) {
	const i = args.indexOf(flag);
	return i === -1 ? dflt : args[i + 1];
}
const dataRoot = path.resolve(argVal("--data", ".worktrees/data"));
const indexFile = path.resolve(argVal("--index", path.join(dataRoot, "viz/data/index.json")));
const listExtras = args.includes("--list");

const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
const { canonicalSku } = loadSkuMap({ dbDir: path.join(dataRoot, "data/db") });
const hidden = loadHiddenSet(path.join(dataRoot, "data"));
const groups = aggregateBySku(index.items, canonicalSku, hidden);

const namesBySku = new Map();
for (const r of index.items) {
	const sku = canonicalSku(String(r.sku || ""));
	if (!namesBySku.has(sku)) namesBySku.set(sku, new Set());
	namesBySku.get(sku).add(String(r.name || ""));
}
const names = (sku) => [...(namesBySku.get(sku) || [])];

function search(q) {
	const tokens = tokenizeQuery(q);
	return new Set(groups.filter((g) => matchesAllTokens(g.searchText, tokens)).map((g) => g.sku));
}

// Independent yardstick: the doc's "explicit G&M group" (a listing name names the bottler).
const EXPLICIT = /gordon\s*(?:&|and|\/)?\s*mac\s*phail|\bg\s*(?:&|and)\s*m\b|\bgm\b|macphails/i;
const explicit = new Set(groups.filter((g) => names(g.sku).some((n) => EXPLICIT.test(n))).map((g) => g.sku));

let failures = 0;
function check(ok, msg) {
	console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
	if (!ok) failures++;
}

const SPELLINGS = ["g&m", "G & M", "gm", "g and m", "g+m", "g/m", "gordon macphail", "Gordon & MacPhail", "gordon and macphail", "GORDON/MACPHAIL"];
const gm = search(SPELLINGS[0]);
for (const q of SPELLINGS.slice(1)) {
	const s = search(q);
	const same = s.size === gm.size && [...s].every((x) => gm.has(x));
	check(same, `"${q}" returns the same ${gm.size} groups as "g&m" (got ${s.size})`);
}

const missing = [...explicit].filter((s) => !gm.has(s));
check(missing.length === 0, `all ${explicit.size} explicit G&M groups returned (missing ${missing.length})`);
for (const s of missing) console.log(`      missing ${s}: ${names(s).join(" / ")}`);

const MARKERLESS = [
	/GLEN GRANT MR\. GEORGE LEGACY 2ND ED 1957/,
	/MR\. GEORGE EDITION 3 GLEN GRANT 1959/,
	/PRIVATE COLLECTION MILTON 1949/,
	/Braes of Glenlivet 1975 31 Year Old Connoisseurs Choice/,
];
for (const re of MARKERLESS) {
	const hits = [...gm].filter((s) => names(s).some((n) => re.test(n)));
	check(hits.length > 0, `marker-less G&M bottle included: ${re.source}`);
}

const FORBIDDEN = [/gordon'?s|gordon’s|gordon`s|gordons|\bgordon london/i, /invergordon/i, /benromach/i];
for (const re of FORBIDDEN) {
	const bad = [...gm].filter((s) => {
		const ns = names(s);
		return ns.some((n) => re.test(n)) && !ns.some((n) => EXPLICIT.test(n));
	});
	check(bad.length === 0, `no un-marked ${re.source} group in the G&M set (found ${bad.length})`);
	for (const s of bad) console.log(`      ${s}: ${names(s).join(" / ")}`);
}

const gordon = search("gordon");
check([...gordon].some((s) => names(s).some((n) => /gordon'?s london dry/i.test(n))), `"gordon" alone still returns Gordon's Gin`);

const gmMacallan = search("g&m macallan");
const strays = [...gmMacallan].filter((s) => !gm.has(s));
check(gmMacallan.size > 0 && strays.length === 0, `"g&m macallan" returns ${gmMacallan.size} groups, all G&M (${strays.length} strays)`);

const extras = [...gm].filter((s) => !explicit.has(s));
console.log(`\nG&M alias set: ${gm.size} groups = ${explicit.size} explicit + ${extras.length} via range name / url`);
if (listExtras) for (const s of extras) console.log(`  + ${s}: ${names(s).join(" / ")}`);

process.exit(failures ? 1 : 0);
