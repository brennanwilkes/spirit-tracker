#!/usr/bin/env node
/**
 * tools/linker_ml/featurize.mjs — the shared substrate for the learned linker.
 *
 * Three deliverables, all reusing the LIVE scorer's helpers (never forking scoring):
 *
 *   buildEnv()        — load the catalog + links, build the vocab/size/price context
 *                       exactly the way tools/linker_eval.mjs does, so features and the
 *                       live ranker can never drift.
 *   featurizeSku()    — "convert a SKU into the right shape": one structured record
 *                       (tokens, distinctive tokens, sizes, abv, age, edition codes,
 *                       brand, category, price, stores) + skuToText() for an embedder.
 *   featurizePair()   — the ~25-column feature vector for a (skuA, skuB) pair: the full
 *                       deterministic score (scorePairWithVocab) PLUS the decomposed
 *                       sub-factors the blend can reweight, PLUS a slot for embed_cosine.
 *
 * The deterministic score is kept as one feature because the live scorer applies max()
 * floors (SMWS / spaceless-core / mid-cut) that don't decompose into a clean product —
 * so we let the blend scale the whole algo and ADD orthogonal signals around it.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { normSearchText, tokenizeQuery, parsePriceToNumber } from "../../viz/app/sku.js";
import {
	filterSimTokens,
	tokenContainmentScore,
	extractAbv,
	abvMultiplier,
	extractAgeFromText,
	bareAgeCandidates,
	extractEditionCodes,
	editionCodeMultiplier,
	smwsKeyFromName,
} from "../../viz/app/linker_page/similarity.js";
import { conceptConflictMultiplier } from "../../viz/app/linker_page/concepts.js";
import { buildVocab, DISTINCTIVE_IDF } from "../../viz/app/linker_page/vocab.js";
import { buildSizePenaltyForPair, parseSizesMlFromText } from "../../viz/app/linker_page/size.js";
import { buildPricePenaltyForPair } from "../../viz/app/linker_page/price.js";
import { prepScorePairCtx, scorePairWithVocab } from "../../viz/app/linker_page/suggestions.js";
import { extractBlendFeatures, FEATURE_KEYS } from "../../viz/app/linker_page/blend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");
export const WORKTREE = process.env.DATA_WORKTREE || path.join(ROOT, ".worktrees/data");
export const OUT_DIR = path.join(__dirname, "out");

const INDEX_PATH = path.join(WORKTREE, "viz/data/index.json");
const LINKS_PATH = path.join(WORKTREE, "data/sku_links.json");
const LINKS_AUTO_PATH = path.join(WORKTREE, "data/sku_links_auto.json");

export function readJson(p) {
	return JSON.parse(fs.readFileSync(p, "utf8"));
}

/* ---------------- environment (single source of truth) ---------------- */

