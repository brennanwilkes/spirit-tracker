#!/usr/bin/env node
/**
 * tools/linker_ml/cooccur_analysis.mjs — PROTOTYPE / measurement for the
 * "token agreement-necessity" idea (Cadenhead/Glentauchers).
 *
 * For each token t, computed on the TRAIN split ONLY (no leakage):
 *   necessity(t)   = P(t on BOTH sides | t on EITHER side, pair is a LINK)
 *                    "if this token appears in a real match, does it appear on both sides?"
 *                    Distillery/bottler tokens → HIGH (a Cadenhead matches only a Cadenhead).
 *   negShare(t)    = same ratio but over NON-links (ignores+hard).
 *                    "among confident non-matches that involve t, how often is it shared?"
 *   lift           = necessity vs the base agreement rate — is t actually discriminative?
 *
 * Derived PAIR features tested here:
 *   disagreeNecMax = max necessity(t) over tokens present on EXACTLY ONE side (XOR).
 *                    High ⇒ one side carries a link-necessary token the other lacks ⇒ negative.
 *                    This is the supervised analogue of crossEntityConflicts/degPerDf.
 *   agreeNecSum    = sum of necessity(t) over SHARED distinctive tokens (the "combination"
 *                    intuition: Cadenhead + Glentauchers + G&M all agreeing).
 *
 * We measure each feature's STANDALONE AUC+ (links vs hard+ignore) and its correlation with
 * the existing unsupervised crossEntityConflicts — to see if it adds anything new.
 *
 * Run:  node tools/linker_ml/cooccur_analysis.mjs
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
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}
const bucket = (canon) => (hash32(canon) % 1000) / 1000;
const isTrainCanon = (canon) => bucket(canon) >= 0.3; // matches the trainers

const rows = fs
	.readFileSync(path.join(OUT_DIR, "features.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l));

const tokCache = new Map();
function toks(sku) {
	let t = tokCache.get(sku);
	if (!t) {
		t = new Set(filterSimTokens(tokenizeQuery(normSearchText(env.bySku.get(sku)?.name || ""))));
		tokCache.set(sku, t);
	}
	return t;
}

/* ---- accumulate co-presence stats on TRAIN pairs only ---- */
const posBoth = new Map(), posEither = new Map();
const negBoth = new Map(), negEither = new Map();
const df = new Map(); // token → # SKUs carrying it (over all SKUs, for idf-ish context)
for (const s of env.bySku.keys()) for (const t of toks(s)) df.set(t, (df.get(t) || 0) + 1);

function bump(m, k) { m.set(k, (m.get(k) || 0) + 1); }
let nPosTrain = 0, nNegTrain = 0;
for (const r of rows) {
	if (r.noTrain) continue;
	// positives have canonA===canonB; key the split on canonA either way
	if (!isTrainCanon(r.canonA)) continue;
	if (r.label === 1 && !isTrainCanon(r.canonB)) continue;
	const A = toks(r.a), B = toks(r.b);
	const either = new Set([...A, ...B]);
	const isPos = r.label === 1;
	if (isPos) nPosTrain++; else nNegTrain++;
	for (const t of either) {
		const both = A.has(t) && B.has(t);
		if (isPos) { bump(posEither, t); if (both) bump(posBoth, t); }
		else { bump(negEither, t); if (both) bump(negBoth, t); }
	}
}

// base agreement rate among positives (prior for shrinkage)
let pb = 0, pe = 0;
for (const [t, e] of posEither) { pe += e; pb += posBoth.get(t) || 0; }
const PRIOR = pb / pe;
const ALPHA = 5; // pseudo-counts of shrinkage toward PRIOR

function necessity(t) {
	const e = posEither.get(t) || 0;
	if (e === 0) return null;
	return ((posBoth.get(t) || 0) + ALPHA * PRIOR) / (e + ALPHA);
}
function negShare(t) {
	const e = negEither.get(t) || 0;
	if (e === 0) return null;
	return ((negBoth.get(t) || 0) + ALPHA * PRIOR) / (e + ALPHA);
}

/* ---- top necessity tokens (the "link-necessary entities") ---- */
const tokStats = [];
for (const [t, e] of posEither) {
	if (e < 4) continue; // need a little support
	const nec = necessity(t);
	const ns = negShare(t);
	tokStats.push({ t, e, both: posBoth.get(t) || 0, nec, ns, df: df.get(t) || 0 });
}
tokStats.sort((a, b) => b.nec - a.nec || b.e - a.e);
console.log(`\nTRAIN pairs: ${nPosTrain} pos, ${nNegTrain} neg.  base agreement rate=${PRIOR.toFixed(3)}\n`);
console.log("TOP 25 link-NECESSARY tokens (high necessity = links require it on both sides):");
console.log("  token              posEither  necessity  negShare   df");
for (const s of tokStats.slice(0, 25))
	console.log(
		`  ${s.t.padEnd(18)} ${String(s.e).padStart(8)}  ${s.nec.toFixed(3).padStart(8)}  ${(s.ns ?? 0).toFixed(3).padStart(8)}  ${String(s.df).padStart(4)}`,
	);

