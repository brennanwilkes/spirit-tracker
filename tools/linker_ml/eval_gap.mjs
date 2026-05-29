#!/usr/bin/env node
/**
 * tools/linker_ml/eval_gap.mjs — the semantic-gap benchmark (before/after).
 *
 * Scores the four named pairs + the harvested ≤1-token positive pairs with:
 *   - detScore        the current deterministic algo (≈0 here — that's the whole point)
 *   - cosBase         off-the-shelf MiniLM cosine (ablation: is fine-tuning necessary?)
 *   - cosFt           fine-tuned MiniLM cosine (the model trained on OUR labels)
 *   - blendProb       the learned blend's probability (uses whatever blend_weights.json holds)
 *
 * Columns that have no data yet (no embeddings.json) show 0 — establishing the baseline.
 * Re-run after train_embed.py + dump_features + train_blend to see the lift.
 *
 * Run:  node tools/linker_ml/eval_gap.mjs
 */

import fs from "fs";
import path from "path";
import { buildEnv, featurizePair, OUT_DIR, readJson } from "./featurize.mjs";

const env = buildEnv();

function tryRead(p) {
	try {
		return readJson(p);
	} catch {
		return null;
	}
}
const gap = readJson(path.join(OUT_DIR, "semantic_gap_cases.json"));
const blend = tryRead(path.join(OUT_DIR, "blend_weights.json"));
const embFt = tryRead(path.join(OUT_DIR, "embeddings.json"));
const embBase = tryRead(path.join(OUT_DIR, "embeddings_base.json"));

function cos(emb, a, b) {
	if (!emb) return 0;
	const va = emb[a];
	const vb = emb[b];
	if (!va || !vb) return 0;
	let d = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < va.length; i++) {
		d += va[i] * vb[i];
		na += va[i] * va[i];
		nb += vb[i] * vb[i];
	}
	return na && nb ? d / Math.sqrt(na * nb) : 0;
}

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
function blendProb(f) {
	if (!blend) return null;
	let dot = blend.b;
	for (let j = 0; j < blend.keys.length; j++) {
		const k = blend.keys[j];
		const v = Number(f[k]);
		const z = ((Number.isFinite(v) ? v : 0) - blend.mean[j]) / (blend.std[j] || 1);
		dot += blend.w[j] * z;
	}
	return sigmoid(dot);
}

function scorePair(a, b) {
	const f = featurizePair(a, b, env);
	if (!f) return null;
	f.embedCos = cos(embFt, a, b);
	return {
		det: f.detScore,
		cosBase: cos(embBase, a, b),
		cosFt: cos(embFt, a, b),
		prob: blendProb(f),
		nameA: env.bySku.get(a)?.name || "",
		nameB: env.bySku.get(b)?.name || "",
	};
}

function fnum(x, d = 3) {
	return x == null ? "—" : Number(x).toFixed(d);
}
function clip(s, n) {
	s = String(s || "");
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

console.log("\n================= SEMANTIC-GAP BENCHMARK — named cases =================");
console.log(
	"  det   cosBase cosFt  blendP  │ Name A".padEnd(46) + "‖ Name B",
);
for (const n of gap.named) {
	if (!n.resolved) {
		console.log(`  (unresolved) ${n.label}`);
		continue;
	}
	const r = scorePair(n.a, n.b);
	if (!r) continue;
	console.log(
		`  ${fnum(r.det, 2).padStart(5)} ${fnum(r.cosBase).padStart(6)} ${fnum(r.cosFt).padStart(5)} ${fnum(r.prob).padStart(6)}  │ ${clip(r.nameA, 28).padEnd(29)}‖ ${clip(r.nameB, 28)}`,
	);
}

console.log("\n================= harvested ≤1-token positives (n=" + gap.harvested.length + ") =================");
let sumDet = 0;
let sumBase = 0;
let sumFt = 0;
let sumProb = 0;
let nProb = 0;
const probAbove = { 0.5: 0, 0.8: 0, 0.9: 0 };
const detAbove2 = { det: 0, ft: 0 };
for (const h of gap.harvested) {
	const r = scorePair(h.a, h.b);
	if (!r) continue;
	sumDet += r.det;
	sumBase += r.cosBase;
	sumFt += r.cosFt;
	if (r.prob != null) {
		sumProb += r.prob;
		nProb++;
		for (const t of [0.5, 0.8, 0.9]) if (r.prob >= t) probAbove[t]++;
	}
	if (r.det >= 2) detAbove2.det++;
	if (r.cosFt >= 0.6) detAbove2.ft++;
}
const N = gap.harvested.length;
console.log(`  mean detScore   ${fnum(sumDet / N)}   (these are the cases det structurally misses)`);
console.log(`  mean cosBase    ${fnum(sumBase / N)}   (off-the-shelf MiniLM)`);
console.log(`  mean cosFt      ${fnum(sumFt / N)}   (fine-tuned MiniLM)`);
if (nProb) {
	console.log(`  mean blendProb  ${fnum(sumProb / nProb)}`);
	console.log(
		`  blendProb ≥0.5: ${probAbove[0.5]}/${N}   ≥0.8: ${probAbove[0.8]}/${N}   ≥0.9: ${probAbove[0.9]}/${N}`,
	);
}
console.log(`  recovered (cosFt ≥0.6): ${detAbove2.ft}/${N}   vs det ≥2: ${detAbove2.det}/${N}`);
/* ---------------- concrete 0-token examples (the showcase) ---------------- */

console.log("\n================= 0-token confirmed links — per-pair before/after =================");
console.log("  det   cosBase cosFt  blendP  │ Name A".padEnd(46) + "‖ Name B");
const zero = [];
for (const h of gap.harvested) {
	if (h.sharedTok !== 0) continue;
	const r = scorePair(h.a, h.b);
	if (r) zero.push({ ...r, a: h.a, b: h.b });
}
zero.sort((x, y) => y.cosFt - x.cosFt);
for (const r of zero.slice(0, 20)) {
	console.log(
		`  ${fnum(r.det, 2).padStart(5)} ${fnum(r.cosBase).padStart(6)} ${fnum(r.cosFt).padStart(5)} ${fnum(r.prob).padStart(6)}  │ ${clip(r.nameA, 28).padEnd(29)}‖ ${clip(r.nameB, 28)}`,
	);
}
console.log(`  … ${zero.length} total 0-token confirmed-link pairs`);
if (embFt) {
	const recBase = zero.filter((r) => r.cosBase >= 0.6).length;
	const recFt = zero.filter((r) => r.cosFt >= 0.6).length;
	console.log(`  0-token recovered @cos≥0.6 — base ${recBase}/${zero.length}   fine-tuned ${recFt}/${zero.length}`);
}

console.log(
	embFt
		? "\n(embeddings present — numbers above reflect the fine-tuned model)"
		: "\n(no embeddings yet — cos columns are 0; this is the pre-embedding baseline)",
);
