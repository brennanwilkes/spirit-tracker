#!/usr/bin/env node
/**
 * tools/linker_ml/train_blend.mjs — the learned "blend" over the existing factors.
 *
 * CLASSIFIER_PLAN §2: the deterministic score is a product of factors, so a logistic
 * regression over the (log-transformed) factors learns the optimal weight on each one —
 * an interpretable, calibrated generalization of the hand-tuned constants. We feed the
 * full deterministic score (logDet) PLUS the decomposed sub-factors PLUS embed_cosine.
 *
 * AUGMENT, NOT REPLACE: logDet is a feature, so the learned model can only re-weight and
 * ADD signal around the current algo. We report the learned blend vs the raw deterministic
 * score ON THE SAME held-out split (split by canonical group → no leakage).
 *
 * Run:  node tools/linker_ml/train_blend.mjs
 * Reads:  out/features.jsonl   Writes:  out/blend_weights.json
 */

import fs from "fs";
import path from "path";
import { OUT_DIR, FEATURE_KEYS } from "./featurize.mjs";

/* ---------------- load ---------------- */

const rows = fs
	.readFileSync(path.join(OUT_DIR, "features.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));

const hasEmbed = rows.some((r) => Math.abs(r.embedCos || 0) > 1e-9);
// Drop the embed column from the model when there are no embeddings yet (all-zero → noise).
const KEYS = hasEmbed ? FEATURE_KEYS : FEATURE_KEYS.filter((k) => k !== "embedCos");

/* ---------------- deterministic split by canonical group ---------------- */

function hash32(str) {
	let h = 0x811c9dc5;
	str = String(str);
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}
// Three-way split by canonical group (same FNV hash as export_gbt.py / train_embed.py):
// [0,0.15)=TEST (never touched for selection), [0.15,0.30)=VAL, [0.30,1)=TRAIN. A whole group
// stays on one side (positives have canonA===canonB; negatives keyed by canonA).
const bucketOf = (r) => (hash32(r.canonA) % 1000) / 1000;
const isTest = (r) => bucketOf(r) < 0.15;
const isVal = (r) => bucketOf(r) >= 0.15 && bucketOf(r) < 0.3;
const isTrain = (r) => bucketOf(r) >= 0.3;

const train = rows.filter(isTrain);
const val = rows.filter(isVal);
const test = rows.filter(isTest);

/* ---------------- feature matrix + standardization ---------------- */

function vec(r) {
	return KEYS.map((k) => {
		const v = Number(r[k]);
		return Number.isFinite(v) ? v : 0;
	});
}
const Xtr = train.map(vec);
const ytr = train.map((r) => r.label);

const D = KEYS.length;
const mean = new Array(D).fill(0);
const std = new Array(D).fill(0);
for (const x of Xtr) for (let j = 0; j < D; j++) mean[j] += x[j];
for (let j = 0; j < D; j++) mean[j] /= Xtr.length;
for (const x of Xtr) for (let j = 0; j < D; j++) std[j] += (x[j] - mean[j]) ** 2;
for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j] / Xtr.length) || 1;

function standardize(x) {
	const o = new Array(D);
	for (let j = 0; j < D; j++) o[j] = (x[j] - mean[j]) / std[j];
	return o;
}
const Ztr = Xtr.map(standardize);

/* ---------------- logistic regression (balanced, L2) ---------------- */

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

const nPos = ytr.reduce((a, b) => a + b, 0);
const nNeg = ytr.length - nPos;
const wPos = ytr.length / (2 * nPos);
const wNeg = ytr.length / (2 * nNeg);

let w = new Array(D).fill(0);
let b = 0;
const LR = 0.5;
const L2 = 1e-4;
const EPOCHS = 3000;

for (let ep = 0; ep < EPOCHS; ep++) {
	const gw = new Array(D).fill(0);
	let gb = 0;
	let wsum = 0;
	for (let i = 0; i < Ztr.length; i++) {
		const z = Ztr[i];
		let dot = b;
		for (let j = 0; j < D; j++) dot += w[j] * z[j];
		const p = sigmoid(dot);
		const cw = ytr[i] ? wPos : wNeg;
		const g = cw * (p - ytr[i]);
		for (let j = 0; j < D; j++) gw[j] += g * z[j];
		gb += g;
		wsum += cw;
	}
	for (let j = 0; j < D; j++) w[j] -= LR * (gw[j] / wsum + L2 * w[j]);
	b -= LR * (gb / wsum);
}

function prob(r) {
	const z = standardize(vec(r));
	let dot = b;
	for (let j = 0; j < D; j++) dot += w[j] * z[j];
	return sigmoid(dot);
}

/* ---------------- metrics ---------------- */

// Exact AUC via Mann-Whitney rank sum (average ranks for ties).
function auc(posScores, negScores) {
	if (!posScores.length || !negScores.length) return NaN;
	const all = [
		...posScores.map((s) => ({ s, p: 1 })),
		...negScores.map((s) => ({ s, p: 0 })),
	].sort((a, b) => a.s - b.s);
	let i = 0;
	let rankSumPos = 0;
	const n = all.length;
	while (i < n) {
		let j = i;
		while (j < n && all[j].s === all[i].s) j++;
		const avgRank = (i + 1 + j) / 2; // ranks i+1..j averaged
		for (let k = i; k < j; k++) if (all[k].p === 1) rankSumPos += avgRank;
		i = j;
	}
	const nP = posScores.length;
	const nN = negScores.length;
	const U = rankSumPos - (nP * (nP + 1)) / 2;
	return U / (nP * nN);
}

