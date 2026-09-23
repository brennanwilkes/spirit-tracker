#!/usr/bin/env node
/**
 * tools/auto_link_classify.mjs — batch SKU auto-linker.
 *
 * Runs at the end of a scrape (run_daily.sh), AFTER the per-build embeddings are written and
 * BEFORE the email pack. For each recent anchor it asks the LIVE ranker (recommendSimilar with
 * the GBT blend) for cross-store matches and, for any candidate scoring at/above the monitored
 * 99%-precision operating point (autoLinkConfidenceBar), appends a link to data/sku_links.json:
 *
 *     { fromSku, toSku, status: "pending", confidence, source: "auto-classify", ts }
 *
 * Because every consumer (src/utils/sku_map.js, viz/app/mapping.js, build_email_event_pack.js)
 * reads only fromSku/toSku and ignores extra fields, a pending link is treated as a REAL link
 * everywhere immediately (catalog grouping, email alerts). The `status` field is purely the
 * marker the review surface (#/link-review) uses; a human Approves (drop status) or Rejects
 * (delete + ignore) it later. This converges: a pending link becomes a real canonical group on
 * the next run, so recommendSimilar's same-group filter never re-scores it.
 *
 * Reuses the live scorer end-to-end via tools/linker_ml/featurize.mjs::buildEnv — never forks
 * scoring — exactly like tools/linker_eval.mjs and the trainer.
 *
 * SPEED: a confident match shares a distinctive token (or SMWS cask code) with the anchor, so we
 * only score candidates from a distinctive-token/SMWS blocking index instead of the full ~12.6k
 * catalog. Precision-preserving (the full scorer still runs on every candidate scored) — it can
 * only drop a few zero-shared-token semantic matches, which retrieve-then-rerank already misses.
 *
 * Usage:
 *   node tools/auto_link_classify.mjs                 # full scan, write
 *   node tools/auto_link_classify.mjs --dry-run       # print what it WOULD add, no write
 *   node tools/auto_link_classify.mjs --top 10        # candidates kept per anchor (default 10)
 *   node tools/auto_link_classify.mjs --since 14      # only anchors first-seen in last 14 days
 *   node tools/auto_link_classify.mjs --max-anchors 2000   # hard cap (newest first); 0 = no cap
 *   DATA_WORKTREE=/path/to/.worktrees/data node tools/auto_link_classify.mjs
 */

import fs from "fs";
import path from "path";

import { buildEnv, WORKTREE, readJson } from "./linker_ml/featurize.mjs";
import { recommendSimilar } from "../viz/app/linker_page/suggestions.js";
import { buildGroupIndex } from "../viz/app/linker_page/group_features.js";
import { makeEmbedCosFn } from "../viz/app/linker_page/embeddings.js";
import { buildCanonStoreCache, makeSameStoreCanonFn } from "../viz/app/linker_page/store_cache.js";
import { autoLinkConfidenceBar } from "../viz/app/linker_page/strong_threshold.js";
import { BLEND_WEIGHTS_EMBED, BLEND_WEIGHTS_NOEMBED } from "../viz/app/linker_page/blend_weights.js";
import { smwsKeyFromName } from "../viz/app/linker_page/similarity.js";
import { buildGroupsAndCanonicalMap, normalizeImplicitSkuKey } from "../viz/app/sku_canonical.js";

/* ---------------- args ---------------- */

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
function argNum(flag, dflt) {
	const i = argv.indexOf(flag);
	if (i < 0) return dflt;
	const v = Number(argv[i + 1]);
	return Number.isFinite(v) ? v : dflt;
}
const TOP = argNum("--top", 10);
const SINCE_DAYS = argNum("--since", 0); // 0 = no recency filter (full scan)
const MAX_ANCHORS = argNum("--max-anchors", 0); // 0 = no cap

const LINKS_FILE = path.join(WORKTREE, "data/sku_links.json");
const EMB_PATH = path.join(WORKTREE, "viz/data/sku_embeddings.json");
const GBT_PATH = path.join(WORKTREE, "viz/data/gbt_model.json");

