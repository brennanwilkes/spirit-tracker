#!/usr/bin/env node
// tools/audit_search.mjs — Phase 1 search-primitive CLI (typo-robust SKU candidate search).
//
// Given a SKU or a free-text query, return a ranked, tight candidate list with evidence
// (det = live scorePairWithVocab; cos = embedding cosine; prob = live GBT/blend probability;
// channels = which blocking channels surfaced each candidate). Same surface + blocking as
// tools/audit_search_core.mjs (current + delisted history); scoring mirrors
// scripts/audit_new_listings.js::buildScorer EXACTLY (never forks).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	loadEnv,
	buildSurface,
	buildBlockIndex,
	buildEmbeddingIndex,
	normNameForTwin,
} from "./audit_search_core.mjs";
import { smwsKeyFromName, similarityScore } from "../viz/app/linker_page/similarity.js";
import {
	normalizeImplicitSkuKey,
	buildGroupsAndCanonicalMap,
} from "../viz/app/sku_canonical.js";
import {
	prepScorePairCtx,
	scorePairWithVocab,
	scorePairBlended,
} from "../viz/app/linker_page/suggestions.js";
import * as weightsMod from "../viz/app/linker_page/blend_weights.js";
import * as groupF from "../viz/app/linker_page/group_features.js";
import { makeEmbedCosFn } from "../viz/app/linker_page/embeddings.js";

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOL_DIR, "..");
const DEFAULT_WORKTREE = path.join(REPO_ROOT, ".worktrees", "data");

const CHANNEL_NAMES = ["dist", "topTerm", "smws", "twin", "fuzzy", "emb"];

// ---------------------------------------------------------------------------
// arg parsing (hardened: unknown flag is a hard error — mirrors audit_new_listings.js)
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["--sku", "--query", "--top", "--worktree", "--category", "--store", "--grep"]);
const BOOLEAN_FLAGS = new Set(["--json", "--no-delisted", "--help", "-h"]);

const USAGE = `audit_search — typo-robust SKU search primitive (Phase 1)

  node tools/audit_search.mjs --sku <rawOrNormalizedSku> [options]
  node tools/audit_search.mjs --query "<free text>"        [options]
  node tools/audit_search.mjs --grep "<regex>"             [options]

  exactly one of --sku / --query / --grep is required.

  --grep is the EXHAUSTIVE, unranked name search: every listing whose name matches the
  (case-insensitive) regex, with its url. Use it whenever you need "show me all the X in
  the catalog" — ranked search cannot answer that, and a hand-rolled grep over data/db
  silently misses listings.

Options:
  --top <K>            show K results (default 25)
  --worktree <path>    data worktree (default .worktrees/data)
  --category <text>    soft annotation — recorded in meta, sets NO filter
  --store <text>       soft annotation — recorded in meta, sets NO filter
  --no-delisted        exclude delisted-history items (they are included by default)
  --grep <regex>       exhaustive unranked name match; ignores --top
  --json               machine-readable rows: [ {_meta}, {rank,...}, ... ]
  --help, -h           this help (exit 0)

Scores:
  det   deterministic scorePairWithVocab (live ranker) — ranking driver
  cos   3-decimal embedding cosine, "-" when either side has no vector
  prob  calibrated GBT probability (linear blend fallback), "-" when unavailable
  channels  blocking channels that surfaced the candidate: dist | topTerm | smws | twin |
            fuzzy | emb (union of the audit_search_core index + embedding top-200 in sku mode)`;

function printUsageAndExit(code) {
	(code === 0 ? console.log : console.error)(USAGE);
	process.exit(code);
}

function parseArgs(argv) {
	const args = new Map();
	const flags = new Set();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") printUsageAndExit(0);
		if (BOOLEAN_FLAGS.has(a)) {
			flags.add(a);
			continue;
		}
		if (VALUE_FLAGS.has(a)) {
			if (i + 1 >= argv.length) {
				console.error(`audit_search: ${a} expects a value`);
				process.exit(2);
			}
			args.set(a, argv[++i]);
			continue;
		}
		console.error(`audit_search: unknown argument "${a}" (use --help for usage)`);
		process.exit(2);
	}
	return { args, flags };
}

function parseTop(s) {
	const v = Number(s);
	if (!Number.isInteger(v) || v < 1) {
		console.error(`audit_search: --top expects a positive integer, got "${s}"`);
		process.exit(2);
	}
	return v;
}

