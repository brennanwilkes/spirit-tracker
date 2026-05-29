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
import { recommendSimilar, dedupeByGroupRep } from "./linker_page/suggestions.js";
import { buildVocab } from "./linker_page/vocab.js";
import { STRONG_ABS_PROB, STRONG_REL_PROB } from "./linker_page/strong_threshold.js";
import { BLEND_WEIGHTS_EMBED, BLEND_WEIGHTS_NOEMBED } from "./linker_page/blend_weights.js";
import { loadSkuEmbeddings, makeEmbedCosFn } from "./linker_page/embeddings.js";

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

	// Learned-blend re-ranker. Embeddings are optional (LFS data-branch artifact); when
	// present we use the embed-trained weights + cosine, otherwise the no-embed weights
	// (correct calibration). Passed to every recommendSimilar call below.
	const skuEmb = await loadSkuEmbeddings();
	const blend = {
		weights: skuEmb ? BLEND_WEIGHTS_EMBED : BLEND_WEIGHTS_NOEMBED,
		embedCosFn: makeEmbedCosFn(skuEmb),
	};

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
		for (const op of staged) {
			if (op.type === "ignore") {
				const k = rules.canonicalPairKey(op.skuA, op.skuB);
				if (k) ignoredLocal.add(k);
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

	let storeLabel = (() => {
		try {
			return localStorage.getItem(STORE_KEY) || "";
		} catch {
			return "";
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
	if (!storeLabel || !storeCounts.has(storeLabel)) storeLabel = storeOptions[0] ? storeOptions[0][0] : "";

	// Two-pass sort:
	//   1) Fast pre-pass — term-index proxy (weightedOverlap against up to PROXY_K
	//      cross-store candidates that share a distinctive unigram). O(storeSize × K).
	//   2) Refine top REFINE_TOP_K by fast-score with the FULL recommendSimilar
	//      pipeline (includes size/price/abv/age penalties + top-term bonus).
	//   The top-K stay in their refined order; the long tail keeps fast-score order.
	const REFINE_TOP_K = 40;
	const PROXY_K = 6;

	function buildTermIndex() {
		const termIndex = new Map();
		for (const it of allAgg) {
			if (!it || isLinked(it.sku)) continue;
			if (it.stores && it.stores.has(storeLabel) && it.stores.size <= 1) continue;
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

	function refinedScore(it) {
		const scored = recommendSimilar(
			allAgg,
			it,
			1,
			String(it.sku),
			mappedSkus,
			isIgnoredPairLocal,
			sizePenaltyForPair,
			pricePenaltyForPair,
			sameStoreCanon,
			sameGroupLocal,
			{ vocab: simVocab, allowSameStore: true, withScores: true, blend },
		);
		return scored && scored[0] && scored[0].it ? scored[0].score || 0 : 0;
	}

	function buildWorklist() {
		const items = [];
		for (const it of allAgg) {
			if (!it || !it.stores || !it.stores.has(storeLabel)) continue;
			if (isLinked(it.sku)) continue;
			items.push(it);
		}

		const termIndex = buildTermIndex();
		const fast = new Map();
		for (const it of items) fast.set(it, fastScore(it, termIndex));

		const byFast = items.slice().sort((a, b) => (fast.get(b) || 0) - (fast.get(a) || 0));
		const refineSet = byFast.slice(0, REFINE_TOP_K);
		const refined = new Map();
		for (const it of refineSet) refined.set(it, refinedScore(it));

		items.sort((a, b) => {
			const ra = (refined.get(a) || 0) > 0;
			const rb = (refined.get(b) || 0) > 0;
			if (ra && rb) {
				const ds = (refined.get(b) || 0) - (refined.get(a) || 0);
				if (Math.abs(ds) > 1e-9) return ds;
			} else if (ra !== rb) {
				return ra ? -1 : 1;
			} else {
				const ds = (fast.get(b) || 0) - (fast.get(a) || 0);
				if (Math.abs(ds) > 1e-9) return ds;
			}
			const ea = (a.stores ? a.stores.size : 99) - (b.stores ? b.stores.size : 99);
			if (ea) return ea;
			return String(a.name || "").localeCompare(String(b.name || ""));
		});
		return items;
	}

	let worklist = buildWorklist();
	let workIdx = 0;
	let candidates = []; // [{ it, score, shared, sameStore }]
	let highlight = 0;

	// Per-pair staged-op references so Space can toggle a single (anchor,candidate)
	// link in/out of the staged queue. Key: `${anchorSku}|${candSku}` → array of op
	// objects pushed into `staged` (matched by reference for removal).
	const pairOps = new Map();
	const pairKey = (a, b) => `${String(a)}|${String(b)}`;
	function isPairStaged(anchorSku, candSku) {
		return pairOps.has(pairKey(anchorSku, candSku));
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
		let scored;
		if (tokens.length) {
			const aSku = String(anchor.sku);
			scored = allAgg
				.filter(
					(it) =>
						it &&
						String(it.sku) !== aSku &&
						!isLinked(it.sku) &&
						matchesAllTokens(it.searchText, tokens),
				)
				.slice(0, RECOMMEND_LIMIT)
				.map((it) => ({ it, score: simVocab.weightedOverlap(anchor.name || "", it.name || "").score }));
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
				{ vocab: simVocab, allowSameStore: true, withScores: true, groupRepFn: findRep, blend },
			).map((x) => (x && x.it ? x : { it: x, score: 0 }));
		}
		// Collapse candidates that already belong to one canonical group into a
		// single card (the search branch builds its own list and isn't routed
		// through recommendSimilar's dedup).
		scored = dedupeByGroupRep(scored, (x) => x.it && x.it.sku, findRep);
		return scored.map((x) => ({
			it: x.it,
			score: x.score || 0,
			shared: simVocab.weightedOverlap(anchor.name || "", x.it.name || "").shared,
			sameStore: sameStoreCanon(String(anchor.sku), String(x.it.sku)),
		}));
	}

	/* ---------------- actions ---------------- */

	function togglePairStaged(candIdx) {
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
			decisions.push({ kind: "unlink", anchorSku: a, candSku: b, ops: existing });
			persistQueue();
			rebuildSession();
			setStatus(`Unstaged link: "${anchor.name || a}" × "${cand.it.name || b}".`);
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
			ops.push({ type: "link", fromSku: from, toSku: preferred });
		}
		if (!ops.length) {
			setStatus("Nothing to link (already canonical).");
			return;
		}
		for (const op of ops) staged.push(op);
		pairOps.set(key, ops);
		decisions.push({ kind: "link", anchorSku: a, candSku: b, ops });
		persistQueue();
		actionsSinceFlush += 1;
		setStatus(`Staged link: "${anchor.name || a}" × "${cand.it.name || b}".`);
		render(true);
	}

	function stageIgnorePair(anchorSku, candSku) {
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
			render(true);
			return;
		}

		if (rules.isIgnoredPair(a, b)) {
			setStatus("Already ignored (from a previous session).");
			return;
		}

		const op = { type: "ignore", skuA: a, skuB: b };
		staged.push(op);
		decisions.push({ kind: "ignore", anchorSku: a, candSku: b, ops: [op] });
		persistQueue();
		rebuildSession();
		setStatus(`Staged ignore: ${displaySku(a)} × ${displaySku(b)}.`);
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
		} else if (d.kind === "unlink" && Array.isArray(d.ops)) {
			for (const op of d.ops) staged.push(op);
			pairOps.set(pairKey(d.anchorSku, d.candSku), d.ops);
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
		render();
	}

	function clearStaged() {
		if (!staged.length) {
			setStatus("Nothing staged to clear.");
			return;
		}
		const n = staged.length;
		staged.length = 0;
		decisions.length = 0;
		pairOps.clear();
		actionsSinceFlush = 0;
		persistQueue();
		rebuildSession();
		setStatus(`Cleared ${n} unsaved staged change(s).`);
		document.querySelector(".rapidRecover")?.remove();
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
					if (op.type === "link") await apiWriteSkuLink(op.fromSku, op.toSku);
					else await apiWriteSkuIgnore(op.skuA, op.skuB);
				}
			} else {
				for (const op of batch) {
					if (op.type === "link") addPendingLink(op.fromSku, op.toSku);
					else addPendingIgnore(op.skuA, op.skuB);
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
		const conf =
			o.pct != null
				? `<div class="rapidConf" title="match strength ${(o.score || 0).toFixed(2)}">
					<div class="rapidConfBar"><div class="rapidConfFill" style="width:${Math.round(Math.max(0.04, o.pct) * 100)}%"></div></div>
					<span class="rapidConfTxt">${confidenceLabel(o.pct)} ${(o.score || 0).toFixed(2)}</span>
				</div>`
				: "";
		const accBadge = o.candidate
			? `<span class="rapidAcc">${o.ignored ? "✕ ignored" : o.accepted ? "✓ linked" : "press to link"}</span>`
			: "";
		const ignoreBtn = o.candidate
			? `<button class="rapidIgnoreBtn ${o.ignored ? "rapidIgnoreBtnActive" : ""}" title="${o.ignored ? "Ignored — press N or click to un-ignore" : "Mark as 'do not suggest' (false positive) — shortcut: N"}" data-sku="${esc(String(it.sku))}">${o.ignored ? "↺ un-ignore" : "✕ ignore"}</button>`
			: "";

		return `
		<div class="rapidCard ${o.highlight ? "rapidHi" : ""} ${o.anchor ? "rapidAnchor" : ""} ${accClass}" data-sku="${esc(String(it.sku))}">
			${numHint}
			<div class="thumbBox">${renderThumbHtml(it.img)}</div>
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
				ignored: isPairIgnoredSession(anchorSkuStr, String(c.it.sku)),
				score: c.score,
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
			$anchor.innerHTML = `<div class="small rapidColLabel">Matching — ${esc(storeLabel)}</div>${anchorHtml}${
				anchor
					? `<div class="rapidCommit small">${accN} staged for this item</div>`
					: ""
			}`;
		if ($cands) $cands.innerHTML = candHtml;
		renderHeader();
		wireCardClicks();
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
			<b>← →</b> previous / next item · <b>↑ ↓</b> highlight · <b>Space</b> toggle link · <b>N</b> ignore
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
		} else if (e.key === "n" || e.key === "N") {
			e.preventDefault();
			const anchor = currentAnchor();
			const cand = candidates[highlight];
			if (anchor && cand) stageIgnorePair(String(anchor.sku), String(cand.it.sku));
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
