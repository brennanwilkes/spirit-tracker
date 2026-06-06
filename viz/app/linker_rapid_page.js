// viz/app/linker_rapid_page.js
//
// Rapid anchor-store SKU linker. A keyboard-driven power tool for clearing the
// large backlog of unlinked SKUs created when new stores are added: pick a
// store, walk its unlinked items (strongest-matchable first), and accept one or
// MORE matches per item, then commit and move on. Decisions are staged in
// memory (mirrored to localStorage for crash-safety) and flushed to disk in a
// batch — there is no per-link page reload. A session union-find overlay keeps
// just-linked pairs out of suggestions without re-fetching the catalog.

import { esc, renderThumbHtml } from "./dom.js";
import { goBack, peekBack } from "./nav.js";
import { displaySku, tokenizeQuery, matchesAllTokens } from "./sku.js";
import { loadIndex } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadHiddenSet } from "./hidden.js";
import { loadSkuRules, clearSkuRulesCache } from "./mapping.js";
import {
	isLocalWriteMode,
	loadSkuMetaBestEffort,
	apiWriteSkuLink,
	apiWriteSkuIgnore,
} from "./api.js";
import { addPendingLink, addPendingIgnore } from "./pending.js";
import { buildUrlBySkuStore } from "./linker_page/url_map.js";
import { buildCanonStoreCache, makeSameStoreCanonFn } from "./linker_page/store_cache.js";
import { buildSizePenaltyForPair } from "./linker_page/size.js";
import { buildPricePenaltyForPair } from "./linker_page/price.js";
import { pickPreferredCanonical } from "./linker_page/canonical_pref.js";
import {
	recommendSimilar,
	dedupeByGroupRep,
	prepScorePairCtx,
	scorePairWithVocab,
	scorePairBlended,
} from "./linker_page/suggestions.js";
import { toConfidence01, extractBlendFeatures } from "./linker_page/blend.js";
import { buildVocab } from "./linker_page/vocab.js";
import { STRONG_ABS_PROB, STRONG_REL_PROB } from "./linker_page/strong_threshold.js";
import { BLEND_WEIGHTS_EMBED, BLEND_WEIGHTS_NOEMBED } from "./linker_page/blend_weights.js";
import { buildBlend } from "./linker_page/embeddings.js";
import { loadGbtModel } from "./linker_page/gbt.js";
import { buildGroupIndex } from "./linker_page/group_features.js";
import { aiEnabled, setAiEnabled } from "./linker_page/ai_pref.js";

const QUEUE_KEY = "stviz:linker_rapid_queue_v1";
const STORE_KEY = "stviz:linker_rapid_store_v1";
const AUTO_FLUSH_EVERY = 10;
const RECOMMEND_LIMIT = 14;
const MAX_SUGGEST = 6;
const MAX_OTHER = 10;

