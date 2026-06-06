#!/usr/bin/env node
/**
 * tools/linker_ml/report_offenders.mjs — worst false-positives / false-negatives for the
 * SHIPPING GBT, scored on the HELD-OUT set (val+test groups + all noTrain pairs — none of
 * which the metric model trained on; the shipping model refits on non-noTrain but val/test
 * groups are still the honest disagreement surface, and noTrain is never trained on at all).
 *
 * Emits two markdown-ready TSV blocks (rank, score, expected, skuA, nameA, skuB, nameB, why).
 *
 * Run:  node tools/linker_ml/report_offenders.mjs [gbt_model.json]
 */
import fs from "fs";
import path from "path";
import { buildEnv, OUT_DIR } from "./featurize.mjs";
import { gbtScore } from "../../viz/app/linker_page/gbt.js";

const env = buildEnv();
const modelPath = process.argv[2] || path.join(OUT_DIR, "gbt_model.json");
const model = JSON.parse(fs.readFileSync(modelPath, "utf8"));
const rows = fs.readFileSync(path.join(OUT_DIR, "features.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function hash32(str) { let h = 0x811c9dc5; str = String(str); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
const isTrainCanon = (c) => (hash32(c) % 1000) / 1000 >= 0.3;
// EXCLUDE noTrain from worst-misses analysis: a noTrain pair scoring "wrong" is EXPECTED (it was
// labeled with info the classifier can't access), not a model failure. See
// [[feedback_notrain_and_hidden_exclusion]]. (Hidden SKUs are already gone — buildEnv drops them.)
const heldOut = (r) => !r.noTrain && (!isTrainCanon(r.canonA) || (r.label === 1 && !isTrainCanon(r.canonB)));

const nm = (s) => (env.bySku.get(String(s))?.name || "?").slice(0, 48);
function why(r) {
	const bits = [];
	if (r.noTrain) bits.push("noTrain");
	if ((r.sizePen ?? 1) < 0.5) bits.push("size");
	if ((r.abvMult ?? 1) < 0.5) bits.push("abv");
	if ((r.edMult ?? 1) < 0.5) bits.push("edition");
	if ((r.conceptMult ?? 1) < 0.7) bits.push("concept");
	if ((r.crossEntityConflicts || 0) > 0) bits.push(`xEntity:${r.crossEntityConflicts}`);
	if ((r.sharedTok || 0) <= 1) bits.push(`sharedTok:${r.sharedTok || 0}`);
	if (Math.abs(r.embedCos || 0) < 1e-9) bits.push("noEmbed");
	else bits.push(`emb:${(r.embedCos).toFixed(2)}`);
	bits.push(`det:${(r.detScore || 0).toFixed(2)}`);
	return bits.join(" ");
}

const scored = rows.filter(heldOut).map((r) => ({ r, s: gbtScore(model, r) }));
const fp = scored.filter((x) => x.r.label === 0).sort((a, b) => b.s - a.s).slice(0, 15);
const fn = scored.filter((x) => x.r.label === 1).sort((a, b) => a.s - b.s).slice(0, 15);

function emit(title, list, expected) {
	console.log(`\n### ${title}`);
	console.log("rank\tscore\texpected\tskuA\tnameA\tskuB\tnameB\twhy");
	list.forEach((x, i) => {
		console.log(`${i + 1}\t${x.s.toFixed(3)}\t${expected}\t${x.r.a}\t${nm(x.r.a)}\t${x.r.b}\t${nm(x.r.b)}\t${why(x.r)}`);
	});
}
console.log(`# offenders for ${path.basename(modelPath)} — held-out rows: ${scored.length}`);
emit("15 worst FALSE POSITIVES (non-link scored highest)", fp, "IGNORE");
emit("15 worst FALSE NEGATIVES (link scored lowest)", fn, "LINK");
