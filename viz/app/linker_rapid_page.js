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
const RECOMMEND_LIMIT = 14;
const STRONG_ABS = 1.5; // absolute score floor to count as a strong "Suggestion"
const STRONG_REL = 0.15; // …and at least this fraction of the top score
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

	// Cheap "likely has a strong match" signal: rarity (idf) of the item's most
	// distinctive term. Items whose top term is rare (a unique distillery /
	// expression) tend to have clear, strong matches → surface them first.
	function anchorStrength(it) {
		const t = simVocab.topTerm(it.name || "");
		return t ? t.idf : 0;
	}

	function buildWorklist() {
		const out = [];
		for (const it of allAgg) {
			if (!it || !it.stores || !it.stores.has(storeLabel)) continue;
			if (isLinked(it.sku)) continue;
			out.push(it);
		}
		out.sort((a, b) => {
			const ds = anchorStrength(b) - anchorStrength(a);
			if (Math.abs(ds) > 1e-9) return ds;
			const ea = (a.stores ? a.stores.size : 99) - (b.stores ? b.stores.size : 99);
			if (ea) return ea;
			return String(a.name || "").localeCompare(String(b.name || ""));
		});
		return out;
	}

	let worklist = buildWorklist();
	let workIdx = 0;
	let candidates = []; // [{ it, score, shared, sameStore }]
	let highlight = 0;
	const accepted = new Set(); // candidate skus accepted for the CURRENT anchor

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
				isIgnoredPairLocal,
				sizePenaltyForPair,
				pricePenaltyForPair,
				sameStoreCanon,
				sameGroupLocal,
				{ vocab: simVocab, allowSameStore: true, withScores: true },
			).map((x) => (x && x.it ? x : { it: x, score: 0 }));
		}
		return scored.map((x) => ({
			it: x.it,
			score: x.score || 0,
			shared: simVocab.weightedOverlap(anchor.name || "", x.it.name || "").shared,
			sameStore: sameStoreCanon(String(anchor.sku), String(x.it.sku)),
		}));
	}

	/* ---------------- actions ---------------- */

	function stageOps(ops, kind, anchorSku) {
		for (const op of ops) staged.push(op);
		decisions.push({ kind, anchorSku: String(anchorSku || ""), opCount: ops.length });
		persistQueue();
		actionsSinceFlush += 1;
		if (actionsSinceFlush >= AUTO_FLUSH_EVERY) flush();
	}

	function commitAndAdvance() {
		const anchor = currentAnchor();
		if (!anchor) return;
		const accs = candidates.filter((c) => accepted.has(String(c.it.sku)));
		if (!accs.length) {
			skippedCount += 1;
			decisions.push({ kind: "skip", anchorSku: String(anchor.sku), opCount: 0 });
			advance();
			return;
		}
		const a = String(anchor.sku);
		const skus = [a, ...accs.map((c) => String(c.it.sku))];
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
			const key = `${from}→${preferred}`;
			if (seen.has(key)) continue;
			seen.add(key);
			ops.push({ type: "link", fromSku: from, toSku: preferred });
		}
		if (ops.length) {
			stageOps(ops, "link", a);
			for (const s of skus) unionLocal(s, preferred);
			for (const s of [...skus, ...canons]) linkedThisSession.add(s);
			setStatus(`Linked ${accs.length} match(es) to "${anchor.name || a}".`);
		}
		advance();
	}

	function doIgnore() {
		const anchor = currentAnchor();
		const cand = candidates[highlight];
		if (!anchor || !cand) return;
		const a = String(anchor.sku);
		const b = String(cand.it.sku);
		if (!a || !b || a === b) return;
		accepted.delete(b);
		stageOps([{ type: "ignore", skuA: a, skuB: b }], "ignore", a);
		const k = rules.canonicalPairKey(a, b);
		if (k) ignoredLocal.add(k);
		render(); // candidate drops out of suggestions; stay on anchor
	}

	function advance() {
		accepted.clear();
		highlight = 0;
		workIdx++;
		skipLinkedForward();
		render();
	}

	function undo() {
		const d = decisions.pop();
		if (!d) {
			setStatus("Nothing to undo.");
			return;
		}
		if (d.opCount > 0) staged.splice(staged.length - d.opCount, d.opCount);
		else if (d.kind === "skip") skippedCount = Math.max(0, skippedCount - 1);
		persistQueue();
		rebuildSession();
		const targetIdx = worklist.findIndex((it) => String(it.sku) === d.anchorSku);
		if (targetIdx >= 0) workIdx = targetIdx;
		else if (d.kind !== "ignore") workIdx = Math.max(0, workIdx - 1);
		accepted.clear();
		highlight = 0;
		render();
	}

	function clearStaged() {
		if (!staged.length) {
			setStatus("Nothing staged to clear.");
			return;
		}
		if (!window.confirm(`Discard ${staged.length} unsaved staged change(s)? This cannot be undone.`))
			return;
		staged.length = 0;
		decisions.length = 0;
		actionsSinceFlush = 0;
		persistQueue();
		rebuildSession();
		setStatus("Cleared all unsaved staged changes.");
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
			staged.length = 0;
			persistQueue();
			decisions.length = 0; // undo only within an unflushed batch
			actionsSinceFlush = 0;
			savedThisSession += batch.length;
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
		const flags = o.sameStore ? `<span class="rapidFlag rapidFlagSame">same store</span>` : "";
		const meta = [chips, flags].filter(Boolean).join(" ");

		const numHint = o.num != null ? `<span class="rapidNum">${o.num}</span>` : "";
		const accClass = o.accepted ? "rapidAccepted" : "";
		const conf =
			o.pct != null
				? `<div class="rapidConf" title="match strength ${(o.score || 0).toFixed(2)}">
					<div class="rapidConfBar"><div class="rapidConfFill" style="width:${Math.round(Math.max(0.04, o.pct) * 100)}%"></div></div>
					<span class="rapidConfTxt">${confidenceLabel(o.pct)} ${(o.score || 0).toFixed(2)}</span>
				</div>`
				: "";
		const accBadge = o.candidate
			? `<span class="rapidAcc">${o.accepted ? "✓ linked" : "press to link"}</span>`
			: "";

		return `
		<div class="rapidCard ${o.highlight ? "rapidHi" : ""} ${o.anchor ? "rapidAnchor" : ""} ${accClass}" data-sku="${esc(String(it.sku))}">
			${numHint}
			<div class="thumbBox">${renderThumbHtml(it.img)}</div>
			<div class="rapidBody">
				<div class="rapidName">${esc(it.name || "(no name)")}</div>
				<div class="rapidLine">${storeHtml}<span class="price">${esc(price)}</span><span class="badge mono">${esc(displaySku(it.sku))}</span>${accBadge}</div>
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

	function render() {
		const anchor = currentAnchor();
		candidates = anchor ? computeCandidates() : [];
		if (highlight >= candidates.length) highlight = candidates.length ? candidates.length - 1 : 0;
		if (highlight < 0) highlight = 0;

		const topScore = candidates.length ? Math.max(...candidates.map((c) => c.score)) : 0;
		const isSearch = !!String($search?.value || "").trim();

		// Adaptive split: a "Suggestion" is a candidate that's strong both
		// absolutely and relative to the best — so the count flexes with quality.
		const cutoff = Math.max(STRONG_ABS, STRONG_REL * topScore);
		const strong = [];
		const other = [];
		candidates.forEach((c, i) => {
			const row = { ...c, idx: i };
			if (!isSearch && c.score >= cutoff && strong.length < MAX_SUGGEST) strong.push(row);
			else other.push(row);
		});
		const otherCapped = other.slice(0, MAX_OTHER);

		const renderRow = (c) =>
			cardHtml(c.it, {
				num: c.idx + 1,
				candidate: true,
				highlight: c.idx === highlight,
				accepted: accepted.has(String(c.it.sku)),
				score: c.score,
				pct: topScore > 0 ? c.score / topScore : 0,
				shared: c.shared,
				sameStore: c.sameStore,
			});

		const anchorHtml = anchor
			? cardHtml(anchor, { anchor: true })
			: `<div class="rapidDone">✓ No more unlinked items for this store. Pick another store, or Flush.</div>`;

		let candHtml = "";
		if (anchor) {
			if (isSearch) {
				candHtml =
					candidates.length
						? `<div class="rapidSectionLabel">Search results</div>${otherCapped.map(renderRow).join("")}`
						: `<div class="small" style="padding:12px;">No results.</div>`;
			} else {
				candHtml =
					(strong.length
						? `<div class="rapidSectionLabel">Suggestions (${strong.length}) — accept all that match</div>${strong.map(renderRow).join("")}`
						: `<div class="rapidSectionLabel rapidWeak">No strong suggestions — check Other options or search (/)</div>`) +
					(otherCapped.length
						? `<div class="rapidSectionLabel rapidOtherLabel">Other options</div>${otherCapped.map(renderRow).join("")}`
						: "");
			}
		}

		const $anchor = document.getElementById("rapidAnchorCol");
		const $cands = document.getElementById("rapidCandCol");
		const accN = anchor ? candidates.filter((c) => accepted.has(String(c.it.sku))).length : 0;
		if ($anchor)
			$anchor.innerHTML = `<div class="small rapidColLabel">Matching — ${esc(storeLabel)}</div>${anchorHtml}${
				anchor
					? `<div class="rapidCommit small">${accN} accepted · <b>Enter</b> to link &amp; next</div>`
					: ""
			}`;
		if ($cands) $cands.innerHTML = candHtml;
		renderHeader();
		wireCardClicks();
	}

	function toggleAccept(i) {
		const c = candidates[i];
		if (!c) return;
		const sku = String(c.it.sku);
		if (accepted.has(sku)) accepted.delete(sku);
		else accepted.add(sku);
	}

	function wireCardClicks() {
		const $cands = document.getElementById("rapidCandCol");
		if (!$cands) return;
		$cands.querySelectorAll(".rapidCard").forEach((el) => {
			el.addEventListener("click", (e) => {
				if (e.target.closest("a")) return;
				const sku = el.getAttribute("data-sku");
				const i = candidates.findIndex((c) => String(c.it.sku) === sku);
				if (i < 0) return;
				highlight = i;
				toggleAccept(i);
				render();
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
			<button id="rapidFlush" class="btn" style="padding:6px 10px;">Flush</button>
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
			<span class="small">${localWrite ? "Local write → Flush writes data/sku_links.json" : "Pages → Flush stages a PR"}</span>
		</div>

		${
			recovered
				? `<div class="card rapidRecover" style="padding:10px;">${recovered} unflushed change(s) recovered from a previous session. <button id="rapidRecoverFlush" class="btn" style="padding:4px 10px;">Flush now</button> <button id="rapidRecoverDiscard" class="btn" style="padding:4px 10px;">Discard</button></div>`
				: ""
		}

		<details class="card rapidInstr">
			<summary>How the rapid linker works (click to expand)</summary>
			<div class="rapidInstrBody">
				<p>Pick a store above; you walk its <b>unlinked</b> items one at a time, <b>strongest-matchable first</b>. The current item is shown at the top ("Matching"). Below it, the best cross-store matches are split into <b>Suggestions</b> (strong — the count varies with how good the matches are) and <b>Other options</b> (weaker). Each shows a <b>strength</b> bar + score and the <b>distinctive terms</b> that drove the match (e.g. distillery/expression). Same-store duplicates are flagged.</p>
				<p>One item can match <b>several</b> listings — accept all that apply, then commit:</p>
				<ul>
					<li><b>Y</b> / <b>Space</b> — toggle the highlighted candidate as a match (moves down)</li>
					<li><b>1–9</b> — toggle that candidate · click a card — toggle it</li>
					<li><b>↑ / ↓</b> — move highlight</li>
					<li><b>Enter</b> / <b>→</b> — link <i>all accepted</i> to this item &amp; go to next (with none accepted = skip)</li>
					<li><b>X</b> — mark the highlighted pair "do not suggest" (stays on item)</li>
					<li><b>/</b> — search to find a match manually · <b>U</b> — undo · <b>F</b> — flush</li>
				</ul>
				<p><b>Caching &amp; safety:</b> every action is <b>staged</b> in memory and mirrored to your browser immediately, so a crash/reload won't lose it. Staged changes are written to disk in a batch — automatically every ${AUTO_FLUSH_EVERY} actions, on <b>Flush</b>, or when you leave. The counters above show <b>staged (unsaved)</b>, <b>saved this session</b>, and <b>skipped</b>. <b>Undo</b> reverts the last action (within the current unflushed batch). <b>Clear</b> discards all currently-staged unsaved changes — it cannot remove changes already flushed to disk.</p>
			</div>
		</details>

		<div class="card" style="padding:10px; margin-bottom:10px;">
			<input id="rapidSearch" class="input" placeholder="/ to search a match by name / sku…" autocomplete="off" />
		</div>

		<div class="rapidGrid">
			<div id="rapidAnchorCol" class="rapidCol"></div>
			<div id="rapidCandCol" class="rapidCol"></div>
		</div>

		<div id="rapidStatus" class="small" style="margin-top:8px; min-height:1.2em;"></div>
		<div class="small rapidHelp">
			<b>Y</b>/<b>Space</b> accept · <b>1–9</b> toggle · <b>↑/↓</b> move · <b>Enter</b>/<b>→</b> link accepted &amp; next · <b>X</b> ignore · <b>/</b> search · <b>U</b> undo · <b>F</b> flush
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
			if (candidates[highlight]) {
				toggleAccept(highlight);
				render();
			}
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
		accepted.clear();
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
		const k = e.key.toLowerCase();
		if (k === "y" || e.key === " " || e.code === "Space") {
			e.preventDefault();
			if (candidates[highlight]) {
				toggleAccept(highlight);
				highlight = Math.min(candidates.length - 1, highlight + 1);
				render();
			}
		} else if (e.key === "Enter" || e.key === "ArrowRight") {
			e.preventDefault();
			commitAndAdvance();
		} else if (k === "x") {
			e.preventDefault();
			doIgnore();
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
				toggleAccept(n);
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