// ---------------------------------------------------------------------------
// scoring-blend wiring (mirror scripts/audit_new_listings.js::buildScorer EXACTLY)
// ---------------------------------------------------------------------------

function buildBlend(worktree, env, canonicalSku) {
	let embRaw = null;
	try {
		embRaw = JSON.parse(fs.readFileSync(path.join(worktree, "viz", "data", "sku_embeddings.json"), "utf8"));
	} catch {
		/* no embeddings → GBT routes embedCos via its 0/NaN branch */
	}
	let gbt = null;
	try {
		gbt = JSON.parse(fs.readFileSync(path.join(worktree, "viz", "data", "gbt_model.json"), "utf8"));
	} catch {
		/* no GBT → linear blend fallback */
	}
	return {
		weights: embRaw ? weightsMod.BLEND_WEIGHTS_EMBED : weightsMod.BLEND_WEIGHTS_NOEMBED,
		weightsNoEmbed: weightsMod.BLEND_WEIGHTS_NOEMBED,
		embedCosFn: embRaw ? makeEmbedCosFn(embRaw) : null,
		gbt,
		groupIndex: groupF.buildGroupIndex(env.allAgg, (s) => String(canonicalSku(s) || s)),
		embeddings: !!embRaw,
	};
}

// ---------------------------------------------------------------------------
// channel annotation (per-candidate membership tests mirroring the block-index channels)
// ---------------------------------------------------------------------------

function tokenizeLetterTokens(name) {
	return String(name || "")
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, " ")
		.split(/\s+/)
		.filter((t) => /^[a-z]{3,}$/.test(t));
}

function levBounded(a, b, maxLev) {
	if (Math.abs(a.length - b.length) > maxLev) return maxLev + 1;
	if (a === b) return 0;
	const n = a.length;
	const m = b.length;
	let prev = new Array(m + 1);
	let cur = new Array(m + 1);
	for (let j = 0; j <= m; j++) prev[j] = j;
	for (let i = 1; i <= n; i++) {
		cur[0] = i;
		let rowMin = cur[0];
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= m; j++) {
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
			if (cur[j] < rowMin) rowMin = cur[j];
		}
		if (rowMin > maxLev) return maxLev + 1;
		[prev, cur] = [cur, prev];
	}
	return prev[m];
}

function sharesTrigram(x, y) {
	if (x.length < 3 || y.length < 3) return false;
	const set = new Set();
	for (let i = 0; i + 3 <= x.length; i++) set.add(x.slice(i, i + 3));
	for (let i = 0; i + 3 <= y.length; i++) if (set.has(y.slice(i, i + 3))) return true;
	return false;
}

