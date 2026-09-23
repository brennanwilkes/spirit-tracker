#!/usr/bin/env node
// Pre-apply guard: every sku in a proposal must be one the catalog actually keys on.
// Motivation: the rich file's LISTING `sku` strips the `id:` prefix for id-sourced records
// (row shows `8768911`) while `data/sku_links.json`, the canonical map and the candidate
// `pairs[].sku` all use the normalized key (`id:8768911`). An op written from the stripped
// form validates, applies, and silently creates a link to a SKU that does not exist.
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const root = process.argv.includes("--root")
	? process.argv[process.argv.indexOf("--root") + 1]
	: path.join(REPO, ".worktrees/data");
const proposalFile = process.argv[process.argv.indexOf("--proposal") + 1];
if (!proposalFile) {
	console.error("usage: validate_proposal_skus.js --proposal <file> [--root <worktree>]");
	process.exit(2);
}

const { normalizeSkuKey } = require(path.join(REPO, "src/utils/sku.js"));

const known = new Set();
const dbDir = path.join(root, "data/db");
for (const f of fs.readdirSync(dbDir).filter((x) => x.endsWith(".json"))) {
	const raw = JSON.parse(fs.readFileSync(path.join(dbDir, f), "utf8"));
	const rows = Array.isArray(raw) ? raw : Object.values(raw).flatMap((v) => (Array.isArray(v) ? v : [v]));
	for (const r of rows) {
		if (!r || typeof r !== "object" || !r.sku) continue;
		const k = normalizeSkuKey(r.sku, { storeLabel: r.store, url: r.url });
		if (k) known.add(k);
	}
}
const links = JSON.parse(fs.readFileSync(path.join(root, "data/sku_links.json"), "utf8"));
for (const l of links.links) { known.add(l.fromSku); known.add(l.toSku); }

const proposal = JSON.parse(fs.readFileSync(proposalFile, "utf8"));
const bad = [];
for (const [i, o] of (proposal.ops || []).entries()) {
	for (const side of ["a", "b"]) {
		const v = o[side];
		if (!v) continue;
		if (known.has(v)) continue;
		// The characteristic failure: a stripped id: form whose prefixed form IS known.
		const guess = known.has(`id:${v}`) ? `id:${v}` : null;
		bad.push({ index: i, op: o.op, side, value: v, suggestion: guess });
	}
}

console.log(`known catalog skus: ${known.size}`);
console.log(`ops: ${(proposal.ops || []).length}   unknown sku refs: ${bad.length}`);
for (const b of bad) {
	console.log(`  op[${b.index}] ${b.op} ${b.side}="${b.value}"${b.suggestion ? `  → did you mean "${b.suggestion}"?` : "  (no match in catalog)"}`);
}
process.exit(bad.length ? 1 : 0);
