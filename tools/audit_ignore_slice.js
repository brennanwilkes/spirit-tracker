#!/usr/bin/env node
// Ignore-screen slices: curated ignores (sku_links.json ignores[]) whose best listing-name token
// Jaccard is in [--min, --max), for an agent to re-judge. Ignored pairs are hard-suppressed from every
// candidate pool, so a wrong ignore is invisible to the funnels; screening the file is the only check.
//
// Each sku is shipped ONCE per batch (skus{}), with its listings and its current canonical group
// (members' skus + one name each), and ignores[] carry only the pair. Batches are filled greedily in
// connected-component order so a sku's ignores tend to share a batch.
//
//   node tools/audit_ignore_slice.js --min 0.8 --max 2 --batch-bytes 650000 --out-prefix audit/ign-a
const fs = require("fs");
const path = require("path");
const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const prefix = arg("--out-prefix");
const min = Number(arg("--min"));
const max = Number(arg("--max"));
const batchBytes = Number(arg("--batch-bytes"));
const root = arg("--root") || path.join(__dirname, "..", ".worktrees", "data");
if (!prefix || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(batchBytes)) {
	console.error("usage: audit_ignore_slice.js --min <j> --max <j> --batch-bytes <n> --out-prefix <path> [--root <worktree>]");
	process.exit(2);
}
const nk = (s) => normalizeImplicitSkuKey(String(s || "").trim());
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

const STOP = new Set(["ml", "year", "old", "yr", "yo", "the", "whisky", "whiskey", "750ml", "scotch", "single", "malt"]);
const tokens = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
const jaccard = (a, b) => {
	let i = 0;
	for (const x of a) if (b.has(x)) i++;
	return i / (a.size + b.size - i || 1);
};

const linksFile = readJson("data/sku_links.json");
const auto = readJson("data/sku_links_auto.json").links;
const collided = new Set(readJson("data/sku_collisions.json").collisions.map((c) => nk(c.sku)));

const parent = new Map();
const find = (x) => {
	while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
	return x;
};
for (const l of [...linksFile.links, ...auto]) {
	const ra = find(nk(l.fromSku)), rb = find(nk(l.toSku));
	if (ra !== rb) parent.set(ra, rb);
}

const idx = readJson("viz/data/index.json");
const listings = new Map();
for (const it of idx.items || idx) {
	const k = nk(it.sku);
	if (!listings.has(k)) listings.set(k, []);
	listings.get(k).push([it.storeLabel, it.name, it.price, it.removed ? 1 : 0, String(it.url || "").replace(/^https?:\/\/(www\.)?/, "")]);
}
const members = new Map();
for (const s of listings.keys()) {
	const r = find(s);
	if (!members.has(r)) members.set(r, []);
	members.get(r).push(s);
}

const selected = [];
for (const g of linksFile.ignores) {
	const a = nk(g.skuA), b = nk(g.skuB);
	const la = listings.get(a) || [], lb = listings.get(b) || [];
	let j = 0;
	for (const x of la) for (const y of lb) j = Math.max(j, jaccard(tokens(x[1]), tokens(y[1])));
	if (j < min || j >= max) continue;
	selected.push({ a: g.skuA, b: g.skuB, j: +j.toFixed(2), ...(g.noTrain ? { noTrain: 1 } : {}), ...(find(a) === find(b) ? { grouped: 1 } : {}) });
}

const skuEntry = (s) => {
	const g = (members.get(find(s)) || []).filter((m) => m !== s);
	return {
		...(collided.has(s) ? { collided: 1 } : {}),
		listings: listings.get(s) || [],
		...(g.length ? { canon: find(s), group: g.slice(0, 12).map((m) => [m, (listings.get(m) || [[null, null]])[0][1]]), ...(g.length > 12 ? { groupMore: g.length - 12 } : {}) } : {}),
	};
};

// component order: pairs sharing skus sit next to each other
const adj = new Map();
for (const [i, p] of selected.entries()) for (const s of [nk(p.a), nk(p.b)]) (adj.get(s) || adj.set(s, []).get(s)).push(i);
const seen = new Set(), order = [];
for (let i = 0; i < selected.length; i++) {
	if (seen.has(i)) continue;
	const stack = [i];
	seen.add(i);
	while (stack.length) {
		const c = stack.pop();
		order.push(c);
		for (const s of [nk(selected[c].a), nk(selected[c].b)]) for (const d of adj.get(s)) if (!seen.has(d)) (seen.add(d), stack.push(d));
	}
}

const batches = [];
let cur = null;
for (const i of order) {
	const p = selected[i];
	if (!cur || cur.bytes >= batchBytes) batches.push((cur = { ignores: [], skus: {}, bytes: 0 }));
	cur.ignores.push(p);
	cur.bytes += JSON.stringify(p).length;
	for (const s of [nk(p.a), nk(p.b)]) {
		if (cur.skus[s]) continue;
		cur.skus[s] = skuEntry(s);
		cur.bytes += JSON.stringify(cur.skus[s]).length + s.length;
	}
}

const legend = "ignores[] = curated hard negatives (skuA/skuB exactly as stored; use them in remove-ignore ops). j = best listing-name token Jaccard. noTrain = the human was unsure. grouped = both skus are ALREADY in one canonical group via other links (an incoherent ignore). skus{} (normalized keys) = each sku once: listings [store,name,price,removed,url]; canon/group = its current canonical group (other members' sku + one name; groupMore = members not shown); collided = verified cross-store collision sku (never link to it). A sku with no listings has left the catalog.";
batches.forEach((b, i) => {
	const f = `${prefix}-b${String(i + 1).padStart(2, "0")}.json`;
	fs.writeFileSync(f, JSON.stringify({ _meta: { band: [min, max], batch: `${i + 1}/${batches.length}`, ignores: b.ignores.length, skus: Object.keys(b.skus).length, legend }, ignores: b.ignores, skus: b.skus }) + "\n");
	console.log(`${f}: ${b.ignores.length} ignores, ${Object.keys(b.skus).length} skus, ${fs.statSync(f).size} B`);
});
console.log(`${selected.length} ignores in [${min}, ${max}) → ${batches.length} batch(es)`);
