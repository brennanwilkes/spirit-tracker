#!/usr/bin/env node
// tools/mine_sku_aliases.mjs — mine token-variant pairs (typos, abbreviations,
// equivalent units) from CONFIRMED links in data/sku_links.json and emit a small
// conservative alias table: viz/app/linker_page/sku_aliases.js (Phase 3).
//
// Alignments counted when, across a confirmed pair's token sets, token x on side A
// "matches" token y on side B and x !== y. Evidence kinds:
//   - levenshtein <= 1 on letters-only-ish tokens (len >= 3, same digit core)
//   - numeric-with-unit equivalence (1000ml == 1l, 375ml == 12.7oz)
//   - common abbreviation (ml <-> milliliter, liter <-> litre, oz <-> ounce)
// Drops pairs that also appear in any IGNORE pair; keeps only tokens with support >= 2
// whose every token maps to exactly one partner (unambiguous).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tokenizeQuery } from "../viz/app/sku.js";
import { levenshtein } from "../viz/app/linker_page/similarity.js";
import { loadEnv } from "./audit_search_core.mjs";

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, "..");
const OUT_FILE = path.join(REPO_ROOT, "viz", "app", "linker_page", "sku_aliases.js");

const MIN_SUPPORT = 2;
const TOP_N = 20;

// Human-owned denylist. Levenshtein alignment finds these because two genuinely-linked
// bottles happen to differ by one letter somewhere, but they are not variants of one word
// and expanding them only inflates the pool. `port` especially (port cask, Port Mourant).
// Regenerating the table must not resurrect them, so the trim lives here, not in the output.
const DENY_PAIRS = [["light", "night"], ["doon", "toon"], ["dete", "ete"], ["port", "post"], ["rufty", "tufty"], ["gran", "grand"]];

const VOL_ML = { ml: 1, cl: 10, l: 1000, liter: 1000, litre: 1000, liters: 1000, litres: 1000, oz: 29.5735, ounce: 29.5735, ounces: 29.5735 };
const UNIT_INLINE_RE = /^(\d+(?:\.\d+)?)(ml|cl|l|liter|litre|liters|litres|oz|ounce|ounces)$/;
const unitMl = (t) => {
	const m = String(t || "").match(UNIT_INLINE_RE);
	return m ? parseFloat(m[1]) * (VOL_ML[m[2]] || 1) : null;
};

const ABBREV_CANON = new Map([
	["ml", "ml"], ["milliliter", "ml"], ["milliliters", "ml"], ["millilitre", "ml"], ["millilitres", "ml"],
	["cl", "cl"], ["centiliter", "cl"], ["centilitre", "cl"], ["centiliters", "cl"],
	["l", "l"], ["liter", "l"], ["liters", "l"], ["litre", "l"], ["litres", "l"],
	["oz", "oz"], ["ounce", "oz"], ["ounces", "oz"],
]);

const isNumeric = (t) => /^\d+$/.test(t);
const digitify = (t) => String(t).replace(/\D+/g, "");

