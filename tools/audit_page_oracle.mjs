#!/usr/bin/env node
// Acceptance oracle: replays the retired #/link-rapid page (removed from main 2026-10-12, last at
// dc922d6b6d) over the current catalog and emits every pair it would have shown. Same shared modules,
// same glue: raw-sku aggregates from viz/app/catalog.js, worklist = unlinked aggregates with a cross-
// sku distinctive-token hit, card = recommendSimilar top 14 deduped by group, plus the worklist sort's
// own best pair (refinedScore, term index capped at 600). Modes: classical (toConfidence01 of the
// deterministic score), ai (GBT blend, what CI uses),
// linear (embeddings + linear blend weights, no GBT), prod (no-embedding linear blend, no GBT).
// "prod" is what the deployed AI toggle actually ran, reproduced to the displayed digit on 4 pairs
// (2026-10-14): gbt.js fetched viz/data/gbt_model.json, a 404 on the deployed site, and the embeddings
// fetch from the Release URL fails CORS (no Access-Control-Allow-Origin on the github.com 302), so
// buildBlend fell back to BLEND_WEIGHTS_NOEMBED. The models disagree sharply (Barbancourt 15 ↔ Appleton
// 15: prod 0.84, linear 0.29, GBT 0.02), so each is its own candidate generator.
//
//   DATA_WORKTREE=.worktrees/data node tools/audit_page_oracle.mjs --out audit/oracle.jsonl [--modes classical,ai,linear,prod] [--shard i/n] [--all-anchors]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { aggregateBySku } from "../viz/app/catalog.js";
import { buildVocab } from "../viz/app/linker_page/vocab.js";
import { buildSizePenaltyForPair } from "../viz/app/linker_page/size.js";
import { buildPricePenaltyForPair } from "../viz/app/linker_page/price.js";
import { buildCanonStoreCache, makeSameStoreCanonFn } from "../viz/app/linker_page/store_cache.js";
import {
	recommendSimilar,
	dedupeByGroupRep,
	prepScorePairCtx,
	scorePairWithVocab,
	scorePairBlended,
} from "../viz/app/linker_page/suggestions.js";
import { toConfidence01 } from "../viz/app/linker_page/blend.js";
import { makeEmbedCosFn } from "../viz/app/linker_page/embeddings.js";
import { buildGroupIndex } from "../viz/app/linker_page/group_features.js";
import { BLEND_WEIGHTS_EMBED, BLEND_WEIGHTS_NOEMBED } from "../viz/app/linker_page/blend_weights.js";
import { keySkuForRow } from "../viz/app/sku.js";
import { buildGroupsAndCanonicalMap, normalizeImplicitSkuKey } from "../viz/app/sku_canonical.js";

const require = createRequire(import.meta.url);
const { loadHiddenSet } = require("../src/utils/sku_hidden.js");

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const OUT = arg("--out");
const MODES = (arg("--modes") || "classical,ai,linear,prod").split(",");
const [SHARD, NSHARDS] = (arg("--shard") || "0/1").split("/").map(Number);
const ROOT = process.env.DATA_WORKTREE;
if (!OUT || !ROOT || MODES.some((m) => !["classical", "ai", "linear", "prod"].includes(m)) || !(SHARD >= 0 && SHARD < NSHARDS)) {
	console.error("usage: DATA_WORKTREE=<worktree> audit_page_oracle.mjs --out <file.jsonl> [--modes classical,ai,linear,prod] [--shard i/n] [--all-anchors]");
	process.exit(2);
}
const RECOMMEND_LIMIT = 14;
const REFINE_CAND_CAP = 600;
const PROXY_K = 6;

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const allRows = readJson("viz/data/index.json").items;
const hiddenSet = loadHiddenSet(path.join(ROOT, "data"));
const linksFile = readJson("data/sku_links.json");
const links = [...linksFile.links, ...readJson("data/sku_links_auto.json").links];