/* ---------------- env + canonical map ---------------- */

const env = buildEnv();
const { allAgg, vocab, sizeFn, priceFn, allLinks, ignoreEntries } = env;

const { canonBySku } = buildGroupsAndCanonicalMap(allLinks);
const canonicalSku = (s) => {
	const k = normalizeImplicitSkuKey(s);
	return canonBySku.get(k) || k;
};
function canonicalPairKey(a, b) {
	const x = canonicalSku(a);
	const y = canonicalSku(b);
	if (!x || !y) return "";
	return x < y ? `${x}|${y}` : `${y}|${x}`;
}
const ignoreSet = new Set();
for (const ig of ignoreEntries) {
	const k = canonicalPairKey(ig?.skuA || ig?.a, ig?.skuB || ig?.b);
	if (k) ignoreSet.add(k);
}
const isIgnoredPair = (a, b) => {
	const k = canonicalPairKey(a, b);
	return k ? ignoreSet.has(k) : false;
};
const sameGroup = (a, b) => canonicalSku(a) === canonicalSku(b);

// A verified cross-store collision sku carries two different products, so a link to it merges the
// OTHER product into a clean group (Roseisle 12 scores 0.98–0.998 against `id:1049495`, whose
// Sierra Springs listing is a Laphroaig). Never auto-link one. Missing file: warn, don't throw —
// this runs under `set +e` in run_daily.sh, same reasoning as build_dataset.mjs's loader.
const COLLISION_PATH = path.join(WORKTREE, "data/sku_collisions.json");
const collidedSkus = new Set();
if (fs.existsSync(COLLISION_PATH)) {
	for (const c of readJson(COLLISION_PATH).collisions || []) {
		if (c && c.sku) collidedSkus.add(normalizeImplicitSkuKey(c.sku));
	}
} else {
	console.warn(`WARN: ${COLLISION_PATH} not found — auto-linking without the collision guard.`);
}
const touchesCollision = (a, b) => collidedSkus.has(normalizeImplicitSkuKey(a)) || collidedSkus.has(normalizeImplicitSkuKey(b));
let collisionSkipped = 0;

const rules = { canonicalSku };
const sameStoreFn = makeSameStoreCanonFn(rules, buildCanonStoreCache(allAgg, rules));

const bySkuAgg = new Map();
for (const it of allAgg) bySkuAgg.set(String(it.sku), it);

/* ---------------- blend (GBT + embeddings + group features) ---------------- */

// Embeddings file is keyed by raw store SKU — the same key space buildEnv aggregates use (and
// the trainer's dump_features.mjs cos()), so makeEmbedCosFn over the raw file is correct. We do
// NOT re-key (that is the browser path in embeddings.js, which aggregates by keySkuForRow).
let embRaw = null;
try {
	embRaw = readJson(EMB_PATH);
} catch {
	/* no embeddings → GBT routes embedCos via its NaN branch; LR uses no-embed weights */
}
let gbt = null;
try {
	gbt = readJson(GBT_PATH);
} catch {
	/* no GBT model → fall back to the linear blend weights */
}
const blend = {
	weights: embRaw ? BLEND_WEIGHTS_EMBED : BLEND_WEIGHTS_NOEMBED,
	weightsNoEmbed: BLEND_WEIGHTS_NOEMBED,
	embedCosFn: embRaw ? makeEmbedCosFn(embRaw) : null,
	gbt,
	groupIndex: buildGroupIndex(allAgg, (s) => String(canonicalSku(s) || s)),
	embeddings: !!embRaw,
};

const BAR = autoLinkConfidenceBar(true); // blend active → PREC99_PROB (0.95)

