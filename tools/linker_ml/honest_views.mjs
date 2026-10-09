// Training/eval rows that look like serving. skuToTextEnriched resolves size/abv/year over a sku's
// whole linked group, so both sides of a labelled positive inherit identical attributes — a view the
// live ranker never sees (it only scores pairs from different groups, and a freshly scraped listing
// has no group at all). Trained on that, the GBT learned "asymmetric enrichment ⇒ different": an
// orphan Liquorama "BUNNAHABHAIN 18 YR" scored 0.40 against a group carrying "abv 46".
//
// Each pair in features.jsonl is re-featurized twice, with fresh per-pair encoder texts:
//   cut — only the scored a–b edge removed (an existing listing meeting another group);
//   new — every edge of `a` removed (`a` was just scraped, the auto-link CI case).
//
// node honest_views.mjs texts <features.jsonl> <outDir>    → outDir/{rows.jsonl, sku_texts.jsonl}
//   then: LINKER_OUT_DIR=<outDir> LINKER_EMB_JSONL=1 python encode.py   → outDir/embeddings.jsonl
// node honest_views.mjs feats <outDir> [view]              → outDir/features.jsonl (view = cut|new, default both)
import fs from "fs";
import path from "path";
import readline from "readline";
import { buildEnv, featurizePair, skuToTextEnriched } from "./featurize.mjs";

const VIEWS = ["cut", "new"];
const mode = process.argv[2];

if (mode === "texts") {
	const [featIn, outDir] = process.argv.slice(3);
	const env = buildEnv();
	const adj = env.linkAdj;
	const rows = [];
	const texts = [];
	for (const l of fs.readFileSync(featIn, "utf8").split("\n")) {
		if (!l) continue;
		const r = JSON.parse(l);
		const a = String(r.a);
		const b = String(r.b);
		for (const view of VIEWS) {
			const saved = adj.get(a);
			const nbrs = saved ? [...saved].filter((n) => view === "new" || n === b) : [];
			for (const n of nbrs) {
				adj.get(n).delete(a);
				saved.delete(n);
			}
			const f = featurizePair(a, b, env);
			const tA = skuToTextEnriched(a, env);
			const tB = skuToTextEnriched(b, env);
			for (const n of nbrs) {
				adj.get(n).add(a);
				saved.add(n);
			}
			if (!f) throw new Error(`featurizePair null for ${a} ${b}`);
			const i = rows.length;
			const meta = { a: r.a, b: r.b, label: r.label, kind: r.kind, canonA: r.canonA, canonB: r.canonB };
			if (r.noTrain) meta.noTrain = true;
			if (r.frozen) meta.frozen = true;
			rows.push(JSON.stringify({ view, ...meta, ...f }));
			texts.push(JSON.stringify({ sku: `${i}|a`, text: tA }), JSON.stringify({ sku: `${i}|b`, text: tB }));
		}
	}
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, "rows.jsonl"), rows.join("\n") + "\n");
	fs.writeFileSync(path.join(outDir, "sku_texts.jsonl"), texts.join("\n") + "\n");
	console.log(`honest views: ${rows.length} rows (${VIEWS.join("+")}) → ${outDir}`);
} else if (mode === "feats") {
	const [outDir, only] = process.argv.slice(3);
	if (only !== undefined && !VIEWS.includes(only)) throw new Error(`unknown view ${only}`);
	const emb = {};
	const rl = readline.createInterface({ input: fs.createReadStream(path.join(outDir, "embeddings.jsonl")) });
	for await (const line of rl) {
		if (!line) continue;
		const { sku, v } = JSON.parse(line);
		emb[sku] = v;
	}
	const out = [];
	let i = 0;
	for (const l of fs.readFileSync(path.join(outDir, "rows.jsonl"), "utf8").split("\n")) {
		if (!l) continue;
		const { view, ...r } = JSON.parse(l);
		const va = emb[`${i}|a`];
		const vb = emb[`${i}|b`];
		i++;
		if (!va || !vb) throw new Error(`missing view vector for row ${i - 1}`);
		if (only !== undefined && view !== only) continue;
		let d = 0, na = 0, nb = 0;
		for (let k = 0; k < va.length; k++) {
			d += va[k] * vb[k];
			na += va[k] * va[k];
			nb += vb[k] * vb[k];
		}
		out.push(JSON.stringify({ ...r, embedCos: d / Math.sqrt(na * nb) }));
	}
	const dest = path.join(outDir, only === undefined ? "features.jsonl" : `features_${only}.jsonl`);
	fs.writeFileSync(dest, out.join("\n") + "\n");
	console.log(`${out.length} rows → ${dest}`);
} else throw new Error(`usage: honest_views.mjs texts <features.jsonl> <outDir> | feats <outDir> [cut|new]`);