/* ---- spot-check the user's named cases ---- */
console.log("\nSpot check (necessity of named entity tokens):");
for (const t of ["cadenhead", "glentauchers", "signatory", "gordon", "macphail", "smws", "oloroso", "sherry", "cask", "reserve", "single"]) {
	const nec = necessity(t);
	console.log(`  ${t.padEnd(14)} necessity=${nec == null ? "  n/a" : nec.toFixed(3)}  posEither=${posEither.get(t) || 0}  df=${df.get(t) || 0}`);
}

/* ---- build pair features and measure standalone AUC+ ---- */
const NEC_MIN_SUPPORT = 4;
function necOf(t) {
	if ((posEither.get(t) || 0) < NEC_MIN_SUPPORT) return null;
	return necessity(t);
}
function pairFeats(r) {
	const A = toks(r.a), B = toks(r.b);
	let disMax = 0, agree = 0;
	for (const t of A) if (!B.has(t)) { const n = necOf(t); if (n != null && n > disMax) disMax = n; }
	for (const t of B) if (!A.has(t)) { const n = necOf(t); if (n != null && n > disMax) disMax = n; }
	for (const t of A) if (B.has(t)) { const n = necOf(t); if (n != null) agree += n; }
	return { disMax, agree };
}

// Evaluate on the held-out side (VAL+TEST) so the necessity table (TRAIN) isn't scored on itself.
const evalRows = rows.filter((r) => !isTrainCanon(r.canonA) || (r.label === 1 && !isTrainCanon(r.canonB)));
function auc(scoreFn, posPred, negPred) {
	const pos = [], neg = [];
	for (const r of evalRows) {
		if (r.label === 1 && posPred(r)) pos.push(scoreFn(r));
		else if (r.label === 0 && negPred(r)) neg.push(scoreFn(r));
	}
	let win = 0, tot = 0;
	for (const p of pos) for (const n of neg) { tot++; if (p > n) win++; else if (p === n) win += 0.5; }
	return { auc: tot ? win / tot : 0, nPos: pos.length, nNeg: neg.length };
}
const isHardNeg = (r) => r.kind === "hard" || r.kind === "ignore";
// disagreement is a NEGATIVE signal → score = -disMax so "higher = more likely link"
const aDis = auc((r) => -pairFeats(r).disMax, () => true, isHardNeg);
const aAgree = auc((r) => pairFeats(r).agree, () => true, isHardNeg);
const aCE = auc((r) => -(r.crossEntityConflicts || 0), () => true, isHardNeg);
const aEmbed = auc((r) => r.embedCos || 0, () => true, isHardNeg);
const aDet = auc((r) => r.detScore || 0, () => true, isHardNeg);
console.log("\nStandalone AUC+ on HELD-OUT (val+test) vs hard+ignore negatives:");
console.log(`  detScore (full classical)   ${aDet.auc.toFixed(4)}  (n=${aDet.nPos}/${aDet.nNeg})`);
console.log(`  embedCos (current FT)        ${aEmbed.auc.toFixed(4)}`);
console.log(`  -crossEntityConflicts        ${aCE.auc.toFixed(4)}   <- existing unsupervised`);
console.log(`  -disagreeNecMax (NEW)        ${aDis.auc.toFixed(4)}   <- supervised necessity`);
console.log(`  agreeNecSum (NEW)            ${aAgree.auc.toFixed(4)}`);

/* ---- how much does disagreeNecMax overlap crossEntityConflicts? ---- */
let nDisFires = 0, nCEfires = 0, nBoth = 0, nDisOnly = 0;
for (const r of evalRows) {
	const d = pairFeats(r).disMax >= 0.85; // a "link-necessary token is missing" event
	const c = (r.crossEntityConflicts || 0) > 0;
	if (d) nDisFires++;
	if (c) nCEfires++;
	if (d && c) nBoth++;
	if (d && !c) nDisOnly++;
}
console.log(`\nOverlap with crossEntityConflicts on held-out (disMax≥0.85 = "link-necessary token missing"):`);
console.log(`  disMax fires: ${nDisFires}   crossEntity fires: ${nCEfires}   both: ${nBoth}   disMax-only: ${nDisOnly}`);
console.log(`  → ${nDisOnly} pairs the supervised signal flags that the unsupervised one misses.\n`);
