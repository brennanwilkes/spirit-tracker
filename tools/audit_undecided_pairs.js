#!/usr/bin/env node
// Whole-catalog undecided-pair batches: the replacement for the retired #/link pages.
//
// The pool is the union of two sources, minus pairs already grouped or ignored (canonical-group level,
// as the page did) in the CURRENT link file, deduped by canonical group pair, shipped with every store
// listing of both groups:
//   --classical  tools/audit_classical_pairs.mjs output: page-parity classical similarity over every
//                store-name variant (≥ --min-classical). Surfaces lookalikes, which the GBT often already
//                scores low and which therefore never reach a top-K-by-prob funnel.
//   --from       a full-history rich file (scripts/audit_new_listings.js --since 1970-01-01 --top 20):
//                candidates with GBT prob ≥ --min-prob. Surfaces true matches with noisy names
//                (description-as-title, ALL-CAPS abbreviations) that classical similarity ranks low.
// Each pair needs a verdict: link, ignore, or (rarely) review. A lookalike that differs is an ignore —
// those are the hard negatives retrains need.
//
//   node tools/audit_undecided_pairs.js --classical audit/classical.jsonl --from audit/rich-full.jsonl \
//        --out-dir audit/undecided-2026-10-12 --min-classical 0.5 --min-prob 0.3 --batch 150 \
//        [--exclude-pairs <pairs.jsonl> ...]
//   node tools/audit_undecided_pairs.js --collect audit/undecided-2026-10-12
//
// --collect builds proposal-merged.json from every bN.decisions.jsonl, taking the a/b strings from the
// batch's own pairs file and DROPPING any row whose decision a/b disagrees with its input (agents
// mis-copy skus; one 2026-10-12 batch did on 8 of 150 rows). Agent-written bN.proposal.json files are
// never trusted. Then: validate_proposal_skus --fix, apply_audit_proposal (dry-run), spot-check, --apply.
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { loadSkuMap } = require("../src/utils/sku_map");

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);

const collectDir = arg("--collect");
// An ignore is near-permanent, so on a pair a model scored >= 0.9 it must cite a concrete attribute;
// "different bottling name" alone may be a relabel (2026-10-14 pilot: Decadent Drams Craigellachie 20
// vs "Marketing Malt" 20) and goes to review instead.
const STATED = /\b(age|aged|year|yr|yo|batch|release|edition|chapter|vintage|cask|finish|proof|abv|strength|%|size|ml|litre|liter|mini|distiller|bottler|bottling by|gift|pack|bundle|set|barrel|single cask|style|flavou?r|spiced|peated|unpeated|category|rum|gin|bourbon|rye|vodka|liqueur|tequila|brandy|wine)/i;
const guardIgnore = (p, d) =>
	!STATED.test(d.why) && Math.max(0, ...Object.values(p.gens || {}), p.classical || 0, p.prob || 0) >= 0.9;