function thresholdForPrecision(posScores, negScores, target) {
	const all = [
		...posScores.map((s) => ({ s, p: 1 })),
		...negScores.map((s) => ({ s, p: 0 })),
	].sort((a, b) => b.s - a.s);
	let tp = 0;
	let fp = 0;
	let best = null;
	for (const x of all) {
		if (x.p) tp++;
		else fp++;
		const prec = tp / (tp + fp);
		if (prec >= target) best = { T: x.s, prec, rec: tp / posScores.length, tp, fp };
	}
	return best;
}

const vp = val.filter((r) => r.kind === "pos");
const vh = val.filter((r) => r.kind === "hard");
const vi = val.filter((r) => r.kind === "ignore");
const vOpNeg = [...vh, ...vi];

const modelScore = (r) => prob(r);
const detScore = (r) => r.detScore;

const posM = vp.map(modelScore);
const hardM = vh.map(modelScore);
const ignM = vi.map(modelScore);
const opM = vOpNeg.map(modelScore);

const posD = vp.map(detScore);
const hardD = vh.map(detScore);
const ignD = vi.map(detScore);
const opD = vOpNeg.map(detScore);

const out = {
	hasEmbed,
	keys: KEYS,
	val: { pos: vp.length, hard: vh.length, ignore: vi.length },
	aucHard: { model: auc(posM, hardM), det: auc(posD, hardD) },
	aucIgnore: { model: auc(posM, ignM), det: auc(posD, ignD) },
	thresholds: {},
};

console.log("\n================= LEARNED BLEND vs DETERMINISTIC (held-out 25% by group) =================");
console.log(`embeddings present: ${hasEmbed}  |  features: ${D}  |  train ${train.length} / val ${val.length}`);
console.log(`val pairs — pos ${vp.length} | hard ${vh.length} | ignore ${vi.length}`);
console.log(`\nAUC+ (pos vs hard)   model ${out.aucHard.model.toFixed(4)}   det ${out.aucHard.det.toFixed(4)}   Δ ${(out.aucHard.model - out.aucHard.det >= 0 ? "+" : "") + (out.aucHard.model - out.aucHard.det).toFixed(4)}`);
console.log(`AUC  (pos vs ignore) model ${out.aucIgnore.model.toFixed(4)}   det ${out.aucIgnore.det.toFixed(4)}   Δ ${(out.aucIgnore.model - out.aucIgnore.det >= 0 ? "+" : "") + (out.aucIgnore.model - out.aucIgnore.det).toFixed(4)}`);

console.log("\nAuto-link thresholds (pos vs ignore+hard) — recall @ precision target:");
console.log("  target │      model recall │        det recall");
for (const tgt of [0.99, 0.98, 0.95, 0.9]) {
	const m = thresholdForPrecision(posM, opM, tgt);
	const d = thresholdForPrecision(posD, opD, tgt);
	out.thresholds[tgt] = {
		model: m && { rec: m.rec, T: m.T, tp: m.tp, fp: m.fp },
		det: d && { rec: d.rec, T: d.T, tp: d.tp, fp: d.fp },
	};
	const f = (r) => (r ? `${(r.rec * 100).toFixed(1)}% (tp ${r.tp} fp ${r.fp})` : "unreachable");
	console.log(`   ${(tgt * 100).toFixed(0)}%   │ ${f(m).padStart(17)} │ ${f(d).padStart(17)}`);
}

// TEST split (never used for any model/hyperparameter choice) — the unbiased number.
const tp_ = test.filter((r) => r.kind === "pos");
const th_ = test.filter((r) => r.kind === "hard");
const ti_ = test.filter((r) => r.kind === "ignore");
const tPosM = tp_.map(modelScore);
const tHardM = th_.map(modelScore);
const tOpM = [...th_, ...ti_].map(modelScore);
console.log(`\nTEST (held-out, never tuned) — pos ${tp_.length} | hard ${th_.length} | ignore ${ti_.length}`);
console.log(`AUC+ (pos vs hard) model ${auc(tPosM, tHardM).toFixed(4)}`);
for (const tgt of [0.99, 0.95]) {
	const m = thresholdForPrecision(tPosM, tOpM, tgt);
	console.log(`  test recall @${(tgt * 100).toFixed(0)}% prec: ${m ? `${(m.rec * 100).toFixed(1)}% (tp ${m.tp} fp ${m.fp})` : "unreachable"}`);
}

/* ---------------- learned weights (interpretability) ---------------- */

const weighted = KEYS.map((k, j) => ({ k, w: w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
console.log("\nLearned standardized weights (|w| desc):");
for (const { k, w: wk } of weighted) console.log(`   ${(wk >= 0 ? "+" : "") + wk.toFixed(3)}  ${k}`);

fs.writeFileSync(
	path.join(OUT_DIR, "blend_weights.json"),
	JSON.stringify({ keys: KEYS, mean, std, w, b, metrics: out }, null, 2),
);
console.log(`\nSaved → ${path.relative(process.cwd(), path.join(OUT_DIR, "blend_weights.json"))}`);
