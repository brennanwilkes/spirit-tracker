#!/usr/bin/env node
// tools/audit_search_eval.mjs — Phase 0 blocker-recall harness over a gold set of
// known-positive link pairs. Baseline each blocking channel and the union. See
// docs/audit-search-and-scale-plan.md §6 (Phase 0).
//
// Channels:
//   current — the existing distinctive-token/SMWS blocking (distIndex + smwsBucket)
//   topTerm — loosened: each SKU indexed by its most-distinctive term
//   fuzzy   — letter-token trigram + bounded-Levenshtein variants
//   emb     — fine-tuned MiniLM cosine (ranks by cosine, not det)
//   union   — all channels; a pair's rank = best rank across channels (mirrors the
//             previous measurement in /tmp/opencode/search_recall.mjs)
//
// Rerun:
//   node tools/audit_search_eval.mjs                          (current-only, fast)
//   AUDIT_INCLUDE_DELISTED=1 node tools/audit_search_eval.mjs (first run walks the git
//                              history ~3 min cold into audit/.cache/; ~19 s warm)
//   ANCHOR_LIMIT=700 node tools/audit_search_eval.mjs         (bigger sample)
// Run from the repo root; the worktree defaults to .worktrees/data.

import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WT = process.env.DATA_WORKTREE || path.join(REPO_ROOT, ".worktrees", "data");

const { loadEnv, buildSurface, buildBlockIndex, buildEmbeddingIndex } = await import(
	path.join(REPO_ROOT, "tools", "audit_search_core.mjs")
);
const { normSearchText, tokenizeQuery } = await import(path.join(REPO_ROOT, "viz", "app", "sku.js"));
const { filterSimTokens, smwsKeyFromName } = await import(
	path.join(REPO_ROOT, "viz", "app", "linker_page", "similarity.js")
);
const { buildGroupsAndCanonicalMap, normalizeImplicitSkuKey } = await import(
	path.join(REPO_ROOT, "viz", "app", "sku_canonical.js")
);
const { prepScorePairCtx, scorePairWithVocab } = await import(
	path.join(REPO_ROOT, "viz", "app", "linker_page", "suggestions.js")
);

const ANCHOR_LIMIT = Number(process.env.ANCHOR_LIMIT || 250);
const INCLUDE_DELISTED = process.env.AUDIT_INCLUDE_DELISTED === "1";
const KS = [5, 10, 20, 50, 100];
const EMB_RANK_K = 3000;
const BIG = 1e9;
// PROD_CAPS=1 measures the configuration the generator actually ships (AUDIT_POOL_*)
// instead of an uncapped pool.
const PROD_CAPS = process.env.EVAL_PROD_CAPS === "1";
const POOL_LIMIT = PROD_CAPS ? Number(process.env.AUDIT_POOL_BUDGET || 700) : BIG;
const POOL_PER_KEY = PROD_CAPS ? Number(process.env.AUDIT_POOL_PER_CHANNEL || 150) : BIG;

const t0 = Date.now();
const env = await loadEnv(WT);
const surface = await buildSurface({ worktree: WT, env, includeDelisted: INCLUDE_DELISTED });
const block = buildBlockIndex(surface.items, { vocab: env.vocab, similarity: { smwsKeyFromName } });
const emb = buildEmbeddingIndex(WT, surface.items);

console.log(`## audit_search_eval  (ANCHOR_LIMIT=${ANCHOR_LIMIT} includeDelisted=${INCLUDE_DELISTED} worktree=${WT})`);
console.log(
	`env: ${env.allAgg.length} aggregates, ${env.allLinks.length} link edges (${Date.now() - t0}ms)`,
);
console.log(
	`surface: ${surface.items.length} items (current=${surface.stats.current}, delisted=${surface.stats.delisted}, fromCache=${surface.stats.fromCache})`,
);
console.log(`block: ${JSON.stringify(block.stats)}`);
console.log(`embeddings: ${emb ? `${emb.count} items with vectors` : "NOT LOADED"}`);