console.log(
	`[auto-link] worktree=${WORKTREE}\n` +
		`[auto-link] ${allAgg.length} aggregates · gbt=${gbt ? "yes" : "no"} · embeddings=${
			embRaw ? Object.keys(embRaw).length + " vectors" : "no"
		} · bar=${BAR.toFixed(3)} · top=${TOP}${SINCE_DAYS ? ` · since=${SINCE_DAYS}d` : ""}`,
);

/* ---------------- anchor selection (recency-sorted; optional --since window) ---------------- */

// firstSeenAt recency per aggregate sku — drives BOTH the --since window and the processing order
// (newest first, so an interrupted/capped run does the freshest SKUs first).
const recency = new Map();
for (const r of env.rows) {
	const sku = String(r.sku || "");
	if (!sku) continue;
	const t = Date.parse(r?.firstSeenAt || r?.updatedAt || "") || 0;
	const cur = recency.get(sku);
	if (cur === undefined || t > cur) recency.set(sku, t);
}
const recencyOf = (it) => recency.get(String(it.sku)) || 0;

let anchors = allAgg;
if (SINCE_DAYS > 0) {
	const cutoff = Date.now() - SINCE_DAYS * 86400000;
	anchors = allAgg.filter((it) => recencyOf(it) >= cutoff);
}
anchors = anchors.slice().sort((a, b) => recencyOf(b) - recencyOf(a));
if (MAX_ANCHORS > 0 && anchors.length > MAX_ANCHORS) {
	console.log(`[auto-link] capping ${anchors.length} -> ${MAX_ANCHORS} newest anchors (rest picked up next run)`);
	anchors = anchors.slice(0, MAX_ANCHORS);
}
console.log(`[auto-link] ${anchors.length} anchors${SINCE_DAYS ? ` within ${SINCE_DAYS}d` : " (full)"}`);

/* ---------------- candidate blocking index ---------------- */

// A confident (>=0.95) match almost always shares a DISTINCTIVE token (e.g. "edradour", "1494") or
// an SMWS cask code with the anchor. Scoring only those candidates turns a per-anchor full-catalog
// scan (~12.6k) into a handful of comparisons. PRECISION-PRESERVING: the full live scorer still
// runs on every candidate it does score; blocking only drops zero-shared-token semantic matches,
// which recommendSimilar's retrieve-then-rerank already misses. vocab/blend.groupIndex/sameGroup
// stay full-catalog, so the score for any candidate we DO consider is identical to the live ranker.
const distIndex = new Map(); // distinctive token -> Set(sku)
const smwsBucket = new Map(); // SMWS cask key -> Set(sku)
for (const it of allAgg) {
	const sku = String(it.sku || "");
	if (!sku) continue;
	for (const tok of vocab.distinctiveUnigramsForName(it.name || "") || []) {
		let s = distIndex.get(tok);
		if (!s) distIndex.set(tok, (s = new Set()));
		s.add(sku);
	}
	const k = smwsKeyFromName(it.name || "");
	if (k) {
		let s = smwsBucket.get(k);
		if (!s) smwsBucket.set(k, (s = new Set()));
		s.add(sku);
	}
}
function candidatesForAnchor(anchor) {
	const aSku = String(anchor.sku || "");
	const set = new Set();
	for (const tok of vocab.distinctiveUnigramsForName(anchor.name || "") || []) {
		const s = distIndex.get(tok);
		if (s) for (const x of s) set.add(x);
	}
	const k = smwsKeyFromName(anchor.name || "");
	if (k) {
		const s = smwsBucket.get(k);
		if (s) for (const x of s) set.add(x);
	}
	set.delete(aSku);
	const out = [anchor];
	for (const x of set) {
		const it = bySkuAgg.get(x);
		if (it) out.push(it);
	}
	return out;
}

/* ---------------- scan ---------------- */

const pairKey = (a, b) => {
	const x = normalizeImplicitSkuKey(a);
	const y = normalizeImplicitSkuKey(b);
	return x < y ? `${x} ${y}` : `${y} ${x}`;
};

