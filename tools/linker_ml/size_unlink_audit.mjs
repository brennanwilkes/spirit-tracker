#!/usr/bin/env node
/**
 * tools/linker_ml/size_unlink_audit.mjs — list confirmed direct LINK edges (data/sku_links.json
 * `links`) where the two SKUs have a genuine SIZE conflict (sizePen < 0.5, e.g. 375 vs 750).
 * Per the user, different bottle sizes must NOT be linked → these are UNLINK candidates.
 * Read-only: prints a table for human review; does NOT edit sku_links.json.
 *
 * Run from repo root:  node tools/linker_ml/size_unlink_audit.mjs
 */
import { buildEnv, featurizePair } from "./featurize.mjs";
import { parseSizesMlFromText } from "../../viz/app/linker_page/size.js";

const env = buildEnv();
const nm = (s) => env.bySku.get(String(s))?.name || "?";
const present = (s) => env.bySku.has(String(s));
const SIZE_BUCKET = (ml) => {
	if (ml === 700 || ml === 750) return 750;
	if (ml === 350 || ml === 375) return 375;
	return ml;
};
const sizesOf = (s) => [...new Set(parseSizesMlFromText(nm(s)).map(SIZE_BUCKET))].sort((a, b) => a - b);

const seen = new Set();
const rows = [];
for (const l of env.manualLinks) {
	if (l.noTrain) continue;
	const a = String(l.fromSku || l.skuA || "").trim();
	const b = String(l.toSku || l.skuB || "").trim();
	if (!a || !b || a === b || !present(a) || !present(b)) continue;
	const k = a < b ? `${a}|${b}` : `${b}|${a}`;
	if (seen.has(k)) continue;
	seen.add(k);
	const f = featurizePair(a, b, env);
	if (!f) continue;
	if ((f.sizePen ?? 1) < 0.5) {
		const sa = sizesOf(a);
		const sb = sizesOf(b);
		// GENUINE conflict: both names state an explicit size and the buckets are disjoint
		// (e.g. 375 vs 750). Otherwise sizePen<0.5 is an INFERRED/one-sided penalty (price-ratio
		// guess or only one side states a size) — not bad data, just an aggressive multiplier.
		const genuine = sa.length > 0 && sb.length > 0 && !sa.some((x) => sb.includes(x));
		rows.push({ a, b, sizePen: f.sizePen, sa, sb, genuine });
	}
}
rows.sort((x, y) => (y.genuine - x.genuine) || (x.sizePen - y.sizePen));

const genuine = rows.filter((r) => r.genuine);
const inferred = rows.filter((r) => !r.genuine);

const fmt = (a) => (a.length ? a.map((m) => `${m}mL`).join("/") : "?");
const printTable = (list) => {
	console.log("| SKU A | name A | SKU B | name B | sizes (A vs B) | sizePen |");
	console.log("|---|---|---|---|---|---|");
	for (const r of list) {
		console.log(`| ${r.a} | ${nm(r.a).slice(0, 40)} | ${r.b} | ${nm(r.b).slice(0, 40)} | ${fmt(r.sa)} vs ${fmt(r.sb)} | ${r.sizePen.toFixed(2)} |`);
	}
};

console.log(`# Size-variant UNLINK candidates — ${rows.length} confirmed LINK edges with sizePen < 0.5`);
console.log(`# ${genuine.length} GENUINE (both sides explicit, disjoint sizes — BAD LINKS) + ${inferred.length} inferred/one-sided (review-only)\n`);
console.log(`## GENUINE size conflicts (both sides state a different explicit size) — ${genuine.length}\n`);
printTable(genuine);
// One-sided cases where the ONLY explicit size is a SMALL/odd format (375/350/200/50/1140/1750).
// These are the highest-suspicion of the "inferred" bucket: a 375 explicitly linked to an unsized
// listing that is almost certainly the standard 750.
const ODD = new Set([375, 350, 200, 100, 50, 1140, 1750, 1000]);
const suspectOneSided = inferred.filter((r) => {
	const only = [...r.sa, ...r.sb];
	return only.length > 0 && only.every((m) => ODD.has(m));
});
console.log(`\n## Suspect one-sided small/odd-format (one side explicitly 375/200/1.14L/etc, other unsized) — ${suspectOneSided.length}\n`);
printTable(suspectOneSided);

console.log(`\n## All other inferred / one-sided sizePen<0.5 (mostly punctuation/word-form variants, NOT bad data) — ${inferred.length}\n`);
printTable(inferred);
