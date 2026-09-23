#!/usr/bin/env node
"use strict";

// ============================================================================
// audit_new_listings.js — NEW-LISTINGS AUDIT (auto-link coverage + sameness scores)
// ============================================================================
//
// Re-runnable audit generator. Walks the `data`-branch worktree and emits a file
// listing every *listing* first seen inside a given date range, decorated with
// auto-link + link-group metadata AND, per listing, the auto-link ranker's own
// top candidate pairs with their decomposed "sameness" feature inputs — so an
// auditor agent can go listing by listing and judge whether its link / no-link
// status should change.
//
// What a "listing" is (this audit's unit): one product row at one store+category,
// identified by (dbFile, normalized SKU). Matches the per-SKU cache granularity
// and the auto-link classifier's working unit. Two size variants sharing one SKU
// collapse into a single listing.
//
// Usage:
//   node scripts/audit_new_listings.js [options]
//
// Date range:
//   --since   First-seen lower bound. Default 2026-06-12T18:47:49Z — the
//             data-branch commit (23799a0b2d) that shipped the first
//             `source:"auto-classify"` links. A bare date = start of that UTC day.
//   --until   First-seen upper bound (exclusive). Default = now. A bare date =
//             start of the FOLLOWING UTC day.
//
// Sources / shape:
//   --root    The data worktree to read from. Default $REPO_ROOT/.worktrees/data.
//   --out     Output file. Default audit/new_listings_<since>_<until>.<ext>.
//
// Output:
//   --format  json | jsonl (default json). jsonl = one `_meta` line (everything
//             except listings, INCLUDING clusters) then one listing per line —
//             ideal for an agent paging with --offset/--limit.
//   --offset  Skip the first N listings of the filtered/sorted set (default 0).
//   --limit   Keep at most N listings (default = all).
//             offset/limit apply AFTER --only, on firstSeen-ascending order.
//   --only    all | orphans | auto-linked | has-links | no-auto-link
//             | want-links | need-unlinks | near-misses
//             (default all). Summary + clusters are computed on the filtered set, so pages
//             stay consistent.
//             - Structural modes (orphans/auto-linked/has-links/no-auto-link) filter
//               BEFORE scoring (fast; scores cover only the windowed page).
//             - Score-driven modes REQUIRE scoring, so they score the whole universe, then
//               keep only the flagged rows. Summary then reports the full funnel counts.
//               want-links  = never auto-linked yet a live candidate prob >= bar today
//                             ("link the missed ones").
//               need-unlinks = auto-classify pair(s) whose live re-scored prob fell below
//                             bar and are NOT deterministic floor-pins ("unlink the bad
//                             ones"). Pins (storedConfidence >= 1e8, e.g. shared SMWS cask
//                             code) are deliberate and excluded.
//               near-misses = THE audit surface: pairs the linker scores BELOW bar yet
//                             that share real overlap evidence — an agent's eye instantly
//                             sees "same product". Crushed true matches (a single hard-rule
//                             veto, a missing embedding, a blocking-index miss). Every
//                             candidate/verified/twin carries `suspicious` + `missHints`;
//                             identical-title pairs that never reached the candidate pool
//                             are scored as `twins[]`. Rows sort by strongest miss first.
//
// Sameness scores (the auto-link ranker's inputs):
//   Scores are computed with the LIVE ranker end-to-end (tools/linker_ml/
//   featurize.mjs::buildEnv + recommendSimilar + GBT blend) — never forked —
//   exactly like tools/auto_link_classify.mjs, so every number below equals what
//   production auto-linking used/would use for that pair.
//   --with-scores  (default) compute top candidates + decomposed features.
//   --no-scores    skip scoring (fast path; no samples/det/features in output).
//   --top N        candidates kept per listing (default 5).
//
// Sources read (all under --root):
//   viz/data/skus/{sku}.json     per-SKU change-point history — first event of a
//                                (dbFile, sku) pair IS its first-seen timestamp
//   data/db/*.json               current record metadata (name/url/price/removed)
//   data/sku_links.json          curated links + ignores (source:"auto-classify"
//                                entries are the classifier's output)
//   data/sku_links_auto.json     merge.js pickBetterSku auto-generated links
//   data/sku_hidden.json         hidden listings (presentation exclusions)
//   viz/data/rarity.json         rarity scores, keyed by canonical SKU
//   viz/data/index.json          (scoring only) the live catalog + vocab +
//                                size/price penalty closures the ranker scores on
//   viz/data/gbt_model.json      (scoring only) the shipping GBT classifier
//   viz/data/sku_embeddings.json (scoring only) SKU vectors; when absent the GBT
//                                runs in its no-embedding mode (embedCos = 0
//                                placeholder) — noted in meta.eval.
//
// ----------------------------------------------------------------------------
// OUTPUT SCHEMA — how to read the file
// ----------------------------------------------------------------------------
// Top level (json format; jsonl puts everything but listings in the _meta line):
// {
//   "generatedAt", "since", "until", "sources", "readme",
//   "eval":  { "withScores", "engine", "bar", "gbtModel", "embeddings", "topCandidates", "note" },
//   "window":{ "only", "offset", "limit", "applied", "total", "totalAfterFilter", "shown" },
//   "summary": { ...aggregates below... },
//   "clusters": [ ...one per canonical group touched by the audited listings... ],
//   "listings": [ ...one object per listing (windowed), firstSeen ascending... ]
// }
//
// Every SKU anywhere in this file is the NORMALIZED form (the same key used by
// `viz/data/skus/<sku>.json`). To drill into any of them on disk:
//   - full price history : viz/data/skus/<sku>.json        (this file's sku field)
//   - raw store record   : data/db/<dbFile> → items[] where item.sku == rawSku
//   - search the whole data branch with: git log -S '"<sku>"' -- data/db/
//
// Each listing:
//   {
//     "id","sku","dbFile","store","storeId","category","firstSeen",
//     "id" = "<dbFile>|<sku>" — the stable reference for agent decisions / diffs
//     "lookup": { cacheSku, cacheFile, dbFile },
//     "current": { name, url, price, removed, rawSku, img } | null,  // null = pruned
//     "wasAutoLinked","autoLinks[]","linkCount","implicitStoreCount","hasLinks",
//     "links[]","canonicalSku","clusterId","inIgnores","rarity","hidden",
//     "cluster": { id, size, auditedMembers, memberStoreCount, isOrphan },  // compact
//     "scores": {                    // omitted when --no-scores
//       "scored": true|false,        // false = sku not in the live catalog (pruned), "reason" set
//       "reason": "not-in-catalog",
//       "engines": "gbt",            // scorer used for "prob"
//       "bar": 0.95,
//       "candidates": [ ...top --top pairs, strongest first... ],
//       "verified": [ ...the listing's EXISTING explicit links re-scored directly... ]
//     }
//   }
//
// Each "verified" entry = one EXISTING explicit pair (the classifier's own decision or a
// manual/merge link), re-scored via the live ranker WITHOUT candidate-rank truncation —
// the data for unlinking a bad link (prob fell below bar) or confirming a good one:
//   {
//     "fromSku","toSku","kind": "auto-link"|"link", "source", "status", "storedConfidence",
//     "pinned": true|false,   // storedConfidence >= 1e8 ⇒ deterministic floor-pin (e.g. shared
//                             // SMWS cask code); NOT a calibrated prob — keep, ignore below-bar live prob
//     "detScore","score01","prob","aiDelta","aboveBar",
//     "partnerName","partnerStores",
//     "features": { ...same 41-column feature object as candidates... }
//   }
//   absentFromCatalog=true → the partner has left the live catalog (pair unverifiable now).
//   features.embedCos == null and aiDelta == 0 → both sides lack an embedding vector; the GBT
//   used its conservative missing-branch, which explains a live prob sitting just under bar.
//
// Each score candidate = ONE cross-SKU pair (this listing's sku vs that sku):
//   {
//     "sku","name","stores":[storeLabels],"cheapest":<num>,
//     "detScore":  <raw scorePairWithVocab>,          // deterministic ranker score
//     "score01":   <detScore/(detScore+1)>,           // squashed display scale
//     "prob":      <blend/GBT calibrated probability> // == what auto-link classifies on
//     "aboveBar":  <prob >= 0.95>,                    // would auto-link today
//     "aiDelta":   <prob with embedding - prob without>,   // undefined/0 when no embeddings
//     "features": { logDet, contain, woScore, woShared, topTermShared, tgtCov,
//                   candExtra, gradedCov, sizePen, pricePen, ageRel, ageOneSided,
//                   abvMult, abvBoth, edMult, edBoth, smwsShared, conceptMult,
//                   storeShared, badSku, sharedTok, jacc, minTok, maxTok, lenDiff,
//                   containGated, grpStoreOverlap, grpStoreCollideCount,
//                   grpStoreJaccard, grpSameSkuShare, grpSizeConflict, grpSizeJaccard,
//                   grpAbvDiff, grpAbvBoth, grpYearDiff, grpYearBoth, grpPriceRatio,
//                   grpCountA, grpCountB, crossEntityConflicts, embedCos }
//   }
//
// Each cluster (canonical group, keyed by canonicalSku, members resolved):
//   {
//     "id","size","auditedMembers","memberStoreCount","newMemberCount","isOrphan",
//     "hasPendingAutoLink","hasConfirmedAutoLink","hasMergeAutoLink","hasManualLink",
//     "members": [
//       { "sku","inAudit","firstSeen","storeCount","implicitStoreCount",
//         "stores": [ { storeId, store, dbFile, category, name, price, url, removed } ] }
//     ]
//   }
//
// Interpretation cheatsheet:
//   - wasAutoLinked=true, autoLinks[].status=pending → classifier matched it; review outstanding
//   - scores.verified[].aboveBar=false on an auto-link pair → its live prob fell below the bar
//     (accept the classifier's ORIGINAL storedConfidence, but today's data votes to unlink)
//   - scores.candidates[].aboveBar=true on a never-auto-linked sku → the ranker would fire today
//     — the --only want-links funnel; a genuine link to add
//   - want-links / need-unlinks flags on each scored listing are exactly those two funnels
//   - inIgnores=true                             → a suggestion for it was rejected (hard negative)
//   - clusters[].isOrphan                        → single-sku, single-store: the review queue's orphan class
//   - features to eyeball per pair: sharedTok/woScore/containGated (overlap),
//     sizePen/abvMult/edMult/ageRel (hard-rule conflicts — floors a wrong match),
//     grpStoreOverlap/grpSizeConflict (canonical-group-level evidence)
//
// SUMMARY aggregates (top-level "summary"): total (post --only), per-store
// breakdown, autoLinked / hasLinks / orphan / pending / confirmed / inIgnores
// counts, coverage rates, liveNow, prunedFromDb, and when scored: scoredCount.
//
// Re-runnable + read-only over the worktree. Output goes to audit/ (git-ignored).
// ============================================================================

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { pathToFileURL } = require("url");

const { normalizeImplicitSkuKey, buildGroupsAndCanonicalMap } = require("../src/utils/sku_canonical");

const SCRIPT_DIR = __dirname;
const REPO_ROOT = path.dirname(SCRIPT_DIR);

// Default lower bound: the auto-link launch commit on the data branch.
const DEFAULT_SINCE = "2026-06-12T18:47:49Z";

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

// Value-taking flags. Every flag MUST be listed here (or in BOOLEAN_FLAGS) — an unknown flag is a
// hard error, because the old naive parse silently swallowed it as a key and could then default
// `--out`, triggering an unintended FULL regeneration (e.g. a stray `--help`).
const VALUE_FLAGS = new Set([
	"--since", "--until", "--root", "--format", "--only", "--offset", "--limit", "--top",
	"--out", "--from", "--id", "--sku", "--cluster", "--pair", "--limit-pairs", "--min-prob", "--min-det",
]);
const BOOLEAN_FLAGS = new Set(["--with-scores", "--no-scores", "--compact", "--ultra-compact", "--help", "-h"]);

const USAGE = `audit_new_listings — agent-facing SKU-link audit generator + view/deep-dive tool

  node scripts/audit_new_listings.js [options]

Stage 1 (generate the rich file):
  --since <date> --until <date>   first-seen window (default: auto-classify launch .. now)
  --only <funnel>                 all|orphans|auto-linked|has-links|no-auto-link
                                  |want-links|need-unlinks|near-misses  (default all)
  --root <path>                   data worktree (default .worktrees/data)
  --format json|jsonl             (default json)
  --out <file>                    default audit/new_listings_<since>_<until>.<ext>
  --no-scores | --with-scores     scoring on by default
  --top <n>                       candidates kept per listing (default 5)

Stage 1.5 (derive views/deep-dives from a rich file — NO re-scoring):
  --from <rich> [--only <funnel>] [--offset N] [--limit N] [--compact] [--format jsonl] [--out <f>]
  --ultra-compact                 like --compact but drops id/category/firstSeen/removed/auto/
                                  inIgnores/why (~2.5x smaller); implies --compact
  --limit-pairs <n>               cap pairs per row, flagged+highest-prob first (default: no
                                  cap). BIASES the page toward above-bar/suspicious pairs — never
                                  infer population statistics from a capped page, and do not cap
                                  a trust-nothing slice audit.
                                  (default 6 with --ultra-compact, uncapped otherwise)
  --min-prob <p> --min-det <d>    drop pairs below BOTH thresholds (verified links always kept);
                                  _meta.window.droppedPairs records how many. Use to skip
                                  mechanically-rejectable rows, e.g. --min-prob 0.05 --min-det 8
  --from <rich> --id "<dbFile>|<sku>"     full rich row for one listing
  --from <rich> --sku <normalizedSku>     all listings with that sku
  --from <rich> --cluster <canonicalSku>  cluster members + missingFromWindow
  --from <rich> --pair "<a>|<b>"          the pair's live score + 41-col features (either order)

See docs/audit-runbook.md for the decision protocol and proposal schema.

WARNING: running with no --from and no --out regenerates the full rich file and OVERWRITES the
default audit path. Always pass an explicit --out (or --from) when you did not mean to regenerate.`;

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
				console.error(`audit_new_listings: ${a} expects a value`);
				process.exit(2);
			}
			args.set(a, argv[++i]);
			continue;
		}
		console.error(`audit_new_listings: unknown argument "${a}" (use --help for usage)`);
		process.exit(2);
	}
	return { args, flags };
}

