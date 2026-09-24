#!/usr/bin/env node
// Group-major precision slices: every canonical group with at least one explicit link edge whose
// live re-score is in [--min, --max), shipped WHOLE — every member with its listings and every
// edge holding the group together (manual + sku_links_auto.json, any prob), batched so no group
// straddles two files.
//
// Why not pair-major (audit_link_band_slice.js): the dominant precision failure is a transitive
// bridge, and splitting a group requires cutting EVERY edge between the two halves. A band slice
// hid the out-of-band edges (299 of the 0.95–0.99 pilot's 517 groups also had edges ≥ 0.99), so
// a split decided from it was routinely incomplete.
//
// Edges come from the CURRENT link files; the rich file is used only for per-pair probs, and
// listings from the current index.json (the rich file misses skus absent from the catalog window).
//
//   node tools/audit_link_group_slice.js --from audit/rich-fh-v5.jsonl --min 0.95 --max 1.0001 \
//        --batch-bytes 250000 --out-prefix audit/v5-groups
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const from = arg("--from");
const prefix = arg("--out-prefix");
const min = Number(arg("--min"));
const max = Number(arg("--max"));
const batchBytes = Number(arg("--batch-bytes"));
const root = arg("--root") || path.join(__dirname, "..", ".worktrees", "data");
// Comma-separated slice files already audited: a group sharing any member with one is skipped, so
// the remainder can be re-cut at a new size after a calibration run (canon keys shift on apply).
const exclude = arg("--exclude") ? arg("--exclude").split(",") : [];
if (!from || !prefix || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(batchBytes)) {
	console.error("usage: audit_link_group_slice.js --from <rich.jsonl> --min <p> --max <p> --batch-bytes <n> --out-prefix <path> [--root <worktree>] [--exclude <slice.json,…>]");
	process.exit(2);
}
const nk = (s) => normalizeImplicitSkuKey(String(s || "").trim());
const pk = (a, b) => (nk(a) < nk(b) ? `${nk(a)}|${nk(b)}` : `${nk(b)}|${nk(a)}`);
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

(async () => {
	const manual = readJson("data/sku_links.json").links;
	const auto = readJson("data/sku_links_auto.json").links;
	const collided = new Set(readJson("data/sku_collisions.json").collisions.map((c) => nk(c.sku)));

	const parent = new Map();
	const find = (x) => {
		while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
		return x;
	};
	const edges = [
		...manual.map((l) => ({ l, src: l.source || "manual" })),
		...auto.map((l) => ({ l, src: "merge-auto" })),
	];
	for (const { l } of edges) {
		const ra = find(nk(l.fromSku)), rb = find(nk(l.toSku));
		if (ra !== rb) parent.set(ra, rb);
	}

	// prob per normalized pair from the rich file's re-scored existing links; min over directions,
	// since a direction-dependent prob straddling the band edge must not hide the group.
	const prob = new Map();
	const pinned = new Set();
	const rl = readline.createInterface({ input: fs.createReadStream(from), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line || line.startsWith('{"_meta"')) continue;
		const l = JSON.parse(line);
		for (const v of (l.scores && l.scores.verified) || []) {
			const k = pk(v.fromSku, v.toSku);
			if (v.pinned) pinned.add(k);
			if (v.prob === null || v.prob === undefined) continue;
			prob.set(k, prob.has(k) ? Math.min(prob.get(k), v.prob) : v.prob);
		}
	}

	const byGroup = new Map();
	for (const { l, src } of edges) {
		const a = nk(l.fromSku), b = nk(l.toSku);
		if (a === b) continue;
		const g = find(a);
		if (!byGroup.has(g)) byGroup.set(g, { members: new Set(), edges: [] });
		const G = byGroup.get(g);
		G.members.add(a).add(b);
		const k = pk(a, b);
		G.edges.push({
			a: l.fromSku,
			b: l.toSku,
			src,
			prob: prob.has(k) ? +prob.get(k).toFixed(4) : null,
			...(pinned.has(k) ? { pin: 1 } : {}),
			...(l.noTrain ? { noTrain: 1 } : {}),
		});
	}

	const idx = readJson("viz/data/index.json");
	const listings = new Map();
	for (const it of idx.items || idx) {
		const k = nk(it.sku);
		if (!listings.has(k)) listings.set(k, []);
		listings.get(k).push([it.storeLabel, it.name, it.price, it.removed ? 1 : 0, String(it.url || "").replace(/^https?:\/\/(www\.)?/, "")]);
	}

	const done = new Set();
	for (const f of exclude) for (const g of JSON.parse(fs.readFileSync(f, "utf8")).groups) for (const m of g.members) done.add(m.sku);
	let excluded = 0;
	const inBand = (e) => e.src !== "merge-auto" && !e.pin && e.prob !== null && e.prob >= min && e.prob < max;
	const out = [];
	let bandEdges = 0;
	for (const [canon, G] of byGroup) {
		const n = G.edges.filter(inBand).length;
		if (!n) continue;
		if ([...G.members].some((s) => done.has(s))) {
			excluded++;
			continue;
		}
		bandEdges += n;
		out.push({
			canon,
			members: [...G.members].sort().map((s) => ({ sku: s, ...(collided.has(s) ? { collided: 1 } : {}), listings: listings.get(s) || [] })),
			edges: G.edges,
		});
	}
	// biggest first so the greedy fill balances batches
	out.sort((x, y) => JSON.stringify(y).length - JSON.stringify(x).length);
	const nBatches = Math.max(1, Math.ceil(out.reduce((s, g) => s + JSON.stringify(g).length, 0) / batchBytes));
	const batches = Array.from({ length: nBatches }, () => ({ groups: [], bytes: 0 }));
	for (const g of out) {
		const b = batches.reduce((m, x) => (x.bytes < m.bytes ? x : m));
		b.groups.push(g);
		b.bytes += JSON.stringify(g).length;
	}
	const legend = "groups[] are WHOLE canonical groups. members[].listings = [store,name,price,removed,url]. edges[] = EVERY link holding the group together; a/b are the exact stored fromSku/toSku (use them in unlink ops). src merge-auto = sku_links_auto.json (an in-place sku upgrade; remove a wrong one with op 'unlink-auto', not 'unlink'). pin = shared SMWS cask code (prob not calibrated). prob null = not re-scored (new link or absent partner). collided = verified cross-store collision sku (never link to it). A member with NO listings is a superseded key (the sku was upgraded in place; its merge-auto edge names the successor) or a vanished listing — judge its edges by the partner, never unlink it for lacking a name.";
	batches.forEach((b, i) => {
		const f = `${prefix}-b${String(i + 1).padStart(2, "0")}.json`;
		const e = b.groups.reduce((s, g) => s + g.edges.length, 0);
		fs.writeFileSync(f, JSON.stringify({ _meta: { from, band: [min, max], batch: `${i + 1}/${nBatches}`, groups: b.groups.length, edges: e, legend }, groups: b.groups }) + "\n");
		console.log(`${f}: ${b.groups.length} groups, ${e} edges, ${fs.statSync(f).size} B`);
	});
	if (exclude.length) console.log(`excluded ${excluded} group(s) already audited in ${exclude.join(", ")}`);
	console.log(`${out.length} groups with ${bandEdges} in-band edges (${out.reduce((s, g) => s + g.edges.length, 0)} edges total) → ${nBatches} batches`);
})();
