#!/usr/bin/env node
// Cross-store SKU collision census.
//
// Two genuinely different products can share one normalized SKU because store numbering
// namespaces overlap. The listings then aggregate into ONE canonical item for free, with no
// entry in sku_links.json — so no `unlink` can separate them, and the wrong product's title can
// end up owning the aggregate name (which poisons every name feature and every blocking channel
// for that sku: measured cases score 0.0005 on links that are plainly correct).
//
// This emits a CANDIDATE list, not a verdict. A collision is only a DEFECT when the two products
// belong in different canonical groups; when policy would link them anyway (a rare-item bundle
// colliding with that same rare item, a size variant in tolerance), the free merge is correct.
// That judgement is the agent's — see docs/audit-runbook.md, "One sku, two products".
import fs from "node:fs";
import path from "node:path";

const root = process.argv.includes("--root") ? process.argv[process.argv.indexOf("--root") + 1] : ".worktrees/data";
const outFile = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "audit/sku-collisions.json";

const idx = JSON.parse(fs.readFileSync(path.join(root, "viz/data/index.json"), "utf8"));

// Size/volume/proof tokens and generic retail words carry no brand identity, so they must not
// count as evidence that two titles describe the same product.
const STOP = new Set(("ml l litre liter cl oz bottle bottles whisky whiskey scotch single malt blended " +
	"rum gin vodka spirit spirits liqueur year years yr yrs old aged abv proof cask casks finish " +
	"edition release the a an and of with x750 750 700 1140 1750 375 200 50 500 vol").split(/\s+/));

// Apostrophes are DELETED, not spaced: "Gordon's" must fold to the same token as "GORDONS",
// otherwise every possessive brand looks like a collision. Trailing plural 's' is folded for the
// same reason ("Bells" / "Bell's" / "Bell").
const fold = (t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
const norm = (s) => String(s || "").toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9\s]/g, " ")
	.split(/\s+/).filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t)).map(fold)
	.filter((t) => !STOP.has(t));

const bySku = new Map();
for (const it of idx.items) {
	if (!it || !it.sku) continue;
	const k = it.sku;
	if (!bySku.has(k)) bySku.set(k, []);
	bySku.get(k).push({ store: it.storeLabel || it.store, name: it.name, price: it.price, removed: !!it.removed, url: it.url });
}

const out = [];
for (const [sku, rows] of bySku) {
	const stores = new Set(rows.map((r) => r.store));
	if (stores.size < 2) continue;
	// One representative title per store — within-store duplicates are a different defect class.
	const perStore = new Map();
	for (const r of rows) if (!perStore.has(r.store)) perStore.set(r.store, r);
	const entries = [...perStore.values()];
	let worst = null;
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const A = new Set(norm(entries[i].name));
			const B = new Set(norm(entries[j].name));
			if (!A.size || !B.size) continue;
			const inter = [...A].filter((t) => B.has(t)).length;
			const jac = inter / new Set([...A, ...B]).size;
			if (!worst || jac < worst.jaccard) worst = { jaccard: Number(jac.toFixed(3)), shared: inter, a: entries[i], b: entries[j] };
		}
	}
	if (!worst || worst.shared > 0) continue; // any shared brand token ⇒ not a candidate
	out.push({
		sku,
		stores: stores.size,
		jaccard: worst.jaccard,
		a: { store: worst.a.store, name: worst.a.name, price: worst.a.price, url: worst.a.url },
		b: { store: worst.b.store, name: worst.b.name, price: worst.b.price, url: worst.b.url },
	});
}

out.sort((x, y) => x.sku.localeCompare(y.sku));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), root, multiStoreSkus: [...bySku.values()].filter((r) => new Set(r.map((x) => x.store)).size > 1).length, candidates: out.length, note: "CANDIDATES, not verdicts: a collision is a defect only when policy would separate the two products. See docs/audit-runbook.md.", collisions: out }, null, 2));

console.log(`multi-store skus: ${[...bySku.values()].filter((r) => new Set(r.map((x) => x.store)).size > 1).length}`);
console.log(`collision candidates (zero shared brand token): ${out.length}`);
console.log(`→ ${outFile}`);
for (const c of out.slice(0, 25)) console.log(`  ${c.sku}  ${c.a.store}: ${String(c.a.name).slice(0, 44)}  ||  ${c.b.store}: ${String(c.b.name).slice(0, 44)}`);
