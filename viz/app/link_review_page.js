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
} from "./api.js";
import { normalizeImplicitSkuKey } from "./sku_canonical.js";
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

	/* ---------------- build the feed ---------------- */

	// Pending auto-links.
	const pendingRows = [];
	for (const l of Array.isArray(rules.links) ? rules.links : []) {
		if (!l || l.status !== "pending") continue;
		const a = resolveAgg(l.fromSku);
		const b = resolveAgg(l.toSku);
		if (!a || !b) continue; // a side fell out of the catalog (delisted) — skip from the queue
		pendingRows.push({
			kind: "pending",
			fromSku: String(l.fromSku),
			toSku: String(l.toSku),
			a,
			b,
			confidence: typeof l.confidence === "number" ? l.confidence : null,
			recency: Math.max(recencyOf(l.fromSku), recencyOf(l.toSku)),
		});
	}

	// Orphan SKUs: no link of any kind (group size 1) AND single-store (no implicit cross-store link).
	const orphanRows = [];
	for (const it of allAgg) {
		const sku = String(it.sku || "");
		if (!sku) continue;
		if ((it.stores ? it.stores.size : 0) > 1) continue; // implicit cross-store link → has links → skip
		const group = rules.groupForCanonical(rules.canonicalSku(sku));
		if (group && group.size > 1) continue; // explicit link → skip
		orphanRows.push({ kind: "orphan", sku, it, recency: recencyOf(sku) });
	}

	const feed = [...pendingRows, ...orphanRows].sort((x, y) => y.recency - x.recency);
	let shown = 0;

	/* ---------------- render shell ---------------- */

	const roNotice = localWrite
		? ""
		: `<div class="reviewNotice">Read-only — Approve/Reject need the local dev server (<span class="mono">node viz/serve.js</span>).</div>`;

	$app.innerHTML = `
    <div class="container" style="max-width:1100px;">
      <div class="topbar">
        <a id="back" class="btn" href="${peekBack()}"><span class="backArrow">← </span>Back</a>
        <div style="flex:1"></div>
        <a class="btn" href="#/link" style="padding:6px 10px;">SKU Linker</a>
        <a class="btn" href="#/link-rapid" style="padding:6px 10px;">⚡ Rapid</a>
        <span class="badge">Review</span>
      </div>
      <h2 class="reviewTitle">Auto-link review</h2>
      <div id="reviewSummary" class="small reviewSummary">
        ${pendingRows.length} pending auto-link${pendingRows.length === 1 ? "" : "s"} ·
        ${orphanRows.length} unlinked SKU${orphanRows.length === 1 ? "" : "s"} · newest first
        ${blended ? "" : `<span class="badge" title="GBT/embedding blend unavailable — using classical scores">classical</span>`}
      </div>
      ${roNotice}
      <div id="reviewList" class="reviewList"></div>
      <div class="reviewMore">
        <button id="loadMore" class="btn" style="display:none;">Load more</button>
        <span id="reviewDone" class="small" style="display:none;">— end of queue —</span>
      </div>
    </div>`;

	const $list = $app.querySelector("#reviewList");
	const $more = $app.querySelector("#loadMore");
	const $done = $app.querySelector("#reviewDone");

	/* ---------------- card helpers ---------------- */

	function miniCardHtml(it) {
		const sku = String(it?.sku || "");
		const name = String(it?.name || "(no name)");
		const store = it?.cheapestStoreLabel || (it?.stores && it.stores.size ? [...it.stores][0] : "") || "";
		const price = it?.cheapestPriceStr || "";
		const url = it?.sampleUrl || "";
		const skuBadge = url
			? `<a class="badge mono skuLink" target="_blank" rel="noopener noreferrer" href="${esc(url)}">${esc(displaySku(sku))}</a>`
			: `<span class="badge mono">${esc(displaySku(sku))}</span>`;
		return `
      <div class="rvCard">
        <div class="rvThumb">${renderThumbHtml(it?.img || "", "thumb")}</div>
        <div class="rvBody">
          <div class="rvName">${esc(name)}</div>
          <div class="rvMeta">
            ${store ? `<span class="rvStore">${esc(store)}</span>` : ""}
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
          <button class="btn rvSkip">Skip</button>
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
		const remaining = feed.length - shown;
		$more.style.display = remaining > 0 ? "" : "none";
		$more.textContent = `Load more (${remaining})`;
		$done.style.display = remaining > 0 || !feed.length ? "none" : "";
	}

	$more.addEventListener("click", renderChunk);
	renderChunk();

	if (!feed.length) {
		$list.innerHTML = `<div class="small" style="padding:20px 0;">Nothing to review — no pending auto-links and no unlinked SKUs. 🎉</div>`;
	}

	/* ---------------- actions (event delegation) ---------------- */

	function removeRow(el, msg) {
		const summary = $app.querySelector("#reviewSummary");
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
					removeRow(row, "Skipped.");
				}
			} catch (err) {
				btn.disabled = false;
				alert(`Action failed: ${err && err.message ? err.message : err}`);
			}
		});
	}
}