const byKey = surface.byKey;
const resolve = (s) => {
	if (!s) return null;
	const t = String(s).trim();
	return byKey.get(t) || byKey.get(normalizeImplicitSkuKey(t)) || null;
};

/* ---------- gold set: unique unordered resolved positive pairs ---------- */
const pairMap = new Map(); // pairKey -> {a,b,aItem,bItem}
const adj = new Map(); // sku -> Set<sku>
let resolvedEdges = 0;
for (const l of env.allLinks) {
	const f = l.fromSku || l.skuA;
	const t = l.toSku || l.skuB;
	const a = resolve(f);
	const b = resolve(t);
	if (!a || !b || a.sku === b.sku) continue;
	resolvedEdges++;
	const pk = a.sku < b.sku ? a.sku + "|" + b.sku : b.sku + "|" + a.sku;
	if (pairMap.has(pk)) continue;
	pairMap.set(pk, { a: a.sku, b: b.sku, aItem: a, bItem: b });
	if (!adj.has(a.sku)) adj.set(a.sku, new Set());
	if (!adj.has(b.sku)) adj.set(b.sku, new Set());
	adj.get(a.sku).add(b.sku);
	adj.get(b.sku).add(a.sku);
}
const pairs = [...pairMap.values()];
console.log(
	`gold set: ${pairs.length} unique positive pairs from ${resolvedEdges}/${env.allLinks.length} resolvable edges`,
);

/* ---------- canonical split (honesty: TEST+VAL = embedder never trained) ---------- */
const { canonBySku } = buildGroupsAndCanonicalMap(
	env.allLinks.map((l) => ({ fromSku: l.fromSku || l.skuA, toSku: l.toSku || l.skuB })),
);
function fnv1a32(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i) & 0xff;
		h = Math.imul(h, 0x01000193) & 0xffffffff;
	}
	return h >>> 0;
}
function splitBucket(sku) {
	const c = canonBySku.get(normalizeImplicitSkuKey(sku));
	return c ? (fnv1a32(String(c)) % 1000) / 1000 : 1; // unknown -> train (excluded from honest)
}
const isHonest = (sku) => splitBucket(sku) < 0.3;

/* ---------- token helpers ---------- */
const tokCache = new Map();
function toksForName(name) {
	let v = tokCache.get(name);
	if (!v) {
		v = filterSimTokens(tokenizeQuery(normSearchText(name)));
		tokCache.set(name, v);
	}
	return v;
}
function sharedTok(aName, bName) {
	const A = toksForName(aName);
	const B = toksForName(bName);
	let n = 0;
	for (const t of A) if (B.includes(t)) n++;
	return n;
}

/* ---------- full-set structural counts (no ranking, no emb beyond nearest) ---------- */
const CH_CUR = { dist: true, topTerm: false, smws: true, twin: false, fuzzy: false };
const CH_ALL = { dist: true, topTerm: true, smws: true, twin: true, fuzzy: true };
let currentMiss = 0;
let recoverToken = 0;
let recoverEmb = 0;
let unionStillAbsent = 0;
const currentMissExamples = [];
for (const p of pairs) {
	const inCurrent = block
		.poolFor(p.aItem, { channels: CH_CUR, maxPerKey: POOL_PER_KEY, limit: POOL_LIMIT })
		.some((it) => it.sku === p.b);
	if (inCurrent) continue;
	currentMiss++;
	const pairKey = p.a + "|" + p.b;
	const inToken = block
		.poolFor(p.aItem, { channels: CH_ALL, maxPerKey: POOL_PER_KEY, limit: POOL_LIMIT })
		.some((it) => it.sku === p.b);
	if (inToken) {
		recoverToken++;
	} else if (emb && emb.nearest(p.aItem, EMB_RANK_K).some((r) => r.item.sku === p.b)) {
		recoverEmb++;
	} else {
		unionStillAbsent++;
		if (currentMissExamples.length < 30) {
			currentMissExamples.push({ key: pairKey, a: p.aItem, b: p.bItem, recoveredBy: null });
		}
	}
}
console.log(`\n### structural pool-absence over the full gold set (n=${pairs.length})`);
console.log(
	`current channel misses: ${currentMiss} (${(100 * currentMiss / pairs.length).toFixed(1)}% of n=${pairs.length})`,
);
console.log(
	`  union token channels recover ${recoverToken} of them; embedding recovers ${recoverEmb} more; STILL ABSENT from every channel: ${unionStillAbsent}`,
);

