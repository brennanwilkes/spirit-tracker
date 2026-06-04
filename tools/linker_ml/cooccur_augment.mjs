#!/usr/bin/env node
/**
 * tools/linker_ml/cooccur_augment.mjs — write features_cooccur.jsonl = features.jsonl +
 * co-occurrence "necessity" columns, computed from the TRAIN split ONLY (no leakage into
 * VAL/TEST). Lets export_gbt.py A/B test whether the supervised token-agreement signal
 * adds anything over the existing features.
 *
 * necessity(t) = shrunk P(t on BOTH sides | t on EITHER side, LINK) over TRAIN pairs.
 * Computed for unigrams AND adjacent unordered bigrams (the "pairs of words" / multi-token
 * unit idea: "compass box", "gordon macphail", "cask strength" behave as one entity).
 *
 * Added columns:
 *   coDisagreeMax   = max necessity over tokens/bigrams on EXACTLY ONE side (XOR). High ⇒ a
 *                     link-necessary entity is missing from one side ⇒ evidence AGAINST.
 *   coAgreeSum      = Σ necessity over SHARED tokens/bigrams (the "combination" evidence FOR).
 *   coAgreeHiCount  = # shared tokens/bigrams with necessity ≥ 0.9 (Cadenhead+Glentauchers+…).
 *   coDisagreeBigram= max necessity over XOR ADJACENT BIGRAMS only (multi-token units).
 *
 * Run:  node tools/linker_ml/cooccur_augment.mjs
 */
import fs from "fs";
import path from "path";
import { buildEnv, OUT_DIR } from "./featurize.mjs";
import { normSearchText, tokenizeQuery } from "../../viz/app/sku.js";
import { filterSimTokens } from "../../viz/app/linker_page/similarity.js";

const env = buildEnv();
function hash32(str) {
	let h = 0x811c9dc5;
	str = String(str);
	for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return h >>> 0;
}
const isTrainCanon = (c) => (hash32(c) % 1000) / 1000 >= 0.3;

const rows = fs.readFileSync(path.join(OUT_DIR, "features.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const tokCache = new Map();
function feats(sku) {
	let f = tokCache.get(sku);
	if (f) return f;
	const t = filterSimTokens(tokenizeQuery(normSearchText(env.bySku.get(sku)?.name || "")));
	const uni = new Set(t);
	const bi = new Set();
	for (let i = 0; i + 1 < t.length; i++) bi.add([t[i], t[i + 1]].sort().join("~"));
	f = { uni, bi, all: new Set([...uni, ...bi]) };
	tokCache.set(sku, f);
	return f;
}

const posBoth = new Map(), posEither = new Map();
function bump(m, k) { m.set(k, (m.get(k) || 0) + 1); }
for (const r of rows) {
	if (r.noTrain) continue;
	if (!isTrainCanon(r.canonA)) continue;
	if (r.label === 1 && !isTrainCanon(r.canonB)) continue;
	if (r.label !== 1) continue; // necessity is defined over LINKS
	const A = feats(r.a).all, B = feats(r.b).all;
	for (const t of new Set([...A, ...B])) { bump(posEither, t); if (A.has(t) && B.has(t)) bump(posBoth, t); }
}
let pb = 0, pe = 0;
for (const [t, e] of posEither) { pe += e; pb += posBoth.get(t) || 0; }
const PRIOR = pb / pe, ALPHA = 5, MIN_SUPPORT = 4;
function nec(t) {
	const e = posEither.get(t) || 0;
	if (e < MIN_SUPPORT) return null;
	return ((posBoth.get(t) || 0) + ALPHA * PRIOR) / (e + ALPHA);
}

const out = rows.map((r) => {
	const A = feats(r.a), B = feats(r.b);
	let disMax = 0, disBigram = 0, agreeSum = 0, hiCount = 0;
	const xorAll = [...A.all].filter((t) => !B.all.has(t)).concat([...B.all].filter((t) => !A.all.has(t)));
	for (const t of xorAll) { const n = nec(t); if (n != null && n > disMax) disMax = n; }
	const xorBi = [...A.bi].filter((t) => !B.bi.has(t)).concat([...B.bi].filter((t) => !A.bi.has(t)));
	for (const t of xorBi) { const n = nec(t); if (n != null && n > disBigram) disBigram = n; }
	for (const t of A.all) if (B.all.has(t)) { const n = nec(t); if (n != null) { agreeSum += n; if (n >= 0.9) hiCount++; } }
	return { ...r, coDisagreeMax: disMax, coAgreeSum: agreeSum, coAgreeHiCount: hiCount, coDisagreeBigram: disBigram };
});
const outPath = path.join(OUT_DIR, "features_cooccur.jsonl");
fs.writeFileSync(outPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`features_cooccur.jsonl: ${out.length} rows, +4 cooccur cols (PRIOR=${PRIOR.toFixed(3)}, vocab uni+bi=${posEither.size}) → ${outPath}`);
