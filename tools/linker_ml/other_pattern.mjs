#!/usr/bin/env node
/**
 * tools/linker_ml/other_pattern.mjs — dissect the "other" 81% miss bucket at the TOKEN level to
 * find the missing classical signal. For each missed confirmed link, show shared vs unshared
 * tokens WITH their IDF, and test candidate new features (max-shared-IDF, distinctive-shared
 * count, shorter-name distinctive containment, spacing-concat) — comparing misses (true matches)
 * vs held-out NEGATIVES, to see if a classical feature would separate them.
 */
import fs from "fs";
import path from "path";
import { buildEnv, OUT_DIR, readJson } from "./featurize.mjs";
import { gbtScore } from "../../viz/app/linker_page/gbt.js";
import { normSearchText, tokenizeQuery } from "../../viz/app/sku.js";
import { filterSimTokens } from "../../viz/app/linker_page/similarity.js";

const env = buildEnv();
const model = readJson(path.join(OUT_DIR, "gbt_model.json"));
const rows = fs.readFileSync(path.join(OUT_DIR, "features.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const h32 = (s) => { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const isTrain = (c) => (h32(c) % 1000) / 1000 >= 0.3;
const held = (r) => !r.noTrain && (!isTrain(r.canonA) || !isTrain(r.canonB));
const nm = (s) => (env.bySku.get(String(s))?.name || "?");
const N = env.allAgg.length;
const dfOf = typeof env.vocab.dfOf === "function" ? (t) => env.vocab.dfOf(t) : () => 0;
const idf = (t) => Math.log((N + 1) / (dfOf(t) + 1));
const toks = (s) => [...new Set(filterSimTokens(tokenizeQuery(normSearchText(s))))];
const noSpace = (s) => normSearchText(s).replace(/ /g, "");

function feats(a, b) {
	const A = toks(nm(a)), B = toks(nm(b));
	const SA = new Set(A), SB = new Set(B);
	const shared = A.filter((t) => SB.has(t));
	const aOnly = A.filter((t) => !SB.has(t)), bOnly = B.filter((t) => !SA.has(t));
	const maxSharedIdf = shared.length ? Math.max(...shared.map(idf)) : 0;
	const sumSharedIdf = shared.reduce((s, t) => s + idf(t), 0);
	const distinctiveShared = shared.filter((t) => idf(t) >= 4.6).length;
	// shorter name's distinctive (idf>=3) tokens contained in the other
	const [shortT, longSet] = A.length <= B.length ? [A, SB] : [B, SA];
	const sd = shortT.filter((t) => idf(t) >= 3);
	const shorterDistinctiveContain = sd.length ? sd.filter((t) => longSet.has(t)).length / sd.length : 0;
	// spacing/concat: shorter no-space string is a substring of the longer no-space
	const na = noSpace(nm(a)), nb = noSpace(nm(b));
	const [sShort, sLong] = na.length <= nb.length ? [na, nb] : [nb, na];
	const concatContain = sShort.length >= 6 && sLong.includes(sShort) ? 1 : 0;
	return { shared, aOnly, bOnly, maxSharedIdf, sumSharedIdf, distinctiveShared, shorterDistinctiveContain, concatContain };
}

// threshold + misses (reuse export_gbt 99% logic)
const ev = rows.filter(held).filter((r) => r.label === 1 || r.kind === "ignore" || r.kind === "hard").map((r) => ({ r, s: gbtScore(model, r) }));
ev.sort((a, b) => b.s - a.s);
let tp = 0, fp = 0, thr = 1, nPos = ev.filter((x) => x.r.label === 1).length, best = 0;
for (const x of ev) { if (x.r.label === 1) tp++; else fp++; if (tp / (tp + fp) >= 0.99 && tp / nPos > best) { best = tp / nPos; thr = x.s; } }

const PACK = /\b(gift|pack|calendar|tasting|glasses|advent|sampler)\b/i;
function isOther(r) {
	if ((r.sizePen ?? 1) < 0.5 || (r.abvMult ?? 1) < 0.5 || (r.edMult ?? 1) < 0.5) return false;
	if (PACK.test(nm(r.a)) || PACK.test(nm(r.b))) return false;
	if ((r.sharedTok || 0) <= 1) return false; // those are spelling/semantic buckets
	return true;
}
const otherMiss = ev.filter((x) => x.r.label === 1 && x.s < thr && isOther(x.r));
const negs = ev.filter((x) => x.r.label === 0); // held-out negatives (ignore+hard)

// aggregate separation: misses vs negatives on candidate features
function agg(list, f) { const v = list.map((x) => f(feats(x.r.a, x.r.b))); v.sort((a, b) => a - b); return { mean: v.reduce((s, n) => s + n, 0) / v.length, med: v[Math.floor(v.length / 2)] }; }
console.log(`# "other" miss pattern — ${otherMiss.length} missed true matches vs ${negs.length} held-out negatives (99% thr=${thr.toFixed(3)})\n`);
console.log("Candidate feature | miss mean/med | neg mean/med (want SEPARATION)");
for (const [name, fn] of [["maxSharedIdf", (f) => f.maxSharedIdf], ["sumSharedIdf", (f) => f.sumSharedIdf], ["distinctiveShared(#idf>=4.6)", (f) => f.distinctiveShared], ["shorterDistinctiveContain", (f) => f.shorterDistinctiveContain], ["concatContain", (f) => f.concatContain]]) {
	const m = agg(otherMiss, fn), n = agg(negs, fn);
	console.log(`  ${name.padEnd(30)} miss ${m.mean.toFixed(2)}/${m.med.toFixed(2)}   neg ${n.mean.toFixed(2)}/${n.med.toFixed(2)}`);
}

// how many misses share a clearly-distinctive token but still missed?
const shareDistinct = otherMiss.filter((x) => feats(x.r.a, x.r.b).maxSharedIdf >= 5).length;
const shortContained = otherMiss.filter((x) => feats(x.r.a, x.r.b).shorterDistinctiveContain >= 0.99).length;
console.log(`\n${shareDistinct}/${otherMiss.length} misses share a token with IDF>=5 (distinctive) yet still missed.`);
console.log(`${shortContained}/${otherMiss.length} misses: ALL of the shorter name's distinctive tokens are present in the longer (clean containment).`);

console.log("\n## Per-miss token breakdown (top 35 by score)");
for (const x of otherMiss.sort((a, b) => a.s - b.s).slice(0, 35)) {
	const f = feats(x.r.a, x.r.b);
	const sh = f.shared.map((t) => `${t}(${idf(t).toFixed(1)})`).join(" ");
	console.log(`s=${x.s.toFixed(2)} emb=${(x.r.embedCos || 0).toFixed(2)} maxShIdf=${f.maxSharedIdf.toFixed(1)} shortContain=${f.shorterDistinctiveContain.toFixed(2)}`);
	console.log(`   ${nm(x.r.a).slice(0, 42)}  ‖  ${nm(x.r.b).slice(0, 42)}`);
	console.log(`   shared: ${sh || "(none distinctive)"}   |  A-only:${f.aOnly.length} B-only:${f.bOnly.length}`);
}
