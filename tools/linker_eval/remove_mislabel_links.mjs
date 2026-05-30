#!/usr/bin/env node
/**
 * tools/linker_eval/remove_mislabel_links.mjs — surgically delete specific bad LINK edges
 * from the (minified, hand-edited) data/sku_links.json in the data worktree.
 *
 * Follows the "Editing data (mislabels)" protocol in tools/linker_eval/CLAUDE.md:
 *   - never reformats the file (string surgery on the exact `{"fromSku":..,"toSku":..}`
 *     object, both key orders), so the byte layout of every untouched edge is preserved;
 *   - backs the file up first;
 *   - verifies the round-trip: re-parses and asserts ONLY the targeted edges disappeared
 *     (ignores array byte-identical, links count drops by exactly N, no other edge changed).
 *
 * DRY-RUN by default. Pass --apply to write. Set EDGES below.
 *
 *   node tools/linker_eval/remove_mislabel_links.mjs            # dry-run, prints the diff
 *   node tools/linker_eval/remove_mislabel_links.mjs --apply    # writes (after backup)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = process.env.DATA_WORKTREE || path.resolve(HERE, "../../.worktrees/data");
const FILE = path.join(WORKTREE, "data/sku_links.json");
const APPLY = process.argv.includes("--apply");

// The exact bad LINK edges to delete. Order-insensitive (both fromSku/toSku orders tried).
const EDGES = [
	{ a: "107404", b: "105948", why: "Drumshanbo 50 mL mini wrongly grouped with 700/750 mL bottles" },
	{ a: "upc:506038365139", b: "822509", why: "Adelphi Caol Ila 2008 12yr ≠ Caol Ila 2010 (different vintage/cask)" },
	{ a: "upc:502061308470", b: "372568", why: "Benromach Peat Sherry 2012 ≠ Peat Smoke Sherry 2014 (bridging edge; keeps 372568↔893858)" },
];

const raw = fs.readFileSync(FILE, "utf8");
const before = JSON.parse(raw);
const beforeLinks = before.links || [];
const beforeIgnores = before.ignores || [];

function edgeVariants(a, b) {
	return [
		`{"fromSku":${JSON.stringify(a)},"toSku":${JSON.stringify(b)}}`,
		`{"fromSku":${JSON.stringify(b)},"toSku":${JSON.stringify(a)}}`,
	];
}

let text = raw;
const removed = [];
for (const e of EDGES) {
	let cut = false;
	for (const v of edgeVariants(e.a, e.b)) {
		if (!text.includes(v)) continue;
		// remove the object plus exactly one adjacent comma (leading if present, else trailing)
		if (text.includes("," + v)) text = text.replace("," + v, "");
		else if (text.includes(v + ",")) text = text.replace(v + ",", "");
		else text = text.replace(v, ""); // sole element
		removed.push({ ...e, matched: v });
		cut = true;
		break;
	}
	if (!cut) console.warn(`  ⚠ NOT FOUND (already gone?): ${e.a} ↔ ${e.b}`);
}

// ---- verify round-trip ----
const after = JSON.parse(text); // throws if string surgery broke JSON
const afterLinks = after.links || [];
const afterIgnores = after.ignores || [];

const key = (e) => `${e.fromSku}|${e.toSku}`;
const removedKeys = new Set();
for (const e of removed) {
	const obj = JSON.parse(e.matched);
	removedKeys.add(key(obj));
}
const beforeSet = beforeLinks.map(key);
const afterSet = new Set(afterLinks.map(key));
const droppedKeys = beforeSet.filter((k) => !afterSet.has(k));

const ignoresIdentical = JSON.stringify(beforeIgnores) === JSON.stringify(afterIgnores);
const countOk = afterLinks.length === beforeLinks.length - removed.length;
const onlyTargetsDropped = droppedKeys.length === removed.length && droppedKeys.every((k) => removedKeys.has(k));

console.log(`file: ${FILE}`);
console.log(`links: ${beforeLinks.length} → ${afterLinks.length}   ignores: ${beforeIgnores.length} → ${afterIgnores.length}`);
console.log(`removed ${removed.length} edge(s):`);
for (const e of removed) console.log(`   - ${e.matched}   (${e.why})`);
console.log(`verify: ignores byte-identical=${ignoresIdentical}  count-correct=${countOk}  only-targets-dropped=${onlyTargetsDropped}`);

if (!ignoresIdentical || !countOk || !onlyTargetsDropped) {
	console.error("✗ VERIFICATION FAILED — refusing to write. No changes made.");
	process.exit(1);
}

if (!APPLY) {
	console.log("\nDRY-RUN ok. Re-run with --apply to write (a .bak backup is made first).");
	process.exit(0);
}

const bak = FILE + ".premislabel.bak";
fs.writeFileSync(bak, raw);
fs.writeFileSync(FILE, text);
console.log(`\n✓ written. backup → ${bak}`);