// Accepts "YYYY-MM-DD" (start of that UTC day) or any ISO-ish string.
function parseBound(s, { exclusiveDate }) {
	const digits = /^\d{4}-\d{2}-\d{2}$/.test(s || "");
	let ms;
	if (digits) {
		const base = Date.parse(s + "T00:00:00Z");
		ms = exclusiveDate ? base + 24 * 60 * 60 * 1000 : base;
	} else {
		ms = Date.parse(s);
	}
	if (!Number.isFinite(ms)) {
		console.error(`audit_new_listings: cannot parse date "${s}"`);
		process.exit(2);
	}
	return { ms, iso: new Date(ms).toISOString() };
}

function parseNum(s, dflt, flag) {
	if (s == null || s === "") return dflt;
	const v = Number(s);
	if (!Number.isFinite(v) || v < 0) {
		console.error(`audit_new_listings: ${flag} expects a non-negative number, got "${s}"`);
		process.exit(2);
	}
	return Math.floor(v);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return null;
	}
}

const ALLOWED_ONLY = new Set([
	"all",
	"orphans", // no link of any kind
	"auto-linked", // classifier has emitted a pending/confirmed link
	"has-links", // any explicit or implicit link
	"no-auto-link", // classifier has never touched it
	"want-links", // never auto-linked, yet a live candidate prob >= bar today (link the missed ones)
	"need-unlinks", // auto-classify pair(s) whose live re-scored prob fell below bar (unlink the bad ones)
	"near-misses", // cratered true matches: shares overlap evidence but prob < bar — what a human/agent
	// eye instantly sees as "the same product" while the linker scores it low
]);
const STRUCTURAL_ONLY = new Set(["all", "orphans", "auto-linked", "has-links", "no-auto-link"]);
const SCORE_DRIVEN_ONLY = new Set(["want-links", "need-unlinks", "near-misses"]);

// Heuristic triage on a scored pair's decomposed features: does this LOOK like a true
// match the classifier suppressed? I.e. strong shared-overlap evidence yet prob under the
// 99%-precision bar — the profile of a "crushed" pair an auditor should eyeball even though
// auto-linking didn't/didn't-wouldn't fire. Misses that a human would call instantly.
// Pure function over the feature vector.
//
// The classifier's penalties split into two opposite meanings:
//   - sizePen / abvMult below 1 are BENIGN crushes (a 375 vs 750 mL bottle, an ABV-typed
//     variant) — such pairs are usually the same product, just under-bar.
//   - ageRel < 0, conceptMult < 1, edMult < 1 are ACTIVE "these differ" votes (12 vs 16yo,
//     rye vs bourbon, different single-cask edition). Those pairs are low-scored CORRECTLY;
//     they are NOT near-misses even when they share a brand's tokens.
//   - edMult > 1 is a boost, not a penalty.
// A pair only counts as a crushed miss when overlap is genuinely strong AND its only
// suppressors are benign (missing embedding vector on one side is the classic one).
function missAnalysis(det, feats, { pinned, prob, bar }) {
	const n = (v) => typeof v === "number" && Number.isFinite(v);
	const sizePen = n(feats.sizePen) && feats.sizePen < 1;
	const abvMult = n(feats.abvMult) && feats.abvMult < 1;
	const edPen = n(feats.edMult) && feats.edMult < 1;
	const ageDiff = n(feats.ageRel) && feats.ageRel < 0;
	const conceptDiff = n(feats.conceptMult) && feats.conceptMult < 1;
	const benign = [];
	if (sizePen) benign.push(`sizePen:${feats.sizePen}`);
	if (abvMult) benign.push(`abvMult:${feats.abvMult}`);
	if (edPen) benign.push(`edMult:${feats.edMult}`);
	const hardDiff = ageDiff || conceptDiff || edPen;
	const noEmb = feats.embedCos == null && !n(feats.embedCos);
	const hints = [];
	if (noEmb) hints.push("no-embedding");
	for (const h of benign) hints.push(h);
	if (ageDiff) hints.push(`ageRel:${feats.ageRel}`);
	if (conceptDiff) hints.push(`conceptMult:${feats.conceptMult}`);
	const strong =
		(n(feats.containGated) && feats.containGated >= 0.66) ||
		(n(feats.woScore) && feats.woScore >= 0.5) ||
		(n(det) && det >= 2);
	const benignCrush = noEmb || benign.length > 0;
	// strong overlap + below bar + no active differ-signal + a benign reason it's under bar.
	const suspicious = !!(!pinned && prob != null && prob < bar && strong && !hardDiff && benignCrush && benign.length <= 1);
	return { suspicious, missHints: hints, vetoes: benign };
}

// Name normalizer for the identical-title backstop: alnum-only lowercase, bottle sizes
// stripped so "700 mL" / "750ml" variants land in the same bucket.
function normNameForTwin(name) {
	return (name || "")
		.toLowerCase()
		.replace(/\b\d+(?:\.\d+)?\s?(?:ml|l|cl|oz|liter|litre)\b/gi, "")
		.replace(/[^a-z0-9]+/g, "")
		.trim();
}