export async function renderSkuLinkerRapid($app) {
	const localWrite = isLocalWriteMode();
	const rules = await loadSkuRules();

	$app.innerHTML = `<div class="container" style="max-width:1100px;"><div class="small">Loading catalog…</div></div>`;

	const [idx, hiddenSet] = await Promise.all([loadIndex(), loadHiddenSet()]);
	const allRows = Array.isArray(idx.items) ? idx.items : [];
	const URL_BY_SKU_STORE = buildUrlBySkuStore(allRows);
	const allAgg = aggregateBySku(allRows, (x) => x, hiddenSet);
	const simVocab = buildVocab(allAgg);

	// AI embedding blend — OFF by default (the original deterministic scorer has the sharp
	// separation users rely on for rapid linking). When the user opts in, lazily load the
	// embeddings + build the blend (coverage-gated). `blend` is null when AI is off, so every
	// recommendSimilar call below falls back to the raw scorer. Toggling rebuilds the worklist.
	let aiOn = aiEnabled();
	let blend = aiOn ? await buildBlend(allAgg, BLEND_WEIGHTS_EMBED, BLEND_WEIGHTS_NOEMBED) : null;

	// Attach the GBT classifier + live canonical-GROUP feature index (see linker_page.js).
	// rules is static within a rapid session (session unions handle just-linked pairs, which
	// are filtered as same-group anyway), so the group index is built once.
	async function attachGbtGroup(b) {
		if (!b) return;
		if (b.gbt === undefined) b.gbt = await loadGbtModel();
		if (!b.groupIndex) b.groupIndex = buildGroupIndex(allAgg, (s) => String(rules.canonicalSku(s) || s));
	}
	if (blend) await attachGbtGroup(blend);

	const meta = await loadSkuMetaBestEffort();

	const CANON_STORE_CACHE = buildCanonStoreCache(allAgg, rules);
	const sameStoreCanon = makeSameStoreCanonFn(rules, CANON_STORE_CACHE);
	const sizePenaltyForPair = buildSizePenaltyForPair({ allRows, allAgg, rules });
	const pricePenaltyForPair = buildPricePenaltyForPair({ allAgg, rules });

	// Persisted (already-on-disk + auto) mapped SKUs — used to skip linked items.
	const mappedSkus = (() => {
		const s = new Set();
		const add = (k) => {
			const x = String(k || "").trim();
			if (!x) return;
			s.add(x);
			const c = String(rules.canonicalSku(x) || "").trim();
			if (c) s.add(c);
		};
		for (const x of [...(rules.links || []), ...(meta.links || [])]) {
			add(x?.fromSku);
			add(x?.toSku);
		}
		return s;
	})();

	/* ---------------- session state ---------------- */

	// staged ops: { type:'link', fromSku, toSku } | { type:'ignore', skuA, skuB }
	let staged = loadQueue();
	// decision stack for undo: { kind, anchorSku, opCount }
	const decisions = [];
	let actionsSinceFlush = 0;
	let savedThisSession = 0;
	let skippedCount = 0;

	const baseCanon = (sku) => String(rules.canonicalSku(String(sku || "")) || "");

	// Session union-find overlay seeded from persisted canonical reps.
	const parent = new Map();
	const linkedThisSession = new Set();
	const ignoredLocal = new Set();
	const ignoredLocalNoTrain = new Set();

	function findRep(sku) {
		let x = baseCanon(sku);
		const path = [];
		while (parent.has(x)) {
			path.push(x);
			x = parent.get(x);
		}
		for (const p of path) parent.set(p, x);
		return x;
	}
	function unionLocal(a, b) {
		const ra = findRep(a);
		const rb = findRep(b);
		if (ra && rb && ra !== rb) parent.set(ra, rb);
	}
	function sameGroupLocal(a, b) {
		if (!a || !b) return false;
		return findRep(a) === findRep(b);
	}
	function isIgnoredPairLocal(a, b) {
		if (rules.isIgnoredPair(a, b)) return true;
		const k = rules.canonicalPairKey(a, b);
		return k ? ignoredLocal.has(k) : false;
	}
	// Only pairs ignored in a *prior* session. Session-staged ignores are kept
	// in the candidate list (rendered red) so the user can see/undo them before
	// committing — the suggestion ranker must not filter those out.
	function isIgnoredPairGlobal(a, b) {
		return rules.isIgnoredPair(a, b);
	}
	function isPairIgnoredSession(a, b) {
		const k = rules.canonicalPairKey(a, b);
		return k ? ignoredLocal.has(k) : false;
	}
	function isPairIgnoredNoTrain(a, b) {
		const k = rules.canonicalPairKey(a, b);
		return k ? ignoredLocalNoTrain.has(k) : false;
	}
	function isPairStagedNoTrain(a, b) {
		const ops = pairOps.get(pairKey(a, b)) || pairOps.get(pairKey(b, a));
		return !!(ops && ops.length && ops[0].noTrain);
	}
	function isLinked(sku) {
		const s = String(sku || "");
		if (mappedSkus.has(s) || mappedSkus.has(baseCanon(s))) return true;
		if (linkedThisSession.has(s) || linkedThisSession.has(baseCanon(s))) return true;
		return false;
	}

	// Rebuild the ignore overlay from the staged ops (used after undo).
	// Staged links intentionally do NOT update the session DSU / linkedThisSession
	// — those would hide the candidate from the list and remove the anchor from
	// the worklist. Staged is "marked for save", not "linked yet".
	// Persistence happens only on flush(), which then unions + marks linked.
	function rebuildSession() {
		ignoredLocal.clear();
		ignoredLocalNoTrain.clear();
		for (const op of staged) {
			if (op.type === "ignore") {
				const k = rules.canonicalPairKey(op.skuA, op.skuB);
				if (k) {
					ignoredLocal.add(k);
					if (op.noTrain) ignoredLocalNoTrain.add(k);
				}
			}
		}
	}
	rebuildSession();

	function persistQueue() {
		try {
			localStorage.setItem(QUEUE_KEY, JSON.stringify(staged));
		} catch {}
	}
	function loadQueue() {
		try {
			const j = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
			return Array.isArray(j) ? j : [];
		} catch {
			return [];
		}
	}

	/* ---------------- worklist ---------------- */

	// "" is the sentinel for the global "All stores" view (no per-store filter). A stored
	// value of null means the user has never chosen — so we can default to the busiest store
	// without clobbering a deliberate "All stores" ("") selection.
	const ALL_STORES = "";
	let storeLabel = (() => {
		try {
			return localStorage.getItem(STORE_KEY);
		} catch {
			return null;
		}
	})();

	function unlinkedCountByStore() {
		const m = new Map();
		for (const it of allAgg) {
			if (!it || isLinked(it.sku)) continue;
			for (const lbl of it.stores || []) m.set(lbl, (m.get(lbl) || 0) + 1);
		}
		return m;
	}
	const storeCounts = unlinkedCountByStore();
	const storeOptions = [...storeCounts.entries()].sort((a, b) => b[1] - a[1]);
	const totalUnlinked = allAgg.reduce((n, it) => (it && !isLinked(it.sku) ? n + 1 : n), 0);
	if (storeLabel === null || (storeLabel !== ALL_STORES && !storeCounts.has(storeLabel))) {
		// Never chosen, or a saved store that no longer has unlinked items → busiest store.
		storeLabel = storeOptions[0] ? storeOptions[0][0] : ALL_STORES;
	}

	// Incremental two-pass sort:
	//   1) Fast pre-pass — term-index proxy (weightedOverlap against up to PROXY_K
	//      cross-store candidates that share a distinctive unigram). O(storeSize × K).
	//   2) Refine by fast-score with the FULL recommendSimilar pipeline (size/price/abv/age
	//      penalties + top-term bonus + AI blend). Only REFINE_HEAD_SYNC items are refined
	//      synchronously so first paint stays fast; the REST are refined in the background
	//      (chunked, yielding to the event loop), re-sorting the not-yet-visited tail after
	//      each chunk. Because the user walks the list sequentially and we refine in
	//      fast-score order, the background pass stays ahead of the cursor — so by the time
	//      they reach an item it is properly scored, without ever stalling page load.
	//   A refined item sorts above an un-refined one (bucketed comparator); since we refine
	//   highest-fast-first, un-refined items always have lower proxy scores than refined
	//   ones, so the boundary sits at the fast-rank frontier and converges to a full true
	//   ordering as the background pass completes.
	const REFINE_HEAD_SYNC = 120;
	const BG_REFINE_CHUNK = 40;
	const PROXY_K = 6;

	function buildTermIndex() {
		const termIndex = new Map();
		for (const it of allAgg) {
			if (!it || isLinked(it.sku)) continue;
			if (storeLabel && it.stores && it.stores.has(storeLabel) && it.stores.size <= 1) continue;
			const terms = simVocab.distinctiveUnigramsForName(it.name || "");
			if (!terms || !terms.size) continue;
			for (const t of terms) {
				let arr = termIndex.get(t);
				if (!arr) termIndex.set(t, (arr = []));
				arr.push(it);
			}
		}
		return termIndex;
	}

	function fastScore(it, termIndex) {
		const terms = simVocab.distinctiveUnigramsForName(it.name || "");
		if (!terms || !terms.size) return 0;
		const itSku = String(it.sku || "");
		const seen = new Set();
		let best = 0;
		let visited = 0;
		outer: for (const t of terms) {
			const bucket = termIndex.get(t);
			if (!bucket) continue;
			for (const cand of bucket) {
				if (cand === it) continue;
				const csku = String(cand.sku || "");
				if (seen.has(csku)) continue;
				seen.add(csku);
				if (isIgnoredPairGlobal(itSku, csku)) continue;
				if (sameGroupLocal(itSku, csku)) continue;
				const s = simVocab.weightedOverlap(it.name || "", cand.name || "").score;
				if (s > best) best = s;
				if (++visited >= PROXY_K) break outer;
			}
		}
		return best;
	}

	// Full distinctive-term index over the WHOLE catalog (built once; store-independent,
	// includes already-linked items so an unlinked anchor can match an existing group).
	// refinedScore uses it to score only candidates that SHARE a distinctive token, instead
	// of scanning all ~12k aggregates per item — the worklist sort just needs a rough order
	// (each item re-queries its full candidates on landing), so this is plenty accurate.
	const fullTermIndex = (() => {
		const idx = new Map();
		for (const it of allAgg) {
			if (!it) continue;
			const terms = simVocab.distinctiveUnigramsForName(it.name || "");
			if (!terms || !terms.size) continue;
			for (const t of terms) {
				let arr = idx.get(t);
				if (!arr) idx.set(t, (arr = []));
				arr.push(it);
			}
		}
		return idx;
	})();
	const REFINE_CAND_CAP = 600;

	// ── Informativeness-weighted worklist ordering ──────────────────────────────────────
	// The user mines hard negatives here ~2–3 pairs/min, so ORDER is the dominant cost.
	// The single most valuable label for pushing auto-link rec@99 toward 99% is a BOUNDARY
	// HARD-NEGATIVE: a pair the scorer rates HIGH (looks like a match) that actually differs
	// on edition/age/size/abv (same-distillery / different-expression). Confirming it as an
	// `ignore` sharpens the precision tail — exactly the negatives that crowd the 99% line.
	// Also valuable: genuinely uncertain pairs sitting near the decision boundary. LOW value:
	// trivially-obvious near-identical matches (scorer ~certain, no conflict — confirming them
	// teaches nothing) and obvious non-matches (already dropped as dead-ends at fastScore=0).
	//
	// `informativeness(score, conflict)` maps an anchor's BEST candidate pair to a sort weight
	// (higher = surfaced first). It REPLACES the raw best-score as the refined sort key. All
	// constants are tunable:
	//   - CONFLICT_BOOST: a conflicting-attribute high-score pair (likely hard-neg) is the
	//     jackpot — multiply its weight so it floats to the very top of the worklist.
	//   - BOUNDARY_CENTER / BOUNDARY_WIDTH: a gaussian "uncertainty" bump peaking at the
	//     decision boundary; uncertain pairs (mid score) get a moderate boost.
	//   - TRIVIAL_SCORE / TRIVIAL_DAMP: a near-certain, NON-conflicting pair is a trivial match
	//     — damp it so obvious links don't hog the front of the queue.
	// Weight stays strictly > 0 so a refined item still out-sorts an un-refined one (the
	// two-pass machinery uses refinedMap.get(it) > 0 to mean "refined").
	const CONFLICT_BOOST = 2.2; // multiplier on high-score pairs that have a conflicting attr
	const CONFLICT_SCORE_MIN = 0.55; // a conflict only counts as a "boundary hard-neg" above this
	const BOUNDARY_CENTER = 0.6; // score of peak uncertainty
	const BOUNDARY_WIDTH = 0.22; // gaussian sigma of the uncertainty bump
	const BOUNDARY_AMP = 0.8; // peak added weight from uncertainty
	const TRIVIAL_SCORE = 0.92; // at/above this, a no-conflict pair is a "trivial match"
	const TRIVIAL_DAMP = 0.45; // weight multiplier applied to trivial matches
	function informativeness(score, conflict) {
		const s = Math.max(0, Math.min(1, score || 0));
		let w = s; // base: the scorer's own confidence (keeps strong, plausible pairs near top)
		// Uncertainty bump — peaks at the decision boundary, fades toward 0 and 1.
		const z = (s - BOUNDARY_CENTER) / BOUNDARY_WIDTH;
		w += BOUNDARY_AMP * Math.exp(-0.5 * z * z);
		if (conflict && s >= CONFLICT_SCORE_MIN) {
			w *= CONFLICT_BOOST; // looks-like-a-match-but-conflicts → the highest-value label
		} else if (!conflict && s >= TRIVIAL_SCORE) {
			w *= TRIVIAL_DAMP; // obvious near-identical match → low label value, de-prioritise
		}
		return Math.max(1e-6, w);
	}

	// True when the pair has a hard conflicting attribute (different size / abv / edition / two-
	// sided age) — the signature of a same-distillery/different-expression near-miss. Mirrors
	// the no-conflict gate thresholds used in blend.js::containGated (kept consistent on purpose).
	function pairHasConflict(ctx, cand) {
		const f = extractBlendFeatures(ctx, cand, {
			vocab: simVocab,
			sizePenaltyFn: sizePenaltyForPair,
			pricePenaltyFn: pricePenaltyForPair,
		});
		return f.sizePen < 0.9 || f.abvMult < 0.9 || f.edMult < 0.9 || f.ageRel === -1;
	}

	function refinedScore(it) {
		const terms = simVocab.distinctiveUnigramsForName(it.name || "");
		if (!terms || !terms.size) return 0;
		const itSku = String(it.sku || "");
		const ctx = prepScorePairCtx(it, {
			vocab: simVocab,
			sizePenaltyFn: sizePenaltyForPair,
			pricePenaltyFn: pricePenaltyForPair,
		});
		const useBlend = aiOn && blend && (blend.weights || blend.gbt);
		const seen = new Set();
		let best = 0;
		let bestCand = null;
		let visited = 0;
		outer: for (const t of terms) {
			const bucket = fullTermIndex.get(t);
			if (!bucket) continue;
			for (const cand of bucket) {
				const csku = String(cand.sku || "");
				if (!csku || csku === itSku || seen.has(csku)) continue;
				seen.add(csku);
				if (isIgnoredPairLocal(itSku, csku)) continue;
				if (sameGroupLocal(itSku, csku)) continue;
				// A staged-but-not-yet-flushed link is a decided pair: exclude it so this
				// item's worklist priority reflects its best UNDECIDED candidate, not the one
				// already handled (ignores drop out above via isIgnoredPairLocal).
				if (isPairStagedEither(itSku, csku)) continue;
				let s = scorePairWithVocab(ctx, cand);
				if (useBlend) {
					const { score } = scorePairBlended(ctx, cand, s, blend, {
						vocab: simVocab,
						sizePenaltyFn: sizePenaltyForPair,
						pricePenaltyFn: pricePenaltyForPair,
					});
					if (score != null) s = score;
				}
				if (s > best) {
					best = s;
					bestCand = cand;
				}
				if (++visited >= REFINE_CAND_CAP) break outer;
			}
		}
		if (!bestCand) return 0;
		// Normalise the best pair's score to the SAME 0–1 scale the cards display: a blend
		// probability is already 0–1; a raw classical score is squashed via toConfidence01.
		const score01 = useBlend ? best : toConfidence01(best);
		// Re-rank by INFORMATIVENESS, not raw match strength: a high-score pair with a
		// conflicting attribute (likely a precision-tail hard-negative) and uncertain mid-score
		// pairs are surfaced first; trivial near-identical matches are damped. See the block above.
		return informativeness(score01, pairHasConflict(ctx, bestCand));
		return best;
	}

	// Sort state shared between the synchronous head build and the background refiner.
	// `worklistGen` invalidates any in-flight background loop when the worklist is rebuilt
	// (store change / AI toggle).
	let fastMap = new Map();
	let refinedMap = new Map();
	let byFastOrder = [];
	let bgPointer = 0;
	let worklistGen = 0;

	// Temperature jitter on the worklist order — so refreshing gives a slightly different
	// (but still high-quality) first pair, mirroring the manual #/link page's Temp slider.
	// Reuses that same persisted setting (`stviz_linker_temp_v1`): 0 = deterministic, 0.2 =
	// mild variety. The jitter is a stable multiplicative perturbation per item (seeded once
	// per page load), so the order is consistent across background resorts within a session
	// but varies between refreshes. It only reorders within a score bucket — a junk item can
	// never leap a strong one.
	const SORT_TEMP = (() => {
		try {
			const raw = localStorage.getItem("stviz_linker_temp_v1");
			const v = raw == null ? 0.2 : parseFloat(raw);
			return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.2;
		} catch {
			return 0.2;
		}
	})();
	const SORT_JITTER_AMP = 0.35; // ±35% score perturbation at temp=1 (±7% at the 0.2 default)
	let _rngState = (() => {
		try {
			const u = new Uint32Array(1);
			crypto.getRandomValues(u);
			return u[0] >>> 0 || 1;
		} catch {
			return ((Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0) || 1;
		}
	})();
	function nextRand() {
		_rngState = (_rngState + 0x6d2b79f5) >>> 0;
		let x = Math.imul(_rngState ^ (_rngState >>> 15), 1 | _rngState);
		x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	}
	const jitterCache = new Map();
	function scoreJitter(it) {
		if (SORT_TEMP <= 0) return 1;
		let j = jitterCache.get(it);
		if (j === undefined) {
			j = 1 + (nextRand() * 2 - 1) * SORT_TEMP * SORT_JITTER_AMP;
			if (j < 0.01) j = 0.01;
			jitterCache.set(it, j);
		}
		return j;
	}

	function worklistCompare(a, b) {
		const ja = scoreJitter(a);
		const jb = scoreJitter(b);
		const ra = (refinedMap.get(a) || 0) > 0;
		const rb = (refinedMap.get(b) || 0) > 0;
		if (ra && rb) {
			const ds = (refinedMap.get(b) || 0) * jb - (refinedMap.get(a) || 0) * ja;
			if (Math.abs(ds) > 1e-9) return ds;
		} else if (ra !== rb) {
			return ra ? -1 : 1;
		} else {
			const ds = (fastMap.get(b) || 0) * jb - (fastMap.get(a) || 0) * ja;
			if (Math.abs(ds) > 1e-9) return ds;
		}
		const ea = (a.stores ? a.stores.size : 99) - (b.stores ? b.stores.size : 99);
		if (ea) return ea;
		return String(a.name || "").localeCompare(String(b.name || ""));
	}

	function buildWorklist() {
		worklistGen++;
		fastMap = new Map();
		refinedMap = new Map();

		const items = [];
		for (const it of allAgg) {
			if (!it || !it.stores) continue;
			if (storeLabel && !it.stores.has(storeLabel)) continue; // "" = all stores, no filter
			if (isLinked(it.sku)) continue;
			items.push(it);
		}

		const termIndex = buildTermIndex();
		for (const it of items) fastMap.set(it, fastScore(it, termIndex));

		// Drop dead-ends: items whose best proxy score is 0 share no distinctive token with any
		// cross-store candidate, so the suggester can never surface a match for them — walking
		// them is wasted keystrokes. They stay reachable via the `/` search box.
		const live = items.filter((it) => (fastMap.get(it) || 0) > 0);

		byFastOrder = live.slice().sort((a, b) => (fastMap.get(b) || 0) - (fastMap.get(a) || 0));
		const headEnd = Math.min(REFINE_HEAD_SYNC, byFastOrder.length);
		for (let i = 0; i < headEnd; i++) refinedMap.set(byFastOrder[i], refinedScore(byFastOrder[i]));
		bgPointer = headEnd;

		live.sort(worklistCompare);
		scheduleBackgroundRefine(worklistGen);
		return live;
	}

	function scheduleNextChunk(fn) {
		if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 200 });
		else setTimeout(fn, 0);
	}

	// Re-sort only the not-yet-visited tail; items at/before workIdx (current anchor +
	// already-walked) stay frozen so the background pass never reorders under the cursor.
	function resortTail() {
		if (workIdx + 1 >= worklist.length) return;
		const head = worklist.slice(0, workIdx + 1);
		const tail = worklist.slice(workIdx + 1);
		tail.sort(worklistCompare);
		worklist = head.concat(tail);
	}

	function scheduleBackgroundRefine(gen) {
		if (bgPointer >= byFastOrder.length) return;
		scheduleNextChunk(function run() {
			if (gen !== worklistGen) return; // a rebuild superseded this pass
			const end = Math.min(bgPointer + BG_REFINE_CHUNK, byFastOrder.length);
			for (; bgPointer < end; bgPointer++) {
				const it = byFastOrder[bgPointer];
				if (!refinedMap.has(it)) refinedMap.set(it, refinedScore(it));
			}
			resortTail();
			if (bgPointer < byFastOrder.length) scheduleNextChunk(run);
		});
	}

	// Per-pair staged-op references so Space can toggle a single (anchor,candidate)
	// link in/out of the staged queue. Key: `${anchorSku}|${candSku}` → array of op
	// objects pushed into `staged` (matched by reference for removal).
	// Declared BEFORE buildWorklist() runs — refinedScore() consults it (staged pairs are
	// excluded from an item's best-remaining-candidate score), so it must exist (empty) at
	// build time, not be in the temporal dead zone.
	const pairOps = new Map();
	const pairKey = (a, b) => `${String(a)}|${String(b)}`;
	// Candidate SKUs that are staged for a link with SOME anchor. Used to filter
	// them from suggestions when viewing a different anchor.
	const stagedCandSkus = new Set();
	function rebuildStagedCandSkus() {
		stagedCandSkus.clear();
		for (const key of pairOps.keys()) {
			const i = key.indexOf("|");
			if (i >= 0) stagedCandSkus.add(key.slice(i + 1));
		}
	}
	function isPairStaged(anchorSku, candSku) {
		return pairOps.has(pairKey(anchorSku, candSku));
	}
	function isPairStagedEither(a, b) {
		return isPairStaged(a, b) || isPairStaged(b, a);
	}

	// sku (aggregate representative) → aggregate, for re-scoring a specific item after a
	// decision changes its best-remaining candidate.
	const aggBySku = new Map();
	for (const it of allAgg) if (it && it.sku != null) aggBySku.set(String(it.sku), it);

	let worklist = buildWorklist();
	let workIdx = 0;
	let candidates = []; // [{ it, score, shared, sameStore }]
	let highlight = 0;

	// A decision (staged link or ignore) removes that pair from each item's candidate pool, so
	// the two items' best-remaining-candidate scores can drop. Recompute them and re-sort the
	// tail so a now-weak item sinks instead of resurfacing next with a leftover low suggestion.
	function rescoreAfterDecision(...skus) {
		for (const s of skus) {
			const it = aggBySku.get(String(s || ""));
			if (it) refinedMap.set(it, refinedScore(it));
		}
		resortTail();
	}

	function skipLinkedForward() {
		while (workIdx < worklist.length && isLinked(worklist[workIdx].sku)) workIdx++;
	}
	function currentAnchor() {
		return workIdx < worklist.length ? worklist[workIdx] : null;
	}
	skipLinkedForward();

	function computeCandidates() {
		const anchor = currentAnchor();
		if (!anchor) return [];
		const q = String($search?.value || "").trim();
		const tokens = tokenizeQuery(q);
		// `blended` = the score is already a 0–1 probability (AI on). Raw classical scores get
		// squashed to 0–1 by toConfidence01 below so the displayed scale matches. This must NOT
		// depend on whether the user is searching — a search hit and a suggestion for the SAME
		// pair must show the SAME score (both go through scorePairBlended).
		const activeBlend = aiOn && blend && (blend.weights || blend.gbt) ? blend : null;
		const blended = !!activeBlend;
		let scored;
		if (tokens.length) {
			const aSku = String(anchor.sku);
			// Score search hits with the SAME pipeline as suggestions (was raw weightedOverlap →
			// it disagreed with the AI score shown on the suggestion cards).
			const sctx = prepScorePairCtx(anchor, {
				vocab: simVocab,
				sizePenaltyFn: sizePenaltyForPair,
				pricePenaltyFn: pricePenaltyForPair,
			});
			scored = allAgg
				.filter(
					(it) =>
						it &&
						String(it.sku) !== aSku &&
						!isLinked(it.sku) &&
						matchesAllTokens(it.searchText, tokens),
				)
				.slice(0, RECOMMEND_LIMIT)
				.map((it) => {
					const det = scorePairWithVocab(sctx, it);
					const { score, aiDelta } = scorePairBlended(sctx, it, det, activeBlend, {
						vocab: simVocab,
						sizePenaltyFn: sizePenaltyForPair,
						pricePenaltyFn: pricePenaltyForPair,
					});
					return { it, score, aiDelta };
				});
		} else {
			scored = recommendSimilar(
				allAgg,
				anchor,
				RECOMMEND_LIMIT,
				"",
				mappedSkus,
				isIgnoredPairGlobal,
				sizePenaltyForPair,
				pricePenaltyForPair,
				sameStoreCanon,
				sameGroupLocal,
				{
					vocab: simVocab,
					allowSameStore: true,
					withScores: true,
					groupRepFn: findRep,
					blend: aiOn ? blend : null,
				},
			).map((x) => (x && x.it ? x : { it: x, score: 0 }));
		}
		// Collapse candidates that already belong to one canonical group into a
		// single card (the search branch builds its own list and isn't routed
		// through recommendSimilar's dedup).
		scored = dedupeByGroupRep(scored, (x) => x.it && x.it.sku, findRep);
		// Hide candidates already staged for a link so the same pair never re-surfaces.
		// The staged key is directional (`anchor|cand`), so check BOTH directions: when the
		// just-linked candidate later becomes the anchor, its former anchor must not reappear
		// as a fresh suggestion (the "reversed pair" bug). The forward direction is kept (the
		// pair shows as accepted under its staging anchor, so it stays visible/undoable).
		const aStr = String(anchor.sku);
		scored = scored.filter((x) => {
			if (!x || !x.it) return false;
			const cSku = String(x.it.sku);
			if (isPairStaged(aStr, cSku)) return true; // forward: this pair was staged here → keep (accepted)
			if (isPairStaged(cSku, aStr)) return false; // reverse of a staged pair → hide
			return !stagedCandSkus.has(cSku); // staged with a different anchor → hide
		});
		return scored.map((x) => ({
			it: x.it,
			score: blended ? x.score || 0 : toConfidence01(x.score || 0),
			aiDelta: x.aiDelta,
			shared: simVocab.weightedOverlap(anchor.name || "", x.it.name || "").shared,
			sameStore: sameStoreCanon(String(anchor.sku), String(x.it.sku)),
		}));
	}

	/* ---------------- actions ---------------- */

	function togglePairStaged(candIdx, noTrain = false) {
		const anchor = currentAnchor();
		const cand = candidates[candIdx];
		if (!anchor || !cand) return;
		const a = String(anchor.sku);
		const b = String(cand.it.sku);
		if (!a || !b || a === b) return;

		const key = pairKey(a, b);
		const existing = pairOps.get(key);
		if (existing) {
			// Unstage: remove these op refs from `staged` (matched by reference).
			for (const op of existing) {
				const i = staged.indexOf(op);
				if (i >= 0) staged.splice(i, 1);
			}
			pairOps.delete(key);
			rebuildStagedCandSkus();
			decisions.push({ kind: "unlink", anchorSku: a, candSku: b, ops: existing });
			persistQueue();
			rebuildSession();
			setStatus(`Unstaged link: "${anchor.name || a}" × "${cand.it.name || b}".`);
			rescoreAfterDecision(a, b);
			render(true);
			return;
		}

		// Stage: build the canonical link ops for this single (anchor, candidate) pair.
		const skus = [a, b];
		const canons = skus.map(baseCanon);
		const preferred = pickPreferredCanonical(allRows, [...skus, ...canons]);
		if (!preferred) {
			setStatus("Could not choose a canonical SKU — nothing linked.");
			return;
		}
		const seen = new Set();
		const ops = [];
		for (const f of [...canons, ...skus]) {
			const from = String(f || "");
			if (!from || from === preferred) continue;
			const k = `${from}→${preferred}`;
			if (seen.has(k)) continue;
			seen.add(k);
			ops.push({ type: "link", fromSku: from, toSku: preferred, ...(noTrain ? { noTrain: true } : {}) });
		}
		if (!ops.length) {
			setStatus("Nothing to link (already canonical).");
			return;
		}
		for (const op of ops) staged.push(op);
		pairOps.set(key, ops);
		rebuildStagedCandSkus();
		decisions.push({ kind: "link", anchorSku: a, candSku: b, ops });
		persistQueue();
		actionsSinceFlush += 1;
		const noTrainNote = noTrain ? " (no-train)" : "";
		setStatus(`Staged link${noTrainNote}: "${anchor.name || a}" × "${cand.it.name || b}".`);
		rescoreAfterDecision(a, b);
		render(true);
	}

	function stageIgnorePair(anchorSku, candSku, noTrain = false) {
		const a = String(anchorSku || "");
		const b = String(candSku || "");
		if (!a || !b || a === b) return;
		const k = rules.canonicalPairKey(a, b);

		// Toggle off if it was ignored *this session* — the row stays visible
		// (red) while staged, so a mis-press is one keystroke to reverse.
		if (k && ignoredLocal.has(k)) {
			const removed = [];
			for (let i = staged.length - 1; i >= 0; i--) {
				const op = staged[i];
				if (op.type === "ignore" && rules.canonicalPairKey(op.skuA, op.skuB) === k) {
					staged.splice(i, 1);
					removed.unshift(op);
				}
			}
			decisions.push({ kind: "unignore", anchorSku: a, candSku: b, ops: removed });
			persistQueue();
			rebuildSession();
			setStatus(`Un-ignored: ${displaySku(a)} × ${displaySku(b)}.`);
			rescoreAfterDecision(a, b);
			render(true);
			return;
		}

		if (rules.isIgnoredPair(a, b)) {
			setStatus("Already ignored (from a previous session).");
			return;
		}

		const op = { type: "ignore", skuA: a, skuB: b, ...(noTrain ? { noTrain: true } : {}) };
		staged.push(op);
		decisions.push({ kind: "ignore", anchorSku: a, candSku: b, ops: [op] });
		persistQueue();
		rebuildSession();
		const noTrainNote = noTrain ? " (no-train)" : "";
		setStatus(`Staged ignore${noTrainNote}: ${displaySku(a)} × ${displaySku(b)}.`);
		rescoreAfterDecision(a, b);
		render(true);
	}

	function undo() {
		const d = decisions.pop();
		if (!d) {
			setStatus("Nothing to undo.");
			return;
		}
		if (d.kind === "link" && Array.isArray(d.ops)) {
			for (const op of d.ops) {
				const i = staged.indexOf(op);
				if (i >= 0) staged.splice(i, 1);
			}
			pairOps.delete(pairKey(d.anchorSku, d.candSku));
			rebuildStagedCandSkus();
		} else if (d.kind === "unlink" && Array.isArray(d.ops)) {
			for (const op of d.ops) staged.push(op);
			pairOps.set(pairKey(d.anchorSku, d.candSku), d.ops);
			rebuildStagedCandSkus();
		} else if (d.kind === "ignore" && Array.isArray(d.ops)) {
			for (const op of d.ops) {
				const i = staged.indexOf(op);
				if (i >= 0) staged.splice(i, 1);
			}
		} else if (d.kind === "unignore" && Array.isArray(d.ops)) {
			for (const op of d.ops) staged.push(op);
		}
		persistQueue();
		rebuildSession();
		const targetIdx = worklist.findIndex((it) => String(it.sku) === d.anchorSku);
		if (targetIdx >= 0) workIdx = targetIdx;
		highlight = 0;
		rescoreAfterDecision(d.anchorSku, d.candSku);
		render();
	}

	function clearStaged() {
		if (!staged.length) {
			setStatus("Nothing staged to clear.");
			return;
		}
		const n = staged.length;
		// Collect every sku touched by a staged decision before wiping — their
		// best-remaining-candidate scores rise back once the decisions are gone.
		const affected = new Set();
		for (const key of pairOps.keys()) for (const s of key.split("|")) affected.add(s);
		for (const op of staged) {
			if (op.type === "ignore") {
				affected.add(String(op.skuA));
				affected.add(String(op.skuB));
			}
		}
		staged.length = 0;
		decisions.length = 0;
		pairOps.clear();
		rebuildStagedCandSkus();
		actionsSinceFlush = 0;
		persistQueue();
		rebuildSession();
		setStatus(`Cleared ${n} unsaved staged change(s).`);
		document.querySelector(".rapidRecover")?.remove();
		rescoreAfterDecision(...affected);
		render();
	}

	async function flush() {
		if (!staged.length) {
			setStatus("Nothing to flush.");
			return;
		}
		const batch = staged.slice();
		setStatus(`Flushing ${batch.length} change(s)…`);
		try {
			if (localWrite) {
				for (const op of batch) {
					if (op.type === "link") await apiWriteSkuLink(op.fromSku, op.toSku, op.noTrain);
					else await apiWriteSkuIgnore(op.skuA, op.skuB, op.noTrain);
				}
			} else {
				for (const op of batch) {
					if (op.type === "link") addPendingLink(op.fromSku, op.toSku, op.noTrain);
					else addPendingIgnore(op.skuA, op.skuB, op.noTrain);
				}
			}
			// Apply the now-persisted ops to the in-memory DSU + linked set so
			// saved items drop out of the worklist on the next render / store change.
			for (const op of batch) {
				if (op.type === "link") {
					unionLocal(op.fromSku, op.toSku);
					linkedThisSession.add(String(op.fromSku));
					linkedThisSession.add(String(op.toSku));
				}
			}
			staged.length = 0;
			pairOps.clear();
			rebuildStagedCandSkus();
			persistQueue();
			decisions.length = 0; // undo only within an unflushed batch
			actionsSinceFlush = 0;
			savedThisSession += batch.length;
			clearSkuRulesCache(); // force fresh rules on next page navigation
			setStatus(
				localWrite
					? `Flushed ${batch.length} change(s) to disk.`
					: `Staged ${batch.length} change(s) for PR.`,
			);
			renderHeader();
		} catch (e) {
			setStatus(`Flush failed: ${String(e && e.message ? e.message : e)}. Changes still queued.`);
		}
	}

	/* ---------------- render ---------------- */

	function termLabel(term) {
		return term.startsWith("b:") ? term.slice(2).replace("~", " ") : term;
	}

	function confidenceLabel(pct) {
		if (pct >= 0.66) return "strong";
		if (pct >= 0.33) return "fair";
		return "weak";
	}

	function cardHtml(it, o) {
		// Count distinct stores across the whole canonical group, not just this raw
		// SKU — so a card representing several already-linked listings shows the
		// real combined store presence.
		const groupStores = CANON_STORE_CACHE.get(baseCanon(it.sku));
		const storeCount = groupStores ? groupStores.size : it.stores ? it.stores.size : 0;
		const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";
		const price = it.cheapestPriceStr || "(no price)";
		const store = it.cheapestStoreLabel || (it.stores ? [...it.stores][0] : "Store") || "Store";
		const href =
			URL_BY_SKU_STORE.get(String(it.sku || ""))?.get(String(store || "")) ||
			String(it.sampleUrl || "").trim() ||
			"";
		const storeHtml = href
			? `<a class="itemStore" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(store)}${esc(plus)}</a>`
			: `<span class="itemStore">${esc(store)}${esc(plus)}</span>`;

		const chips = (o.shared || [])
			.filter((x) => x.term && !x.term.startsWith("b:"))
			.slice(0, 4)
			.map((x) => `<span class="rapidChip">${esc(termLabel(x.term))}</span>`)
			.join("");
		const flags = o.sameStore ? `<span class="rapidFlag rapidFlagSame">same store</span>` : "";
		const meta = [chips, flags].filter(Boolean).join(" ");

		const numHint = o.num != null ? `<span class="rapidNum">${o.num}</span>` : "";
		const accClass = o.ignored ? "rapidIgnored" : o.accepted ? "rapidAccepted" : "";
		// Confidence: a tier-coloured dot + the score number. When the AI blend is active,
		// an "AI ±x" chip shows how much the embedding shifted the score vs the classical
		// algorithm — a large purple chip on a bad suggestion means the AI is to blame.
		const tierColor = o.pct >= 0.66 ? "#22c55e" : o.pct >= 0.33 ? "#d97706" : "#94a3b8";
		// AI contribution chip, colour-coded by SIGN so a + (AI inflating a suggestion) pops:
		// red/rose ▲ = AI pushed the score UP (scrutinise), blue ▼ = AI pushed it DOWN,
		// grey = negligible. Lets you spot at a glance when a bad result is AI-driven.
		let aiChip = "";
		if (o.aiDelta != null) {
			const d = o.aiDelta;
			const negl = Math.abs(d) < 0.02;
			const bg = negl ? "rgba(148,163,184,0.18)" : d > 0 ? "rgba(244,63,94,0.28)" : "rgba(56,189,248,0.22)";
			const fg = negl ? "#94a3b8" : d > 0 ? "#fb7185" : "#7dd3fc";
			const arrow = negl ? "" : d > 0 ? "▲ " : "▼ ";
			aiChip = `<span class="rapidAiChip" title="AI embedding shifts this score by ${d >= 0 ? "+" : ""}${d.toFixed(2)} vs the classical algorithm" style="margin-left:7px;padding:2px 7px;border-radius:8px;font-size:0.82em;font-weight:700;background:${bg};color:${fg};">AI ${arrow}${d >= 0 ? "+" : ""}${d.toFixed(2)}</span>`;
		}
		const conf =
			o.pct != null
				? `<div class="rapidConf" title="score ${(o.score || 0).toFixed(2)}" style="display:flex;align-items:center;">
					<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${tierColor};margin-right:6px;flex:0 0 auto;"></span>
					<span class="rapidConfTxt" style="font-variant-numeric:tabular-nums;font-weight:600;">${(o.score || 0).toFixed(2)}</span>
					${aiChip}
				</div>`
				: "";
		const accLabel = o.ignoredNoTrain ? "✕ no-train ignore"
			: o.ignored ? "✕ ignored"
			: o.acceptedNoTrain ? "✓ linked (no-train)"
			: o.accepted ? "✓ linked"
			: "press to link";
		const accBadge = o.candidate ? `<span class="rapidAcc">${accLabel}</span>` : "";
		const ignoreBtn = o.candidate
			? `<button class="rapidIgnoreBtn ${o.ignored ? "rapidIgnoreBtnActive" : ""}" title="${o.ignored ? "Ignored — press N or click to un-ignore" : "Mark as 'do not suggest' (false positive) — shortcut: N"}" data-sku="${esc(String(it.sku))}">${o.ignored ? "↺ un-ignore" : "✕ ignore"}</button>`
			: "";

		return `
		<div class="rapidCard ${o.highlight ? "rapidHi" : ""} ${o.anchor ? "rapidAnchor" : ""} ${accClass}" data-sku="${esc(String(it.sku))}">
			${numHint}
			<div class="thumbBox thumbInternalLink" data-sku="${esc(String(it.sku))}" title="Open item page">${renderThumbHtml(it.img)}</div>
			<div class="rapidBody">
				<div class="rapidName">${esc(it.name || "(no name)")}</div>
				<div class="rapidLine">${storeHtml}<span class="price">${esc(price)}</span><span class="badge mono">${esc(displaySku(it.sku))}</span>${accBadge}${ignoreBtn}</div>
				${conf}
				${meta ? `<div class="rapidMeta">${meta}</div>` : ""}
			</div>
		</div>`;
	}

	function renderHeader() {
		const set = (id, v) => {
			const el = document.getElementById(id);
			if (el) el.textContent = String(v);
		};
		set("rapidStaged", staged.length);
		set("rapidFlushed", savedThisSession);
		set("rapidSkipped", skippedCount);
		const $prog = document.getElementById("rapidProgress");
		if ($prog) {
			const done = Math.min(workIdx, worklist.length);
			$prog.textContent = `${done} / ${worklist.length} (${Math.max(0, worklist.length - done)} left)`;
		}
	}

	function setStatus(msg) {
		const $s = document.getElementById("rapidStatus");
		if ($s) $s.textContent = msg || "";
	}

	let $search = null;

	function render(skipRecompute = false) {
		const anchor = currentAnchor();
		if (!skipRecompute) candidates = anchor ? computeCandidates() : [];
		if (highlight >= candidates.length) highlight = candidates.length ? candidates.length - 1 : 0;
		if (highlight < 0) highlight = 0;

		const topScore = candidates.length ? Math.max(...candidates.map((c) => c.score)) : 0;
		const isSearch = !!String($search?.value || "").trim();

		// Adaptive split: a "Suggestion" is a candidate that's strong both
		// absolutely and relative to the best — so the count flexes with quality.
		// Scores are 0–1 in both modes now (probability when AI on, squashed classical
		// otherwise), so one cutoff scale applies.
		const cutoff = Math.max(STRONG_ABS_PROB, STRONG_REL_PROB * topScore);
		const strong = [];
		const other = [];
		candidates.forEach((c, i) => {
			const row = { ...c, idx: i };
			if (!isSearch && c.score >= cutoff && strong.length < MAX_SUGGEST) strong.push(row);
			else other.push(row);
		});
		const otherCapped = other.slice(0, MAX_OTHER);

		const anchorSkuStr = anchor ? String(anchor.sku) : "";
		const renderRow = (c) =>
			cardHtml(c.it, {
				num: c.idx + 1,
				candidate: true,
				highlight: c.idx === highlight,
				accepted: isPairStaged(anchorSkuStr, String(c.it.sku)),
				acceptedNoTrain: isPairStagedNoTrain(anchorSkuStr, String(c.it.sku)),
				ignored: isPairIgnoredSession(anchorSkuStr, String(c.it.sku)),
				ignoredNoTrain: isPairIgnoredNoTrain(anchorSkuStr, String(c.it.sku)),
				score: c.score,
				aiDelta: c.aiDelta,
				pct: topScore > 0 ? c.score / topScore : 0,
				shared: c.shared,
				sameStore: c.sameStore,
			});

		const anchorHtml = anchor
			? cardHtml(anchor, { anchor: true })
			: `<div class="rapidDone">✓ No more unlinked items for this store. Pick another store, or Save.</div>`;

		let candHtml = "";
		if (anchor) {
			if (isSearch) {
				candHtml =
					candidates.length
						? `<div class="rapidSectionLabel">Search results</div>${otherCapped.map(renderRow).join("")}`
						: `<div class="small" style="padding:12px;">No results.</div>`;
			} else {
				const strongBlock = strong.length
					? `<div class="rapidSectionLabel rapidStrongLabel">Suggestions (${strong.length})</div><div class="rapidStrongGroup">${strong.map(renderRow).join("")}</div>`
					: `<div class="rapidSectionLabel rapidWeak">No strong suggestions</div><div class="rapidStrongEmpty">No confident matches for this item — check Other options below or skip with →.</div>`;
				const otherBlock = otherCapped.length
					? `<div class="rapidSectionLabel rapidOtherLabel">Other options</div><div class="rapidOtherGroup">${otherCapped.map(renderRow).join("")}</div>`
					: "";
				candHtml = `${strongBlock}<div class="rapidSplit" aria-hidden="true"></div>${otherBlock}`;
			}
		}

		const $anchor = document.getElementById("rapidAnchorCol");
		const $cands = document.getElementById("rapidCandCol");
		const accN = anchor
			? candidates.filter((c) => isPairStaged(anchorSkuStr, String(c.it.sku))).length
			: 0;
		if ($anchor)
			$anchor.innerHTML = `<div class="small rapidColLabel">Matching — ${esc(storeLabel || "All stores")}</div>${anchorHtml}${
				anchor
					? `<div class="rapidCommit small">${accN} staged for this item</div>`
					: ""
			}`;
		if ($cands) $cands.innerHTML = candHtml;
		renderHeader();
		wireCardClicks();
		// Thumb → item page (matches the manual #/link page). Wired on BOTH columns so the
		// anchor's image is clickable too; the cand-card click handler skips thumb clicks.
		wireThumbLinks($anchor);
		wireThumbLinks($cands);
	}

	function wireThumbLinks($root) {
		if (!$root) return;
		$root.querySelectorAll(".thumbInternalLink").forEach((el) => {
			el.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const sku = (el.getAttribute("data-sku") || "").trim();
				if (!sku) return;
				const u = new URL(location.href);
				u.hash = `#/item/${encodeURIComponent(sku)}`;
				window.open(u.toString(), "_blank", "noopener,noreferrer");
			});
		});
	}

	function wireCardClicks() {
		const $cands = document.getElementById("rapidCandCol");
		if (!$cands) return;
		$cands.querySelectorAll(".rapidIgnoreBtn").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const anchor = currentAnchor();
				const candSku = btn.getAttribute("data-sku");
				if (!anchor || !candSku) return;
				stageIgnorePair(String(anchor.sku), candSku);
			});
		});
		$cands.querySelectorAll(".rapidCard").forEach((el) => {
			el.addEventListener("click", (e) => {
				if (e.target.closest("a")) return;
				if (e.target.closest(".rapidIgnoreBtn")) return;
				if (e.target.closest(".thumbInternalLink")) return;
				const sku = el.getAttribute("data-sku");
				const i = candidates.findIndex((c) => String(c.it.sku) === sku);
				if (i < 0) return;
				highlight = i;
				togglePairStaged(i);
			});
		});
	}

	/* ---------------- shell ---------------- */

	const recovered = staged.length;
	$app.innerHTML = `
	<div class="container rapidContainer" style="max-width:1100px;">
		<div class="topbar">
			<a id="rapidBack" class="btn" href="${peekBack()}"><span class="backArrow">← </span>Back</a>
			<span class="badge">⚡ Rapid Linker</span>
			<select id="rapidStore" class="input" style="max-width:260px;">
				<option value="" ${storeLabel === ALL_STORES ? "selected" : ""}>All stores (${totalUnlinked})</option>
				${storeOptions
					.map(
						([lbl, n]) =>
							`<option value="${esc(lbl)}" ${lbl === storeLabel ? "selected" : ""}>${esc(lbl)} (${n})</option>`,
					)
					.join("")}
			</select>
			<span id="rapidProgress" class="badge mono"></span>
			<div style="flex:1"></div>
			<button id="rapidUndo" class="btn" style="padding:6px 10px;">↩ Undo</button>
			<button id="rapidFlush" class="btn" style="padding:6px 10px;">Save</button>
			<button id="rapidClear" class="btn" style="padding:6px 10px;">Clear</button>
			<a class="btn" href="#/link" style="padding:6px 10px;">Manual</a>
			<label id="rapidAiToggle" class="btn" title="Re-rank suggestions with the fine-tuned AI embedding. Off = classical scorer (sharp). On = embedding blend, with an 'AI ±x' chip showing how much it shifts each score." style="padding:6px 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
				<input type="checkbox" id="rapidAiChk" ${aiOn ? "checked" : ""} style="cursor:pointer;margin:0;" />🧠 AI embeddings
			</label>
		</div>

		<div class="card rapidStatsBar">
			<span><b id="rapidStaged">0</b> staged (unsaved)</span>
			<span class="rapidDot">·</span>
			<span><b id="rapidFlushed">0</b> saved this session</span>
			<span class="rapidDot">·</span>
			<span><b id="rapidSkipped">0</b> skipped</span>
			<span class="rapidDot">·</span>
			<span class="small">${localWrite ? "Local write → Save writes data/sku_links.json" : "Pages → Save stages a PR"}</span>
		</div>

		${
			recovered
				? `<div class="card rapidRecover" style="padding:10px;">${recovered} unflushed change(s) recovered from a previous session. <button id="rapidRecoverFlush" class="btn" style="padding:4px 10px;">Flush now</button> <button id="rapidRecoverDiscard" class="btn" style="padding:4px 10px;">Discard</button></div>`
				: ""
		}

		<div class="card" style="padding:10px; margin-bottom:10px;">
			<input id="rapidSearch" class="input" placeholder="/ to search a match by name / sku…" autocomplete="off" />
		</div>

		<div class="rapidGrid">
			<div id="rapidAnchorCol" class="rapidCol"></div>
			<div id="rapidCandCol" class="rapidCol"></div>
		</div>

		<div id="rapidStatus" class="small" style="margin-top:8px; min-height:1.2em;"></div>
		<div class="small rapidHelp">
			<b>← →</b> previous / next item · <b>↑ ↓</b> highlight · <b>Space</b> toggle link · <b>N</b> ignore · <b>Y</b> link∗ · <b>M</b> ignore∗ <span style="color:var(--muted)">(∗ = verified externally, excluded from training)</span>
		</div>
	</div>`;

	document.getElementById("rapidBack").addEventListener("click", (e) => {
		if (e.ctrlKey || e.metaKey || e.shiftKey) return;
		e.preventDefault();
		flush().finally(() => goBack());
	});

	$search = document.getElementById("rapidSearch");
	$search.addEventListener("input", () => {
		highlight = 0;
		render();
	});
	$search.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			$search.value = "";
			$search.blur();
			highlight = 0;
			render();
		}
		e.stopPropagation();
	});

	const $aiChk = document.getElementById("rapidAiChk");
	if ($aiChk) {
		$aiChk.addEventListener("change", async (e) => {
			aiOn = !!e.target.checked;
			setAiEnabled(aiOn);
			if (aiOn && !blend) {
				setStatus("Loading AI embeddings…");
				blend = await buildBlend(allAgg, BLEND_WEIGHTS_EMBED, BLEND_WEIGHTS_NOEMBED);
				await attachGbtGroup(blend);
			}
			worklist = buildWorklist();
			workIdx = 0;
			skipLinkedForward();
			highlight = 0;
			setStatus(
				aiOn
					? blend && blend.embeddings
						? "AI embeddings ON — suggestions re-ranked by the fine-tuned model (AI ±x shows its influence)."
						: "AI ON, but embeddings unavailable/mismatched — using the classical blend."
					: "AI embeddings OFF — classical scorer.",
			);
			render();
		});
	}

	document.getElementById("rapidStore").addEventListener("change", (e) => {
		storeLabel = e.target.value;
		try {
			localStorage.setItem(STORE_KEY, storeLabel);
		} catch {}
		worklist = buildWorklist();
		workIdx = 0;
		skipLinkedForward();
		highlight = 0;
		if ($search) $search.value = "";
		render();
	});

	document.getElementById("rapidUndo").addEventListener("click", () => undo());
	document.getElementById("rapidFlush").addEventListener("click", () => flush());
	document.getElementById("rapidClear").addEventListener("click", () => clearStaged());
	const $rf = document.getElementById("rapidRecoverFlush");
	if ($rf) $rf.addEventListener("click", () => flush().then(() => render()));
	const $rd = document.getElementById("rapidRecoverDiscard");
	if ($rd)
		$rd.addEventListener("click", () => {
			staged.length = 0;
			persistQueue();
			rebuildSession();
			document.querySelector(".rapidRecover")?.remove();
			render();
		});

	const rootEl = $app.querySelector(".rapidContainer");
	function onKey(e) {
		if (!document.body.contains(rootEl)) {
			document.removeEventListener("keydown", onKey);
			return;
		}
		if (e.target === $search) return; // search box handles its own keys
		if (e.key === " " || e.code === "Space") {
			e.preventDefault();
			if (candidates[highlight]) togglePairStaged(highlight);
		} else if (e.key === "y" || e.key === "Y") {
			e.preventDefault();
			if (candidates[highlight]) togglePairStaged(highlight, true);
		} else if (e.key === "n" || e.key === "N") {
			e.preventDefault();
			const anchor = currentAnchor();
			const cand = candidates[highlight];
			if (anchor && cand) stageIgnorePair(String(anchor.sku), String(cand.it.sku));
		} else if (e.key === "m" || e.key === "M") {
			e.preventDefault();
			const anchor = currentAnchor();
			const cand = candidates[highlight];
			if (anchor && cand) stageIgnorePair(String(anchor.sku), String(cand.it.sku), true);
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			highlight = Math.min(candidates.length - 1, highlight + 1);
			render(true);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlight = Math.max(0, highlight - 1);
			render(true);
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			if (workIdx < worklist.length - 1) {
				workIdx++;
				skipLinkedForward();
				highlight = 0;
				render();
			}
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			if (workIdx > 0) {
				workIdx = Math.max(0, workIdx - 1);
				highlight = 0;
				render();
			}
		}
	}
	document.addEventListener("keydown", onKey);
	window.addEventListener("beforeunload", () => {
		persistQueue();
	});

	render();
}
