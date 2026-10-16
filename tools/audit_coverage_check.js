#!/usr/bin/env node
// Acceptance check for link-audit coverage. Every candidate generator is read, each pair is reduced
// to its canonical-group pair against the CURRENT link file, and classified as linked (same group),
// ignored, queued (in a batch or review file still awaiting a verdict) or MISSING. "Done" means
// MISSING = 0 for every generator at its bar; any other claim of completeness is unverified.
//
// Generators (each optional, repeatable; name=path):
//   --page    tools/audit_page_oracle.mjs output → page-<card|worklist>-<classical|ai|linear|prod>
//             (popularity-filler rows: page-fallback)
//   --classical  tools/audit_classical_pairs.mjs output (score = classical)
//   --rich    scripts/audit_new_listings.js --top 20 rich jsonl (score = GBT prob)
//   --emb     scripts/audit_new_listings.js --emb-neighbours K output (score = GBT prob)
//   --queued  any jsonl with a/b per line (pending batches, REVIEW_QUEUE.jsonl)
//   --last <gen>      a generator with known-broken inputs: pairs ONLY it surfaces go to tier 3.
//   --bar <gen>=<x>   bar per generator (default 0.5); --union-out <file> writes every undecided,
//                     unqueued pair at or above any generator's bar, with each generator's score.
//
//   node tools/audit_coverage_check.js --page audit/x/page.jsonl --classical audit/x/g3.jsonl \
//        --rich audit/x/g4.jsonl --emb audit/x/g5.jsonl --queued audit/.../REVIEW_QUEUE.jsonl \
//        --union-out audit/x/union.jsonl
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { loadSkuMap } = require("../src/utils/sku_map");

const argv = process.argv.slice(2);
const multi = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
const one = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const KNOWN = new Set(["--last", "--page", "--classical", "--rich", "--emb", "--queued", "--bar", "--union-out", "--root"]);
for (let i = 0; i < argv.length; i += 2)
	if (!KNOWN.has(argv[i]) || argv[i + 1] === undefined) {
		console.error(`audit_coverage_check: bad argument ${argv[i]}`);
		process.exit(2);
	}
const root = one("--root") || ".worktrees/data";
const bars = new Map();
for (const b of multi("--bar")) {
	const [g, x] = b.split("=");
	if (!Number.isFinite(Number(x))) throw new Error(`bad --bar ${b}`);
	bars.set(g, Number(x));
}
const barOf = (g) => (bars.has(g) ? bars.get(g) : 0.5);

const skuMap = loadSkuMap({ dbDir: path.join(root, "data/db") });
const canon = (s) => skuMap.canonicalSku(String(s));
const groupKey = (a, b) => [canon(a), canon(b)].sort().join("|");
const linksObj = JSON.parse(fs.readFileSync(path.join(root, "data/sku_links.json"), "utf8"));
const ignored = new Set(linksObj.ignores.map((i) => groupKey(i.skuA, i.skuB)));
const queued = new Set();
for (const f of multi("--queued"))
	for (const line of fs.readFileSync(f, "utf8").split("\n"))
		if (line.trim()) {
			const r = JSON.parse(line);
			queued.add(groupKey(r.a, r.b));
		}

// best[gen] : groupKey → {a, b, score}
const best = new Map();
const note = (gen, a, b, score) => {
	if (!Number.isFinite(score)) throw new Error(`${gen}: non-numeric score for ${a}|${b}`);
	if (!best.has(gen)) best.set(gen, new Map());
	const m = best.get(gen);
	const k = groupKey(a, b);
	if (!m.has(k) || score > m.get(k).score) m.set(k, { a: String(a), b: String(b), score });
};

