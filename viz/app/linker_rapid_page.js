// viz/app/linker_rapid_page.js
//
// Rapid anchor-store SKU linker. A keyboard-driven power tool for clearing the
// large backlog of unlinked SKUs created when new stores are added: pick a
// store, walk its unlinked items one at a time, and accept/reject the top
// suggestion with a single keypress. Decisions are staged in memory (mirrored
// to localStorage for crash-safety) and flushed to disk in a batch — there is
// no per-link page reload. The session keeps its own union-find overlay so a
// just-linked pair stops being suggested without re-fetching the catalog.

import { esc, renderThumbHtml } from "./dom.js";
import { goBack, peekBack } from "./nav.js";
import { displaySku, tokenizeQuery, matchesAllTokens } from "./sku.js";
import { loadIndex } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadHiddenSet } from "./hidden.js";
import { loadSkuRules } from "./mapping.js";
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
import { recommendSimilar } from "./linker_page/suggestions.js";
import { buildVocab } from "./linker_page/vocab.js";

const QUEUE_KEY = "stviz:linker_rapid_queue_v1";
const STORE_KEY = "stviz:linker_rapid_store_v1";
const AUTO_FLUSH_EVERY = 10;
const TOP_N = 8;

export async function renderSkuLinkerRapid($app) {
	const localWrite = isLocalWriteMode();
	const rules = await loadSkuRules();

	$app.innerHTML = `<div class="container" style="max-width:1100px;"><div class="small">Loading catalog…</div></div>`;

	const [idx, hiddenSet] = await Promise.all([loadIndex(), loadHiddenSet()]);
	const allRows = Array.isArray(idx.items) ? idx.items : [];
	const URL_BY_SKU_STORE = buildUrlBySkuStore(allRows);
	const allAgg = aggregateBySku(allRows, (x) => x, hiddenSet);
	const simVocab = buildVocab(allAgg);

	const meta = await loadSkuMetaBestEffort();

	const CANON_STORE_CACHE = buildCanonStoreCache(allAgg, rules);
	const sameStoreCanon = makeSameStoreCanonFn(rules, CANON_STORE_CACHE);
	const sizePenaltyForPair = buildSizePenaltyForPair({ allRows, allAgg, rules });
	const pricePenaltyForPair = buildPricePenaltyForPair({ allAgg, rules });

	const aggBySku = new Map();
	for (const it of allAgg) if (it && it.sku != null) aggBySku.set(String(it.sku), it);

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
	function isLinked(sku) {
		const s = String(sku || "");
		if (mappedSkus.has(s) || mappedSkus.has(baseCanon(s))) return true;
		if (linkedThisSession.has(s) || linkedThisSession.has(baseCanon(s))) return true;
		return false;
	}

	// Rebuild the DSU / ignore overlay from the staged ops (used after undo).
	function rebuildSession() {
		parent.clear();
		linkedThisSession.clear();
		ignoredLocal.clear();
		for (const op of staged) {
			if (op.type === "link") {
				unionLocal(op.fromSku, op.toSku);
				linkedThisSession.add(String(op.fromSku));
				linkedThisSession.add(String(op.toSku));
			} else if (op.type === "ignore") {
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

	function buildWorklist() {
		const out = [];
		for (const it of allAgg) {
			if (!it || !it.stores || !it.stores.has(storeLabel)) continue;
			if (isLinked(it.sku)) continue;
			out.push(it);
		}
		// exclusives (single-store) first, then by name
		out.sort((a, b) => {
			const ea = (a.stores ? a.stores.size : 99) - (b.stores ? b.stores.size : 99);
			if (ea) return ea;
			return String(a.name || "").localeCompare(String(b.name || ""));
		});
		return out;
	}

	let worklist = buildWorklist();
	let workIdx = 0;
	let candidates = [];
	let highlight = 0;
	let searchMode = false;

	function currentAnchor() {
		while (workIdx < worklist.length && isLinked(worklist[workIdx].sku)) workIdx++;
		return workIdx < worklist.length ? worklist[workIdx] : null;
	}

	function computeCandidates() {
		const anchor = currentAnchor();
		if (!anchor) return [];
		const q = String($search?.value || "").trim();
		const tokens = tokenizeQuery(q);
		let list;
		if (tokens.length) {
			const aSku = String(anchor.sku);
			list = allAgg
				.filter(
					(it) =>
						it &&
						String(it.sku) !== aSku &&
						!isLinked(it.sku) &&
						matchesAllTokens(it.searchText, tokens),
				)
				.slice(0, 12);
		} else {
			list = recommendSimilar(
				allAgg,
				anchor,
				TOP_N,
				"",
				mappedSkus,
				isIgnoredPairLocal,
				sizePenaltyForPair,
				pricePenaltyForPair,
				sameStoreCanon,
				sameGroupLocal,
				{ vocab: simVocab, allowSameStore: true },
			);
		}
		return list;
	}

	/* ---------------- actions ---------------- */

	function stageOps(ops, kind, anchorSku) {
		for (const op of ops) staged.push(op);
		decisions.push({ kind, anchorSku: String(anchorSku || ""), opCount: ops.length });
		persistQueue();
		actionsSinceFlush += 1;
		if (actionsSinceFlush >= AUTO_FLUSH_EVERY) flush();
	}

	function doLink(anchor, cand) {
		const a = String(anchor.sku);
		const b = String(cand.sku);
		if (!a || !b || a === b) return;
		const aCanon = baseCanon(a);
		const bCanon = baseCanon(b);
		const preferred = pickPreferredCanonical(allRows, [a, b, aCanon, bCanon]);
		if (!preferred) {
			setStatus("Could not choose a canonical SKU — skipped.");
			return;
		}
		const seen = new Set();
		const ops = [];
		for (const f of [aCanon, bCanon, a, b]) {
			const from = String(f || "");
			if (!from || from === preferred) continue;
			const key = `${from}→${preferred}`;
			if (seen.has(key)) continue;
			seen.add(key);
			ops.push({ type: "link", fromSku: from, toSku: preferred });
		}
		if (!ops.length) return;

		stageOps(ops, "link", a);
		unionLocal(a, b);
		linkedThisSession.add(a);
		linkedThisSession.add(b);
		linkedThisSession.add(aCanon);
		linkedThisSession.add(bCanon);
		advance();
	}

	function doIgnore(anchor, cand) {
		const a = String(anchor.sku);
		const b = String(cand.sku);
		if (!a || !b || a === b) return;
		stageOps([{ type: "ignore", skuA: a, skuB: b }], "ignore", a);
		const k = rules.canonicalPairKey(a, b);
		if (k) ignoredLocal.add(k);
		// stay on the same anchor; the ignored candidate drops out of suggestions
		render();
	}

	function doSkip() {
		const anchor = currentAnchor();
		decisions.push({ kind: "skip", anchorSku: anchor ? String(anchor.sku) : "", opCount: 0 });
		advance();
	}

	function advance() {
		workIdx++;
		render();
	}

	function undo() {
		const d = decisions.pop();
		if (!d) {
			setStatus("Nothing to undo.");
			return;
		}
		if (d.opCount > 0) staged.splice(staged.length - d.opCount, d.opCount);
		persistQueue();
		rebuildSession();
		// return to the anchor of the undone decision
		const targetIdx = worklist.findIndex((it) => String(it.sku) === d.anchorSku);
		if (targetIdx >= 0) workIdx = targetIdx;
		else if (d.kind !== "ignore") workIdx = Math.max(0, workIdx - 1);
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
			staged.length = 0;
			persistQueue();
			decisions.length = 0; // undo only within an unflushed batch
			actionsSinceFlush = 0;
			setStatus(localWrite ? `Flushed ${batch.length} change(s) to disk.` : `Staged ${batch.length} for PR.`);
			renderHeader();
		} catch (e) {
			setStatus(`Flush failed: ${String(e && e.message ? e.message : e)}. Changes still queued.`);
		}
	}

	/* ---------------- render ---------------- */

	function termLabel(term) {
		return term.startsWith("b:") ? term.slice(2).replace("~", " ") : term;
	}

	function cardHtml(it, opts) {
		const o = opts || {};
		const storeCount = it.stores ? it.stores.size : 0;
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
		const flags = [];
		if (o.sameStore) flags.push(`<span class="rapidFlag rapidFlagSame">same store</span>`);
		const meta = [chips, flags.join("")].filter(Boolean).join(" ");

		const numHint = o.num != null ? `<span class="rapidNum">${o.num}</span>` : "";
		return `
		<div class="rapidCard ${o.highlight ? "rapidHi" : ""} ${o.anchor ? "rapidAnchor" : ""}" data-sku="${esc(String(it.sku))}">
			${numHint}
			<div class="thumbBox">${renderThumbHtml(it.img)}</div>
			<div class="rapidBody">
				<div class="rapidName">${esc(it.name || "(no name)")}</div>
				<div class="rapidLine">${storeHtml}<span class="price">${esc(price)}</span><span class="badge mono">${esc(displaySku(it.sku))}</span>${o.score != null ? `<span class="rapidScore">${o.score.toFixed(2)}</span>` : ""}</div>
				${meta ? `<div class="rapidMeta">${meta}</div>` : ""}
			</div>
		</div>`;
	}

	function renderHeader() {
		const $count = document.getElementById("rapidStaged");
		if ($count) $count.textContent = staged.length ? `${staged.length} staged` : "0 staged";
		const $prog = document.getElementById("rapidProgress");
		if ($prog) {
			const remaining = worklist.length - workIdx;
			$prog.textContent = `${Math.min(workIdx + 1, worklist.length)} / ${worklist.length} (${Math.max(0, remaining)} left)`;
		}
	}

	function setStatus(msg) {
		const $s = document.getElementById("rapidStatus");
		if ($s) $s.textContent = msg || "";
	}

	let $search = null;

	function render() {
		const anchor = currentAnchor();
		candidates = anchor ? computeCandidates() : [];
		if (highlight >= candidates.length) highlight = candidates.length ? candidates.length - 1 : 0;
		if (highlight < 0) highlight = 0;

		const anchorHtml = anchor
			? cardHtml(anchor, { anchor: true })
			: `<div class="rapidDone">✓ No more unlinked items for this store.</div>`;

		const candHtml = candidates.length
			? candidates
					.map((it, i) => {
						const wo = simVocab.weightedOverlap(anchor.name || "", it.name || "");
						return cardHtml(it, {
							num: i + 1,
							highlight: i === highlight,
							score: undefined,
							shared: wo.shared,
							sameStore: sameStoreCanon(String(anchor.sku), String(it.sku)),
						});
					})
					.join("")
			: anchor
				? `<div class="small" style="padding:12px;">No suggestions. Use search (/) to find a match, or press N to skip.</div>`
				: "";

		const $anchor = document.getElementById("rapidAnchorCol");
		const $cands = document.getElementById("rapidCandCol");
		if ($anchor) $anchor.innerHTML = `<div class="small rapidColLabel">Anchor — ${esc(storeLabel)}</div>${anchorHtml}`;
		if ($cands) $cands.innerHTML = candHtml;
		renderHeader();
		wireCardClicks();
	}

	function wireCardClicks() {
		const $cands = document.getElementById("rapidCandCol");
		if (!$cands) return;
		$cands.querySelectorAll(".rapidCard").forEach((el, i) => {
			el.addEventListener("click", (e) => {
				if (e.target.closest("a")) return;
				highlight = i;
				const anchor = currentAnchor();
				if (anchor && candidates[i]) doLink(anchor, candidates[i]);
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
			<span id="rapidStaged" class="badge mono"></span>
			<button id="rapidFlush" class="btn">Flush</button>
			<a class="btn" href="#/link" style="padding:6px 10px;">Manual</a>
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
			<b>Y</b>/<b>Enter</b> link · <b>N</b>/<b>→</b> skip · <b>X</b> ignore pair · <b>1–9</b> pick · <b>↑/↓</b> move · <b>U</b> undo · <b>/</b> search · <b>F</b> flush
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
		} else if (e.key === "Enter") {
			e.preventDefault();
			const anchor = currentAnchor();
			if (anchor && candidates[highlight]) doLink(anchor, candidates[highlight]);
			$search.blur();
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
		highlight = 0;
		if ($search) $search.value = "";
		render();
	});

	document.getElementById("rapidFlush").addEventListener("click", () => flush());
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
		const anchor = currentAnchor();
		const k = e.key.toLowerCase();
		if (k === "y" || e.key === "Enter") {
			e.preventDefault();
			if (anchor && candidates[highlight]) doLink(anchor, candidates[highlight]);
		} else if (k === "n" || e.key === "ArrowRight") {
			e.preventDefault();
			doSkip();
		} else if (k === "x") {
			e.preventDefault();
			if (anchor && candidates[highlight]) doIgnore(anchor, candidates[highlight]);
		} else if (k === "u") {
			e.preventDefault();
			undo();
		} else if (k === "f") {
			e.preventDefault();
			flush();
		} else if (e.key === "/") {
			e.preventDefault();
			$search.focus();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			highlight = Math.min(candidates.length - 1, highlight + 1);
			render();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			highlight = Math.max(0, highlight - 1);
			render();
		} else if (/^[1-9]$/.test(e.key)) {
			const n = parseInt(e.key, 10) - 1;
			if (n < candidates.length) {
				highlight = n;
				render();
			}
		}
	}
	document.addEventListener("keydown", onKey);
	window.addEventListener("beforeunload", () => {
		// localStorage mirror is the durable safety net; nothing else needed.
		persistQueue();
	});

	render();
}
