#!/usr/bin/env node
/**
 * tools/linker_ml/dump_features.mjs — join dataset_pairs × featurizePair → features.jsonl.
 *
 * Each output row: { a, b, label, kind, canonA, canonB, ...featureColumns }.
 * canonA/canonB let train_blend split train/val by canonical group (no group on both
 * sides) for an honest generalization estimate.
 *
 * If out/embeddings.json exists (written by train_embed.py), the embed_cosine column is
 * filled from it; otherwise it stays 0 and the blend simply runs without the semantic
 * feature (Stage 1–2). Re-run this after training the embedder to add embed_cosine.
 *
 * Run:  node tools/linker_ml/dump_features.mjs
 */

import fs from "fs";
import path from "path";
import { buildEnv, featurizePair, OUT_DIR, readJson } from "./featurize.mjs";

const env = buildEnv();

const parent = new Map();
function find(x) {
	const st = [];
	while (parent.has(x)) {
		st.push(x);
		x = parent.get(x);
	}
	for (const p of st) parent.set(p, x);
	return x;
}
for (const l of env.allLinks) {
	const f = String(l.fromSku || "").trim();
	const t = String(l.toSku || "").trim();
	if (f && t && f !== t && env.bySku.has(f) && env.bySku.has(t)) {
		const ra = find(f);
		const rb = find(t);
		if (ra !== rb) parent.set(ra, rb);
	}
}
const canonOf = (s) => find(String(s));

// Optional embeddings (sku → vector) for cosine.
let emb = null;
const embPath = path.join(OUT_DIR, "embeddings.json");
if (fs.existsSync(embPath)) {
	emb = readJson(embPath);
	console.log(`embeddings.json found: ${Object.keys(emb).length} vectors → filling embed_cosine`);
}
function cos(a, b) {
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

const pairsPath = path.join(OUT_DIR, "dataset_pairs.jsonl");
const lines = fs.readFileSync(pairsPath, "utf8").split("\n").filter(Boolean);

const out = [];
let done = 0;
for (const line of lines) {
	const p = JSON.parse(line);
	const f = featurizePair(p.a, p.b, env);
	if (!f) continue;
	if (emb) f.embedCos = cos(p.a, p.b);
	out.push(
		JSON.stringify({
			a: p.a,
			b: p.b,
			label: p.label,
			kind: p.kind,
			canonA: canonOf(p.a),
			canonB: canonOf(p.b),
			...(p.noTrain ? { noTrain: true } : {}),
			...f,
		}),
	);
	if (++done % 2000 === 0) console.log(`  featurized ${done}/${lines.length}`);
}

const featPath = path.join(OUT_DIR, "features.jsonl");
fs.writeFileSync(featPath, out.join("\n") + "\n");
console.log(`features.jsonl: ${out.length} rows${emb ? " (with embed_cosine)" : " (no embeddings yet)"}`);
