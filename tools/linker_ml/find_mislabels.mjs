#!/usr/bin/env node
/**
 * tools/linker_ml/find_mislabels.mjs — scan the FULL label set with the shipped GBT to surface
 * likely mislabels in BOTH directions:
 *   SHOULD-LINK   : pairs in `ignores` the model scores HIGH (you said different, model says same)
 *   SHOULD-UNLINK : direct edges in `links` the model scores LOW  (you said same, model says different)
 *
 * Scores every present, non-noTrain ignore and direct link edge. Prints sorted, with SKUs/names/
 * det/emb and (for ignores) whether the two are ALREADY in the same canonical group (contradiction).
 *
 * Run:  node tools/linker_ml/find_mislabels.mjs [linkHi=0.20] [ignoreHi=0.80]
 */
import fs from "fs";
import path from "path";
import { buildEnv, featurizePair, OUT_DIR, readJson } from "./featurize.mjs";
import { gbtScore } from "../../viz/app/linker_page/gbt.js";
import { normalizeImplicitSkuKey } from "../../viz/app/sku_canonical.js";

const LINK_LO = parseFloat(process.argv[2] || "0.20");
const IGN_HI = parseFloat(process.argv[3] || "0.80");
const env = buildEnv();
const model = readJson(path.join(OUT_DIR, "gbt_model.json"));
const emb = readJson(path.join(OUT_DIR, "embeddings.json"));
const normKey = (s) => normalizeImplicitSkuKey(String(s || "").trim());

// full-graph union (same as fixed build_dataset) for the contradiction flag
const parent = new Map();
const find = (x) => { const st = []; while (parent.has(x)) { st.push(x); x = parent.get(x); } for (const p of st) parent.set(p, x); return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
for (const l of env.allLinks) { const f = normKey(l.fromSku), t = normKey(l.toSku); if (f && t && f !== t) union(f, t); }
const canon = (s) => find(normKey(s));

function cos(a, b) { const va = emb[a], vb = emb[b]; if (!va || !vb) return NaN; let d = 0, na = 0, nb = 0; for (let i = 0; i < va.length; i++) { d += va[i] * vb[i]; na += va[i] * va[i]; nb += vb[i] * vb[i]; } return na && nb ? d / Math.sqrt(na * nb) : 0; }
function score(a, b) { const f = featurizePair(a, b, env); if (!f) return null; f.embedCos = cos(a, b); return { s: gbtScore(model, f), det: f.detScore || 0, emb: f.embedCos, sizePen: f.sizePen ?? 1, abvMult: f.abvMult ?? 1, edMult: f.edMult ?? 1 }; }
// terse tag of WHY the model scored a link low → distinguishes "variant the model under-scores"
// (likely keep/notrain) from "genuinely different product" (likely true mislabel)
function tag(r) {
	const t = [];
	if (r.sizePen < 0.5) t.push("SIZE");
	if (r.abvMult < 0.5) t.push("ABV");
	if (r.edMult < 0.5) t.push("EDITION");
	if (!t.length) t.push(r.emb > 0.9 ? "near-dup?" : "DIFFERENT?");
	return t.join("+");
}
const nm = (s) => (env.bySku.get(String(s))?.name || "?").slice(0, 46);
const present = (s) => env.bySku.has(String(s));

// SHOULD-UNLINK — direct link edges the model rejects
const seenL = new Set();
const unlink = [];
for (const l of env.manualLinks) {
	if (l.noTrain) continue;
	const a = String(l.fromSku || "").trim(), b = String(l.toSku || "").trim();
	if (!a || !b || a === b || !present(a) || !present(b)) continue;
	const k = a < b ? `${a}|${b}` : `${b}|${a}`;
	if (seenL.has(k)) continue; seenL.add(k);
	const r = score(a, b); if (!r) continue;
	if (r.s < LINK_LO) unlink.push({ a, b, ...r });
}
unlink.sort((x, y) => x.s - y.s);

// SHOULD-LINK — ignores the model accepts
const seenI = new Set();
const link = [];
for (const ig of env.ignoreEntries) {
	if (ig.noTrain) continue;
	const a = String(ig.skuA || ig.fromSku || "").trim(), b = String(ig.skuB || ig.toSku || "").trim();
	if (!a || !b || a === b || !present(a) || !present(b)) continue;
	const k = a < b ? `${a}|${b}` : `${b}|${a}`;
	if (seenI.has(k)) continue; seenI.add(k);
	const r = score(a, b); if (!r) continue;
	if (r.s > IGN_HI) link.push({ a, b, ...r, sameGroup: canon(a) === canon(b) });
}
link.sort((x, y) => y.s - x.s);

function emit(title, list, cols) {
	console.log(`\n### ${title} (${list.length})`);
	console.log(cols);
	list.forEach((x, i) => console.log(
		`${i + 1}\t${x.s.toFixed(3)}\t${tag(x)}\t${x.det.toFixed(1)}\t${(x.emb ?? NaN).toFixed(2)}\t${x.a}\t${nm(x.a)}\t${x.b}\t${nm(x.b)}${x.sameGroup !== undefined ? `\t${x.sameGroup ? "SAME-GRP" : ""}` : ""}`));
}
console.log(`# mislabel candidates — links scored <${LINK_LO}, ignores scored >${IGN_HI}`);
emit("SHOULD-UNLINK — you linked these, model says DIFFERENT", unlink, "#\tgbt\tdet\temb\tskuA\tnameA\tskuB\tnameB");
emit("SHOULD-LINK — you ignored these, model says SAME", link, "#\tgbt\tdet\temb\tskuA\tnameA\tskuB\tnameB\tnote");