async function eachLine(file, fn) {
	const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

(async () => {
	for (const f of multi("--page"))
		await eachLine(f, (r) => note(r.fallback ? "page-fallback" : `page-${r.src}-${r.mode}`, r.a, r.b, r.score));
	for (const f of multi("--classical")) await eachLine(f, (r) => note("classical", r.a, r.b, r.classical));
	for (const f of multi("--rich"))
		await eachLine(f, (o) => {
			if (o._meta || o.hidden) return;
			for (const c of o.scores.candidates) if (!c.fallback) note("rich-gbt", o.sku, c.sku, c.prob);
		});
	for (const f of multi("--emb"))
		await eachLine(f, (r) => {
			if (r._meta) return;
			note("emb-nn", r.a, r.b, r.prob);
		});

	const thresholds = [0.3, 0.5, 0.7, 0.9, 0.95];
	const rows = [];
	const union = new Map();
	for (const [gen, m] of best) {
		const bar = barOf(gen);
		const c = { linked: 0, ignored: 0, queued: 0, missing: 0 };
		const missingAt = Object.fromEntries(thresholds.map((t) => [t, 0]));
		for (const [k, p] of m) {
			const [x, y] = k.split("|");
			const state = x === y ? "linked" : ignored.has(k) ? "ignored" : queued.has(k) ? "queued" : "missing";
			if (state === "missing") for (const t of thresholds) if (p.score >= t) missingAt[t]++;
			if (p.score < bar) continue;
			c[state]++;
			if (state !== "missing") continue;
			if (!union.has(k)) union.set(k, { a: p.a, b: p.b, gens: {} });
			union.get(k).gens[gen] = +p.score.toFixed(4);
		}
		rows.push({ gen, bar, pairs: m.size, ...c, missingAt });
	}
	const pad = (s, n) => String(s).padEnd(n);
	console.log(`links ${linksObj.links.length} · ignores ${linksObj.ignores.length} · queued ${queued.size}`);
	console.log(
		pad("generator", 24) + pad("bar", 6) + pad("pairs", 9) + pad("linked", 8) + pad("ignored", 9) + pad("queued", 8) + pad("MISSING", 9) +
			thresholds.map((t) => pad(`miss≥${t}`, 10)).join(""),
	);
	for (const r of rows.sort((p, q) => p.gen.localeCompare(q.gen)))
		console.log(
			pad(r.gen, 24) + pad(r.bar, 6) + pad(r.pairs, 9) + pad(r.linked, 8) + pad(r.ignored, 9) + pad(r.queued, 8) + pad(r.missing, 9) +
				thresholds.map((t) => pad(r.missingAt[t], 10)).join(""),
		);
	console.log(`UNION of missing pairs at each generator's bar: ${union.size}`);
	const out = one("--union-out");
	if (out) {
		// Value tiers, likely links first (a missed link is the visible failure): 1 = any credible
		// probability-scale generator, 2 = classical-scale only (lookalikes, hard negatives), 3 = only
		// generators named by --last (known-broken inputs; still judged, never dropped). Within a tier,
		// by best score.
		const PROB_GENS = new Set(["page-card-linear", "page-worklist-linear", "page-card-prod", "page-worklist-prod", "rich-gbt", "emb-nn"]);
		const last = new Set(multi("--last"));
		const tier = (p) => {
			const g = Object.keys(p.gens).filter((x) => !last.has(x));
			if (!g.length) return 3;
			return g.some((x) => PROB_GENS.has(x)) ? 1 : 2;
		};
		const top = (p) => Math.max(...Object.entries(p.gens).filter(([g]) => tier(p) === 3 || !last.has(g)).map(([, v]) => v));
		const list = [...union.values()].map((p) => ({ ...p, tier: tier(p) })).sort((p, q) => p.tier - q.tier || top(q) - top(p));
		console.log(`tiers: ${[1, 2, 3].map((t) => `${t}=${list.filter((p) => p.tier === t).length}`).join(" ")}`);
		fs.writeFileSync(out, list.map((p) => JSON.stringify(p)).join("\n") + "\n");
		console.log(`→ ${out}`);
	}
})();