// Mirrors tools/linker_eval.mjs's setup so the feature context is identical to the
// live ranker's: per-raw-SKU aggregates, catalog vocab, size/price penalty closures.
export function buildEnv() {
	const idx = readJson(INDEX_PATH);
	const rows = idx.items || [];

	const bySku = new Map();
	for (const r of rows) {
		const sku = String(r.sku || "");
		if (!sku) continue;
		let a = bySku.get(sku);
		if (!a) {
			a = {
				sku,
				name: r.name || "",
				stores: new Set(),
				cheapestPriceNum: null,
				category: r.category || "",
				categoryLabel: r.categoryLabel || "",
			};
			bySku.set(sku, a);
		}
		if (r.storeLabel) a.stores.add(r.storeLabel);
		const p = parsePriceToNumber(r.price);
		if (Number.isFinite(p) && p > 0)
			a.cheapestPriceNum = a.cheapestPriceNum == null ? p : Math.min(a.cheapestPriceNum, p);
		// Keep the longest name seen — DB-truncated titles are shorter; the longer is richer.
		if ((r.name || "").length > a.name.length) a.name = r.name;
		if (!a.category && r.category) a.category = r.category;
	}
	const allAgg = [...bySku.values()];

	const manualLinks = (() => {
		try {
			return readJson(LINKS_PATH).links || [];
		} catch {
			return [];
		}
	})();
	const ignoreEntries = (() => {
		try {
			return readJson(LINKS_PATH).ignores || [];
		} catch {
			return [];
		}
	})();
	const autoLinks = (() => {
		try {
			return readJson(LINKS_AUTO_PATH).links || [];
		} catch {
			return [];
		}
	})();
	const allLinks = [...manualLinks, ...autoLinks];

	const vocab = buildVocab(allAgg);
	const rulesStub = { canonicalSku: (s) => String(s) };
	const sizeFn = buildSizePenaltyForPair({ allRows: rows, allAgg, rules: rulesStub });
	const priceFn = buildPricePenaltyForPair({ allAgg, rules: rulesStub });

	const ctxCache = new Map();
	function ctxFor(sku) {
		let c = ctxCache.get(sku);
		if (c !== undefined) return c;
		const it = bySku.get(sku);
		c = it ? prepScorePairCtx(it, { vocab, sizePenaltyFn: sizeFn, pricePenaltyFn: priceFn }) : null;
		ctxCache.set(sku, c);
		return c;
	}

	return {
		rows,
		bySku,
		allAgg,
		vocab,
		sizeFn,
		priceFn,
		ctxFor,
		manualLinks,
		autoLinks,
		allLinks,
		ignoreEntries,
	};
}

/* ---------------- SKU → shape ---------------- */

// One canonical text string for an embedder. We feed the normalized NAME only — the
// attention model's job is semantic name equivalence (TBWC↔That Boutique-y, MCDXCIV↔1494,
// Compass Box↔Great King Street); size/abv/edition stay as deterministic vetoes (the
// embedding raising recall, hard rules protecting precision — CLASSIFIER_PLAN §5).
export function skuToText(item) {
	return normSearchText(item?.name || "");
}

// Structured single-SKU representation — the "right shape" for any downstream model.
export function featurizeSku(sku, env) {
	const it = env.bySku.get(String(sku));
	if (!it) return null;
	const name = it.name || "";
	const norm = normSearchText(name);
	const rawToks = tokenizeQuery(norm);
	const toks = filterSimTokens(rawToks);
	const distinctive = env.vocab.distinctiveUnigramsForName(name);
	return {
		sku: it.sku,
		name,
		text: norm,
		toks,
		distinctiveToks: [...(distinctive || [])],
		sizesMl: parseSizesMlFromText(name),
		abv: extractAbv(norm),
		age: extractAgeFromText(norm) || null,
		editionCodes: [...(extractEditionCodes(name) || [])],
		smws: smwsKeyFromName(name) || null,
		brand: toks[0] || "",
		category: it.category || "",
		priceNum: it.cheapestPriceNum,
		stores: [...it.stores],
	};
}

/* ---------------- pair → feature vector ---------------- */

const NUM_RE = /^\d+$/;

// The pair feature vector. Delegates to the SHARED extractBlendFeatures in
// viz/app/linker_page/blend.js (the same function the live ranker uses) so the eval and
// production can never drift. detScore (the full deterministic score) is added explicitly
// because the blend consumes it as `logDet` but downstream tools also read it raw.
export function featurizePair(skuA, skuB, env) {
	const a = env.bySku.get(String(skuA));
	const b = env.bySku.get(String(skuB));
	if (!a || !b) return null;
	const ctxA = env.ctxFor(a.sku);
	if (!ctxA) return null;
	const detScore = scorePairWithVocab(ctxA, b);
	const feats = extractBlendFeatures(ctxA, b, {
		vocab: env.vocab,
		sizePenaltyFn: env.sizeFn,
		pricePenaltyFn: env.priceFn,
		detScore,
	});
	return { a: a.sku, b: b.sku, detScore, ...feats };
}

// FEATURE_KEYS is the single source of truth in blend.js; re-exported for the trainer.
export { FEATURE_KEYS, NUM_RE };
