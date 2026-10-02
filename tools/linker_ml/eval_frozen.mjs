#!/usr/bin/env node
// Score GBT models on the audit campaign's FROZEN split: the rows of a features.jsonl that
// dump_features.mjs marked `frozen` (LINKER_FROZEN_SPLIT), noTrain excluded. Same definitions as
// export_gbt.py's report: AUC+ = positives vs mined hard negatives; rec@P = best recall with
// precision >= P over positives vs (hard + ignore); plus precision/recall at the auto-link bar.
// Thresholds are evaluated per DISTINCT score, so tied scores never split.
//
//   node tools/linker_ml/eval_frozen.mjs --features <features.jsonl> --model base=<gbt.json> \
//        --model round=<gbt.json> [--bar 0.95] [--out <metrics.json>]
import fs from "fs";
import { gbtScore } from "../../viz/app/linker_page/gbt.js";

const argv = process.argv.slice(2);
const models = [];
let featuresPath = null;
let outPath = null;
let bar = 0.95;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	const v = argv[++i];
	if (v === undefined) throw new Error(`${a} expects a value`);
	if (a === "--features") featuresPath = v;
	else if (a === "--out") outPath = v;
	else if (a === "--bar") bar = Number(v);
	else if (a === "--model") {
		const eq = v.indexOf("=");
		if (eq < 1) throw new Error(`--model expects name=path, got "${v}"`);
		models.push({ name: v.slice(0, eq), path: v.slice(eq + 1) });
	} else throw new Error(`unknown argument ${a}`);
}
if (!featuresPath || !models.length || !Number.isFinite(bar)) {
	console.error("usage: eval_frozen.mjs --features <features.jsonl> --model <name>=<gbt.json> [...] [--bar 0.95] [--out <file>]");
	process.exit(2);
}

const rows = fs
	.readFileSync(featuresPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
	.filter((r) => r.frozen && !r.noTrain);
if (!rows.length) throw new Error(`${featuresPath} has no frozen rows — was dump_features run with LINKER_FROZEN_SPLIT?`);

function aucOf(posScores, negScores) {
	const all = [...posScores.map((s) => [s, 1]), ...negScores.map((s) => [s, 0])].sort((x, y) => x[0] - y[0]);
	let rankSumPos = 0;
	for (let i = 0; i < all.length; ) {
		let j = i;
		while (j < all.length && all[j][0] === all[i][0]) j++;
		const avgRank = (i + 1 + j) / 2;
		for (let k = i; k < j; k++) if (all[k][1]) rankSumPos += avgRank;
		i = j;
	}
	const P = posScores.length, N = negScores.length;
	return (rankSumPos - (P * (P + 1)) / 2) / (P * N);
}

function metrics(scores) {
	const pos = [], hard = [], opneg = [];
	rows.forEach((r, i) => {
		if (r.label === 1) pos.push(scores[i]);
		else if (r.kind === "hard") (hard.push(scores[i]), opneg.push(scores[i]));
		else if (r.kind === "ignore") opneg.push(scores[i]);
	});
	const ranked = [...pos.map((s) => [s, 1]), ...opneg.map((s) => [s, 0])].sort((x, y) => y[0] - x[0]);
	const recAt = (target) => {
		let tp = 0, fp = 0, best = 0;
		for (let i = 0; i < ranked.length; ) {
			let j = i;
			while (j < ranked.length && ranked[j][0] === ranked[i][0]) (ranked[j][1] ? tp++ : fp++), j++;
			if (tp / (tp + fp) >= target) best = Math.max(best, tp / pos.length);
			i = j;
		}
		return best;
	};
	const tpBar = pos.filter((s) => s >= bar).length;
	const fpBar = opneg.filter((s) => s >= bar).length;
	return {
		pos: pos.length,
		hard: hard.length,
		ignore: opneg.length - hard.length,
		aucPlus: aucOf(pos, hard),
		rec99: recAt(0.99),
		rec98: recAt(0.98),
		rec95: recAt(0.95),
		precAtBar: tpBar + fpBar ? tpBar / (tpBar + fpBar) : null,
		recAtBar: tpBar / pos.length,
		falseLinksAtBar: fpBar,
	};
}

const out = { features: featuresPath, bar, rows: rows.length, models: {} };
for (const m of models) {
	const model = JSON.parse(fs.readFileSync(m.path, "utf8"));
	// export_gbt.py trains on `r.get(k, 0) or 0`; gbtScore would route an absent key down the
	// missing branch instead, so an absent column must fail loudly rather than score differently.
	const scores = rows.map((r) => {
		for (const k of model.keys) if (typeof r[k] !== "number") throw new Error(`features row ${r.a}|${r.b} lacks numeric "${k}" required by ${m.path}`);
		const s = gbtScore(model, r);
		if (s === null) throw new Error(`model ${m.path} returned no score`);
		return s;
	});
	out.models[m.name] = { path: m.path, ...metrics(scores) };
}

const pct = (x) => (x === null ? "—" : `${(100 * x).toFixed(2)}%`);
console.log(`frozen split: ${rows.length} rows (noTrain excluded), bar ${bar}`);
console.log("| model | pos | hard | ignore | AUC+ | rec@99 | rec@98 | prec@bar | rec@bar | false links@bar |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const [name, r] of Object.entries(out.models))
	console.log(`| ${name} | ${r.pos} | ${r.hard} | ${r.ignore} | ${r.aucPlus.toFixed(5)} | ${pct(r.rec99)} | ${pct(r.rec98)} | ${pct(r.precAtBar)} | ${pct(r.recAtBar)} | ${r.falseLinksAtBar} |`);
if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