// Dedupe against links already on disk (any status) and against pairs emitted this run.
const existingPairs = new Set();
for (const l of allLinks) {
	if (l?.fromSku && l?.toSku) existingPairs.add(pairKey(l.fromSku, l.toSku));
}

// Read the current file once; flush() rewrites baseline + all pending found so far. Flushing every
// FLUSH_EVERY anchors makes a long run (a big new-store batch) RESUMABLE: a cancel/timeout keeps the
// links found so far on disk, and a re-run skips them via existingPairs (fast no-op).
const baseline = readJson(LINKS_FILE);
const baseLinks = Array.isArray(baseline.links) ? baseline.links : [];
const baseIgnores = Array.isArray(baseline.ignores) ? baseline.ignores : [];
const FLUSH_EVERY = 400;
let lastFlushCount = 0;
function flush() {
	if (DRY_RUN || newLinks.length === lastFlushCount) return;
	fs.writeFileSync(
		LINKS_FILE,
		JSON.stringify({ links: [...baseLinks, ...newLinks], ignores: baseIgnores }) + "\n",
		"utf8",
	);
	lastFlushCount = newLinks.length;
}

const ts = new Date().toISOString();
const emitted = new Set();
const newLinks = [];

let processed = 0;
let scoredCandidates = 0;
for (const anchor of anchors) {
	const candAgg = candidatesForAnchor(anchor);
	scoredCandidates += candAgg.length - 1;
	if (candAgg.length > 1) {
		const recs = recommendSimilar(
			candAgg,
			anchor,
			TOP,
			"",
			null,
			isIgnoredPair,
			sizeFn,
			priceFn,
			sameStoreFn,
			sameGroup,
			{ vocab, allowSameStore: true, withScores: true, blend },
		);
		for (const r of recs) {
			if (!r || !r.it || r.fallback || typeof r.score !== "number") continue;
			if (r.score < BAR) continue;
			const f = String(anchor.sku);
			const t = String(r.it.sku);
			if (!f || !t || f === t) continue;
			if (sameGroup(f, t) || isIgnoredPair(f, t)) continue;
			if (touchesCollision(f, t)) {
				collisionSkipped++;
				continue;
			}
			const pk = pairKey(f, t);
			if (existingPairs.has(pk) || emitted.has(pk)) continue;
			emitted.add(pk);
			newLinks.push({
				fromSku: f,
				toSku: t,
				status: "pending",
				confidence: Number(r.score.toFixed(4)),
				source: "auto-classify",
				ts,
			});
		}
	}
	if (++processed % 200 === 0) {
		console.log(
			`[auto-link] ${processed}/${anchors.length} (${((100 * processed) / anchors.length).toFixed(0)}%) · ${newLinks.length} pending`,
		);
	}
	if (processed % FLUSH_EVERY === 0) flush();
}

console.log(
	`[auto-link] scanned ${anchors.length} anchors (${scoredCandidates} candidate comparisons) · found ${newLinks.length} new pending links (>= ${BAR.toFixed(3)}) · ${collisionSkipped} above-bar skipped touching ${collidedSkus.size} collided skus`,
);

/* ---------------- output ---------------- */

if (!newLinks.length) {
	console.log("[auto-link] nothing to add — no inserts, no rewrite.");
	process.exit(0);
}

console.log("[auto-link] sample:");
for (const l of newLinks.slice(0, 20)) {
	const an = bySkuAgg.get(l.fromSku)?.name || l.fromSku;
	const bn = bySkuAgg.get(l.toSku)?.name || l.toSku;
	console.log(`  ${l.confidence.toFixed(4)}  ${l.fromSku} "${an}"  <->  ${l.toSku} "${bn}"`);
}

if (DRY_RUN) {
	console.log("[auto-link] --dry-run: not writing.");
	process.exit(0);
}

flush(); // final write — minified single-line + trailing newline (matches viz/serve.js's writeMeta)
console.log(`[auto-link] wrote ${newLinks.length} pending links -> ${LINKS_FILE}`);
