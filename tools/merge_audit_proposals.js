#!/usr/bin/env node
// Merge concurrent audit proposals into one file before applying. Each agent's dry-run saw only its
// own ops, so contradictions between batches (link in one, unlink/ignore in another) surface only
// here. Pairs are keyed normalized (`id:N` ≡ `N`); a same-pair conflict across inputs exits 1.
// Grouped-ignore, collision and auto-edge checks stay in apply_audit_proposal.js — dry-run the output.
//
//   node tools/merge_audit_proposals.js --out audit/proposal-merged.json audit/proposal-a.json audit/proposal-b.json
const fs = require("fs");
const { normalizeImplicitSkuKey: nk } = require("../src/utils/sku_canonical");

const argv = process.argv.slice(2);
const oi = argv.indexOf("--out");
if (oi === -1 || !argv[oi + 1] || argv.length < 3) {
	console.error("usage: merge_audit_proposals.js --out <merged.json> <proposal.json> [<proposal.json> …]");
	process.exit(2);
}
const out = argv[oi + 1];
const ins = argv.filter((_, i) => i !== oi && i !== oi + 1);

const ops = [], review = [], dataQuality = [], policyAmendments = [];
const byPair = new Map();
const seen = new Set();
for (const f of ins) {
	const p = JSON.parse(fs.readFileSync(f, "utf8"));
	const tag = f.replace(/^.*proposal-/, "").replace(/\.json$/, "");
	for (const o of p.ops) {
		const a = o.a ?? o.fromSku ?? o.skuA, b = o.b ?? o.toSku ?? o.skuB;
		const pk = [nk(a), nk(b)].sort().join("|");
		if (!byPair.has(pk)) byPair.set(pk, []);
		byPair.get(pk).push(`${tag}:${o.op}`);
		const k = `${o.op}|${pk}`;
		if (seen.has(k)) continue;
		seen.add(k);
		ops.push({ ...o, why: `[${tag}] ${o.why}` });
	}
	review.push(...(p.review || []).map((r) => ({ from: tag, ...r })));
	dataQuality.push(...(p.dataQuality || []).map((r) => ({ from: tag, ...r })));
	policyAmendments.push(...(p.policyAmendments || p.policy || []));
}
// remove-ignore + link on one pair is the documented two-file sequence, not a contradiction; the
// applier still refuses it inside one proposal, so it is reported here too.
const conflicts = [...byPair.entries()].filter(([, v]) => new Set(v.map((x) => x.split(":").pop())).size > 1);
const counts = {};
for (const o of ops) counts[o.op] = (counts[o.op] || 0) + 1;
console.log(`${ins.length} proposals → ${ops.length} ops`, counts, `review ${review.length}, dataQuality ${dataQuality.length}`);
if (conflicts.length) {
	console.error(`${conflicts.length} pair(s) with different ops across proposals — resolve before merging:`);
	for (const [k, v] of conflicts) console.error(`  ${k}: ${v.join(", ")}`);
	process.exit(1);
}
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), auditRef: `merged: ${ins.join(", ")}`, ops, review, dataQuality, policyAmendments }, null, 2) + "\n");
console.log(`wrote ${out}`);
