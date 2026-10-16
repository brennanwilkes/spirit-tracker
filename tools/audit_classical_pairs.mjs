#!/usr/bin/env node
// Classical (token) similarity over EVERY undecided pair in the catalog, with the retired #/link-rapid
// page's scorer (scorePairWithVocab on a distinctive-term candidate index, squashed with
// toConfidence01, ignores applied at canonical-group level) but featurize's vocab and aggregates, not
// the page's, so scores can differ from what the page showed. tools/audit_page_oracle.mjs replays the page itself.
//
// Why this exists alongside the rich file: scripts/audit_new_listings.js scores ONE aggregate name per
// sku (featurize's first live row), while the page showed each store's own display name. "OMC 25th Annv
// Fettercairn 15 Year" vs "OMC 25th Annv Inchgower 15 Year" scored 0.99 on the page and 0.06 in the
// rich file, because CLB names the second sku "Omc Inchgower 700ml". This tool scores every live
// store-name variant of every sku and keeps the best pair per canonical group pair, so nothing the page
// could have surfaced is missed. Feed its output to tools/audit_undecided_pairs.js --classical.
//
//   DATA_WORKTREE=.worktrees/data node tools/audit_classical_pairs.mjs --min 0.5 --out audit/classical.jsonl
import fs from "node:fs";
import { buildEnv } from "./linker_ml/featurize.mjs";
import { prepScorePairCtx, scorePairWithVocab } from "../viz/app/linker_page/suggestions.js";
import { toConfidence01 } from "../viz/app/linker_page/blend.js";
import { buildGroupsAndCanonicalMap, normalizeImplicitSkuKey } from "../viz/app/sku_canonical.js";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const MIN = Number(arg("--min"));
const OUT = arg("--out");
if (!Number.isFinite(MIN) || !OUT) {
	console.error("usage: audit_classical_pairs.mjs --min <0..1> --out <file.jsonl>");
	process.exit(2);
}
const CAND_CAP = 600; // the page's REFINE_CAND_CAP

const env = buildEnv();
const { allAgg, bySku, rows, vocab, sizeFn, priceFn, allLinks, ignoreEntries } = env;

const { canonBySku } = buildGroupsAndCanonicalMap(allLinks);
const canonicalSku = (s) => {
	const k = normalizeImplicitSkuKey(s);
	return canonBySku.get(k) || k;
};
const pairKey = (a, b) => {
	const x = canonicalSku(a);
	const y = canonicalSku(b);
	return x < y ? `${x}|${y}` : `${y}|${x}`;
};
const ignored = new Set(ignoreEntries.map((ig) => pairKey(ig.skuA, ig.skuB)));

const variantsBySku = new Map();
for (const agg of allAgg) variantsBySku.set(String(agg.sku), new Set([agg.name]));
for (const r of rows) {
	const sku = String(r.sku || "");
	if (r.removed || !r.name || !variantsBySku.has(sku)) continue;
	variantsBySku.get(sku).add(r.name);
}
const entries = [];
for (const [sku, names] of variantsBySku) for (const name of names) entries.push({ ...bySku.get(sku), name });

const termIndex = new Map();
for (const e of entries) {
	const terms = vocab.distinctiveUnigramsForName(e.name);
	if (!terms) continue;
	for (const t of terms) {
		if (!termIndex.has(t)) termIndex.set(t, []);
		termIndex.get(t).push(e);
	}
}

const best = new Map();
let done = 0;
const t0 = Date.now();
for (const e of entries) {
	const terms = vocab.distinctiveUnigramsForName(e.name);
	if (terms && terms.size) {
		const ctx = prepScorePairCtx(e, { vocab, sizePenaltyFn: sizeFn, pricePenaltyFn: priceFn });
		const eSku = String(e.sku);
		let visited = 0;
		const seen = new Set();
		outer: for (const t of terms) {
			for (const cand of termIndex.get(t) || []) {
				const cSku = String(cand.sku);
				const seenKey = `${cSku}\u0000${cand.name}`;
				if (cSku === eSku || seen.has(seenKey)) continue;
				seen.add(seenKey);
				if (canonicalSku(eSku) === canonicalSku(cSku)) continue;
				const k = pairKey(eSku, cSku);
				if (ignored.has(k)) continue;
				const s = toConfidence01(scorePairWithVocab(ctx, cand));
				if (s >= MIN && (!best.has(k) || s > best.get(k).classical))
					best.set(k, { a: eSku, b: cSku, classical: +s.toFixed(3), aName: e.name, bName: cand.name });
				if (++visited >= CAND_CAP) break outer;
			}
		}
	}
	if (++done % 5000 === 0) console.error(`  ${done}/${entries.length} name variants (${((Date.now() - t0) / 1000).toFixed(0)}s) · ${best.size} pairs`);
}
const out = [...best.values()].sort((x, y) => y.classical - x.classical);
fs.writeFileSync(OUT, out.map((p) => JSON.stringify(p)).join("\n") + "\n");
console.log(`${entries.length} name variants of ${variantsBySku.size} skus → ${out.length} undecided pairs with classical ≥ ${MIN} → ${OUT}`);