// Whether candidate token c is a fuzzy variant of anchor token t — same rule as the core's
// fuzzyVariants (shared trigram required, then bounded edit distance).
function fuzzyVariantOf(c, t) {
	if (c === t) return false;
	const lenDiff = Math.abs(c.length - t.length);
	if (lenDiff <= 1 && levBounded(t, c, 1) <= 1) return true;
	if (t.length >= 6 && lenDiff <= 2 && levBounded(t, c, 2) <= 2 && sharesTrigram(t, c)) return true;
	return false;
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function storeList(it) {
	const arr = [...(it.stores || [])].map((s) => String(s)).sort();
	if (arr.length > 3) return `${arr.slice(0, 3).join(",")}+${arr.length - 3}`;
	return arr.join(",");
}

function fmtPrice(n) {
	return n == null || !Number.isFinite(n) ? "-" : `$${n.toFixed(2)}`;
}

function fmt3(n) {
	return n == null || !Number.isFinite(n) ? "-" : n.toFixed(3);
}

function microName(name, width) {
	name = String(name || "");
	return name.length > width ? name.slice(0, width - 1) + "…" : name;
}

function pad(s, width, dir) {
	s = String(s);
	return dir === "right" ? s.padStart(width) : s.padEnd(width);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const { args, flags } = parseArgs(process.argv.slice(2));
const top = parseTop(args.get("--top") || "25");
const worktree = args.get("--worktree") || DEFAULT_WORKTREE;
const sku = args.get("--sku");
const query = args.get("--query");
const isQuery = query != null;
const storeFilter = args.get("--store");
const categoryFilter = args.get("--category");

const grepArg = args.get("--grep");
const modeCount = [sku, query, grepArg].filter((x) => x != null).length;
if (modeCount > 1) {
	console.error("audit_search: give exactly one of --sku / --query / --grep (use --help for usage)");
	process.exit(2);
}
if (modeCount === 0) {
	console.error("audit_search: exactly one of --sku / --query / --grep is required (use --help for usage)");
	process.exit(2);
}
if (grepArg != null && !String(grepArg).trim()) {
	console.error("audit_search: --grep cannot be empty");
	process.exit(2);
}
if (!grepArg && isQuery && !String(query).trim()) {
	console.error("audit_search: --query cannot be empty");
	process.exit(2);
}
if (!grepArg && !isQuery && !String(sku).trim()) {
	console.error("audit_search: --sku cannot be empty");
	process.exit(2);
}

const includeDelisted = !flags.has("--no-delisted") && process.env.AUDIT_INCLUDE_DELISTED !== "0";

const t0 = Date.now();
const env = await loadEnv(worktree);
const surface = await buildSurface({ worktree, env, includeDelisted });
// --grep short-circuits before any scoring: it is a catalog census, not a ranking.
if (grepArg) {
	const rowsBySku = new Map();
	for (const r of env.rows || []) {
		const k = String(r.sku || "");
		if (!rowsBySku.has(k)) rowsBySku.set(k, []);
		rowsBySku.get(k).push(r);
	}
	let re;
	try {
		re = new RegExp(grepArg, "i");
	} catch (e) {
		console.error(`audit_search: --grep is not a valid regex: ${e.message}`);
		process.exit(2);
	}
	const hits = [];
	for (const it of surface.items) {
		if (!re.test(String(it.name || ""))) continue;
		// urlsByStore is empty on the aggregates, so resolve urls from the raw index rows.
		// The slug routinely encodes the GTIN/EAN and the bottle size, which is sometimes the
		// only thing that separates two identically-titled listings at one store.
		const urls = (rowsBySku.get(String(it.sku || "")) || []).map((r) => [r.storeLabel || r.store, r.url]).filter(([, u]) => u);
		hits.push({
			sku: String(it.sku || ""),
			name: String(it.name || ""),
			stores: [...(it.stores || [])].map(String).sort(),
			price: it.cheapestPriceNum == null ? null : it.cheapestPriceNum,
			delisted: !!it.delisted,
			urls: urls.map(([store, url]) => ({ store, url })),
		});
	}
	hits.sort((a, b) => a.sku.localeCompare(b.sku));
	if (flags.has("--json")) {
		process.stdout.write(JSON.stringify([{ _meta: { mode: "grep", pattern: grepArg, matches: hits.length, surface: surface.stats } }, ...hits], null, 2) + "\n");
	} else {
		for (const h of hits) {
			console.log(`${h.sku}\t${h.delisted ? "DELISTED" : "live"}\t${h.price == null ? "-" : "$" + h.price}\t${h.stores.join(",")}\t${h.name}`);
			for (const u of h.urls) console.log(`\t  ${u.store}: ${u.url}`);
		}
		console.error(`audit_search --grep ${JSON.stringify(grepArg)}: ${hits.length} listing(s) over ${surface.stats.current} current + ${surface.stats.delisted} delisted`);
	}
	process.exit(hits.length ? 0 : 1);
}

const block = buildBlockIndex(surface.items, { vocab: env.vocab, similarity: { smwsKeyFromName } });
const emb = buildEmbeddingIndex(worktree, surface.items);

let anchor;
if (!isQuery) {
	anchor = surface.byKey.get(sku) || surface.byKey.get(normalizeImplicitSkuKey(sku));
	if (!anchor) {
		console.error(`not found: ${sku}`);
		process.exit(1);
	}
} else {
	anchor = {
		sku: "__query__",
		normKey: "__query__",
		name: String(query).trim(),
		stores: new Set(),
		cheapestPriceNum: null,
		category: "",
		delisted: false,
	};
}

// --- candidate pool: block channels always; + embedding top-200 in sku mode ---
const MAX_PER_CHANNEL = 1500;
const POOL_LIMIT = 3000;
const EMB_UNION_K = 200;

const poolItems = block.poolFor(anchor, {
	channels: { dist: true, topTerm: true, smws: true, twin: true, fuzzy: true },
	maxPerChannel: MAX_PER_CHANNEL,
	limit: POOL_LIMIT,
});
const poolBySku = new Map();
const embForce = new Set();
for (const it of poolItems) poolBySku.set(String(it.sku || it.normKey || ""), it);
if (emb && !isQuery) {
	for (const r of emb.nearest(anchor, EMB_UNION_K)) {
		if (!r || !r.item) continue;
		const k = String(r.item.sku || r.item.normKey || "");
		if (!poolBySku.has(k)) {
			poolBySku.set(k, r.item);
			embForce.add(k);
		}
	}
}

// --store / --category are SOFT ANNOTATIONS: echoed in meta/footer, never filter.

// --- canonical map + blend (mirror buildScorer) ---
const { canonBySku } = buildGroupsAndCanonicalMap(env.allLinks);
const canonicalSku = (s) => {
	const k = normalizeImplicitSkuKey(s);
	return canonBySku.get(k) || k;
};
const blend = buildBlend(worktree, env, canonicalSku);

// --- score ---
const ctx = prepScorePairCtx(anchor, {
	vocab: env.vocab,
	sizePenaltyFn: env.sizeFn,
	pricePenaltyFn: env.priceFn,
});
const aSku = String(ctx.sku || "");
const anchorName = anchor.name || "";
const anchorDist = env.vocab.distinctiveUnigramsForName(anchorName);
const anchorTopTerm = env.vocab.topTerm(anchorName);
const anchorSmws = smwsKeyFromName(anchorName);
const anchorTwin = normNameForTwin(anchorName);
const anchorLetterTokens = tokenizeLetterTokens(anchorName);

function channelsFor(it) {
	const out = [];
	const candName = String(it.name || "");
	const candTerms = env.vocab.termsForName(candName);
	if (anchorDist.size) for (const t of anchorDist) if (candTerms.has(t)) { out.push("dist"); break; }
	if (anchorTopTerm && anchorTopTerm.term && candTerms.has(anchorTopTerm.term)) out.push("topTerm");
	if (anchorSmws && smwsKeyFromName(candName) === anchorSmws) out.push("smws");
	if (anchorTwin && normNameForTwin(candName) === anchorTwin) out.push("twin");
	let fuzzy = false;
	const candLt = tokenizeLetterTokens(candName);
	for (const t of anchorLetterTokens) {
		let exact = false;
		for (const c of candLt) {
			if (c === t) { exact = true; break; }
			if (fuzzyVariantOf(c, t)) { fuzzy = true; break; }
		}
		if (exact) { fuzzy = true; break; }
	}
	if (fuzzy) out.push("fuzzy");
	return out;
}

const scored = [];
for (const it of poolBySku.values()) {
	const det = scorePairWithVocab(ctx, it);
	let cos = null;
	if (blend.embedCosFn) {
		cos = blend.embedCosFn(aSku, String(it.sku || ""));
		if (cos != null && !Number.isFinite(cos)) cos = null;
	}
	let prob = null;
	if (blend.gbt || blend.weights) {
		const res = scorePairBlended(ctx, it, det, blend, {
			vocab: env.vocab,
			sizePenaltyFn: env.sizeFn,
			pricePenaltyFn: env.priceFn,
		});
		if (res && typeof res.score === "number" && Number.isFinite(res.score)) prob = res.score;
	}
	const channels = channelsFor(it);
	const k = String(it.sku || it.normKey || "");
	if (embForce.has(k) && !channels.includes("emb")) channels.push("emb");
	scored.push({
		it,
		det,
		cos,
		prob,
		channels,
		querySim: isQuery ? similarityScore(anchorName, it.name || "") : null,
	});
}

// Rank: live deterministic score first (spec); then (query mode only) the live legacy
// similarityScore — the edit-distance tiebreak a misspelled query needs, since det is
// exact-token and collapses a typo to BASE_FLOOR; then prob, then cos, then sku.
scored.sort((a, b) => {
	if (b.det !== a.det) return b.det - a.det;
	const qa = a.querySim == null ? -Infinity : a.querySim;
	const qb = b.querySim == null ? -Infinity : b.querySim;
	if (qb !== qa) return qb - qa;
	const pb = b.prob == null ? -Infinity : b.prob;
	const pa = a.prob == null ? -Infinity : a.prob;
	if (pb !== pa) return pb - pa;
	const cba = b.cos == null ? -Infinity : b.cos;
	const caa = a.cos == null ? -Infinity : a.cos;
	if (cba !== caa) return cba - caa;
	return String(a.it.sku || "").localeCompare(String(b.it.sku || ""));
});
const rows = scored.slice(0, top);

const observedChannels = [...new Set(scored.flatMap((r) => r.channels))].sort();

const meta = {
	_command: `node tools/audit_search.mjs ${process.argv.slice(2).map((a) => / /.test(a) ? JSON.stringify(a) : a).join(" ")}`,
	mode: isQuery ? "query" : "sku",
	anchor: { sku: anchor.sku, name: anchorName, delisted: !!anchor.delisted },
	top,
	worktree,
	includeDelisted,
	annotations: {
		store: storeFilter || null,
		category: categoryFilter || null,
	},
	surface: {
		current: surface.stats.current,
		delisted: surface.stats.delisted,
		fromCache: surface.stats.fromCache,
	},
	pool: scored.length,
	embeddings: emb ? emb.count : 0,
	engine: blend.gbt ? "gbt" : blend.weights ? "blend-linear" : null,
	channels: observedChannels,
	channelLegend: {
		dist: "candidate shares a distinctive anchor unigram",
		topTerm: "candidate carries the anchor's most-distinctive unigram",
		smws: "same SMWS cask key",
		twin: "same size-stripped title",
		fuzzy: "token edit-distance/trigram variant or exact token",
		emb: "surfaced by embedding cosine top-200 (sku mode only)",
	},
	ms: Date.now() - t0,
};

if (flags.has("--json")) {
	const out = [{ _meta: meta }];
	rows.forEach((r, i) => {
		out.push({
			rank: i + 1,
			sku: String(r.it.sku || ""),
			name: String(r.it.name || ""),
			stores: [...(r.it.stores || [])].map((s) => String(s)).sort(),
			price: r.it.cheapestPriceNum == null ? null : r.it.cheapestPriceNum,
			delisted: !!r.it.delisted,
			det: r.det,
			cos: r.cos,
			prob: r.prob,
			channels: r.channels,
		});
	});
	process.stdout.write(JSON.stringify(out, null, 2) + "\n");
	process.exit(0);
}

// aligned table
const maxW = 44;
const tRows = rows.map((r, i) => ({
	rank: String(i + 1),
	sku: String(r.it.sku || ""),
	name: microName(r.it.name || "", maxW),
	stores: storeList(r.it),
	price: fmtPrice(r.it.cheapestPriceNum),
	delisted: r.it.delisted ? "yes" : "no",
	det: r.det.toFixed(2),
	cos: fmt3(r.cos),
	prob: fmt3(r.prob),
	channels: r.channels.join(","),
}));
const w = {};
const COLNAMES = ["#", "sku", "name", "store(s)", "price", "delisted", "det", "cos", "prob", "channels"];
for (const c of COLNAMES) w[c] = c.length;
for (const r of tRows)
	for (const c of COLNAMES) w[c] = Math.min(Math.max(w[c], String(r[c]).length), c === "name" ? maxW : 200);

console.log(COLNAMES.map((c) => pad(c, w[c], c === "#" || c === "det" || c === "cos" || c === "prob" ? "right" : "left")).join("  ").trimEnd());
for (const r of tRows) {
	console.log(
		[pad(r.rank, w["#"], "right"), pad(r.sku, w["sku"], "right"), pad(r.name, w["name"], "left"),
			pad(r.stores, w["store(s)"], "left"), pad(r.price, w["price"], "left"), pad(r.delisted, w["delisted"], "left"),
			pad(r.det, w["det"], "right"), pad(r.cos, w["cos"], "right"), pad(r.prob, w["prob"], "right"),
			pad(r.channels, w["channels"], "left"),
		].join("  ").trimEnd(),
	);
}
console.error(`audit_search: ${meta.mode} "${anchorName}" — pool ${meta.pool}, top ${meta.top}, ${meta.embeddings} embedded, surface current=${meta.surface.current} delisted=${meta.surface.delisted}${meta.surface.fromCache ? " (cached)" : ""}, engine ${meta.engine}, ${meta.ms}ms`);
if (meta.annotations.store || meta.annotations.category) {
	const bits = [];
	if (meta.annotations.category) bits.push(`category="${meta.annotations.category}"`);
	if (meta.annotations.store) bits.push(`store="${meta.annotations.store}"`);
	console.error(`audit_search: soft annotation: ${bits.join(" ")} (recorded only — results are NOT filtered)`);
}