/* ---------- sampled anchor measurement with ranking ---------- */
const anchors = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
const stride = Math.max(1, Math.floor(anchors.length / ANCHOR_LIMIT));
const sample = [];
for (let i = 0; i < anchors.length && sample.length < ANCHOR_LIMIT; i += stride) sample.push(anchors[i]);

const ms = { current: 0, topTerm: 0, fuzzy: 0, emb: 0, union: 0 };
const records = [];
let anchorCount = 0;

for (const aSku of sample) {
	const a = byKey.get(aSku) || byKey.get(normalizeImplicitSkuKey(aSku));
	if (!a) continue;
	const neighbors = adj.get(a.sku) || adj.get(aSku);
	if (!neighbors) continue;
	anchorCount++;
	const ctx = prepScorePairCtx(a, { vocab: env.vocab, sizePenaltyFn: env.sizeFn, pricePenaltyFn: env.priceFn });

	const tAnchor = Date.now();
	let t = Date.now();
	const currentPool = block.poolFor(a, { channels: CH_CUR, maxPerKey: POOL_PER_KEY, limit: POOL_LIMIT });
	ms.current += Date.now() - t;
	t = Date.now();
	const topTermPool = block.poolFor(a, { channels: { dist: false, topTerm: true, smws: false, twin: false, fuzzy: false }, maxPerKey: POOL_PER_KEY, limit: POOL_LIMIT });
	ms.topTerm += Date.now() - t;
	t = Date.now();
	const fuzzyPool = block.poolFor(a, { channels: { dist: false, topTerm: false, smws: false, twin: false, fuzzy: true }, maxPerKey: POOL_PER_KEY, limit: POOL_LIMIT });
	ms.fuzzy += Date.now() - t;
	t = Date.now();
	const embList = emb ? emb.nearest(a, EMB_RANK_K) : [];
	ms.emb += Date.now() - t;

	// score the token-pool union once, rank each channel by live det score
	const unionItems = new Map();
	for (const it of currentPool) unionItems.set(it.sku, it);
	for (const it of topTermPool) unionItems.set(it.sku, it);
	for (const it of fuzzyPool) unionItems.set(it.sku, it);
	const detScore = new Map();
	for (const it of unionItems.values()) detScore.set(it.sku, scorePairWithVocab(ctx, it));
	const rankByDet = (pool) => {
		const arr = pool.map((it) => it.sku);
		arr.sort((x, y) => (detScore.get(y) ?? 0) - (detScore.get(x) ?? 0));
		return arr;
	};
	// unionMerged is the only budget-comparable column: ONE pool, ranked once, cut at K —
	// the same contract as `current`. `unionAny` (best rank in any channel) is kept for
	// diagnosis but at K it spends up to 4*K candidate slots, so it is not comparable.
	const mergedRanked = rankByDet([...unionItems.values()]);
	const embRank = embList ? new Map(embList.map((r, i) => [r.item.sku, i])) : new Map();
	const ranks = {
		current: new Map(rankByDet(currentPool).map((s, i) => [s, i])),
		topTerm: new Map(rankByDet(topTermPool).map((s, i) => [s, i])),
		fuzzy: new Map(rankByDet(fuzzyPool).map((s, i) => [s, i])),
		emb: embRank,
		unionMerged: new Map(mergedRanked.map((s, i) => [s, i])),
	};
	ms.union += Date.now() - tAnchor;

	for (const bSku of neighbors) {
		const b = byKey.get(bSku) || byKey.get(normalizeImplicitSkuKey(bSku));
		if (!b || b.sku === a.sku) continue;
		const shared = sharedTok(a.name, b.name);
		const r = {
			current: ranks.current.get(b.sku) ?? -1,
			topTerm: ranks.topTerm.get(b.sku) ?? -1,
			fuzzy: ranks.fuzzy.get(b.sku) ?? -1,
			emb: ranks.emb.get(b.sku) ?? -1,
			unionMerged: ranks.unionMerged.get(b.sku) ?? -1,
		};
		const present = [r.current, r.topTerm, r.fuzzy, r.emb].filter((v) => v >= 0);
		r.unionAny = present.length ? Math.min(...present) : -1;
		records.push({
			a: a.sku,
			b: b.sku,
			aName: a.name,
			bName: b.name,
			shared,
			bucket: shared === 0 ? "0" : shared === 1 ? "1" : "2+",
			honest: isHonest(a.sku) && isHonest(b.sku),
			r,
		});
	}
}

