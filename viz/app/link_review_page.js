// viz/app/link_review_page.js
//
// #/link-review — audit surface for the auto-link classifier (tools/auto_link_classify.mjs).
// Two kinds of rows, interleaved newest-first (by the most recent firstSeenAt across each
// item's raw listings):
//
//   1. PENDING auto-links — links in sku_links.json carrying status:"pending". Rendered as the
//      TWO separate SKUs side-by-side (NOT collapsed into one listing, unlike the rest of the
//      app) so the human sees exactly what the classifier joined. Approve drops the pending
//      annotation in place (it was already a real link); Reject deletes it AND records an ignore.
//      Either way the system already treated it as real (catalog + email) — review is an audit.
//
//   2. ORPHAN SKUs — aggregates with NO links of any kind: canonical group of size 1 AND present
//      at a single store (so no implicit same-raw-SKU cross-store link either). For each we run
//      the live ranker and offer its top candidates to Link (or Ignore / Skip).
//
// Local-write only (mutations go through viz/serve.js), like the other linker pages.

import { esc, renderThumbHtml } from "./dom.js";
import { peekBack } from "./nav.js";
import { displaySku } from "./sku.js";
import { loadIndex } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadHiddenSet } from "./hidden.js";
import { loadSkuRules, clearSkuRulesCache } from "./mapping.js";
import {
	isLocalWriteMode,
	apiWriteSkuLink,
	apiWriteSkuIgnore,
	apiConfirmSkuLink,
	apiRejectSkuLink,
	apiGetReviewWatermark,
} from "./api.js";
import { normalizeImplicitSkuKey } from "./sku_canonical.js";
import { buildUrlBySkuStore } from "./linker_page/url_map.js";
import { buildSizePenaltyForPair } from "./linker_page/size.js";
import { buildPricePenaltyForPair } from "./linker_page/price.js";
import { buildCanonStoreCache, makeSameStoreCanonFn } from "./linker_page/store_cache.js";
import { recommendSimilar } from "./linker_page/suggestions.js";
import { toConfidence01 } from "./linker_page/blend.js";
import { buildVocab } from "./linker_page/vocab.js";
import { buildBlend } from "./linker_page/embeddings.js";
import { loadGbtModel } from "./linker_page/gbt.js";
import { buildGroupIndex } from "./linker_page/group_features.js";
import { BLEND_WEIGHTS_EMBED, BLEND_WEIGHTS_NOEMBED } from "./linker_page/blend_weights.js";

const PAGE_SIZE = 20; // rows materialized per chunk (orphan candidates are scored lazily per chunk)
const ORPHAN_CANDIDATES = 5;

