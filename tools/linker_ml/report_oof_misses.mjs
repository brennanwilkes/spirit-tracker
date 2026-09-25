#!/usr/bin/env node
// Every out-of-fold miss at the auto-link bar (out/oof_scores.jsonl from oof_misses.py), with both
// sides' listings, for trend analysis. noTrain pairs are excluded (the model cannot learn them).
//   node tools/linker_ml/report_oof_misses.mjs [bar=0.95]  → out/oof_misses.json + summary on stdout
import fs from "fs";
import path from "path";
import { buildEnv, OUT_DIR } from "./featurize.mjs";

const BAR = parseFloat(process.argv[2] || "0.95");
const env = buildEnv();
const rows = fs.readFileSync(path.join(OUT_DIR, "oof_scores.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const side = (s) => {
	const it = env.bySku.get(String(s));
	if (!it) throw new Error(`sku ${s} not in catalog`);
	return {
		sku: s,
		name: it.name,
		price: it.cheapestPriceNum,
		stores: [...it.stores],
		slugs: [...it.urlsByStore.values()].map((u) => new URL(u).pathname.split("/").filter(Boolean).pop()),
	};
};

const scored = rows.filter((r) => !r.noTrain);
const fn = scored.filter((r) => r.label === 1 && r.p < BAR).sort((x, y) => x.p - y.p);
const fp = scored.filter((r) => r.label === 0 && (r.kind === "ignore" || r.kind === "hard") && r.p >= BAR).sort((x, y) => y.p - x.p);
const pos = scored.filter((r) => r.label === 1).length;
const neg = scored.filter((r) => r.label === 0 && (r.kind === "ignore" || r.kind === "hard")).length;
const tp = pos - fn.length;
console.log(`bar ${BAR}: positives ${pos}, hard/ignore negatives ${neg}`);
console.log(`  missed links (FN) ${fn.length} (${((100 * fn.length) / pos).toFixed(1)}%) · false links (FP) ${fp.length} · precision ${((100 * tp) / (tp + fp.length)).toFixed(2)}%`);
const out = { bar: BAR, fn: fn.map((r) => ({ p: r.p, kind: r.kind, A: side(r.a), B: side(r.b) })), fp: fp.map((r) => ({ p: r.p, kind: r.kind, A: side(r.a), B: side(r.b) })) };
fs.writeFileSync(path.join(OUT_DIR, "oof_misses.json"), JSON.stringify(out, null, 1));
console.log(`wrote out/oof_misses.json`);
