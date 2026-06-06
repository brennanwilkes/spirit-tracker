#!/usr/bin/env node
/**
 * tools/linker_ml/join_crossenc_oof.mjs — add the OOF crossEnc column to a features file.
 *
 * Reads features.jsonl (the shipping coverage+chartri feature set) and the OOF scores from
 * out/crossenc_oof_scores.json, emits out/features_crossenc_oof.jsonl with a `crossEnc`
 * column inserted BEFORE embedCos (so export_gbt picks it up as just another column; the
 * embIndex is still resolved by name via KEYS.index, so order only matters for the JS
 * featurizer parity — which this experiment does NOT ship live).
 *
 * Run:  node tools/linker_ml/join_crossenc_oof.mjs
 */
import fs from "fs";
import path from "path";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "out");
const scores = JSON.parse(fs.readFileSync(path.join(OUT, "crossenc_oof_scores.json"), "utf8"));
const pkey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const lines = fs.readFileSync(path.join(OUT, "features.jsonl"), "utf8").split("\n").filter(Boolean);
let missing = 0;
const out = lines.map((l) => {
	const r = JSON.parse(l);
	const k = pkey(r.a, r.b);
	let cs = scores[k];
	if (cs == null) {
		missing++;
		cs = NaN; // let the tree route it as missing
	}
	// insert crossEnc just before embedCos to keep a tidy column order
	const ordered = {};
	for (const key of Object.keys(r)) {
		if (key === "embedCos") ordered.crossEnc = cs;
		ordered[key] = r[key];
	}
	if (!("crossEnc" in ordered)) ordered.crossEnc = cs;
	return JSON.stringify(ordered);
});
const dest = path.join(OUT, "features_crossenc_oof.jsonl");
fs.writeFileSync(dest, out.join("\n") + "\n");
console.log(`features_crossenc_oof.jsonl: ${out.length} rows, ${missing} pairs with no OOF score (NaN)`);