function fmtNum(x) {
	if (x == null || !isFinite(x)) return "-";
	return String(Number(x).toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
}

// `data/db/**` stores a display price string ("$1,799.99"); normalize to a number for the anchor
// side of a compact row so it matches the candidate side's numeric `price`.
function priceToNum(s) {
	if (typeof s === "number") return isFinite(s) ? s : undefined;
	const n = parseFloat(String(s == null ? "" : s).replace(/[^0-9.]/g, ""));
	return Number.isFinite(n) ? n : undefined;
}

// ---- per-store price-ratio distribution + rarity (evidence, never a verdict) ----
// A price gap only means something relative to how far THIS store normally sits from the
// rest of the market. Liberty runs ~1.20x median / 1.35x p90 over the products it shares,
// so a 2.2x gap there is outside its whole observed range and is real evidence of a
// different product; at a store that routinely doubles the market it would mean nothing.
// Built once in stage 1 over every multi-store canonical group and carried in _meta.
function buildStorePriceStats(indexItems, canonicalSku) {
	const groups = new Map();
	for (const it of indexItems) {
		if (!it || it.removed) continue;
		const p = priceToNum(it.price);
		if (!(p > 0)) continue;
		const g = canonicalSku(it.sku);
		if (!g) continue;
		let m = groups.get(g);
		if (!m) groups.set(g, (m = new Map()));
		const store = it.storeLabel || it.store;
		const prev = m.get(store);
		if (prev == null || p < prev) m.set(store, p);
	}
	const ratios = new Map();
	for (const m of groups.values()) {
		if (m.size < 2) continue;
		const entries = [...m.entries()];
		for (const [store, p] of entries) {
			const others = entries.filter((e) => e[0] !== store).map((e) => e[1]).sort((a, b) => a - b);
			const med = others[Math.floor(others.length / 2)];
			if (!(med > 0)) continue;
			let a = ratios.get(store);
			if (!a) ratios.set(store, (a = []));
			a.push(p / med);
		}
	}
	const byStore = {};
	for (const [store, arr] of ratios) {
		arr.sort((a, b) => a - b);
		const q = (f) => +arr[Math.min(arr.length - 1, Math.floor(f * arr.length))].toFixed(3);
		byStore[store] = { n: arr.length, p50: q(0.5), p75: q(0.75), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: +arr[arr.length - 1].toFixed(3) };
	}
	return byStore;
}

// Where a pair's price gap falls in the DEARER side's own distribution. ">max" = this store
// has never been observed this far above the market on any product it demonstrably shares.
function priceRatioLabel(byStore, store, ratio) {
	const s = byStore && byStore[store];
	if (!s || !(ratio > 0)) return undefined;
	if (ratio > s.max) return ">max";
	if (ratio > s.p99) return ">p99";
	if (ratio > s.p95) return ">p95";
	if (ratio > s.p90) return ">p90";
	if (ratio > s.p75) return ">p75";
	if (ratio > s.p50) return ">p50";
	return "<=p50";
}

function loadRarityData(root) {
	try {
		const j = JSON.parse(fs.readFileSync(path.join(root, "viz", "data", "rarity.json"), "utf8"));
		const t = j.thresholds || {};
		return { byCanon: j.byCanon || {}, rareMin: t.rareMin != null ? t.rareMin : 0.6, stapleMax: t.stapleMax != null ? t.stapleMax : 0.1143 };
	} catch {
		return null;
	}
}

// Only the two tails are emitted; "common" is the 80% middle and not worth the bytes.
// `rare` is what the policy's bundle rule keys off (a rare+common bundle links to the
// rare component), so it has to be visible on the row, not looked up separately.
// Store markers that, inside a product TITLE, mark that store's own exclusive bottling
// (data/sku_link_policy.md, "Store / exclusive cask"). Deliberately narrow: only strings that
// cannot plausibly be part of a distillery or expression name. "legacy", "vessel", "gull" and
// "liberty" are omitted for exactly that reason — they occur in real product names.
const STORE_MARKERS = new Map([
	["Co-op World of Whisky", ["coop", "co-op"]],
	["Kensington Wine Market", ["kensington", "kwm"]],
	["Keg N Cork", ["keg n cork", "kegncork"]],
	["Sherbrooke Liquor", ["sherbrooke"]],
	["Marquis Wine Cellars", ["marquis"]],
	["Willow Park", ["willow park"]],
	["Tudor House", ["tudor house"]],
	["ZYN The Wine Market", ["zyn"]],
	["Strath Liquor", ["strath"]],
	["Malts & Grains", ["malts & grains", "malts and grains"]],
	["Whisky Drop", ["whisky drop"]],
	["New District", ["new district"]],
	["Craft Cellars", ["craft cellars"]],
	["Everything Wine", ["everything wine"]],
	["Sierra Springs", ["sierra springs"]],
	["Silver Springs Liquor", ["silver springs"]],
	["Color de Vino", ["color de vino"]],
	["Highlander Wine & Spirits", ["highlander"]],
	["Vine Arts", ["vine arts"]],
	["Rocky Mountain Wine Spirits Beer", ["rocky mountain"]],
	["Canadian Liquor Store", ["canadian liquor store"]],
	["Liquor Warehouse", ["liquor warehouse"]],
	["Wine and Beyond", ["wine and beyond"]],
]);

// HARD policy conflicts the scorer does not veto. This is a "stop and look" marker for the
// agent, never a verdict — an above-bar pair carrying one still needs a human-grade decision,
// it just must not be waved through on `prob` alone. Only mechanical, unambiguous rules live
// here; everything judgement-shaped stays in data/sku_link_policy.md where the human owns it.
//
// Why it exists: the GBT happily clears the 0.95 bar on pairs the policy calls SEPARATE.
// Measured 2026-09-19 on the full window — `Knut Hansen Gin 750mL` <-> `Knut Hansen Dry Gin
// 500ml` at prob 0.9898, and `Decadent Drams Glenlitigious 12 Year KWM` <-> the non-KWM listing
// at 0.9695. Neither carried any other signal that the row already surfaced.
function policyConflicts(aNames, bNames, aStore, bStores, parseSizes, canonSize) {
	const out = [];

	const bucketsOf = (names) => {
		const set = new Set();
		for (const n of names) for (const ml of parseSizes(n)) set.add(canonSize(ml));
		return set;
	};
	// An UNSTATED size is the normal case (measured: 0-9% of titles state one), so silence on
	// either side is never a conflict — only two stated, disjoint sizes are.
	//
	// The anchor side prefers THIS listing's own title over the union of the aggregate's name
	// variants. A sku can carry variants that disagree with each other (`103252` is listed as
	// both "Knut Hansen Gin 750mL" and "Knut Hansen Dry Gin 500ml"), and unioning them makes
	// the aggregate match every size at once, silently swallowing the conflict.
	const aSz = bucketsOf(aNames.slice(0, 1)).size ? bucketsOf(aNames.slice(0, 1)) : bucketsOf(aNames);
	const bSz = bucketsOf(bNames);
	if (aSz.size && bSz.size) {
		let shared = false;
		for (const x of aSz) if (bSz.has(x)) shared = true;
		if (!shared) out.push(`size:${[...aSz].join("/")}vs${[...bSz].join("/")}`);
	}

	// A store marker counts only when that store actually carries one of the two listings —
	// grounding it in evidence is what keeps "Sierra Springs" the store apart from a product
	// that merely reads like one.
	// Whitespace-delimited phrase match, not substring: a bare `includes("coop")` fires on
	// "John Sleeman & Sons Cooper's Rye". Normalising punctuation to spaces also makes the
	// marker "co-op" match the title "Co-op Exclusive Cask".
	const norm = (t) => ` ${String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
	const aTxt = aNames.map(norm);
	const bTxt = bNames.map(norm);
	const involved = new Set([aStore, ...(bStores || [])].filter(Boolean));
	for (const store of involved) {
		const markers = STORE_MARKERS.get(store);
		if (!markers) continue;
		const inA = markers.some((m) => aTxt.some((t) => t.includes(norm(m))));
		const inB = markers.some((m) => bTxt.some((t) => t.includes(norm(m))));
		if (inA !== inB) out.push(`store-exclusive:${store}`);
	}

	return out.length ? out : undefined;
}

function rarityTierOf(rar, canon) {
	if (!rar || !canon) return undefined;
	const e = rar.byCanon[canon];
	if (!e || e.r == null) return undefined;
	if (e.r >= rar.rareMin) return "rare";
	if (e.r <= rar.stapleMax) return "staple";
	return undefined;
}

// ---- compact decision projection (stage-2 page view) ----
// Stage 1 emits the RICH file; the decision pass reads a slimmed projection of it so a
// page of listings fits cheaply in context. Keeps only decision-relevant fields: identity,
// current name/price, triage + evidence, link counts, and the relevant PAIRS (verified
// links, above-bar candidates, suspicious/twin pairs) with prob/det/hints but NOT the 41
// decomposed features (expand those from the rich file only when a pair needs diagnosing).
function projectCompactPairs(l, ctx) {
	const s = l.scores;
	if (!s || !s.scored) return undefined;
	const byKey = new Map();
	const push = (t, c) => {
		const k = String(c.sku || "");
		if (!k || byKey.has(k)) return;
		const flag = c.pinned ? "pin" : c.absentFromCatalog ? "absent" : c.aboveBar ? "hit" : c.suspicious ? "susp" : undefined;
		const row = {
			t,
			sku: k,
			name: c.name || c.partnerName || "",
			prob: c.prob != null ? +c.prob.toFixed(4) : null,
			det: c.detScore != null ? +c.detScore.toFixed(2) : null,
		};
		if (c.cheapest != null) row.price = c.cheapest;
		// store + sameStore resolved the four hardest calls of the first trial run (is this
		// one product double-listed, or two products the store stocks side by side?), so it
		// belongs on the row rather than in a separate index.json lookup.
		const cStores = c.stores || c.partnerStores || [];
		if (cStores.length === 1) row.st = cStores[0];
		else if (cStores.length > 1) {
			row.st = cStores.slice(0, 2);
			row.nst = cStores.length;
		}
		if (ctx && ctx.anchorStore && cStores.includes(ctx.anchorStore)) row.same = 1;
		if (c.rar) row.rar = c.rar;
		// The anchor's own price for this candidate, present only when `same:1`. Without it the
		// same-store test is unusable from the view: `price` is the cheapest ACROSS stores.
		if (c.samePrice != null) row.samePrice = c.samePrice;
		if (ctx && ctx.anchorPrice > 0 && c.cheapest > 0) {
			const hi = Math.max(ctx.anchorPrice, c.cheapest);
			const lo = Math.min(ctx.anchorPrice, c.cheapest);
			const ratio = hi / lo;
			if (ratio >= 1.05) {
				row.pr = +ratio.toFixed(2);
				const dearStore = ctx.anchorPrice >= c.cheapest ? ctx.anchorStore : cStores[0];
				const lab = priceRatioLabel(ctx.storePriceRatio, dearStore, ratio);
				if (lab && lab !== "<=p50") row.prPct = lab;
			}
		}
		if (c.missHints && c.missHints.length) row.hints = c.missHints;
		if (c.pol && c.pol.length) row.pol = c.pol;
		if (flag) row.flag = flag;
		byKey.set(k, row);
	};
	let cands = (s.candidates || []).filter((c) => c.aboveBar || c.suspicious);
	if (!cands.length && (s.candidates || []).length) cands = [(s.candidates || [])[0]];
	for (const c of cands) push("c", c);
	for (const t of s.twins || []) if (t.suspicious || t.aboveBar) push("w", t);
	for (const v of s.verified || []) push("v", v);
	let arr = [...byKey.values()];
	// Cap pairs per row so one heavily-twinned anchor cannot dominate a page. Ordered by
	// decision value (flagged first, then prob) rather than by the insertion order above.
	// Mechanically-rejectable pairs (explicit differing volumes, prob ~0) are pure token cost.
	// Filtering is opt-in and never silent: _meta.window records what was dropped.
	const minProb = (ctx && ctx.minProb) || 0;
	const minDet = (ctx && ctx.minDet) || 0;
	if (minProb > 0 || minDet > 0) {
		const before = arr.length;
		arr = arr.filter((r) => r.t === "v" || (r.prob != null && r.prob >= minProb) || (r.det != null && r.det >= minDet));
		if (ctx && ctx.counters) ctx.counters.droppedPairs += before - arr.length;
	}
	const cap = ctx && ctx.limitPairs;
	if (cap > 0 && arr.length > cap) {
		const rank = (r) => (r.flag === "hit" ? 0 : r.flag === "susp" ? 1 : r.t === "v" ? 2 : 3);
		arr = arr.slice().sort((a, b) => rank(a) - rank(b) || (b.prob ?? -1) - (a.prob ?? -1)).slice(0, cap);
	}
	return arr.length ? arr : undefined;
}

function projectCompactListing(l, ctx) {
	const cur = l.current || {};
	const ultra = !!(ctx && ctx.ultra);
	const price = priceToNum(cur.price);
	const pairCtx = {
		anchorStore: l.store,
		anchorPrice: price,
		storePriceRatio: ctx && ctx.storePriceRatio,
		limitPairs: ctx && ctx.limitPairs,
		minProb: ctx && ctx.minProb,
		minDet: ctx && ctx.minDet,
		counters: ctx && ctx.counters,
	};
	// --ultra-compact drops what is either derivable or rarely load-bearing: `id` restates
	// dbFile+sku, `category` restates store, and firstSeen/removed/auto/inIgnores were not
	// consulted on a single decision in the first trial. Deep-dive by --sku when needed.
	const out = ultra
		? {
				sku: l.sku,
				store: l.storeId,
				name: cur.name || l.detectedName || "",
				price,
				// canon + grp stay even in ultra: the anchor policy's "smallest canonical group
				// first" rule and the "same canon => already one entity" check are both
				// unimplementable without them, and they cost a few bytes.
				canon: l.canonicalSku || undefined,
				grp: (l.cluster && l.cluster.size) || undefined,
				triage: l.triage,
			}
		: {
				id: l.id,
				store: l.storeId,
				category: l.category || undefined,
				sku: l.sku,
				canon: l.canonicalSku || undefined,
				name: cur.name || l.detectedName || "",
				price,
				removed: cur.removed != null ? !!cur.removed : undefined,
				firstSeen: l.firstSeen,
				links: (l.links || []).length,
				auto: l.wasAutoLinked ? 1 : 0,
				inIgnores: l.inIgnores ? 1 : 0,
				triage: l.triage,
			};
	if (!ultra && l.canonicalSku) out.canon = l.canonicalSku;
	if (!ultra && l.cluster && l.cluster.size) out.grp = l.cluster.size;
	const vl = projectVerifiedLinks(l);
	if (vl) out.vl = vl;
	if (l.rar) out.rar = l.rar;
	if (l.noopEvidence && !ultra) out.why = l.noopEvidence;
	const pairs = projectCompactPairs(l, pairCtx);
	if (pairs) out.pairs = pairs;
	return out;
}

// The PRECISION half of a row. Until 2026-09-20 the compact views exposed only `links: <count>`
// (and nothing at all under --ultra-compact), so an agent could see what a listing might still
// need but never whether what it ALREADY has is correct — the audit could add links and could not
// meaningfully remove them. Every field here is already computed into scores.verified[].
// Array-of-arrays, not objects: [partnerSku, partnerName, prob, sourceInitial, flags].
// flags: "!" = below bar and NOT pinned (a removal candidate), "p" = deterministic floor-pin.
function projectVerifiedLinks(l) {
	const v = (l.scores && l.scores.verified) || [];
	if (!v.length) return undefined;
	const out = [];
	for (const e of v) {
		const partner = e.toSku === l.sku ? e.fromSku : e.toSku;
		const prob = typeof e.prob === "number" ? Number(e.prob.toFixed(4)) : null;
		let flag = "";
		if (e.pinned) flag = "p";
		else if (e.aboveBar === false) flag = "!";
		const src = e.source === "auto-classify" ? "a" : e.source === "agent-audit" ? "g" : "m";
		out.push([partner, String(e.partnerName || "").slice(0, 60), prob, src, flag || undefined]);
	}
	return out.length ? out : undefined;
}

// Stage-1/--from jsonl output: write the _meta line then the row array in batches so we
// never build one giant joined string (Array.join over the whole library overflowed V8's
// max string length — RangeError "Invalid string length" at ~12 min into a full-history run).
function writeJsonlBatched(outFile, metaLine, rows) {
	fs.writeFileSync(outFile, metaLine + "\n", "utf8");
	const BATCH = 200;
	for (let i = 0; i < rows.length; i += BATCH) {
		const chunk = rows.slice(i, i + BATCH).map((l) => JSON.stringify(l)).join("\n");
		fs.appendFileSync(outFile, chunk + "\n", "utf8");
	}
}

// Streaming loader for --from. readFileSync + JSON.parse caps out around V8's max string
// length (~512 MiB), so a whole-library rich jsonl (~700+ MB) crashed with
// ERR_STRING_TOO_LONG. jsonl is read line-by-line via readline (never as one string); the
// single-JSON legacy path still uses readFileSync so old shapes keep working unchanged.
// Returns { meta, listings } or { unrecognized: "empty" } for an empty/blank file.
async function loadFromFile(fromFile) {
	const parseLine = (s) => { try { return JSON.parse(s); } catch { return null; } };
	if (fs.statSync(fromFile).size === 0) return { unrecognized: "empty" };

	// Peek the first non-blank line to classify the shape without holding the whole file.
	let firstLine = null;
	{
		const rl = readline.createInterface({ crlfDelay: Infinity, input: fs.createReadStream(fromFile) });
		for await (const line of rl) {
			if (!line.trim()) continue;
			firstLine = line;
			break;
		}
	}
	if (firstLine == null) return { unrecognized: "empty" };
	const first = parseLine(firstLine);

	// single-JSON: the whole file is one object with a listings[] array (--format json output).
	// Legacy whole-file readFileSync path preserved; trust the first line if the re-parse fails.
	if (first && Array.isArray(first.listings)) {
		try {
			const asObj = JSON.parse(fs.readFileSync(fromFile, "utf8"));
			if (asObj && Array.isArray(asObj.listings)) return { meta: asObj, listings: asObj.listings };
		} catch (e) {
			if (!(e instanceof SyntaxError)) throw e;
		}
		return { meta: first, listings: first.listings };
	}

	if (first && first._meta) {
		// jsonl: _meta on line 1, one listing per subsequent line — stream those line-by-line.
		const listings = [];
		let isMetaLine = true;
		const rl = readline.createInterface({ crlfDelay: Infinity, input: fs.createReadStream(fromFile) });
		for await (const line of rl) {
			if (!line.trim()) continue;
			if (isMetaLine) { isMetaLine = false; continue; }
			const l = parseLine(line);
			if (l) listings.push(l);
		}
		return { meta: first._meta, listings };
	}

	// Bare jsonl (listings, no _meta header) or a legacy pretty-printed single JSON whose first
	// line is not a complete value. Whole-file detection first (preserves old behaviour); if the
	// file is too large for one string, stream it as bare jsonl instead.
	try {
		const text = fs.readFileSync(fromFile, "utf8").trim();
		const asObj = (() => { try { return JSON.parse(text); } catch { return null; } })();
		if (asObj && Array.isArray(asObj.listings)) return { meta: asObj, listings: asObj.listings };
		return { meta: {}, listings: text.split("\n").map(parseLine).filter(Boolean) };
	} catch (e) {
		if (!(e instanceof RangeError)) throw e;
		const listings = [];
		const rl = readline.createInterface({ crlfDelay: Infinity, input: fs.createReadStream(fromFile) });
		for await (const line of rl) {
			if (!line.trim()) continue;
			const l = parseLine(line);
			if (l) listings.push(l);
		}
		return { meta: {}, listings };
	}
}

// Smart-filter view over an already-generated rich file (stage 1.5). Loads the file produced
// by this script, re-applies --only / --offset / --limit / --compact / --format and emits the
// view WITHOUT re-scoring — decisions never recompute the ranker, they read the rich data.
// Deep-dive lookups (the agent's "give me more data on this sku" tool): --id <listingId>,
// --sku <normalizedSku>, --cluster <canonicalSku> pull the FULL rich rows for exactly the
// sku/cluster a decision is about — everything the compact packet trimmed.
async function runFromView({ fromFile, only, offset, limit, format, compact, ultra, limitPairs, minProb, minDet, outFile, id, sku, cluster, pair }) {
	if (!fs.existsSync(fromFile)) {
		console.error(`audit_new_listings: --from file not found: ${fromFile}`);
		process.exit(2);
	}
	const loaded = await loadFromFile(fromFile);
	if (loaded.unrecognized) {
		console.error(`audit_new_listings: --from: unrecognized file shape (empty) (${fromFile})`);
		process.exit(2);
	}
	const meta = loaded.meta || null;
	const listings = loaded.listings || [];
	// Everything the compact projection needs that is not on the row itself. The per-store
	// price-ratio table rides in the rich _meta, so a view never re-reads index.json.
	const viewCtx = {
		ultra,
		// No default cap. `--ultra-compact` used to imply 6, which silently truncated the
		// candidate list flagged-first — the classical ranker deciding which pairs deserve
		// judgement, in a review whose whole point is that the agent decides. Measured on the
		// near-miss funnel (1,520 rows) the cap dropped 8 of 3,196 pairs and saved 1.7 KB of
		// 1,042 KB (0.17%). It bought nothing and biased the sample. Still available explicitly.
		limitPairs: limitPairs != null ? limitPairs : 0,
		minProb,
		minDet,
		storePriceRatio: (meta && meta.eval && meta.eval.storePriceRatio) || null,
		counters: { droppedPairs: 0 },
	};

	// ---- deep-dive lookups (--id / --sku / --cluster / --pair) ----
	if (id || sku || cluster || pair) {
		let outPayload;
		if (id) {
			const row = listings.find((l) => l.id === id);
			outPayload = row || { error: `no listing with id=${id} in ${fromFile}` };
		} else if (sku) {
			outPayload = listings.filter((l) => l.sku === sku);
		} else if (pair) {
			const parts = String(pair).split(/[|,\s]+/).filter(Boolean);
			if (parts.length !== 2) {
				outPayload = { error: `--pair expects "<a>|<b>", got "${pair}"` };
			} else {
				const [A, B] = parts;
				// Listing `sku` is the normalized form (`8768911`) while partner skus keep the catalog
				// form (`id:8768911`), so compare normalized or half of all id-sourced pairs miss.
				const nA = normalizeImplicitSkuKey(A);
				const nB = normalizeImplicitSkuKey(B);
				const matches = [];
				for (const l of listings) {
					const s = l.scores;
					if (!s) continue;
					for (const [bucket, kind] of [["candidates", "candidate"], ["verified", "verified"], ["twins", "twin"]]) {
						for (const c of s[bucket] || []) {
							const set = new Set([normalizeImplicitSkuKey(l.sku), normalizeImplicitSkuKey(c.sku)]);
							if (!(set.has(nA) && set.has(nB))) continue;
							matches.push({
								listingId: l.id,
								anchorSku: l.sku,
								anchorName: (l.current && l.current.name) || l.detectedName || "",
								bucket: kind,
								partnerSku: c.sku,
								partnerName: c.name || c.partnerName || "",
								prob: c.prob != null ? c.prob : null,
								det: c.detScore != null ? c.detScore : null,
								aboveBar: !!c.aboveBar,
								pinned: !!c.pinned,
								suspicious: !!c.suspicious,
								absentFromCatalog: !!c.absentFromCatalog,
								missHints: c.missHints || [],
								features: c.features || null,
							});
						}
					}
				}
				outPayload = {
					pair: { a: A, b: B },
					found: matches.length,
					...(matches.length
						? {}
						: { note: "NOT SCORED — this pair never entered any listing's candidate pool, existing links or twin scan in this rich file. found:0 is absence of data, not a zero score." }),
					featureColumns: matches[0] && matches[0].features ? Object.keys(matches[0].features) : [],
					matches,
				};
			}
		} else {
			const c = (meta.clusters || []).find((x) => x.id === cluster);
			if (!c) {
				const noIndex = !(meta.clusters || []).length;
				outPayload = { error: noIndex
					? `no cluster index in ${fromFile} (derived views omit it) — run --cluster against the rich stage-1 file`
					: `no cluster ${cluster} in ${fromFile}` };
			} else {
				const cSkus = new Set((c.members || []).map((m) => m.sku));
				const members = listings.filter((l) => cSkus.has(l.sku));
				const projectMember = (l) => ({
					sku: l.sku,
					name: (l.current && l.current.name) || l.detectedName || "",
					store: l.storeId,
					price: priceToNum(l.current && l.current.price),
					removed: !!(l.current && l.current.removed) || undefined,
				});
				outPayload = {
					cluster: { id: c.id, size: c.size, memberStoreCount: c.memberStoreCount, hasPendingAutoLink: c.hasPendingAutoLink, hasConfirmedAutoLink: c.hasConfirmedAutoLink, isOrphan: c.isOrphan },
					members: compact ? members.map(projectMember) : members,
					missingFromWindow: (c.members || []).filter((m) => m.sku && !listings.some((l) => l.sku === m.sku)).map((m) => m.sku),
				};
			}
		}
		if (format === "jsonl") {
			const rows = Array.isArray(outPayload) ? outPayload : [outPayload];
			fs.mkdirSync(path.dirname(outFile), { recursive: true });
			fs.writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
		} else {
			fs.mkdirSync(path.dirname(outFile), { recursive: true });
			fs.writeFileSync(outFile, JSON.stringify(outPayload, null, 0) + "\n", "utf8");
		}
		console.log(`audit_deepdive --from ${fromFile} (${id ? "id=" + id : sku ? "sku=" + sku : pair ? "pair=" + pair : "cluster=" + cluster}) → ${outFile}`);
		return;
	}

	const canClassify = (l) => l && (l.scored || (l.scores && l.scores.scored));
	let filtered = listings;
	if (only === "orphans") filtered = listings.filter((l) => !l.hasLinks);
	else if (only === "auto-linked") filtered = listings.filter((l) => l.wasAutoLinked);
	else if (only === "has-links") filtered = listings.filter((l) => l.hasLinks);
	else if (only === "no-auto-link") filtered = listings.filter((l) => !l.wasAutoLinked);
	else if (only === "want-links" || only === "need-unlinks" || only === "near-misses") {
		const scoredEnough = listings.filter(canClassify);
		if (!scoredEnough.length) {
			console.error(`audit_new_listings: --from "${fromFile}" has no scores; score-driven --only ${only} is not derivable. Re-run stage 1 with scoring.`);
			process.exit(2);
		}
		if (only === "want-links") filtered = scoredEnough.filter((l) => l.wantLink);
		else if (only === "need-unlinks") filtered = scoredEnough.filter((l) => l.needUnlink);
		else {
			const listed = scoredEnough.filter((l) => l.nearMiss);
			function bestSuspectDet(l) {
				let m = -1;
				for (const c of l.scores?.candidates || []) if (c.suspicious) m = Math.max(m, c.detScore ?? -1);
				for (const t of l.scores?.twins || []) if (t.suspicious) m = Math.max(m, t.detScore ?? -1);
				return m;
			}
			listed.sort((a, b) => bestSuspectDet(b) - bestSuspectDet(a));
			filtered = listed;
		}
	}
	const windowed = (limit === Infinity ? filtered : filtered.slice(offset, offset + limit));

	const byStore = new Map();
	for (const l of filtered) {
		if (!byStore.has(l.storeId)) byStore.set(l.storeId, { total: 0, autoLinked: 0, hasLinks: 0 });
		const s0 = byStore.get(l.storeId);
		s0.total++;
		if (l.wasAutoLinked) s0.autoLinked++;
		if (l.hasLinks) s0.hasLinks++;
	}
	const n = filtered.length;
	const summary = {
		total: n,
		autoLinked: filtered.filter((l) => l.wasAutoLinked).length,
		hasLinks: filtered.filter((l) => l.hasLinks).length,
		orphans: filtered.filter((l) => !l.hasLinks).length,
		coverageRate: n ? +(filtered.filter((l) => l.hasLinks).length / n).toFixed(4) : 0,
		autoLinkCoverageRate: n ? +(filtered.filter((l) => l.wasAutoLinked).length / n).toFixed(4) : 0,
		byStore: Object.fromEntries([...byStore.entries()].sort()),
		derivedFrom: fromFile,
	};
	if (n) {
		summary.nearMisses = filtered.filter((l) => l.nearMiss).length;
		const triageBuckets = {};
		for (const l of filtered) {
			const t = l.triage || "noop-verified";
			triageBuckets[t] = (triageBuckets[t] || 0) + 1;
		}
		summary.triage = triageBuckets;
	}

	const windowInfo = {
		only,
		offset,
		limit: limit === Infinity ? null : limit,
		applied: offset > 0 || limit !== Infinity,
		total: listings.length,
		totalAfterFilter: n,
		shown: windowed.length,
		remaining: Math.max(0, n - (offset + windowed.length)),
		nextOffset: offset + windowed.length < n ? offset + windowed.length : null,
		derivedFrom: fromFile,
		compact: compact || undefined,
	};

	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	const outData = {
		generatedAt: new Date().toISOString(),
		derivedFrom: fromFile,
		since: meta.since,
		until: meta.until,
		sources: meta.sources,
		// storePriceRatio is ~3 KB of percentile tables and every pair already carries its own
		// prPct label, so views ship the rest of eval without it (the rich file keeps it).
		eval: meta && meta.eval ? (({ storePriceRatio, ...rest }) => rest)(meta.eval) : meta && meta.eval,
		window: windowInfo,
		readme: `DERIVED VIEW (no re-scoring) of ${fromFile}. Cluster lookups are NOT available here — run --cluster against the rich stage-1 file. ${
			meta.readme || "See the stage-1 rich file's readme."
		}`,
		legend: {
			"pairs[].t": "c=live candidate, v=verified existing link, w=title-twin (identical normalized title, never reached the candidate pool)",
			"pairs[].flag": "hit=above auto-link bar (auto-classify WOULD fire — not a correctness guarantee), susp=suspicious below-bar miss, pin=deterministic floor-pin (SMWS cask; do NOT unlink), absent=partner left the catalog. NOTE: already-linked candidates are filtered out of the pool upstream (recommendSimilar sameGroup), so they do not appear here",
			"pairs[].pol": "HARD conflicts with data/sku_link_policy.md that the scorer does NOT veto — size:<a>vs<b> (both sides state a size and the canonical buckets are disjoint; 700=750 and 350=375 are already tolerated) and store-exclusive:<store> (that store's own marker is in ONE title only, which per policy almost always means its exclusive single cask). A `pol` on an above-bar pair means DO NOT accept it on prob alone; decide it or route it to review[].",
			"pairs[].hints": "why a suspicious pair was crushed: no-embedding (this candidate's sku has no vector; per-candidate, not global), sizePen/abvMult/ageRel/conceptMult/edMult are the multiplier(s) responsible",
			"price": "anchor listing price (numeric); pairs[].price is the candidate's cheapest price",
			"sku": "'id:'/upc:'/'u:' prefixed skus are synthetic/aggregate labels; a bare number and its 'id:<n>' form can be the SAME entity",
			"vl": "THIS listing's EXISTING links, re-scored live — the PRECISION surface. [partnerSku, partnerName, prob, source, flag]; source m=manual/legacy, a=auto-classify, g=agent-audit; flag '!' = re-scores BELOW bar and is NOT pinned (a removal candidate — judge it), 'p' = deterministic floor-pin (SMWS cask code, NOT a probability: never unlink). A link with no flag scored above bar, which is evidence but NOT proof it is correct — a wrong link the model still likes looks exactly like this.",
			"canon": "canonical group rep for this listing — two rows with the SAME canon are ALREADY one entity (transitively linked); proposing a link between them is redundant",
			"decode": "use --from <rich> --pair \"<a>|<b>\" for one pair's full 41-col features, or --id <listingId> for a full rich row",
		},
		summary,
		// NOTE: clusters are deliberately NOT included in derived views. They are ~1 MB of the meta
		// line (the whole point of a view is a small, token-cheap page) and no view consumer needs
		// them: --cluster deep-dive runs against the rich file, which carries the full index.
		listings: compact
			? windowed.map((l) => projectCompactListing(l, viewCtx))
			: windowed.map((l) => {
			// triage/noopEvidence already attached by stage 1; keep rows verbatim otherwise.
			return l;
		}),
	};
	// Must be set BEFORE the write: the `listings` projection above is what populates the
	// counter, and _meta is serialized from outData.
	if (viewCtx.counters.droppedPairs) outData.window.droppedPairs = viewCtx.counters.droppedPairs;
	let payload = outData;
	if (format === "jsonl") {
		const { listings: ls, ...m2 } = outData;
		payload = null;
		writeJsonlBatched(outFile, JSON.stringify({ _meta: m2 }), ls);
	} else {
		fs.writeFileSync(outFile, JSON.stringify(payload) + "\n", "utf8");
	}
	const scoredTarget = scoreDrivenOnlySet().has(only) ? n : windowed.length;
	console.log(`audit_view --from ${fromFile}: ${n} filtered (--only ${only}, shown ${windowed.length}${compact ? ", compact" : ""})`);
	console.log(`  auto-linked: ${summary.autoLinked}   has-links: ${summary.hasLinks}   orphans: ${summary.orphans}`);
	if (summary.nearMisses != null) console.log(`  near-miss listings in source file: ${summary.nearMisses}`);
	if (summary.triage) console.log(`  triage: ${Object.entries(summary.triage).map(([k, v]) => `${k}:${v}`).join("  ")}`);
	console.log(`  ${format} → ${outFile}`);
}

function scoreDrivenOnlySet() { return SCORE_DRIVEN_ONLY; }
function triageFor(l) {
	const out = { triage: "noop-verified", evidence: "" };
	const s = l.scores;
	if (!s || !s.scored) {
		out.triage = "pruned";
		out.evidence = "sku not in live catalog (pruned from db) — nothing to link today";
		return out;
	}
	const su = [
		...(s.candidates || []).filter((c) => c.suspicious),
		...(s.twins || []).filter((t) => t.suspicious),
	];
	if (su.length) {
		const c = su[0];
		const label = (s.twins || []).some((t) => t === c) ? "title-twin" : "crushed match";
		out.triage = "check";
		out.evidence = `${label} below bar: ${c.sku} "${c.name}" prob=${fmtNum(c.prob)} det=${fmtNum(c.detScore)} hints=[${(c.missHints || []).join(", ")}]`;
		return out;
	}
	const un = (s.verified || []).filter(
		(v) => v.kind === "auto-link" && v.prob != null && v.prob < (s.bar ?? 0.95) && !v.pinned,
	);
	if (un.length) {
		const v = un[0];
		out.triage = "review";
		out.evidence = `existing auto-link re-scores below bar: ${v.toSku} "${v.partnerName || ""}" prob=${fmtNum(v.prob)} → unlink candidate`;
		return out;
	}
	const ab = (s.candidates || []).filter((c) => c.aboveBar);
	if (ab.length) {
		const c = ab[0];
		out.triage = "auto-high";
		out.evidence = `above-bar candidate ${c.sku} "${c.name}" prob=${fmtNum(c.prob)} det=${fmtNum(c.detScore)}${
			s.twins && s.twins.length ? ` (+${s.twins.length} title-twin)` : ""
		}`;
		return out;
	}
	const cands = s.candidates || [];
	const topC = cands[0];
	if (l.hasLinks) {
		out.evidence =
			`existing link${l.links.length > 1 ? "s" : ""} re-score fine; ` +
			(topC
				? `top contender ${topC.sku} det=${fmtNum(topC.detScore)} prob=${fmtNum(topC.prob)} below bar — no action`
				: "no contenders — no action");
	} else {
		out.evidence = "orphan — no link";
		if (cands.length) {
			out.evidence += `; ${cands.length} contender${cands.length > 1 ? "s" : ""}, top det=${fmtNum(topC.detScore)} prob=${fmtNum(topC.prob)} — too weak, no action`;
		} else {
			out.evidence += "; no candidate shares overlap evidence — nothing comparably named or sold elsewhere";
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Live-ranker environment (dynamic-imported ESM). Mirrors tools/auto_link_classify.mjs
// so every emitted score equals production auto-linking. Never forks scoring.
// ---------------------------------------------------------------------------

// Pool budgeting env knobs (Phase 2 union blocker). AUDIT_POOL_BUDGET caps the per-anchor
// candidate union (default 700); AUDIT_POOL_PER_CHANNEL caps each blocking channel's
// per-key contribution (default 150). AUDIT_POOL_EMB=1 adds the embedding cosine top-K
// channel (default off — ~9 ms/anchor). Failure anywhere → OLD two-index blocker.
function envNum(name, dflt) {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

// Pool-size distribution across scored listings: {n, min, max, med}. Empty → null.
function poolStats(vals) {
	const data = (vals || []).filter((v) => typeof v === "number" && Number.isFinite(v));
	if (!data.length) return null;
	data.sort((a, b) => a - b);
	const mid = Math.floor(data.length / 2);
	return {
		n: data.length,
		min: data[0],
		max: data[data.length - 1],
		med: data.length % 2 ? data[mid] : Math.round((data[mid - 1] + data[mid]) / 2),
	};
}

async function buildScorer(root, opts = {}) {
	// featurize.mjs resolves its WORKTREE at module load time from DATA_WORKTREE.
	process.env.DATA_WORKTREE = root;

	const featurize = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "tools", "linker_ml", "featurize.mjs")).href
	);
	const suggestions = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "suggestions.js")).href
	);
	const blends = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "blend.js")).href
	);
	const groupF = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "group_features.js")).href
	);
	const embeddingsMod = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "embeddings.js")).href
	);
	const storeCache = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "store_cache.js")).href
	);
	const strongT = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "strong_threshold.js")).href
	);
	const similarity = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "similarity.js")).href
	);
	const sizeMod = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "size.js")).href
	);
	const weightsMod = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "linker_page", "blend_weights.js")).href
	);
	const skuCanonEsm = await import(
		pathToFileURL(path.join(SCRIPT_DIR, "..", "viz", "app", "sku_canonical.js")).href
	);

	let env;
	try {
		env = featurize.buildEnv();
	} catch (e) {
		if (e && e.code === "ENOENT" && (String(e.path || "").endsWith("index.json") || /index\.json/.test(String(e.path || "")))) {
			console.error(`audit_new_listings: ERROR: viz/data/index.json not found in ${root} — restore it from the index-latest Release asset (curl -sL -o .worktrees/data/viz/data/index.json https://github.com/brennanwilkes/spirit-tracker/releases/download/index-latest/index.json)`);
		} else {
			console.error(`audit_new_listings: failed to build the ranker env from ${root}`);
		}
		throw e;
	}
	const { allAgg, vocab, sizeFn, priceFn, allLinks } = env;

	// Canonical map over the FULL link set (manual + merge-auto), ESM sibling of
	// src/utils/sku_canonical.js — same keys, kept in sync by convention.
	const { canonBySku } = skuCanonEsm.buildGroupsAndCanonicalMap(allLinks);
	const canonicalSku = (s) => {
		const k = skuCanonEsm.normalizeImplicitSkuKey(s);
		return canonBySku.get(k) || k;
	};
	const canonicalPairKey = (a, b) => {
		const x = canonicalSku(a);
		const y = canonicalSku(b);
		if (!x || !y) return "";
		return x < y ? `${x}|${y}` : `${y}|${x}`;
	};
	const ignoreEntries = env.ignoreEntries || [];
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
	let aggAltNameCount = 0;
	const rarityData = loadRarityData(root);
	// `pairs[].price` is the candidate's CHEAPEST across all stores, which is the wrong number
	// whenever the anchor's own store also carries the candidate — the policy's same-store test
	// needs both prices AT that store. Index them once.
	const priceBySkuStore = new Map();
	for (const it of env.rows || []) {
		const v = priceToNum(it.price);
		if (!(v > 0)) continue;
		const k = String(it.sku || "");
		let m = priceBySkuStore.get(k);
		if (!m) priceBySkuStore.set(k, (m = new Map()));
		const label = it.storeLabel || it.store;
		const prev = m.get(label);
		if (prev == null || v < prev) m.set(label, v);
	}
	// Attach every per-store name variant to the aggregates so blocking can retrieve on all of
	// them (see audit_search_core.buildBlockIndex). Retrieval only — scoring still uses agg.name.
	{
		const namesBySku = new Map();
		for (const it of env.rows || []) {
			const k = String(it.sku || "");
			const n = String(it.name || "").trim();
			if (!k || !n) continue;
			let set = namesBySku.get(k);
			if (!set) namesBySku.set(k, (set = new Set()));
			set.add(n);
		}
		let withAlts = 0;
		for (const agg of allAgg) {
			const set = namesBySku.get(String(agg.sku || ""));
			if (!set) continue;
			const alts = [...set].filter((n) => n !== agg.name);
			if (alts.length) {
				agg.altNames = alts;
				withAlts++;
			}
		}
		aggAltNameCount = withAlts;
	}
	const sameStorePrice = (sku, storeLabel) => {
		if (!storeLabel) return undefined;
		const m = priceBySkuStore.get(String(sku));
		const v = m && m.get(storeLabel);
		return v != null ? v : undefined;
	};
	const storePriceRatio = buildStorePriceStats(env.rows || [], canonicalSku);
	const rules = { canonicalSku };
	const sameStoreFn = storeCache.makeSameStoreCanonFn(rules, storeCache.buildCanonStoreCache(allAgg, rules));

	const EMB_PATH = path.join(root, "viz", "data", "sku_embeddings.json");
	const GBT_PATH = path.join(root, "viz", "data", "gbt_model.json");
	let embRaw = null;
	try {
		embRaw = featurize.readJson(EMB_PATH);
	} catch {
		/* no embeddings → GBT routes embedCos via its 0/NaN branch (same as production here) */
	}
	let gbt = null;
	try {
		gbt = featurize.readJson(GBT_PATH);
	} catch {
		/* no GBT → linear blend fallback */
	}
	const blend = {
		weights: embRaw ? weightsMod.BLEND_WEIGHTS_EMBED : weightsMod.BLEND_WEIGHTS_NOEMBED,
		weightsNoEmbed: weightsMod.BLEND_WEIGHTS_NOEMBED,
		embedCosFn: embRaw ? embeddingsMod.makeEmbedCosFn(embRaw) : null,
		gbt,
		groupIndex: groupF.buildGroupIndex(allAgg, (s) => String(canonicalSku(s) || s)),
		embeddings: !!embRaw,
	};
	const bar = strongT.autoLinkConfidenceBar(true); // blend active → PREC99_PROB (0.95)
	const engine = gbt ? "gbt" : weightsMod.BLEND_WEIGHTS_NOEMBED ? "blend-linear" : "det-only";

	const bySkuAgg = new Map(); // raw + normalized sku -> aggregate
	for (const it of allAgg) {
		const raw = String(it.sku || "");
		if (raw) bySkuAgg.set(raw, it);
		const ns = skuCanonEsm.normalizeImplicitSkuKey(raw);
		if (ns && !bySkuAgg.has(ns)) bySkuAgg.set(ns, it);
	}

	// Distinctive-token / SMWS blocking index (same as auto_link_classify).
	const distIndex = new Map();
	const smwsBucket = new Map();
	for (const it of allAgg) {
		const sku = String(it.sku || "");
		if (!sku) continue;
		for (const tok of vocab.distinctiveUnigramsForName(it.name || "") || []) {
			let s = distIndex.get(tok);
			if (!s) distIndex.set(tok, (s = new Set()));
			s.add(sku);
		}
		const k = similarity.smwsKeyFromName(it.name || "");
		if (k) {
			let s = smwsBucket.get(k);
			if (!s) smwsBucket.set(k, (s = new Set()));
			s.add(sku);
		}
	}
	// Phase 2 union blocker (tools/audit_search_core.mjs) — candidates come from the
	// union of dist/topTerm/smws/twin/fuzzy channels, budgeted per-anchor so the default
	// run stays in the same ~35-75s envelope. Optional embedding channel behind
	// AUDIT_POOL_EMB=1. Any init failure falls back to the two-index blocker below.
	const poolBudget = envNum("AUDIT_POOL_BUDGET", 700);
	const poolPerKey = envNum("AUDIT_POOL_PER_CHANNEL", 150);
	const poolEmb = process.env.AUDIT_POOL_EMB === "1";
	const poolEmbK = envNum("AUDIT_POOL_EMB_K", 200);
	// recommendSimilar's post-pool cuts. Raising these — not the pool budget — is what
	// widens the funnel; an 8.5x wider pool at the defaults yielded 0 extra above-bar pairs.
	const maxCheapKeep = envNum("AUDIT_MAX_CHEAP_KEEP", 320);
	const maxFine = envNum("AUDIT_MAX_FINE", 70);
	let unionBlock = null;
	let unionEmb = null;
	try {
		const core = await import(pathToFileURL(path.join(SCRIPT_DIR, "..", "tools", "audit_search_core.mjs")).href);
		unionBlock = core.buildBlockIndex(allAgg, {
			vocab,
			similarity: { smwsKeyFromName: similarity.smwsKeyFromName },
			aliasTable: null, // null = use the mined built-in table, not "no aliases"
		});
		if (poolEmb) unionEmb = core.buildEmbeddingIndex(root, allAgg) || null;
	} catch (e) {
		console.error(`WARN: union blocker init failed, falling back to dist/SMWS blocker — ${e && e.message}`);
		unionBlock = null;
		unionEmb = null;
	}
	let lastPoolSize = 0;
	function candidatesForAnchor(anchor) {
		const aSku = String(anchor.sku || "");
		if (unionBlock) {
			const aCanon = canonicalSku(aSku);
			const seen = new Set();
			const arr = [];
			const emit = (it) => {
				if (!it) return;
				const s = String(it.sku || it.normKey || "");
				if (!s || s === aSku || seen.has(s)) return;
				if (canonicalSku(s) === aCanon) return;
				seen.add(s);
				arr.push(it);
			};
			const pool = unionBlock.poolFor(anchor, {
				channels: { dist: true, topTerm: true, smws: true, twin: true, fuzzy: true },
				maxPerKey: poolPerKey,
				limit: poolBudget,
			});
			for (const it of pool) emit(it);
			if (unionEmb) {
				for (const r of unionEmb.nearest(anchor, poolEmbK)) emit(r.item);
				if (arr.length > poolBudget) arr.length = poolBudget;
			}
			lastPoolSize = arr.length;
			return [anchor, ...arr];
		}
		const set = new Set();
		for (const tok of vocab.distinctiveUnigramsForName(anchor.name || "") || []) {
			const s = distIndex.get(tok);
			if (s) for (const x of s) set.add(x);
		}
		const k = similarity.smwsKeyFromName(anchor.name || "");
		if (k) {
			const s = smwsBucket.get(k);
			if (s) for (const x of s) set.add(x);
		}
		set.delete(aSku);
		lastPoolSize = set.size;
		const out = [anchor];
		for (const x of set) {
			const it = bySkuAgg.get(x);
			if (it) out.push(it);
		}
		return out;
	}

	// Title-twin bucket: aggregate sku by normalized product title (sizes stripped so
	// "700 mL" / "750ml" collapse). Built lazily and only when opts.enableTwins.
	const nameBucket = new Map();
	let nameBucketReady = false;
	function ensureNameBucket() {
		if (nameBucketReady) return;
		nameBucketReady = true;
		if (!opts.enableTwins) return;
		for (const it of allAgg) {
			const nk = normNameForTwin(it.name || "");
			if (!nk) continue;
			let arr = nameBucket.get(nk);
			if (!arr) nameBucket.set(nk, (arr = []));
			arr.push(it);
		}
	}

	// Score one audit listing against its aggregates. Returns null when the sku is
	// absent from the live catalog (then scored:false is still emitted by the caller).
	//
	// Two score surfaces:
	//   candidates[] — the ranker's TOP pairs for this sku (retrieve-then-rerank, the same
	//     as auto_link_classify / #/link-rapid). aboveBar=true ⇒ auto-linking would fire on
	//     that pair today.
	//   verified[]  — the EXISTING explicit links touching this listing re-scored directly
	//     (auto-classify pending/confirmed entries AND manual/merge links), independent of
	//     candidate-rank truncation. This is the "is this link still good" surface the agent
	//     uses to unlink bad ones.
	function scoreListing(listing, top) {
		const anchor = bySkuAgg.get(listing.sku) || bySkuAgg.get(listing.lookup.cacheSku);
		if (!anchor) return null;
		const me = listing.sku;
		const anchorStoreLabel = listing.store;
		const ctx = suggestions.prepScorePairCtx(anchor, { vocab, sizePenaltyFn: sizeFn, pricePenaltyFn: priceFn });
		const candAgg = candidatesForAnchor(anchor);
		const candidates = [];
		if (candAgg.length > 1) {
			const recs = suggestions.recommendSimilar(
				candAgg,
				anchor,
				top,
				"",
				null,
				isIgnoredPair,
				sizeFn,
				priceFn,
				sameStoreFn,
				sameGroup,
				{ vocab, allowSameStore: true, withScores: true, blend, maxCheapKeep, maxFine },
			);
			for (const r of recs) {
				if (!r || !r.it || r.fallback) continue;
				const det = suggestions.scorePairWithVocab(ctx, r.it);
				const feats = blends.extractBlendFeatures(ctx, r.it, {
					vocab,
					sizePenaltyFn: sizeFn,
					pricePenaltyFn: priceFn,
					embedCosFn: blend.embedCosFn,
					detScore: det,
				});
				if (blend.groupIndex) {
					Object.assign(feats, blend.groupIndex.features(String(anchor.sku), String(r.it.sku)));
				}
				const prob = typeof r.score === "number" ? r.score : null;
				const ma = prob != null ? missAnalysis(det, feats, { pinned: false, prob, bar }) : null;
				candidates.push({
					sku: String(r.it.sku),
					name: r.it.name || "",
					rar: rarityTierOf(rarityData, canonicalSku(String(r.it.sku))),
					samePrice: sameStorePrice(String(r.it.sku), anchorStoreLabel),
					stores: r.it.stores instanceof Set ? [...r.it.stores] : r.it.stores || [],
					cheapest: r.it.cheapestPriceNum != null ? r.it.cheapestPriceNum : null,
					detScore: det,
					score01: blends.toConfidence01(det),
					prob,
					aboveBar: prob != null && prob >= bar,
					aiDelta: r.aiDelta,
					features: feats,
					suspicious: ma ? ma.suspicious : false,
					missHints: ma ? ma.missHints : [],
					pol: policyConflicts(
						[listing.name, anchor.name, ...(anchor.altNames || [])],
						[r.it.name, ...(r.it.altNames || [])],
						anchorStoreLabel,
						r.it.stores instanceof Set ? [...r.it.stores] : r.it.stores || [],
						sizeMod.parseSizesMlFromText,
						sizeMod.canonSizeMl,
					),
				});
			}
		}

		// --- verified: re-score each EXISTING explicit pair touching this listing ---
		const pairMap = new Map();
		for (const al of listing.autoLinks || []) {
			const partner = al.toSku === me ? al.fromSku : al.fromSku === me ? al.toSku : null;
			if (!partner || partner === me) continue;
			const key = [me, partner].sort().join("|");
			if (!pairMap.has(key))
				pairMap.set(key, { kind: "auto-link", source: "auto-classify", status: al.status, confidence: al.confidence, partner });
		}
		for (const lk of listing.links || []) {
			if (lk.kind !== "explicit") continue;
			const src = lk.entry && lk.entry.source;
			if (src === "auto-classify") continue; // already covered via autoLinks
			const partner = lk.sku;
			const key = [me, partner].sort().join("|");
			if (!pairMap.has(key))
				pairMap.set(key, {
					kind: "link",
					source: src || "manual",
					status: "confirmed",
					confidence: lk.entry && lk.entry.confidence,
					partner,
				});
		}
		const verified = [];
		for (const info of pairMap.values()) {
			const v = { fromSku: me, toSku: info.partner, kind: info.kind, source: info.source, status: info.status, storedConfidence: info.confidence };
			const agg = bySkuAgg.get(info.partner);
			if (!agg) {
				v.absentFromCatalog = true;
				verified.push(v);
				continue;
			}
			const det = suggestions.scorePairWithVocab(ctx, agg);
			const sr = suggestions.scorePairBlended(ctx, agg, det, blend, {
				vocab,
				sizePenaltyFn: sizeFn,
				pricePenaltyFn: priceFn,
			});
			const feats = blends.extractBlendFeatures(ctx, agg, {
				vocab,
				sizePenaltyFn: sizeFn,
				pricePenaltyFn: priceFn,
				embedCosFn: blend.embedCosFn,
				detScore: det,
			});
			if (blend.groupIndex) {
				Object.assign(feats, blend.groupIndex.features(String(anchor.sku), String(agg.sku)));
			}
			v.detScore = det;
			v.score01 = blends.toConfidence01(det);
			v.prob = sr.score == null ? null : sr.score;
			v.aiDelta = sr.aiDelta;
			v.aboveBar = v.prob != null && v.prob >= bar;
			v.partnerName = agg.name || "";
			v.partnerStores = agg.stores instanceof Set ? [...agg.stores] : agg.stores || [];
			v.rar = rarityTierOf(rarityData, canonicalSku(v.toSku));
			v.samePrice = sameStorePrice(v.toSku, anchorStoreLabel);
			v.features = feats;
			verified.push(v);
		}
		verified.sort((a, b) => (b.prob === null ? -1 : a.prob === null ? 1 : b.prob - a.prob));

		// A `pinned` link is a DETERMINISTIC floor-pin (e.g. shared SMWS cask code: suggestions.js
		// keeps raw scores >= 1e8 out of the blend re-rank, so a pinned storedConfidence is
		// NOT a calibrated probability). Do not treat a below-bar LIVE prob on a pin as a
		// "bad link" — the pin is deliberate and stronger than the bar.
		for (const v of verified) {
			v.pinned = v.storedConfidence != null && v.storedConfidence >= 1e8;
			if (v.prob != null && v.detScore != null && v.features) {
				const ma = missAnalysis(v.detScore, v.features, { pinned: v.pinned, prob: v.prob, bar });
				v.suspicious = ma.suspicious;
				v.missHints = ma.missHints;
			}
		}

		// --- title-twin backstop (opt-in) ---
		// Identical normalized product titles that never reached the candidate pool. The
		// blocking index can fail to surface a true match (a distinctive token dropped from
		// vocab / not shared), yet two stores selling an identically-named spirit are almost
		// always the same product. This is the pipeline's blind spot; surface it explicitly
		// so "'obviously the same' but the linker never even saw it" is discoverable.
		let twins = [];
		if (opts.enableTwins) {
			ensureNameBucket();
			const nk = normNameForTwin(anchor.name || "");
			const bucket = nk ? nameBucket.get(nk) || [] : [];
			const dup = new Set(
				[...candidates.map((c) => c.sku), ...verified.map((v) => v.toSku)].filter(Boolean),
			);
			for (const agg of bucket) {
				const sku = String(agg.sku || "");
				if (!sku || sku === me || dup.has(sku)) continue;
				if (sameGroup(me, sku) || isIgnoredPair(me, sku)) continue;
				const det = suggestions.scorePairWithVocab(ctx, agg);
				const sr = suggestions.scorePairBlended(ctx, agg, det, blend, {
					vocab,
					sizePenaltyFn: sizeFn,
					pricePenaltyFn: priceFn,
				});
				const feats = blends.extractBlendFeatures(ctx, agg, {
					vocab,
					sizePenaltyFn: sizeFn,
					pricePenaltyFn: priceFn,
					embedCosFn: blend.embedCosFn,
					detScore: det,
				});
				if (blend.groupIndex) {
					Object.assign(feats, blend.groupIndex.features(String(anchor.sku), String(agg.sku)));
				}
				const prob = sr.score == null ? null : sr.score;
				const ma = prob != null ? missAnalysis(det, feats, { pinned: false, prob, bar }) : null;
				twins.push({
					sku,
					name: agg.name || "",
					rar: rarityTierOf(rarityData, canonicalSku(sku)),
					samePrice: sameStorePrice(sku, anchorStoreLabel),
					stores: agg.stores instanceof Set ? [...agg.stores] : agg.stores || [],
					cheapest: agg.cheapestPriceNum != null ? agg.cheapestPriceNum : null,
					detScore: det,
					score01: blends.toConfidence01(det),
					prob,
					aboveBar: prob != null && prob >= bar,
					aiDelta: sr.aiDelta,
					features: feats,
					suspicious: ma ? ma.suspicious : false,
					missHints: ma ? ma.missHints : [],
				});
			}
			twins.sort((a, b) => (b.prob ?? -1) - (a.prob ?? -1));
			if (twins.length > top) twins = twins.slice(0, top);
		}

		return { scored: true, engine, bar, candidates, verified, twins, poolSize: lastPoolSize, poolUnion: !!unionBlock, poolEmb: !!unionEmb };
	}

	return {
		engine,
		bar,
		gbtLoaded: !!gbt,
		embLoaded: !!embRaw,
		twinsEnabled: !!opts.enableTwins,
		pool: {
			union: !!unionBlock,
			budget: poolBudget,
			perKey: poolPerKey,
			maxCheapKeep,
			maxFine,
			emb: !!unionEmb,
			embK: poolEmbK,
			truncation: unionBlock ? unionBlock.truncation : null,
		},
		scoreListing,
		rarityFor: (sku) => rarityTierOf(rarityData, canonicalSku(sku)),
		rarityLoaded: !!rarityData,
		aggAltNameCount,
		storePriceRatio,
	};
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
	const { args, flags } = parseArgs(process.argv.slice(2));

	const since = parseBound(args.get("--since") || DEFAULT_SINCE, { exclusiveDate: false });
	const untilRaw = args.get("--until");
	const until = untilRaw
		? parseBound(untilRaw, { exclusiveDate: true })
		: { ms: Date.now(), iso: new Date().toISOString() };

	const rootArg = args.get("--root") || path.join(REPO_ROOT, ".worktrees", "data");
	const root = path.isAbsolute(rootArg) ? rootArg : path.join(REPO_ROOT, rootArg);

	if (!fs.existsSync(path.join(root, "viz", "data", "skus"))) {
		console.error(`audit_new_listings: expected worktree at ${root} (no viz/data/skus found).`);
		console.error("  Pass --root <path-to-data-worktree> (default .worktrees/data).");
		process.exit(2);
	}

	const format = args.get("--format") || "json";
	if (format !== "json" && format !== "jsonl") {
		console.error(`audit_new_listings: --format must be json or jsonl, got "${format}"`);
		process.exit(2);
	}
	const only = args.get("--only") || "all";
	if (!ALLOWED_ONLY.has(only)) {
		console.error(`audit_new_listings: --only must be one of ${[...ALLOWED_ONLY].join(", ")}`);
		process.exit(2);
	}
	const offset = parseNum(args.get("--offset"), 0, "--offset");
	const limit = parseNum(args.get("--limit"), Infinity, "--limit");
	const withScores = flags.has("--no-scores") ? false : flags.has("--with-scores") ? true : true;
	const top = parseNum(args.get("--top"), withScores ? 5 : 0, "--top");
	const ultra = flags.has("--ultra-compact");
	const compact = flags.has("--compact") || ultra;
	const limitPairs = args.get("--limit-pairs") != null ? parseNum(args.get("--limit-pairs"), 0, "--limit-pairs") : null;
	const minProb = args.get("--min-prob") != null ? Number(args.get("--min-prob")) : 0;
	const minDet = args.get("--min-det") != null ? Number(args.get("--min-det")) : 0;
	if (!Number.isFinite(minProb) || !Number.isFinite(minDet)) {
		console.error("audit_new_listings: --min-prob/--min-det must be numbers");
		process.exit(2);
	}

	const ext = format === "jsonl" ? "jsonl" : "json";
	const fromArg = args.get("--from");
	const outFile =
		args.get("--out") ||
		path.join(REPO_ROOT, "audit", `new_listings_${since.iso.slice(0, 10)}_${until.iso.slice(0, 10)}.${ext}`);

	// --from is a view/deep-dive over an EXISTING rich file — it must never silently fall back
	// to the default rich path (that default is the generator's own output name; writing a
	// small view there would clobber it and print nothing about the destination).
	if (fromArg && !args.get("--out")) {
		console.error("audit_new_listings: deep-dive/view mode (--from) requires --out; refusing to write the default rich path.");
		process.exit(2);
	}

	// Two-stage discipline: the GENERATOR always emits the RICH file; compact projections and
	// score-driven funnels are derived from it via --from (no re-scoring). --compact in the
	// generator contradicts that, so refuse it and point at the view path.
	if (!fromArg && compact) {
		console.error("audit_new_listings: --compact/--ultra-compact is a VIEW projection — generate the rich file first, then derive a compact view with: ");
		console.error(`  node scripts/audit_new_listings.js --from <rich-file> --compact --format jsonl --out <view.jsonl>`);
		process.exit(2);
	}
	const idArg = args.get("--id");
	const skuArg = args.get("--sku");
	const clusterArg = args.get("--cluster");
	const pairArg = args.get("--pair");
	if (fromArg) {
		await runFromView({ fromFile: fromArg, only, offset, limit, format, compact, ultra, limitPairs, minProb, minDet, outFile, id: idArg, sku: skuArg, cluster: clusterArg, pair: pairArg });
		return;
	}
	if (idArg || skuArg || clusterArg || pairArg) {
		console.error("audit_new_listings: --id/--sku/--cluster/--pair are deep-dive lookups over an existing rich file — pass --from <file>.");
		process.exit(2);
	}

	// ---- load link sources (explicit) ----
	const manualFile = readJson(path.join(root, "data", "sku_links.json")) || { links: [], ignores: [] };
	const autoFile = readJson(path.join(root, "data", "sku_links_auto.json")) || { links: [] };
	const manualLinks = Array.isArray(manualFile.links) ? manualFile.links : [];
	const autoLinks = Array.isArray(autoFile.links) ? autoFile.links : [];
	const ignores = Array.isArray(manualFile.ignores) ? manualFile.ignores : [];

	// Adjacency: normalized sku -> explicit link entries that touch it.
	const adjacency = new Map();
	const allEntries = [];
	for (const e of manualLinks) allEntries.push({ entry: e, file: "manual" });
	for (const e of autoLinks) allEntries.push({ entry: e, file: "auto" });

	const seenPairs = new Set();
	for (const { entry, file } of allEntries) {
		const a = normalizeImplicitSkuKey(entry.fromSku);
		const b = normalizeImplicitSkuKey(entry.toSku);
		if (!a || !b) continue;
		const pairKey = [a, b].sort().join("|");
		if (seenPairs.has(pairKey)) continue; // a manual + merge-auto duplicate pair = one link
		seenPairs.add(pairKey);
		const kind = file === "manual" ? entry.source || "manual" : "merge-auto";
		const rec = { entry, file, kind, a, b };
		if (!adjacency.has(a)) adjacency.set(a, []);
		adjacency.get(a).push(rec);
		if (a !== b) {
			if (!adjacency.has(b)) adjacency.set(b, []);
			adjacency.get(b).push(rec);
		}
	}

	// Canonical map over EXPLICIT links (same semantics as src/utils/sku_map.js).
	const { canonBySku, groupsByCanon } = buildGroupsAndCanonicalMap([...manualLinks, ...autoLinks]);

	// Auto-classify entries specifically (the classifier's own output).
	const autoClassifyBySku = new Map();
	for (const e of manualLinks) {
		if (e.source !== "auto-classify") continue;
		const a = normalizeImplicitSkuKey(e.fromSku);
		const b = normalizeImplicitSkuKey(e.toSku);
		if (!a || !b) continue;
		for (const s of new Set([a, b])) {
			if (!autoClassifyBySku.has(s)) autoClassifyBySku.set(s, []);
			autoClassifyBySku.get(s).push({
				fromSku: a,
				toSku: b,
				status: e.status || "confirmed",
				confidence: e.confidence,
				ts: e.ts,
			});
		}
	}

	// Ignores: normalized sku -> true.
	const ignoreSkus = new Set();
	for (const ig of ignores) {
		const a = normalizeImplicitSkuKey(ig.skuA);
		const b = normalizeImplicitSkuKey(ig.skuB);
		if (a) ignoreSkus.add(a);
		if (b) ignoreSkus.add(b);
	}

	// ---- current db state ----
	// currentByDbFile[dbFile] = Map(normSku -> item)
	// skuIndex[normSku] = [ {dbFile, storeId, store, category, ...item} ] over ALL dbFiles
	const dbFiles = fs
		.readdirSync(path.join(root, "data", "db"))
		.filter((f) => f.endsWith(".json"))
		.sort();
	const dbMeta = new Map();
	const currentByDbFile = new Map();
	const skuIndex = new Map();

	for (const f of dbFiles) {
		const data = readJson(path.join(root, "data", "db", f));
		if (!data) continue;
		// SKU-cache store keys are full relPaths ("data/db/xxx.json") — key these
		// maps the SAME way or every lookup below silently misses.
		const relPath = path.posix.join("data", "db", f);
		const storeId = f.split("__")[0];
		const meta = {
			storeId,
			store: data.storeLabel || data.store || storeId,
			category: data.categoryLabel || data.category || "",
		};
		dbMeta.set(relPath, meta);
		const bySku = new Map();
		for (const item of Array.isArray(data.items) ? data.items : []) {
			const ns = normalizeImplicitSkuKey(item?.sku);
			if (!ns) continue;
			const existing = bySku.get(ns);
			if (existing) {
				if (existing.removed && !item.removed) bySku.set(ns, item); // live wins
			} else {
				bySku.set(ns, item);
			}
			if (!skuIndex.has(ns)) skuIndex.set(ns, []);
			skuIndex.get(ns).push({ dbFile: relPath, ...meta, rawSku: String(item.sku), ...item });
		}
		currentByDbFile.set(relPath, bySku);
	}

	// ---- hidden set ((storeId, rawSku)) ----
	const hiddenFile = readJson(path.join(root, "data", "sku_hidden.json"));
	const hiddenSet = new Set();
	for (const h of hiddenFile?.hidden || []) {
		if (h?.storeId && h?.sku != null) hiddenSet.add(`${h.storeId}\u0000${String(h.sku)}`);
	}

	// ---- rarity (keyed by canonical sku) ----
	const rarityFile = readJson(path.join(root, "viz", "data", "rarity.json"));
	const rarity = rarityFile?.byCanon || {};

	// ---- walk the per-SKU cache to find listings first seen in range ----
	const skuCacheDir = path.join(root, "viz", "data", "skus");
	const skuCacheFiles = fs.readdirSync(skuCacheDir).filter((f) => f.endsWith(".json"));
	const listings = [];

	// For cluster member resolution: per-sku cache summary (first-seen + store set).
	const cacheBySku = new Map();

	let skuFilesLoaded = 0;
	for (const f of skuCacheFiles) {
		const data = readJson(path.join(skuCacheDir, f));
		if (!data) continue;
		skuFilesLoaded++;
		const normSku = data.sku || f.replace(/\.json$/, "");
		const stores = data.stores || {};

		// per-sku cache summary for clusters
		let minFirstMs = Infinity;
		const storeSet = new Map(); // dbFile -> {label}
		for (const [dbFile, info] of Object.entries(stores)) {
			const events = Array.isArray(info?.events) ? info.events : [];
			if (!events.length) continue;
			const fm = Date.parse(events[0].ts);
			if (Number.isFinite(fm) && fm < minFirstMs) minFirstMs = fm;
			if (!storeSet.has(dbFile)) storeSet.set(dbFile, { label: info.label });
		}
		if (Number.isFinite(minFirstMs)) {
			cacheBySku.set(normSku, { firstMs: minFirstMs, stores: storeSet });
		}

		for (const [dbFile, info] of Object.entries(stores)) {
			const events = Array.isArray(info?.events) ? info.events : [];
			if (!events.length) continue;
			const first = events[0];
			const firstMs = Date.parse(first.ts);
			if (!Number.isFinite(firstMs)) continue;
			if (firstMs < since.ms || firstMs >= until.ms) continue;

			const meta = dbMeta.get(dbFile) || { storeId: dbFile.split("__")[0], store: info.label || "", category: "" };
			const currentMap = currentByDbFile.get(dbFile);
			const curItem = currentMap ? currentMap.get(normSku) : null;

			// --- explicit links touching this sku ---
			const explicitOther = new Map(); // other normSku -> {kind, entry}
			for (const rec of adjacency.get(normSku) || []) {
				const other = rec.a === normSku ? rec.b : rec.a;
				if (other === normSku) continue;
				explicitOther.set(other, {
					kind: "explicit",
					entry: {
						fromSku: rec.a,
						toSku: rec.b,
						source: rec.kind,
						status: rec.entry.status,
						confidence: rec.entry.confidence,
						ts: rec.entry.ts,
					},
				});
			}

			// --- implicit same-sku shares = other dbFiles tracked for this sku ---
			const implicitOther = [];
			for (const [odf, oinfo] of Object.entries(stores)) {
				if (odf === dbFile) continue;
				implicitOther.push({
					kind: "implicit",
					storeId: odf.split("__")[0],
					store: oinfo.label || "",
				});
			}

			// --- merge into one "links" list with resolved metadata ---
			const merged = new Map();
			for (const [other, v] of explicitOther) {
				const resolved = (skuIndex.get(other) || []).map((r) => ({
					dbFile: r.dbFile,
					storeId: r.storeId,
					store: r.store,
					category: r.category,
					rawSku: r.rawSku,
					name: r.name,
					price: r.price,
					url: r.url,
					removed: !!r.removed,
				}));
				merged.set(other, { sku: other, kind: "explicit", entry: v.entry, resolved });
			}
			for (const io of implicitOther) {
				const key = "implicit:" + io.storeId;
				const existing = merged.get(key);
				const resolved = (skuIndex.get(normSku) || [])
					.filter((r) => r.dbFile !== dbFile)
					.map((r) => ({
						dbFile: r.dbFile,
						storeId: r.storeId,
						store: r.store,
						category: r.category,
						rawSku: r.rawSku,
						name: r.name,
						price: r.price,
						url: r.url,
						removed: !!r.removed,
					}));
				if (existing) {
					existing.kind = "both";
					existing.resolved = [...(existing.resolved || []), ...resolved];
				} else {
					merged.set(key, { sku: normSku, kind: "implicit", storeId: io.storeId, store: io.store, resolved });
				}
			}

			const autoLinks = autoClassifyBySku.get(normSku) || [];
			const canonicalSku = canonBySku.get(normSku) || normSku;
			const hidRaw = curItem && meta.storeId ? `${meta.storeId}\u0000${String(curItem.sku)}` : null;

			let current = null;
			if (curItem) {
				current = {
					name: curItem.name,
					url: curItem.url,
					price: curItem.price,
					removed: !!curItem.removed,
					rawSku: String(curItem.sku),
					img: curItem.img,
				};
			}

			listings.push({
				id: dbFile + "|" + normSku,
				sku: normSku,
				dbFile,
				store: meta.store,
				storeId: meta.storeId,
				category: meta.category,
				firstSeen: first.ts,
				lookup: { cacheSku: normSku, cacheFile: `viz/data/skus/${encodeURIComponent(normSku)}.json`, dbFile },
				current,
				wasAutoLinked: autoLinks.length > 0,
				autoLinks,
				linkCount: explicitOther.size,
				implicitStoreCount: implicitOther.length,
				hasLinks: explicitOther.size > 0 || implicitOther.length > 0,
				links: Array.from(merged.values()),
				canonicalSku,
				inIgnores: ignoreSkus.has(normSku),
				rarity: rarity[canonicalSku] || null,
				hidden: hidRaw ? hiddenSet.has(hidRaw) : undefined,
			});
		}
	}

	// ---- sort: firstSeen asc, then sku, then dbFile ----
	listings.sort((x, y) => {
		const d = Date.parse(x.firstSeen) - Date.parse(y.firstSeen);
		if (d) return d;
		if (x.sku !== y.sku) return x.sku < y.sku ? -1 : 1;
		return x.dbFile < y.dbFile ? -1 : x.dbFile > y.dbFile ? 1 : 0;
	});

	// ---- --only: structural filters apply immediately; score-driven ones need scores ----
	// (want-links / need-unlinks partition the scored universe, so filtering happens AFTER
	// scoring; clusters then describe the FINAL filtered set, keeping pages consistent.)
	const scoreDrivenOnly = SCORE_DRIVEN_ONLY.has(only);
	const willScore = withScores || scoreDrivenOnly;
	if (scoreDrivenOnly && !withScores) {
		console.log(`  note: --only ${only} needs sameness scores; enabling scoring (ignoring --no-scores).`);
	}
	const windowSlice = (arr) =>
		offset || limit !== Infinity ? arr.slice(offset, limit === Infinity ? undefined : offset + limit) : arr;

	let filtered = listings;
	if (only === "orphans") filtered = listings.filter((l) => !l.hasLinks);
	else if (only === "auto-linked") filtered = listings.filter((l) => l.wasAutoLinked);
	else if (only === "has-links") filtered = listings.filter((l) => l.hasLinks);
	else if (only === "no-auto-link") filtered = listings.filter((l) => !l.wasAutoLinked);

	// ---- sameness scores (live ranker) ----
	// Score DRIVEN by the filter: score-driven modes score the whole (unwindowed) structural
	// universe so classification is exact; structural modes score only the windowed page.
	let scorer = null;
	let scoredCount = 0;
	let candidateCount = 0;
	let verifiedCount = 0;
	let wantLinkCount = 0;
	let needUnlinkCount = 0;
	let nearMissCount = 0;
	let twinScanCount = 0;
	const poolSizes = [];
	if (willScore) {
		scorer = await buildScorer(root, { enableTwins: true });
		const scoreTarget = scoreDrivenOnly ? filtered : windowSlice(filtered);
		for (const l of scoreTarget) {
			const res = scorer.scoreListing(l, top);
			if (res) {
				l.scores = res;
				scoredCount++;
				if (typeof res.poolSize === "number") poolSizes.push(res.poolSize);
				candidateCount += res.candidates.length;
				verifiedCount += (res.verified || []).filter((v) => v.prob != null).length;
				const twins = res.twins || [];
				twinScanCount += twins.length;
				l.wantLink = !l.wasAutoLinked && res.candidates.some((c) => c.aboveBar);
				// Any EXISTING link that no longer scores above bar, whatever wrote it. This was
				// gated on `wasAutoLinked` + `kind === "auto-link"` until 2026-09-20, which made the
				// funnel blind to the 95% of the link file that is manual/legacy (5,622 of 5,922
				// entries carry no `source`) — `need-unlinks: 0` meant "no bad AUTO links", not "no
				// bad links". Measured on one window the gate hid 180 of 182 below-bar links.
				// pinned = deterministic floor-pin (SMWS cask code), never a probability: keep.
				l.needUnlink = (res.verified || []).some(
					(v) => v.prob != null && v.prob < scorer.bar && !v.pinned,
				);
				l.nearMiss = res.candidates.some((c) => c.suspicious) || twins.some((t) => t.suspicious);
				if (l.wantLink) wantLinkCount++;
				if (l.needUnlink) needUnlinkCount++;
				if (l.nearMiss) nearMissCount++;
			} else {
				l.scores = { scored: false, reason: "not-in-catalog", engine: scorer.engine, bar: scorer.bar, candidates: [], verified: [], twins: [] };
			}
		}
	}

	// ---- score-driven --only re-filter (after scoring) ----
	if (only === "want-links") filtered = filtered.filter((l) => l.wantLink);
	else if (only === "need-unlinks") filtered = filtered.filter((l) => l.needUnlink);
	else if (only === "near-misses") {
		filtered = filtered.filter((l) => l.nearMiss);
		// Strongest crushed match first: the below-bar pairs whose overlap evidence is
		// most damning (deteScore desc) float to the top of the funnel.
		function bestSuspectDet(l) {
			let m = -1;
			for (const c of l.scores?.candidates || []) if (c.suspicious) m = Math.max(m, c.detScore ?? -1);
			for (const t of l.scores?.twins || []) if (t.suspicious) m = Math.max(m, t.detScore ?? -1);
			return m;
		}
		filtered.sort((a, b) => bestSuspectDet(b) - bestSuspectDet(a));
	}

	// ---- clusters (canonical groups of the filtered universe) ----
	function memberStores(sku) {
		const rows = skuIndex.get(sku) || [];
		const out = rows.map((r) => ({
			storeId: r.storeId,
			store: r.store,
			dbFile: r.dbFile,
			category: r.category,
			name: r.name,
			price: r.price,
			url: r.url,
			removed: !!r.removed,
		}));
		const seen = new Set(rows.map((r) => r.dbFile));
		for (const [dbFile, info] of cacheBySku.get(sku)?.stores || new Map()) {
			if (seen.has(dbFile)) continue;
			const meta = dbMeta.get(dbFile) || { storeId: dbFile.split("__")[0], store: info.label || "" };
			out.push({ storeId: meta.storeId, store: meta.store, dbFile, category: meta.category || "" });
		}
		return out;
	}

	const auditedSkuSet = new Set(filtered.map((l) => l.sku));
	const clusters = [];
	for (const canon of new Set(filtered.map((l) => l.canonicalSku))) {
		const members = Array.from(groupsByCanon.get(canon) || [canon]).sort();
		const memberObjs = members.map((sku) => {
			const cache = cacheBySku.get(sku);
			const stores = memberStores(sku);
			const storeIds = new Set(stores.map((s) => s.storeId));
			return {
				sku,
				inAudit: auditedSkuSet.has(sku),
				firstSeen: cache ? new Date(cache.firstMs).toISOString() : null,
				storeCount: storeIds.size,
				implicitStoreCount: Math.max(0, storeIds.size - 1),
				stores,
			};
		});
		const memberStoreCount = new Set(memberObjs.flatMap((m) => m.stores.map((s) => s.storeId))).size;
		let hasPending = false;
		let hasConfirmed = false;
		let hasMerge = false;
		let hasManual = false;
		for (const m of members) {
			for (const rec of adjacency.get(m) || []) {
				if (rec.entry?.source === "auto-classify") {
					if (rec.entry.status === "pending") hasPending = true;
					else hasConfirmed = true;
				} else if (rec.kind === "merge-auto") {
					hasMerge = true;
				} else {
					hasManual = true;
				}
			}
		}
		clusters.push({
			id: canon,
			size: members.length,
			auditedMembers: memberObjs.filter((m) => m.inAudit).length,
			memberStoreCount,
			newMemberCount: memberObjs.filter(
				(m) => m.firstSeen && Date.parse(m.firstSeen) >= since.ms && Date.parse(m.firstSeen) < until.ms,
			).length,
			isOrphan: members.length === 1 && memberStoreCount <= 1,
			hasPendingAutoLink: hasPending,
			hasConfirmedAutoLink: hasConfirmed,
			hasMergeAutoLink: hasMerge,
			hasManualLink: hasManual,
			members: memberObjs,
		});
	}
	clusters.sort((x, y) => y.size - x.size || (x.id < y.id ? -1 : 1));

	// Attach compact cluster refs to each listing.
	const clusterById = new Map(clusters.map((c) => [c.id, c]));
	for (const l of filtered) {
		const c = clusterById.get(l.canonicalSku);
		l.clusterId = l.canonicalSku;
		l.cluster = c
			? {
					id: c.id,
					size: c.size,
					auditedMembers: c.auditedMembers,
					memberStoreCount: c.memberStoreCount,
					isOrphan: c.isOrphan,
				}
			: { id: l.canonicalSku, size: 1, auditedMembers: 1, memberStoreCount: 1, isOrphan: true };
	}

	// ---- window (offset/limit) ----
	const windowed = windowSlice(filtered);

	// Every emitted listing carries a triage verdict + the evidence making it defensible,
	// so an auditor must actively DISAGREE with a row rather than it just being skippable.
	for (const l of windowed) {
		const t = triageFor(l);
		l.triage = t.triage;
		l.noopEvidence = t.evidence;
		if (scorer && scorer.rarityFor) {
			const tier = scorer.rarityFor(l.canonicalSku || l.sku);
			if (tier) l.rar = tier;
		}
	}

	// Coverage, provable rather than assertable. A `noop-verified` row is only safely skippable
	// if it carries NO above-bar and NO suspicious pair; this counts the ones that do, so an
	// auditor can discharge the whole noop bucket with one number instead of reading it.
	// Two different questions, so two counters. `unexaminedCandidates` is the one that gates
	// coverage: a noop-verified row with a flagged CANDIDATE or TWIN hides a possible missed
	// link. A flagged VERIFIED entry is an existing link that re-scored oddly — already
	// surfaced by the need-unlinks funnel (pins excluded), and common enough that folding it
	// in here would swamp the signal.
	const noopVerified = { rows: 0, unexaminedCandidates: 0, flaggedVerifiedOnly: 0 };
	for (const l of windowed) {
		if (l.triage !== "noop-verified") continue;
		const sc = l.scores;
		if (!sc || !sc.scored) continue;
		noopVerified.rows++;
		const flagged = (arr) => (arr || []).some((x) => x.aboveBar || x.suspicious);
		if (flagged(sc.candidates) || flagged(sc.twins)) noopVerified.unexaminedCandidates++;
		else if (flagged(sc.verified)) noopVerified.flaggedVerifiedOnly++;
	}

	// ---- summary (over the filtered universe) ----
	const n = filtered.length;
	const autoLinked = filtered.filter((l) => l.wasAutoLinked);
	const anyLinks = filtered.filter((l) => l.hasLinks);
	const orphans = filtered.filter((l) => !l.hasLinks);
	const pending = autoLinked.filter((l) => l.autoLinks.some((a) => a.status === "pending"));
	const confirmed = autoLinked.filter((l) => l.autoLinks.some((a) => a.status === "confirmed"));
	const inIgnores = filtered.filter((l) => l.inIgnores);

	const byStore = new Map();
	for (const l of filtered) {
		if (!byStore.has(l.storeId)) byStore.set(l.storeId, { total: 0, autoLinked: 0, hasLinks: 0 });
		const s = byStore.get(l.storeId);
		s.total++;
		if (l.wasAutoLinked) s.autoLinked++;
		if (l.hasLinks) s.hasLinks++;
	}

	const summary = {
		total: n,
		autoLinked: autoLinked.length,
		hasLinks: anyLinks.length,
		orphans: orphans.length,
		coverageRate: n ? +(anyLinks.length / n).toFixed(4) : 0,
		autoLinkCoverageRate: n ? +(autoLinked.length / n).toFixed(4) : 0,
		pendingReview: pending.length,
		confirmed: confirmed.length,
		inIgnores: inIgnores.length,
		liveNow: filtered.filter((l) => l.current && !l.current.removed).length,
		prunedFromDb: filtered.filter((l) => !l.current).length,
		byStore: Object.fromEntries([...byStore.entries()].sort()),
	};
	if (willScore) {
		summary.scoredCount = scoredCount;
		summary.scoredCandidates = candidateCount;
		summary.nearMisses = nearMissCount;
		summary.twinsScanned = twinScanCount;
		const triageBuckets = {};
		for (const l of filtered) {
			const t = triageFor(l);
			triageBuckets[t.triage] = (triageBuckets[t.triage] || 0) + 1;
		}
		summary.triage = triageBuckets;
		if (scoreDrivenOnly) {
			summary.wantLinks = wantLinkCount;
			summary.needUnlinks = needUnlinkCount;
			summary.verifiedPairs = verifiedCount;
		}
	}

	const readme =
		"NEW-LISTINGS AUDIT — this file is machine-readable input for an auditor agent. " +
		`Listings: unit=(dbFile, normalizedSku), first-seen in [${since.iso}, ${until.iso}). ` +
		"Every sku is a normalized key == `viz/data/skus/<sku>.json`; every listing has stable `id` = `<dbFile>|<sku>` for agent references. " +
		"Per listing: `current` = record in the db today (name/url/price/removed; null = pruned out of the db), " +
		"`autoLinks[]` = source:auto-classify entries touching it (status pending=awaiting review), " +
		"`links[]` = explicit/implicit links with per-store `resolved[]`, `cluster` = its canonical-group summary, " +
		"`scores.verified[]` = each EXISTING explicit link re-scored today (`prob` < bar ⇒ candidate to unlink; keep `storedConfidence` as the classifier's original call), " +
		"`scores.candidates[]` = the LIVE ranker's top pairs (`prob` = GBT blend probability thresholds at bar; " +
		"`aboveBar` true ⇒ auto-linking would fire today; `features` are the decomposed sameness inputs — " +
		"overlap: sharedTok/woScore/containGated/tgtCov/jacc; hard-rule vetoes: sizePen/abvMult/edMult/ageRel/conceptMult; " +
		"group-level: grp*; embedCos is a 0 placeholder when the embeddings asset is absent — see meta.eval). " +
		"Two decision funnels: `want-links` (never auto-linked but candidates above bar — link the missed ones) " +
		"and `need-unlinks` (auto-link pair prob fell below bar — unlink the bad ones); `--only` fetches just those rows. " +
		"A THIRD funnel, `--only near-misses`, is the auditor's highest-value surface: pairs the LINKER SCORES LOW but " +
		"that share real overlap evidence — a human/agent eye instantly sees they are the same product (a crushed true " +
		"match, e.g. one hard-rule veto or a missing embedding). Every candidate/verified/twin carries `suspicious` + " +
		"`missHints` (which veto/penalty fired, `no-embedding`); `twins[]` are identically-titled products across stores " +
		"that never even reached the candidate pool (blocking-index blind spot), emitted when running `--only near-misses`. " +
		"Every listing also carries a `triage` verdict + `noopEvidence`: `check` (crushed/twin — eyeball it), `review` " +
		"(existing auto-link went below bar — unlink), `auto-high` (a candidate above bar will auto-link — confirm it), " +
		"`noop-verified` (evidence says nothing to do — dismissal is a claim to verify, not a skipped row), `pruned`. " +
		"Act on a decision by editing data/sku_links.json (add/confirm a pair, or drop one and add an ignore) and re-running — " +
		"this audit never modifies the worktree. " +
		"`clusters` groups skus by canonical rep with member store/name/price. " +
		"`summary` counts the filtered universe; `window` records the paging applied to `listings`. " +
		"COVERAGE CONTRACT (for the auditor's SOP): listings are emitted in deterministic order with stable `id`s; with no " +
		"`--offset/--limit`, `window.total === summary.total === _listings.length` — a review is only complete when every `id` " +
		"in `listings` has an explicit decision, easy or not. Re-run the same invocation afterwards and diff id lists to prove full coverage.";

	const evalInfo = willScore
? {
			withScores: willScore,
				engine: scorer.engine,
				bar: scorer.bar,
				gbtModel: scorer.gbtLoaded,
				embeddings: scorer.embLoaded,
				topCandidates: top,
				pool: scorer.pool,
				poolSizes: poolStats(poolSizes),
				rarity: scorer.rarityLoaded,
				aggAltNames: scorer.aggAltNameCount,
				noopVerified,
				storePriceRatio: scorer.storePriceRatio,
				note: scorer.embLoaded
					? "embedCos are real cosine values."
					: "embeddings asset absent from worktree → embedCos=0 placeholder; GBT runs in its no-embedding mode (identical to tools/auto_link_classify.mjs runtime state).",
			}
		: { withScores: false, note: "scoring skipped (--no-scores)." };

	const windowInfo = {
		only,
		offset,
		limit: limit === Infinity ? null : limit,
		applied: offset > 0 || limit !== Infinity,
		total: listings.length,
		totalAfterFilter: n,
		shown: windowed.length,
	};

	const sources = {
		root,
		skuCacheFiles: skuFilesLoaded,
		dbFiles: dbFiles.length,
		linkEntries: { manual: manualLinks.length, mergeAuto: autoLinks.length, ignores: ignores.length },
	};

	const outData = {
		generatedAt: new Date().toISOString(),
		since: since.iso,
		until: until.iso,
		sources,
		eval: evalInfo,
		window: windowInfo,
		readme,
		summary,
		clusters,
		listings: windowed,
	};

	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	let payload = outData;
	if (format === "jsonl") {
		const { listings: ls, ...meta } = outData;
		payload = null;
		writeJsonlBatched(outFile, JSON.stringify({ _meta: meta }), ls);
	} else {
		fs.writeFileSync(outFile, JSON.stringify(payload) + "\n", "utf8");
	}

	// ---- console summary ----
	console.log(`audit_new_listings: ${n} listings first seen ${since.iso} .. ${until.iso} (--only ${only}, shown ${windowed.length})`);
	console.log(`  auto-linked by classifier: ${autoLinked.length} (${((autoLinked.length / Math.max(n, 1)) * 100).toFixed(1)}%)`);
	console.log(`  have links today:          ${anyLinks.length} (${((anyLinks.length / Math.max(n, 1)) * 100).toFixed(1)}%)`);
	console.log(`  orphans (no links):        ${orphans.length}`);
	console.log(`  pending review:            ${pending.length}   confirmed: ${confirmed.length}   in ignores: ${inIgnores.length}`);
	if (willScore) {
		console.log(`  scored ${scoredCount}/${scoreDrivenOnly ? filtered.length : windowed.length} ${scoreDrivenOnly ? "universe" : "windowed"} · ${candidateCount} candidates · ${verifiedCount} verified pairs · engine=${scorer.engine} bar=${scorer.bar}`);
		const ps = poolStats(poolSizes);
		const poolDesc = scorer.pool.union ? `budget=${scorer.pool.budget} perKey=${scorer.pool.perKey}${scorer.pool.emb ? "+emb:" + scorer.pool.embK : ""}` : "fallback (dist+smws)";
		if (ps) console.log(`  pool[${poolDesc}] sizes min=${ps.min} med=${ps.med} max=${ps.max} n=${ps.n}`);
		const tr = scorer.pool.truncation;
		if (tr && (tr.perKeyHits || tr.limitHits))
			console.log(`  pool truncation: perKey ${tr.perKeyHits} keys/${tr.perKeyDropped} dropped · budget ${tr.limitHits} anchors/${tr.limitDropped} dropped (measured NOT to help — see docs/audit-runbook.md, the pool is not the binding constraint)`);
		if (scoreDrivenOnly)
			console.log(`  want-links: ${wantLinkCount}   need-unlinks: ${needUnlinkCount}   near-misses: ${nearMissCount}${scorer.twinsEnabled ? ` (${twinScanCount} title-twins scanned)` : ""}`);
		else console.log(`  near-miss listings: ${nearMissCount}${scorer.twinsEnabled ? ` · ${twinScanCount} title-twins scanned` : ""}`);
	}
	console.log(`  ${format} → ${outFile}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});