function recall(rows, ch, k) {
	const hit = rows.filter((rec) => rec.r[ch] >= 0 && rec.r[ch] < k).length;
	return hit / (rows.length || 1);
}
function fmtPct(x) {
	return (x * 100).toFixed(1).padStart(5);
}
function table(title, rows) {
	const channels = ["current", "topTerm", "fuzzy", "emb", "unionMerged", "unionAny"];
	console.log(`\n### ${title}  (n=${rows.length} records, honest=${rows.filter((x) => x.honest).length})`);
	console.log("K           " + KS.map((k) => String(k).padStart(5)).join(" "));
	for (const ch of channels) {
		console.log(ch.padEnd(11) + " " + KS.map((k) => fmtPct(recall(rows, ch, k))).join(" "));
	}
}

const allRows = [...records].sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
table("ALL positives (sampled)", allRows);
table("shared-token = 0 (typo/abbrev/semantic)", allRows.filter((x) => x.bucket === "0"));
table("shared-token = 1", allRows.filter((x) => x.bucket === "1"));
table("shared-token >= 2", allRows.filter((x) => x.bucket === "2+"));
table("HONEST (TEST+VAL groups; embedder never trained)", allRows.filter((x) => x.honest));
table("HONEST & shared-token = 0", allRows.filter((x) => x.honest && x.bucket === "0"));

console.log("\n### ms/anchor by channel");
console.log(`scored ${anchorCount} anchors, ${records.length} ordered positive-pair records`);
for (const ch of ["current", "topTerm", "fuzzy", "emb", "union"]) {
	console.log(`${ch.padEnd(7)} ${(ms[ch] / anchorCount).toFixed(1)} ms`);
}

/* ---------- still-missed at K=100 ---------- */
const missed = new Map(); // unordered pair key -> record
for (const rec of records) {
	if (rec.r.unionMerged < 0 || rec.r.unionMerged >= 100) {
		const pk = rec.a < rec.b ? rec.a + "|" + rec.b : rec.b + "|" + rec.a;
		if (!missed.has(pk)) missed.set(pk, rec);
	}
}
const missedList = [...missed.values()].slice(0, 30);
console.log(`\n### pairs STILL missed by the merged union at K=100 (sampled): ${missed.size} unique (showing ${missedList.length})`);
for (const rec of missedList) {
	const r = rec.r;
	const parts = ["current", "topTerm", "fuzzy", "emb"].map((ch) => `${ch}=${r[ch] < 0 ? "-" : r[ch]}`);
	console.log(`  ${parts.join(" ")}  ${rec.aName}  <->  ${rec.bName}`);
}

if (currentMissExamples.length) {
	console.log(`\n### gold pairs STILL absent from every channel (n=${unionStillAbsent}):`);
	for (const ex of currentMissExamples) {
		console.log(`  ${ex.a.name}  <->  ${ex.b.name}`);
	}
}