export async function renderSkuLinkReview($app) {
	const localWrite = isLocalWriteMode();
	const rules = await loadSkuRules();

	$app.innerHTML = `<div class="container" style="max-width:1100px;"><div class="small">Loading catalog…</div></div>`;

	const [idx, hiddenSet] = await Promise.all([loadIndex(), loadHiddenSet()]);
	const allRows = Array.isArray(idx.items) ? idx.items : [];
	const allAgg = aggregateBySku(allRows, (x) => x, hiddenSet);

	const bySku = new Map();
	for (const it of allAgg) bySku.set(String(it.sku), it);
	// Per-(sku, store) product URL — so a card's store label links to THAT store's page, not the
	// arbitrary first URL seen during aggregation (which can belong to a different store).
	const URL_BY_SKU_STORE = buildUrlBySkuStore(allRows);
	// Stored link skus come from the tracker/classifier raw SKU space (e.g. "id:123"); the catalog
	// keys by keySkuForRow ("000123"). normalizeImplicitSkuKey bridges the id: form; fall back to raw.
	const resolveAgg = (s) => {
		const raw = String(s || "");
		return bySku.get(raw) || bySku.get(normalizeImplicitSkuKey(raw)) || null;
	};

	// Recency: most recent firstSeenAt across an aggregate's raw listings (newest-added first).
	const recencyBySku = (() => {
		const m = new Map();
		for (const r of allRows) {
			const k = normalizeImplicitSkuKey(r?.sku);
			if (!k) continue;
			const t = Date.parse(r?.firstSeenAt || r?.updatedAt || "") || 0;
			const cur = m.get(k);
			if (cur === undefined || t > cur) m.set(k, t);
		}
		return m;
	})();
	const recencyOf = (sku) => recencyBySku.get(normalizeImplicitSkuKey(sku)) || 0;

	// Live ranker context (blend ON — embeddings help orphan suggestions; GBT works without them).
	const vocab = buildVocab(allAgg);
	const sizePenaltyForPair = buildSizePenaltyForPair({ allRows, allAgg, rules });
	const pricePenaltyForPair = buildPricePenaltyForPair({ allAgg, rules });
	const sameStoreCanon = makeSameStoreCanonFn(rules, buildCanonStoreCache(allAgg, rules));
	const isIgnoredPair = (a, b) => rules.isIgnoredPair(a, b);
	const sameGroup = (a, b) => String(rules.canonicalSku(a)) === String(rules.canonicalSku(b));

	let blend = await buildBlend(allAgg, BLEND_WEIGHTS_EMBED, BLEND_WEIGHTS_NOEMBED);
	if (blend) {
		if (blend.gbt === undefined) blend.gbt = await loadGbtModel();
		if (!blend.groupIndex) blend.groupIndex = buildGroupIndex(allAgg, (s) => String(rules.canonicalSku(s) || s));
	}
	const blended = !!(blend && (blend.weights || blend.gbt));

	/* ---------------- review watermark ---------------- */

	// The "I've already reviewed up to here" line: the last time sku_links.json was hand-committed
	// (a human review/curation session), from git — NOT a scrape commit. The normal queue shows
	// only recommendations that APPEARED after this; everything older is considered handled (you
	// saw it last session — whether you acted on it or just scrolled past — and a hand-commit drew
	// the line). The audit view drops the filter to revisit the older ones. 0 = no prior hand
	// commit (or read-only Pages, where git isn't reachable) → show everything.
	let watermark = 0;
	let dirty = false;
	if (localWrite) {
		try {
			const w = await apiGetReviewWatermark();
			watermark = w.watermark || 0;
			dirty = w.dirty;
		} catch {
			watermark = 0;
		}
	}
	let auditMode = false;

	/* ---------------- build the candidate rows ---------------- */

	// Pending auto-links. Appearance time = link creation `ts` (when the classifier proposed it),
	// NOT SKU recency — a newly-proposed link between two OLD SKUs is still "new to review".
	const candidateRows = [];
	for (const l of Array.isArray(rules.links) ? rules.links : []) {
		if (!l || l.status !== "pending") continue;
		const a = resolveAgg(l.fromSku);
		const b = resolveAgg(l.toSku);
		if (!a || !b) continue; // a side fell out of the catalog (delisted) — skip from the queue
		const fromSku = String(l.fromSku);
		const toSku = String(l.toSku);
		candidateRows.push({
			kind: "pending",
			fromSku,
			toSku,
			a,
			b,
			confidence: typeof l.confidence === "number" ? l.confidence : null,
			appearance: Date.parse(l.ts) || Math.max(recencyOf(fromSku), recencyOf(toSku)),
		});
	}

	// Orphan SKUs: no link of any kind (group size 1) AND single-store (no implicit cross-store
	// link). Appearance time = SKU first-seen recency.
	for (const it of allAgg) {
		const sku = String(it.sku || "");
		if (!sku) continue;
		if ((it.stores ? it.stores.size : 0) > 1) continue; // implicit cross-store link → has links → skip
		const group = rules.groupForCanonical(rules.canonicalSku(sku));
		if (group && group.size > 1) continue; // explicit link → skip
		candidateRows.push({ kind: "orphan", sku, it, appearance: recencyOf(sku) });
	}

	// Normal view: only recommendations newer than the watermark. Audit view: only the older
	// (previously-handled) ones, so they can be revisited.
	const visibleNow = (row) => (auditMode ? row.appearance <= watermark : row.appearance > watermark);
	const olderPresent = candidateRows.filter((r) => r.appearance <= watermark).length;
	const buildFeed = () => candidateRows.filter(visibleNow).sort((x, y) => y.appearance - x.appearance);

	let feed = buildFeed();
	let shown = 0;

	/* ---------------- render shell ---------------- */

	const roNotice = localWrite
		? dirty
			? `<div class="reviewNotice reviewDirty">Uncommitted review edits to <span class="mono">data/sku_links.json</span> — commit by hand to advance the review line (the next load will then show only what's newer).</div>`
			: ""
		: `<div class="reviewNotice">Read-only — Approve/Reject need the local dev server (<span class="mono">node viz/serve.js</span>).</div>`;

	$app.innerHTML = `
    <div class="container" style="max-width:1100px;">
      <div class="topbar">
        <a id="back" class="btn" href="${peekBack()}"><span class="backArrow">← </span>Back</a>
        <div style="flex:1"></div>
        <a class="btn" href="#/link" style="padding:6px 10px;">SKU Linker</a>
        <a class="btn" href="#/link-rapid" style="padding:6px 10px;">⚡ Rapid</a>
        ${
					olderPresent
						? `<button id="auditToggle" class="btn" style="padding:6px 10px;" title="Revisit older recommendations from before your last review commit">🔍 Audit (${olderPresent})</button>`
						: ""
				}
        <span class="badge">Review</span>
      </div>
      <h2 class="reviewTitle">Auto-link review</h2>
      <div id="reviewSummary" class="small reviewSummary"></div>
      ${roNotice}
      <div id="reviewList" class="reviewList"></div>
      <div class="reviewMore">
        <div id="reviewSentinel" aria-hidden="true"></div>
        <span id="reviewDone" class="small" style="display:none;">— end of queue · all caught up —</span>
      </div>
    </div>`;

	const $list = $app.querySelector("#reviewList");
	const $sentinel = $app.querySelector("#reviewSentinel");
	const $done = $app.querySelector("#reviewDone");
	const $summary = $app.querySelector("#reviewSummary");
	const $auditToggle = $app.querySelector("#auditToggle");

	const classicalBadge = blended
		? ""
		: `<span class="badge" title="GBT/embedding blend unavailable — using classical scores">classical</span>`;

	function updateSummary() {
		const p = feed.filter((r) => r.kind === "pending").length;
		const o = feed.filter((r) => r.kind === "orphan").length;
		const counts = `${p} pending auto-link${p === 1 ? "" : "s"} · ${o} unlinked SKU${o === 1 ? "" : "s"}`;
		const since = watermark
			? `new since last review (${esc(new Date(watermark).toLocaleString())})`
			: "all items (no prior review commit)";
		$summary.innerHTML = auditMode
			? `<strong>Audit view</strong> — ${counts} from before your last review ${classicalBadge}`
			: `${counts} new to review · ${since}${olderPresent ? ` · ${olderPresent} older held for audit` : ""} ${classicalBadge}`;
	}

	/* ---------------- card helpers ---------------- */

	// Choose the store to display and the URL that BELONGS to it. Prefer the cheapest store (it
	// matches the price shown); use that store's own product URL. Fall back to any store that has a
	// URL so the label and link always refer to the same store (never a cross-store mismatch).
	function pickStoreAndUrl(it) {
		const sku = String(it?.sku || "");
		const byStore = URL_BY_SKU_STORE.get(sku) || null;
		const cheapest = it?.cheapestStoreLabel || "";
		if (cheapest) {
			return { store: cheapest, url: (byStore && byStore.get(cheapest)) || "" };
		}
		if (byStore && byStore.size) {
			const [store, url] = [...byStore.entries()][0];
			return { store, url };
		}
		const anyStore = it?.stores && it.stores.size ? [...it.stores][0] : "";
		return { store: anyStore, url: "" };
	}

	function miniCardHtml(it) {
		const sku = String(it?.sku || "");
		const name = String(it?.name || "(no name)");
		const { store, url } = pickStoreAndUrl(it); // store label + its OWN product URL (consistent)
		const price = it?.cheapestPriceStr || "";
		const itemHref = sku ? `#/item/${encodeURIComponent(sku)}` : ""; // viz item detail page
		// Image → item detail page; store label → product URL; SKU badge → product URL. Open in new
		// tabs (target=_blank) so a click never loses the review queue / a half-finished decision.
		const thumb = renderThumbHtml(it?.img || "", "thumb");
		const thumbEl = itemHref
			? `<a href="${esc(itemHref)}" target="_blank" rel="noopener noreferrer">${thumb}</a>`
			: thumb;
		const storeEl = store
			? url
				? `<a class="itemStore" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(store)}</a>`
				: `<span class="itemStore">${esc(store)}</span>`
			: "";
		const skuBadge = url
			? `<a class="badge mono skuLink" target="_blank" rel="noopener noreferrer" href="${esc(url)}">${esc(displaySku(sku))}</a>`
			: `<span class="badge mono">${esc(displaySku(sku))}</span>`;
		return `
      <div class="rvCard">
        <div class="rvThumb">${thumbEl}</div>
        <div class="rvBody">
          <div class="rvName">${esc(name)}</div>
          <div class="rvMeta">
            ${storeEl}
            ${price ? `<span class="price">${esc(price)}</span>` : ""}
            ${skuBadge}
          </div>
        </div>
      </div>`;
	}

	function confBadge(score, isProb) {
		if (score == null) return "";
		const v = isProb ? score : toConfidence01(score);
		return `<span class="badge mono" title="classifier confidence">${(v * 100).toFixed(0)}%</span>`;
	}

	function pendingRowHtml(row) {
		const disabled = localWrite ? "" : "disabled";
		return `
      <div class="reviewRow pendingRow" data-kind="pending" data-from="${esc(row.fromSku)}" data-to="${esc(row.toSku)}">
        <div class="rvPair">
          ${miniCardHtml(row.a)}
          <span class="rvLinkGlyph" title="auto-linked">🔗</span>
          ${miniCardHtml(row.b)}
        </div>
        <div class="rvSide">
          <span class="badge">auto-link</span>
          ${confBadge(row.confidence, true)}
          <div class="rvActions">
            <button class="btn rvApprove" ${disabled}>✓ Approve</button>
            <button class="btn rvReject" ${disabled}>✗ Reject</button>
          </div>
        </div>
      </div>`;
	}

	function orphanRowHtml(row, cands) {
		const disabled = localWrite ? "" : "disabled";
		const candHtml = cands.length
			? cands
					.map(
						(c) => `
            <div class="rvCand" data-cand="${esc(String(c.it.sku))}">
              ${miniCardHtml(c.it)}
              <div class="rvCandSide">
                ${confBadge(c.score, blended)}
                <button class="btn rvLink" ${disabled}>Link</button>
                <button class="btn rvIgnoreCand" title="record as not-a-match" ${disabled}>✗</button>
              </div>
            </div>`,
					)
					.join("")
			: `<div class="small rvNoCand">No confident matches found.</div>`;
		return `
      <div class="reviewRow orphanRow" data-kind="orphan" data-sku="${esc(row.sku)}">
        <div class="rvOrphanHead">
          ${miniCardHtml(row.it)}
          <span class="badge" title="no links of any kind">no links</span>
          <button class="btn rvSkip" title="dismiss from this view (returns until you commit)" ${disabled}>Skip</button>
        </div>
        <div class="rvCands">${candHtml}</div>
      </div>`;
	}

	function candidatesFor(it) {
		const recs = recommendSimilar(
			allAgg,
			it,
			ORPHAN_CANDIDATES,
			"",
			null,
			isIgnoredPair,
			sizePenaltyForPair,
			pricePenaltyForPair,
			sameStoreCanon,
			sameGroup,
			{ vocab, allowSameStore: true, withScores: true, blend: blended ? blend : null },
		);
		return (recs || [])
			.map((r) => (r && r.it ? { it: r.it, score: r.score } : null))
			.filter((r) => r && r.it && String(r.it.sku) !== String(it.sku));
	}

	/* ---------------- chunked render ---------------- */

	function renderChunk() {
		const slice = feed.slice(shown, shown + PAGE_SIZE);
		const html = slice
			.map((row) => (row.kind === "pending" ? pendingRowHtml(row) : orphanRowHtml(row, candidatesFor(row.it))))
			.join("");
		$list.insertAdjacentHTML("beforeend", html);
		shown += slice.length;
		const done = shown >= feed.length;
		$done.style.display = done && feed.length ? "" : "none";
		if (done && io) io.disconnect();
	}

	// Auto-load the whole queue as the sentinel nears the viewport — no manual "Load more" button.
	// Orphan candidates are still scored lazily per chunk, so we only pay for rows actually scrolled
	// into view. `maybeFill` keeps rendering until the viewport (plus a margin) is full, since a
	// single IntersectionObserver tick renders just one chunk.
	let io = null;
	function maybeFill() {
		if (shown >= feed.length) return;
		const rect = $sentinel.getBoundingClientRect();
		if (rect.top < (window.innerHeight || 0) + 600) {
			renderChunk();
			requestAnimationFrame(maybeFill);
		}
	}
	if ("IntersectionObserver" in window) {
		io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) maybeFill();
			},
			{ rootMargin: "600px" },
		);
	}

	function emptyStateHtml() {
		if (auditMode) return `<div class="small" style="padding:20px 0;">Nothing older to audit. 🎉</div>`;
		return watermark
			? `<div class="small" style="padding:20px 0;">All caught up — nothing new since your last review (${esc(new Date(watermark).toLocaleString())}). 🎉</div>`
			: `<div class="small" style="padding:20px 0;">Nothing to review — no pending auto-links and no unlinked SKUs. 🎉</div>`;
	}

	// Full (re)render — used on first load and whenever the audit toggle flips the feed.
	function render() {
		feed = buildFeed();
		shown = 0;
		$list.innerHTML = "";
		updateSummary();
		if (!feed.length) {
			$list.innerHTML = emptyStateHtml();
			$done.style.display = "none";
			if (io) io.disconnect();
			return;
		}
		if (io) io.observe($sentinel); // (re)attach (renderChunk disconnects it when a feed finishes)
		renderChunk();
		requestAnimationFrame(maybeFill);
	}

	render();

	if ($auditToggle) {
		$auditToggle.addEventListener("click", () => {
			auditMode = !auditMode;
			$auditToggle.classList.toggle("rvAuditActive", auditMode);
			$auditToggle.textContent = auditMode ? "✕ Exit audit" : `🔍 Audit (${olderPresent})`;
			render();
		});
	}

	/* ---------------- actions (event delegation) ---------------- */

	function removeRow(el, msg) {
		el.classList.add("rvResolved");
		el.innerHTML = `<div class="rvResolvedMsg small">${esc(msg)}</div>`;
		clearSkuRulesCache(); // next page load reflects the change
	}

	if (localWrite) {
		$list.addEventListener("click", async (e) => {
			const btn = e.target.closest("button");
			if (!btn) return;
			const row = btn.closest(".reviewRow");
			if (!row) return;
			btn.disabled = true;

			try {
				if (btn.classList.contains("rvApprove")) {
					await apiConfirmSkuLink(row.dataset.from, row.dataset.to);
					removeRow(row, "✓ Approved — confirmed link.");
				} else if (btn.classList.contains("rvReject")) {
					await apiRejectSkuLink(row.dataset.from, row.dataset.to);
					removeRow(row, "✗ Rejected — link removed, ignore recorded.");
				} else if (btn.classList.contains("rvLink")) {
					const cand = btn.closest(".rvCand");
					await apiWriteSkuLink(row.dataset.sku, cand.dataset.cand);
					removeRow(row, `Linked to ${displaySku(cand.dataset.cand)}.`);
				} else if (btn.classList.contains("rvIgnoreCand")) {
					const cand = btn.closest(".rvCand");
					await apiWriteSkuIgnore(row.dataset.sku, cand.dataset.cand);
					cand.remove();
				} else if (btn.classList.contains("rvSkip")) {
					// Session-only dismiss: it returns on reload until you commit (the watermark is what
					// makes it stick). Approve/Reject/Link change the data and don't come back.
					removeRow(row, "Skipped for now.");
				}
			} catch (err) {
				btn.disabled = false;
				alert(`Action failed: ${err && err.message ? err.message : err}`);
			}
		});
	}
}
