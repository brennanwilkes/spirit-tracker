#!/usr/bin/env node
// Pair-major precision slice: every EXISTING explicit link whose live re-score falls in a prob band,
// deduped to one row per undirected pair, plus each touched canonical group's members once.
// Row-major funnels repeat the same pair on every store row that carries it (measured 2.4–4.3x);
// this hands the agent each decision exactly once. Pins (shared SMWS cask code) are excluded — their
// prob is not calibrated (see CLAUDE.md "Pin gotcha").
//
//   node tools/audit_link_band_slice.js --from audit/rich-fh-v4.jsonl --min 0.30 --max 0.95 \
//        --out audit/slice-band-030-095.json
const fs = require("fs");
const readline = require("readline");
const { normalizeImplicitSkuKey } = require("../src/utils/sku_canonical");

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const from = arg("--from");
const out = arg("--out");
const min = Number(arg("--min"));
const max = Number(arg("--max"));
if (!from || !out || !Number.isFinite(min) || !Number.isFinite(max)) {
	console.error("usage: audit_link_band_slice.js --from <rich.jsonl> --min <p> --max <p> --out <file>");
	process.exit(2);
}

(async () => {
	const pairs = new Map();
	const listingsBySku = new Map();
	const canonOf = new Map();
	const rl = readline.createInterface({ input: fs.createReadStream(from), crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line || line.startsWith('{"_meta"')) continue;
		const l = JSON.parse(line);
		const me = normalizeImplicitSkuKey(l.sku);
		canonOf.set(me, l.canonicalSku);
		if (!listingsBySku.has(me)) listingsBySku.set(me, []);
		listingsBySku.get(me).push([l.store, l.current ? l.current.name : l.detectedName || "", l.current ? l.current.price : null, l.current && l.current.removed ? 1 : 0, l.current ? String(l.current.url || "").replace(/^https?:\/\/(www\.)?/, "") : ""]);
		for (const v of (l.scores && l.scores.verified) || []) {
			if (v.pinned || v.prob === null || v.prob === undefined) continue;
			if (v.prob < min || v.prob >= max) continue;
			const other = normalizeImplicitSkuKey(v.fromSku === l.sku ? v.toSku : v.fromSku);
			if (other === me) continue;
			const key = me < other ? `${me}|${other}` : `${other}|${me}`;
			if (pairs.has(key)) continue;
			pairs.set(key, {
				a: me < other ? me : other,
				b: me < other ? other : me,
				rawLink: [v.fromSku, v.toSku],
				prob: +v.prob.toFixed(4),
				det: v.detScore === null || v.detScore === undefined ? null : +v.detScore.toFixed(2),
				src: v.source,
				hints: v.missHints && v.missHints.length ? v.missHints : undefined,
				canon: l.canonicalSku,
			});
		}
	}

	const groups = {};
	for (const p of pairs.values()) {
		if (groups[p.canon]) continue;
		const members = [...canonOf.entries()].filter(([, c]) => c === p.canon).map(([s]) => s);
		groups[p.canon] = members.map((s) => ({ sku: s, listings: listingsBySku.get(s) || [] }));
	}
	const rows = [...pairs.values()].sort((x, y) => (x.canon < y.canon ? -1 : x.canon > y.canon ? 1 : x.prob - y.prob));
	fs.writeFileSync(out, JSON.stringify({ _meta: { from, band: [min, max], pairs: rows.length, groups: Object.keys(groups).length, legend: "pairs[].a/b = normalized skus (bare id form); rawLink = the exact fromSku/toSku in data/sku_links.json — use THESE in unlink ops. groups[canon] = every member sku with its listings [store,name,price,removed,url]." }, pairs: rows, groups }) + "\n");
	console.log(`${rows.length} unique pairs in [${min}, ${max}) across ${Object.keys(groups).length} canonical groups → ${out} (${fs.statSync(out).size} B)`);
})();