const { canonBySku } = buildGroupsAndCanonicalMap(links);
const canonicalSku = (sku) => {
	const s = normalizeImplicitSkuKey(sku);
	return s ? canonBySku.get(s) || s : s;
};
const canonicalPairKey = (a, b) => {
	const x = canonicalSku(a);
	const y = canonicalSku(b);
	if (!x || !y) return "";
	return x < y ? `${x}|${y}` : `${y}|${x}`;
};
const ignoreSet = new Set();
for (const x of linksFile.ignores) {
	const k = canonicalPairKey(String(x.skuA || "").trim(), String(x.skuB || "").trim());
	if (k) ignoreSet.add(k);
}
const isIgnoredPair = (a, b) => {
	const k = canonicalPairKey(a, b);
	return k ? ignoreSet.has(k) : false;
};
const rules = { canonicalSku, isIgnoredPair, canonicalPairKey, links };

const mappedSkus = new Set();
for (const x of links)
	for (const k of [x.fromSku, x.toSku]) {
		const s = String(k || "").trim();
		if (!s) continue;
		mappedSkus.add(s);
		const c = String(canonicalSku(s) || "").trim();
		if (c) mappedSkus.add(c);
	}
const baseCanon = (sku) => String(canonicalSku(String(sku || "")) || "");
const isLinked = (sku) => mappedSkus.has(String(sku || "")) || mappedSkus.has(baseCanon(sku));
const sameGroup = (a, b) => !!a && !!b && baseCanon(a) === baseCanon(b);

const allAgg = aggregateBySku(allRows, (x) => x, hiddenSet);
const simVocab = buildVocab(allAgg);
const sameStoreCanon = makeSameStoreCanonFn(rules, buildCanonStoreCache(allAgg, rules));
const sizePenaltyForPair = buildSizePenaltyForPair({ allRows, allAgg, rules });
const pricePenaltyForPair = buildPricePenaltyForPair({ allAgg, rules });
const scoreOpts = { vocab: simVocab, sizePenaltyFn: sizePenaltyForPair, pricePenaltyFn: pricePenaltyForPair };

function buildBlend(withGbt) {
	const groupIndex = buildGroupIndex(allAgg, (s) => String(canonicalSku(s) || s));
	if (MODE_PROD) return { weights: BLEND_WEIGHTS_NOEMBED, weightsNoEmbed: null, embedCosFn: null, embeddings: false, gbt: null, groupIndex };
	const raw = readJson("viz/data/sku_embeddings.json");
	const emb = Object.create(null);
	for (const k in raw) {
		emb[k] = raw[k];
		const nk = keySkuForRow({ sku: k });
		if (nk && nk !== k) emb[nk] = raw[k];
	}
	return {
		weights: BLEND_WEIGHTS_EMBED,
		weightsNoEmbed: BLEND_WEIGHTS_NOEMBED,
		embedCosFn: makeEmbedCosFn(emb),
		embeddings: true,
		gbt: withGbt ? readJson("viz/data/gbt_model.json") : null,
		groupIndex,
	};
}

const termIndexOf = (items) => {
	const idx = new Map();
	for (const it of items) {
		const terms = simVocab.distinctiveUnigramsForName(it.name || "");
		if (!terms || !terms.size) continue;
		for (const t of terms) {
			if (!idx.has(t)) idx.set(t, []);
			idx.get(t).push(it);
		}
	}
	return idx;
};

const items = allAgg.filter((it) => it && it.stores && !isLinked(it.sku));
const unlinkedIndex = termIndexOf(items);
const fullTermIndex = termIndexOf(allAgg.filter(Boolean));

function fastScore(it) {
	const terms = simVocab.distinctiveUnigramsForName(it.name || "");
	if (!terms || !terms.size) return 0;
	const itSku = String(it.sku || "");
	const seen = new Set();
	let best = 0;
	let visited = 0;
	outer: for (const t of terms) {
		for (const cand of unlinkedIndex.get(t) || []) {
			if (cand === it) continue;
			const csku = String(cand.sku || "");
			if (seen.has(csku)) continue;
			seen.add(csku);
			if (isIgnoredPair(itSku, csku) || sameGroup(itSku, csku)) continue;
			const s = simVocab.weightedOverlap(it.name || "", cand.name || "").score;
			if (s > best) best = s;
			if (++visited >= PROXY_K) break outer;
		}
	}
	return best;
}