if (collectDir) {
	const ops = [];
	const review = [];
	const dropped = [];
	let rows = 0;
	const batches = fs.readdirSync(collectDir).filter((f) => /^b\d+\.pairs\.jsonl$/.test(f)).map((f) => f.split(".")[0]);
	for (const b of batches) {
		const read = (f) => fs.readFileSync(path.join(collectDir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
		const pairs = read(`${b}.pairs.jsonl`);
		const decisions = read(`${b}.decisions.jsonl`);
		rows += pairs.length;
		if (decisions.length !== pairs.length) dropped.push(`${b}: ${decisions.length} decisions for ${pairs.length} pairs`);
		for (const d of decisions) {
			const p = pairs[d.n - 1];
			if (!p || p.a !== d.a || p.b !== d.b) {
				dropped.push(`${b}#${d.n}`);
				continue;
			}
			if (d.verdict === "ignore" && guardIgnore(p, d)) review.push({ a: p.a, b: p.b, why: `guard: name-only difference on a high-scoring pair. ${d.why}` });
			else if (d.verdict === "link" || d.verdict === "ignore") ops.push({ op: d.verdict, a: p.a, b: p.b, why: d.why });
			else if (d.verdict === "review") review.push({ a: p.a, b: p.b, why: d.why });
			else throw new Error(`${b}#${d.n}: unknown verdict ${d.verdict}`);
		}
	}
	const out = path.join(collectDir, "proposal-merged.json");
	const proposal = { auditRef: `${collectDir} undecided pairs`, ops, review, coverage: { universe: rows, reviewed: rows - dropped.length, dropped } };
	fs.writeFileSync(out, JSON.stringify(proposal, null, 1) + "\n");
	console.log(`${out}: ${ops.filter((o) => o.op === "link").length} link, ${ops.filter((o) => o.op === "ignore").length} ignore, ${review.length} review, ${dropped.length} dropped ${dropped.join(" ")}`);
	process.exit(0);
}
const from = arg("--from");
const classicalFile = arg("--classical");
const unionFile = arg("--union");
const outDir = arg("--out-dir");
const minClassical = Number(arg("--min-classical"));
const minProb = Number(arg("--min-prob"));
const batch = Number(arg("--batch"));
const root = arg("--root") || ".worktrees/data";
const excludeFiles = argv.flatMap((a, i) => (a === "--exclude-pairs" ? [argv[i + 1]] : []));
const compact = argv.includes("--compact");
if (unionFile ? !outDir || !(batch > 0) : !from || !classicalFile || !outDir || !Number.isFinite(minClassical) || !Number.isFinite(minProb) || !(batch > 0)) {
	console.error("usage: audit_undecided_pairs.js --union <audit_coverage_check --union-out> --out-dir <dir> --batch <n> [--root <worktree>] [--compact]");
	console.error("   or: audit_undecided_pairs.js --classical <classical.jsonl> --from <rich.jsonl> --out-dir <dir> --min-classical <x> --min-prob <p> --batch <n> [--root <worktree>] [--exclude-pairs <pairs.jsonl> ...]");
	process.exit(2);
}

const skuMap = loadSkuMap({ dbDir: path.join(root, "data/db") });
const canon = (s) => skuMap.canonicalSku(s);
const linksObj = JSON.parse(fs.readFileSync(path.join(root, "data/sku_links.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(root, "viz/data/index.json"), "utf8")).items;

const byCanon = new Map();
for (const it of index) {
	const c = canon(it.sku);
	if (!byCanon.has(c)) byCanon.set(c, []);
	byCanon.get(c).push(it);
}
const side = (sku) =>
	(byCanon.get(canon(sku)) || []).map((it) => ({
		sku: it.sku,
		store: it.storeLabel,
		name: it.name,
		price: it.price,
		slug: (it.url || "").split("/").pop().split("?")[0].slice(0, 90),
		...(it.removed ? { removed: true } : {}),
	}));
// --compact: one summary per group instead of one row per listing (~1/3 the bytes on multi-store groups).
const priceNum = (p) => {
	const x = Number(String(p).replace(/[^0-9.]/g, ""));
	if (!Number.isFinite(x) || x <= 0) throw new Error(`unparseable price ${JSON.stringify(p)}`);
	return x;
};
const compactSide = (sku) => {
	const ls = byCanon.get(canon(sku)) || [];
	const live = ls.filter((it) => !it.removed);
	const names = [...new Set(ls.map((it) => it.name))];
	const prices = live.map((it) => priceNum(it.price)).sort((x, y) => x - y);
	const slugs = [...new Set(ls.map((it) => (it.url || "").split("/").pop().split("?")[0].slice(0, 90)))];
	return {
		names: names.slice(0, 6),
		...(names.length > 6 ? { moreNames: names.length - 6 } : {}),
		stores: [...new Set(ls.map((it) => it.storeLabel + (it.removed ? " (removed)" : "")))],
		...(prices.length ? { price: prices[0] === prices[prices.length - 1] ? `$${prices[0]}` : `$${prices[0]}–$${prices[prices.length - 1]}` } : {}),
		slugs: slugs.slice(0, 2),
	};
};
const groupKey = (a, b) => [canon(a), canon(b)].sort().join("|");
const ignored = new Set(linksObj.ignores.map((i) => groupKey(i.skuA, i.skuB)));
const undecided = (a, b) => canon(a) !== canon(b) && !ignored.has(groupKey(a, b)) && !excludedHas(groupKey(a, b));

const excluded = new Set();
const excludedHas = (k) => excluded.has(k);
for (const f of excludeFiles)
	for (const line of fs.readFileSync(f, "utf8").split("\n"))
		if (line.trim()) {
			const r = JSON.parse(line);
			excluded.add(groupKey(r.a, r.b));
		}

function writeBatches(pairs) {
	fs.mkdirSync(outDir, { recursive: true });
	let n = 0;
	for (let i = 0; i < pairs.length; i += batch) {
		n++;
		const file = path.join(outDir, `b${n}.pairs.jsonl`);
		const lines = pairs.slice(i, i + batch).map((p, j) => JSON.stringify({ n: j + 1, ...p, A: (compact ? compactSide : side)(p.a), B: (compact ? compactSide : side)(p.b) }));
		fs.writeFileSync(file, lines.join("\n") + "\n");
		console.log(`${file}: ${lines.length} pairs, ${fs.statSync(file).size} bytes`);
	}
	return n;
}

if (unionFile) {
	const pairs = fs
		.readFileSync(unionFile, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l))
		.filter((p) => undecided(p.a, p.b));
	console.log(`${pairs.length} undecided union pairs in ${writeBatches(pairs)} batches`);
	return;
}

(async () => {
	const best = new Map();
	for (const line of fs.readFileSync(classicalFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const c = JSON.parse(line);
		if (c.classical < minClassical || !undecided(c.a, c.b)) continue;
		const k = groupKey(c.a, c.b);
		if (!best.has(k) || c.classical > best.get(k).classical) best.set(k, { a: c.a, b: c.b, classical: c.classical, prob: null });
	}
	const rl = readline.createInterface({ input: fs.createReadStream(from) });
	let first = true;
	let rows = 0;
	for await (const line of rl) {
		if (first) {
			first = false;
			continue;
		}
		const o = JSON.parse(line);
		rows++;
		if (o.hidden) continue;
		for (const c of o.scores.candidates) {
			const k = groupKey(o.sku, c.sku);
			const prev = best.get(k);
			if (prev) {
				if (prev.prob === null || c.prob > prev.prob) prev.prob = +c.prob.toFixed(4);
				continue;
			}
			if (c.prob < minProb || !undecided(o.sku, c.sku)) continue;
			best.set(k, { a: o.sku, b: c.sku, classical: null, prob: +c.prob.toFixed(4) });
		}
	}
	const rank = (p) => Math.max(...[p.classical, p.prob].filter((v) => v !== null));
	const pairs = [...best.values()].sort((x, y) => rank(y) - rank(x));
	fs.mkdirSync(outDir, { recursive: true });
	let n = 0;
	for (let i = 0; i < pairs.length; i += batch) {
		n++;
		const file = path.join(outDir, `b${n}.pairs.jsonl`);
		const lines = pairs.slice(i, i + batch).map((p, j) => JSON.stringify({ n: j + 1, ...p, A: (compact ? compactSide : side)(p.a), B: (compact ? compactSide : side)(p.b) }));
		fs.writeFileSync(file, lines.join("\n") + "\n");
		console.log(`${file}: ${lines.length} pairs, ${fs.statSync(file).size} bytes`);
	}
	const both = pairs.filter((p) => p.classical >= minClassical && p.prob >= minProb).length;
	console.log(
		`${rows} listing rows → ${pairs.length} undecided pairs (classical≥${minClassical}: ${pairs.filter((p) => p.classical >= minClassical).length}, prob≥${minProb}: ${pairs.filter((p) => p.prob >= minProb).length}, both: ${both}) in ${n} batches`,
	);
})();