function alignmentsFor(a, b) {
	const out = new Set();
	for (const x of a) {
		for (const y of b) {
			if (x === y) continue;
			let hit = false;
			if (x.length >= 3 && y.length >= 3 && !(isNumeric(x) && isNumeric(y)) && digitify(x) === digitify(y) && levenshtein(x, y) <= 1) hit = true;
			if (!hit && unitMl(x) != null && unitMl(y) != null) {
				const xm = unitMl(x);
				const ym = unitMl(y);
				const span = Math.max(xm, ym);
				if (span > 0 && Math.abs(xm - ym) / span <= 0.01) hit = true;
			}
			if (!hit && ABBREV_CANON.get(x) && ABBREV_CANON.get(x) === ABBREV_CANON.get(y)) hit = true;
			if (!hit) continue;
			out.add(x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
		}
	}
	return [...out];
}

const pairKey = (x, y) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
const DENY = new Set(DENY_PAIRS.map(([x, y]) => pairKey(x, y)));

async function main() {
	const args = process.argv.slice(2);
	const get = (k) => {
		const i = args.indexOf(k);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const worktree = get("--worktree") || process.env.DATA_WORKTREE || path.join(REPO_ROOT, ".worktrees", "data");

	const env = await loadEnv(worktree);
	const nameFor = (s) => env.bySku.get(String(s))?.name || "";

	const counts = new Map();
	let pairs = 0;
	let skipped = 0;
	for (const l of env.allLinks) {
		const f = String(l.fromSku || l.skuA || "").trim();
		const t = String(l.toSku || l.skuB || "").trim();
		if (!f || !t || f === t) continue;
		const na = nameFor(f);
		const nb = nameFor(t);
		if (!na || !nb) {
			skipped++;
			continue;
		}
		const ta = tokenizeQuery(na);
		const tb = tokenizeQuery(nb);
		if (!ta.length || !tb.length) continue;
		const al = alignmentsFor(ta, tb);
		if (!al.length) continue;
		pairs++;
		const seen = new Set();
		for (const k of al) {
			if (seen.has(k)) continue;
			seen.add(k);
			const [x, y] = k.split("\u0000");
			let e = counts.get(k);
			if (!e) counts.set(k, (e = { x, y, count: 0, aName: na, bName: nb }));
			e.count++;
		}
	}

	const ignoreHit = new Set();
	let ignorePairs = 0;
	for (const ig of env.ignoreEntries) {
		const f = String(ig.skuA || ig.fromSku || "").trim();
		const t = String(ig.skuB || ig.toSku || "").trim();
		if (!f || !t || f === t) continue;
		const na = nameFor(f);
		const nb = nameFor(t);
		if (!na || !nb) continue;
		const al = alignmentsFor(tokenizeQuery(na), tokenizeQuery(nb));
		if (!al.length) continue;
		ignorePairs++;
		for (const k of al) ignoreHit.add(k);
	}

	let cands = [...counts.values()].filter((e) => e.count >= MIN_SUPPORT);
	const droppedVsIgnores = cands.filter((e) => ignoreHit.has(pairKey(e.x, e.y))).length;
	cands = cands.filter((e) => !ignoreHit.has(pairKey(e.x, e.y)));
	const droppedVsDeny = cands.filter((e) => DENY.has(pairKey(e.x, e.y))).length;
	cands = cands.filter((e) => !DENY.has(pairKey(e.x, e.y)));

	const partners = new Map();
	for (const e of cands) {
		let s = partners.get(e.x);
		if (!s) partners.set(e.x, (s = new Set()));
		s.add(e.y);
		s = partners.get(e.y);
		if (!s) partners.set(e.y, (s = new Set()));
		s.add(e.x);
	}
	cands = cands.filter((e) => partners.get(e.x).size === 1 && partners.get(e.y).size === 1);
	cands.sort((a, b) => b.count - a.count || (a.x !== b.x ? (a.x < b.x ? -1 : 1) : a.y < b.y ? -1 : 1));

	const rows = cands.map((e) => `	["${e.x}", "${e.y}"],`);
	const moduleSrc = `// Generated by tools/mine_sku_aliases.mjs — do not edit by hand.
// Rows are undirected; buildAliasTable() expands both directions.
// Regenerate with: node tools/mine_sku_aliases.mjs
export const SKU_ALIASES = [
${rows.join("\n")}
];

export function buildAliasTable() {
	const m = new Map();
	for (const [s, t] of SKU_ALIASES) {
		let a = m.get(s);
		if (!a) m.set(s, (a = []));
		a.push(t);
		a = m.get(t);
		if (!a) m.set(t, (a = []));
		a.push(s);
	}
	return m;
}
`;
	fs.writeFileSync(OUT_FILE, moduleSrc);

	console.log(`links resolved: ${pairs}/${env.allLinks.length} pairs with >=1 alignment (${skipped} skipped: no name in index)`);
	console.log(`alignments mined: ${counts.size}`);
	console.log(`ignore pairs checked: ${ignorePairs} (${ignoreHit.size} distinct alignments blocked)`);
	console.log(`after min-support >= ${MIN_SUPPORT}: ${[...counts.values()].filter((e) => e.count >= MIN_SUPPORT).length}`);
	console.log(`dropped vs ignores: ${droppedVsIgnores}`);
	console.log(`dropped vs denylist: ${droppedVsDeny}`);
	console.log(`after unambiguous gate: ${cands.length}`);
	console.log(`emitted SKU_ALIASES rows: ${cands.length} (alias-table Map keys: ${cands.length * 2})`);
	console.log(`wrote ${path.relative(REPO_ROOT, OUT_FILE)}\n`);
	console.log(`top ${Math.min(TOP_N, cands.length)} aliases by support:`);
	console.log(`${"count".padStart(5)}  ${"source".padEnd(24)} ${"target".padEnd(24)} example`);
	for (const e of cands.slice(0, TOP_N)) {
		const ex = `${e.aName.slice(0, 30)} ↔ ${e.bName.slice(0, 30)}`;
		console.log(`${String(e.count).padStart(5)}  ${e.x.padEnd(24)} ${e.y.padEnd(24)} ${ex}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});