function refinedBest(it, blend) {
	const terms = simVocab.distinctiveUnigramsForName(it.name || "");
	if (!terms || !terms.size) return null;
	const itSku = String(it.sku || "");
	const ctx = prepScorePairCtx(it, scoreOpts);
	const seen = new Set();
	let best = 0;
	let bestCand = null;
	let visited = 0;
	outer: for (const t of terms) {
		for (const cand of fullTermIndex.get(t) || []) {
			const csku = String(cand.sku || "");
			if (!csku || csku === itSku || seen.has(csku)) continue;
			seen.add(csku);
			if (isIgnoredPair(itSku, csku) || sameGroup(itSku, csku)) continue;
			let s = scorePairWithVocab(ctx, cand);
			if (blend) {
				const { score } = scorePairBlended(ctx, cand, s, blend, scoreOpts);
				if (score != null) s = score;
			}
			if (s > best) {
				best = s;
				bestCand = cand;
			}
			if (++visited >= REFINE_CAND_CAP) break outer;
		}
	}
	return bestCand ? { cand: bestCand, score: blend ? best : toConfidence01(best) } : null;
}

// --all-anchors: also anchor already-linked aggregates. The page never did (its worklist is unlinked items
// only), so a lookalike between two linked groups was invisible to every page model, including the linear
// blend that no other generator runs.
const ALL_ANCHORS = argv.includes("--all-anchors");
const worklist = ALL_ANCHORS
	? allAgg.filter((it) => it && it.stores && (simVocab.distinctiveUnigramsForName(it.name || "") || new Set()).size)
	: items.filter((it) => fastScore(it) > 0);
const live = worklist.filter((_, i) => i % NSHARDS === SHARD);
console.error(`${allAgg.length} aggregates · ${items.length} unlinked · ${worklist.length} on the worklist · shard ${SHARD}/${NSHARDS}: ${live.length}`);

let MODE_PROD = false;
const out = fs.openSync(OUT, "w");
let emitted = 0;
for (const mode of MODES) {
	MODE_PROD = mode === "prod";
	const blend = mode === "classical" ? null : buildBlend(mode === "ai");
	const t0 = Date.now();
	for (let i = 0; i < live.length; i++) {
		const anchor = live[i];
		const a = String(anchor.sku);
		const rows = [];
		const ref = refinedBest(anchor, blend);
		if (ref) rows.push({ src: "worklist", b: String(ref.cand.sku), bName: ref.cand.name, score: ref.score, rank: 0 });
		let scored = recommendSimilar(
			allAgg,
			anchor,
			RECOMMEND_LIMIT,
			"",
			mappedSkus,
			isIgnoredPair,
			sizePenaltyForPair,
			pricePenaltyForPair,
			sameStoreCanon,
			sameGroup,
			{ vocab: simVocab, allowSameStore: true, withScores: true, groupRepFn: baseCanon, blend },
		).map((x) => (x && x.it ? x : { it: x, score: 0 }));
		scored = dedupeByGroupRep(scored, (x) => x.it && x.it.sku, baseCanon);
		scored.forEach((x, j) => {
			if (!x || !x.it) return;
			rows.push({
				src: "card",
				b: String(x.it.sku),
				bName: x.it.name,
				score: blend ? x.score || 0 : toConfidence01(x.score || 0),
				rank: j + 1,
				...(x.fallback ? { fallback: true } : {}),
			});
		});
		for (const r of rows) {
			fs.writeSync(out, JSON.stringify({ mode, a, aName: anchor.name, ...r, score: +r.score.toFixed(4) }) + "\n");
			emitted++;
		}
		if ((i + 1) % 500 === 0) console.error(`  ${mode} ${i + 1}/${live.length} anchors (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
	}
}
fs.closeSync(out);
console.log(`${live.length} worklist anchors × modes ${MODES.join("+")} → ${emitted} page pairs → ${OUT}`);
