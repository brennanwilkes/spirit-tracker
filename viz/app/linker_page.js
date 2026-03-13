// viz/app/linker_page.js
import { esc, renderThumbHtml } from "./dom.js";
import { tokenizeQuery, matchesAllTokens, displaySku, keySkuForRow, normSearchText } from "./sku.js";
import { loadIndex } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules, clearSkuRulesCache } from "./mapping.js";
import {
	inferGithubOwnerRepo,
	isLocalWriteMode,
	loadSkuMetaBestEffort,
	apiWriteSkuLink,
	apiWriteSkuIgnore,
} from "./api.js";
import {
	addPendingLink,
	addPendingIgnore,
	pendingCounts,
	movePendingToSubmitted,
	clearPendingEdits,
} from "./pending.js";

import { buildUrlBySkuStore } from "./linker_page/url_map.js";
import { buildCanonStoreCache, makeSameStoreCanonFn } from "./linker_page/store_cache.js";
import { buildSizePenaltyForPair } from "./linker_page/size.js";
import { pickPreferredCanonical } from "./linker_page/canonical_pref.js";
import { smwsKeyFromName, similarityScore } from "./linker_page/similarity.js";
import { buildPricePenaltyForPair } from "./linker_page/price.js";
import { topSuggestions, recommendSimilar, computeInitialPairsFast } from "./linker_page/suggestions.js";

/* ---------------- Page ---------------- */

export async function renderSkuLinker($app) {
	const localWrite = isLocalWriteMode();
	let rules = await loadSkuRules();

	const PAGE_SEED = (() => {
		try {
			const u = new Uint32Array(1);
			crypto.getRandomValues(u);
			return u[0] >>> 0;
		} catch {
			return (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
		}
	})();

	const TEMP_KEY = "stviz_linker_temp_v1";

	function clamp01(x) {
		x = Number(x);
		if (!Number.isFinite(x)) return 0.2;
		if (x < 0) return 0;
		if (x > 1) return 1;
		return x;
	}

	function loadTemp() {
		try {
			const raw = localStorage.getItem(TEMP_KEY);
			if (raw == null) return 0.2;
			return clamp01(parseFloat(raw));
		} catch {
			return 0.2;
		}
	}

	function saveTemp(x) {
		try {
			localStorage.setItem(TEMP_KEY, String(clamp01(x)));
		} catch {
			// ignore
		}
	}

	let currentTemp = loadTemp();

	$app.innerHTML = `
    <div class="container" style="max-width:1200px;">
      <div class="topbar">
        <button id="back" class="btn">← Back</button>
		<div style="display:flex; align-items:center; gap:8px;">
			<span class="badge">Temp</span>
			<input
				id="tempSlider"
				type="range"
				min="0"
				max="1"
				step="0.01"
				value="${currentTemp.toFixed(2)}"
				style="height:18px; accent-color:#9aa3b2; opacity:.85;"
			/>
			<span id="tempVal" class="badge mono">${currentTemp.toFixed(2)}</span>
		</div>

        <div style="flex:1"></div>
        ${!localWrite ? `<span id="pendingTop" class="badge mono" style="display:none;"></span>` : ``}
        ${
			!localWrite
				? `<button id="clearPendingBtn" class="btn" style="padding:6px 10px; display:none;">Clear</button>`
				: ``
		}
        <span class="badge">SKU Linker</span>
        ${
			localWrite
				? `<span class="badge mono">LOCAL WRITE</span>`
				: `<button id="createPrBtn" class="btn" disabled>Create PR</button>`
		}
      </div>

      <div class="card" style="padding:14px;">
        <div class="small" style="margin-bottom:10px;">
          Existing mapped SKUs are excluded from auto-suggestions. Same-store pairs are never suggested. LINK SKU writes map (can merge groups); IGNORE PAIR writes a "do-not-suggest" pair (local only).
        </div>

        <div style="display:flex; gap:16px;">
          <div style="flex:1; min-width:0;">
            <div class="small" style="margin-bottom:6px;">Left</div>
            <input id="qL" class="input" placeholder="Search (name / url / sku)..." autocomplete="off" />
            <div id="listL" class="list" style="margin-top:10px;"></div>
          </div>

          <div style="flex:1; min-width:0;">
            <div class="small" style="margin-bottom:6px;">Right</div>
            <input id="qR" class="input" placeholder="Search (name / url / sku)..." autocomplete="off" />
            <div id="listR" class="list" style="margin-top:10px;"></div>
          </div>
        </div>
      </div>

      <div class="card linkBar" style="padding:10px;">
        <button id="linkBtn" class="btn" style="width:100%;" disabled>LINK SKU</button>
        <button id="forceLinkBtn" class="btn" style="width:100%; margin-top:8px;" disabled>LINK SAME-STORE</button> <!-- ✅ NEW -->
        <button id="ignoreBtn" class="btn" style="width:100%; margin-top:8px;" disabled>IGNORE PAIR</button>
        <div id="status" class="small" style="margin-top:8px;"></div>
      </div>
    </div>
  `;

	document.getElementById("back").addEventListener("click", () => (location.hash = "#/"));

	const $qL = document.getElementById("qL");
	const $qR = document.getElementById("qR");
	const $listL = document.getElementById("listL");
	const $listR = document.getElementById("listR");
	const $linkBtn = document.getElementById("linkBtn");
	const $forceLinkBtn = document.getElementById("forceLinkBtn"); // ✅ NEW
	const $ignoreBtn = document.getElementById("ignoreBtn");
	const $status = document.getElementById("status");
	const $pendingTop = !localWrite ? document.getElementById("pendingTop") : null;
	const $clearPendingBtn = !localWrite ? document.getElementById("clearPendingBtn") : null;

	const $tempSlider = document.getElementById("tempSlider");
	const $tempVal = document.getElementById("tempVal");

	let tempDebounceT = null;

	function applyTempFromSlider() {
		if (!$tempSlider || !$tempVal) return;

		const v = clamp01(parseFloat($tempSlider.value));
		currentTemp = v;
		$tempVal.textContent = currentTemp.toFixed(2);
		saveTemp(currentTemp);

		// force new initial suggestions
		initialPairs = null;
		$status.textContent = "";
		updateAll();
	}

	if ($tempSlider && $tempVal) {
		$tempSlider.value = String(currentTemp.toFixed(2));
		$tempVal.textContent = currentTemp.toFixed(2);

		// immediate label update while dragging, but delayed recompute
		$tempSlider.addEventListener("input", () => {
			const v = clamp01(parseFloat($tempSlider.value));
			$tempVal.textContent = v.toFixed(2);
			saveTemp(v);

			if (tempDebounceT) clearTimeout(tempDebounceT);
			tempDebounceT = setTimeout(() => {
				tempDebounceT = null;
				applyTempFromSlider();
			}, 220);
		});

		// also commit quickly on release
		$tempSlider.addEventListener("change", () => {
			if (tempDebounceT) clearTimeout(tempDebounceT);
			tempDebounceT = null;
			applyTempFromSlider();
		});
	}

	$listL.innerHTML = `<div class="small">Loading index…</div>`;
	$listR.innerHTML = `<div class="small">Loading index…</div>`;

	const idx = await loadIndex();
	const allRows = Array.isArray(idx.items) ? idx.items : [];

	// ✅ moved into helper
	const URL_BY_SKU_STORE = buildUrlBySkuStore(allRows);

	const allAgg = aggregateBySku(allRows, (x) => x);

	const meta = await loadSkuMetaBestEffort();
	const mappedSkus = buildMappedSkuSet(meta.links || [], rules);
	let ignoreSet = rules.ignoreSet;

	// ✅ canonical-group store cache + helper
	let CANON_STORE_CACHE = buildCanonStoreCache(allAgg, rules);
	let sameStoreCanon = makeSameStoreCanonFn(rules, CANON_STORE_CACHE);

	// ✅ canonical-group size cache + helper
	let sizePenaltyForPair = buildSizePenaltyForPair({ allRows, allAgg, rules });

	// ✅ canonical-group price cache + helper
	let pricePenaltyForPair = buildPricePenaltyForPair({ allAgg, rules });

	function rebuildCachesAfterRulesReload() {
		CANON_STORE_CACHE = buildCanonStoreCache(allAgg, rules);
		sameStoreCanon = makeSameStoreCanonFn(rules, CANON_STORE_CACHE);
		sizePenaltyForPair = buildSizePenaltyForPair({ allRows, allAgg, rules });
		pricePenaltyForPair = buildPricePenaltyForPair({ allAgg, rules });
	}

	function isIgnoredPair(a, b) {
		return rules.isIgnoredPair(String(a || ""), String(b || ""));
	}

	function sameGroup(aSku, bSku) {
		if (!aSku || !bSku) return false;
		return String(rules.canonicalSku(aSku)) === String(rules.canonicalSku(bSku));
	}

	// ✅ NEW: helpers for same-store override gating
	const EMPTY_SET = new Set();

	function canonStoresForSkuKey(skuKey) {
		const s = String(skuKey || "").trim();
		if (!s) return EMPTY_SET;
		const canon = String(rules.canonicalSku(s) || s);
		return CANON_STORE_CACHE.get(canon) || EMPTY_SET;
	}

	function sameStoreOverrideAllowed(aIt, bIt) {
		const aSku = String(aIt?.sku || "");
		const bSku = String(bIt?.sku || "");
		if (!aSku || !bSku) return false;
		if (!sameStoreCanon(aSku, bSku)) return false;
	  
		const A = canonStoresForSkuKey(aSku);
		const B = canonStoresForSkuKey(bSku);
		if (!A.size || !B.size) return false;
	  
		// Prefer overlap on the user-visible “selected” store label (cheapest)
		const aPrimary = String(aIt?.cheapestStoreLabel || "").trim();
		const bPrimary = String(bIt?.cheapestStoreLabel || "").trim();
	  
		// Determine overlap
		let anyOverlap = false;
		let primaryOverlap = false;
		for (const s of A) {
		  if (!B.has(s)) continue;
		  anyOverlap = true;
		  if ((aPrimary && s === aPrimary) || (bPrimary && s === bPrimary)) primaryOverlap = true;
		}
		if (!anyOverlap) return false;
	  
		// If we know a primary store, require overlap on it (tightens to “this looks like a relist on that store”)
		if ((aPrimary || bPrimary) && !primaryOverlap) return false;
	  
		// SMWS exact code is a slam-dunk
		const ka = smwsKeyFromName(aIt?.name || "");
		const kb = smwsKeyFromName(bIt?.name || "");
		if (ka && kb && ka === kb) return true;
	  
		// Otherwise require strong name similarity
		return similarityScore(aIt?.name || "", bIt?.name || "") >= 3.1;
	}

	let initialPairs = null;

	function getInitialPairsIfNeeded() {
		// never compute if either side is pinned
		if (pinnedL || pinnedR) return null;

		// never compute if URL query param was used (preselect flow)
		if (shouldReloadAfterLink) return null;

		if (initialPairs) return initialPairs;

		initialPairs = computeInitialPairsFast(
			allAgg,
			mappedSkus,
			28,
			isIgnoredPair,
			sameStoreCanon,
			sameGroup, // ✅ NEW: hard-block already-linked pairs (incl SMWS stage)
			sizePenaltyForPair,
			pricePenaltyForPair,
			PAGE_SEED,
			{ temp: currentTemp }, // 0.00 = deterministic, 0.15–0.30 = mild variety, 0.50+ = very diverse
		);

		return initialPairs;
	}

	let pinnedL = null;
	let pinnedR = null;

	// if page was opened with #/link/?left=... (or sku=...), reload after LINK completes
	let shouldReloadAfterLink = false;

	function renderCard(it, pinned) {
		const storeCount = it.stores.size || 0;
		const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";
		const price = it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)";
		const store = it.cheapestStoreLabel || [...it.stores][0] || "Store";

		const href =
			URL_BY_SKU_STORE.get(String(it.sku || ""))?.get(String(store || "")) ||
			String(it.sampleUrl || "").trim() ||
			"";

		const storeBadge = href
			? `<a class="badge" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
					store,
				)}${esc(plus)}</a>`
			: `<span class="badge">${esc(store)}${esc(plus)}</span>`;

		const pinnedBadge = pinned ? `<span class="badge">PINNED</span>` : ``;

		return `
      <div class="item ${pinned ? "pinnedItem" : ""}" data-sku="${esc(it.sku)}">
        <div class="itemRow">
          <div class="thumbBox thumbInternalLink" data-sku="${esc(it.sku)}">
            ${renderThumbHtml(it.img)}
          </div>
          <div class="itemBody">
              <div class="itemTop">
              <div class="itemName">${esc(it.name || "(no name)")}</div>
              <span class="badge mono">${esc(displaySku(it.sku))}</span>
            </div>
            <div class="metaRow">
              ${pinnedBadge}
              <span class="mono price">${esc(price)}</span>
              ${storeBadge}
            </div>
          </div>
        </div>
      </div>
    `;
	}

	function sideItems(side, query, otherPinned) {
		const tokens = tokenizeQuery(query);
		const otherSku = otherPinned ? String(otherPinned.sku || "") : "";

		// manual search: allow mapped SKUs so you can merge groups,
		// BUT if the other side is pinned, hide anything already in that pinned's group
		if (tokens.length) {
			let out = allAgg
				.filter((it) => it && it.sku !== otherSku && matchesAllTokens(it.searchText, tokens))
				.slice(0, 120);

			if (otherPinned) {
				const oSku = String(otherPinned.sku || "");
				out = out.filter((it) => !isIgnoredPair(oSku, String(it.sku || "")));

				out = out.filter((it) => {
					const sSku = String(it?.sku || "");
					return !sameStoreCanon(oSku, sSku) || true;
				  });

				out = out.filter((it) => !sameGroup(oSku, String(it.sku || "")));
			}

			return out.slice(0, 80);
		}

		// auto-suggestions: never include mapped skus
		if (otherPinned)
			return recommendSimilar(
				allAgg,
				otherPinned,
				60,
				otherSku,
				mappedSkus,
				isIgnoredPair,
				sizePenaltyForPair,
				pricePenaltyForPair,
				sameStoreCanon,
				sameGroup,
			);

		const pairs = getInitialPairsIfNeeded();
		if (pairs && pairs.length) {
			const list = side === "L" ? pairs.map((p) => p.a) : pairs.map((p) => p.b);
			return list.filter(
				(it) =>
					it && it.sku !== otherSku && (!mappedSkus.has(String(it.sku)) || smwsKeyFromName(it.name || "")),
			);
		}

		return topSuggestions(allAgg, 60, otherSku, mappedSkus);
	}

	function attachHandlers($root, side) {
		for (const el of Array.from($root.querySelectorAll(".thumbInternalLink"))) {
			el.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();

				const sku = (el.getAttribute("data-sku") || "").trim();
				if (!sku) return;

				const u = new URL(location.href);
				u.hash = `#/item/${encodeURIComponent(sku)}`;
				window.open(u.toString(), "_blank", "noopener,noreferrer");
			});
		}

		for (const el of Array.from($root.querySelectorAll(".item"))) {
			el.addEventListener("click", () => {
				const skuKey = el.getAttribute("data-sku") || "";
				const it = allAgg.find((x) => String(x.sku || "") === skuKey);
				if (!it) return;

				const other = side === "L" ? pinnedR : pinnedL;

				if (other && String(other.sku || "") === String(it.sku || "")) {
					$status.textContent = "Not allowed: both sides cannot be the same SKU.";
					return;
				}

				// ✅ CHANGED: remove hard-block on same-store here (allow pinning);
				//           linking is still blocked unless override passes.

				// HARD BLOCK: already linked group
				if (other && sameGroup(String(other.sku || ""), String(it.sku || ""))) {
					$status.textContent = "Already linked: both SKUs are in the same group.";
					return;
				}

				if (side === "L") pinnedL = pinnedL && pinnedL.sku === it.sku ? null : it;
				else pinnedR = pinnedR && pinnedR.sku === it.sku ? null : it;

				updateAll();
			});
		}
	}

	function renderSide(side) {
		const pinned = side === "L" ? pinnedL : pinnedR;
		const other = side === "L" ? pinnedR : pinnedL;
		const query = side === "L" ? $qL.value : $qR.value;
		const $list = side === "L" ? $listL : $listR;

		if (pinned) {
			$list.innerHTML = renderCard(pinned, true);
			attachHandlers($list, side);
			return;
		}

		const items = sideItems(side, query, other);
		$list.innerHTML = items.length
			? items.map((it) => renderCard(it, false)).join("")
			: `<div class="small">No matches.</div>`;
		attachHandlers($list, side);
	}

	function updateButtons() {
		const isPages = !localWrite;

		const $pr = isPages ? document.getElementById("createPrBtn") : null;
		if ($pr) {
			const c0 = pendingCounts();
			$pr.disabled = c0.total === 0;
		}

		if ($pendingTop && $clearPendingBtn) {
			const c0 = pendingCounts();
			$pendingTop.textContent = c0.total ? `Pending: ${c0.total}` : "";
			$pendingTop.style.display = c0.total ? "inline-flex" : "none";
			$clearPendingBtn.style.display = c0.total ? "inline-flex" : "none";
			$clearPendingBtn.disabled = c0.total === 0;
		}

		if (!(pinnedL && pinnedR)) {
			$linkBtn.disabled = true;
			$forceLinkBtn.disabled = true; // ✅ NEW
			$ignoreBtn.disabled = true;

			if (isPages) {
				const c = pendingCounts();
				$status.textContent = c.total
					? `Pending changes: ${c.links} link(s), ${c.ignores} ignore(s). Create PR when ready.`
					: "Pin one item on each side to enable linking / ignoring.";
			} else {
				if (!$status.textContent)
					$status.textContent = "Pin one item on each side to enable linking / ignoring.";
			}
			return;
		}

		const a = String(pinnedL.sku || "");
		const b = String(pinnedR.sku || "");

		if (a === b) {
			$linkBtn.disabled = true;
			$forceLinkBtn.disabled = true;
			$ignoreBtn.disabled = true;
			$status.textContent = "Not allowed: both sides cannot be the same SKU.";
			return;
		}

		// ✅ CHANGED: same-store blocks normal link/ignore, but may enable LINK SAME-STORE
		if (sameStoreCanon(a, b)) {
			$linkBtn.disabled = true;
			$ignoreBtn.disabled = true;

			const ok = sameStoreOverrideAllowed(pinnedL, pinnedR);
			$forceLinkBtn.disabled = !ok;

			$status.textContent = ok
				? "Same-store duplicate candidate. Use LINK SAME-STORE to merge."
				: "Not allowed: both items belong to the same store.";
			return;
		}

		// not same-store
		$forceLinkBtn.disabled = true;

		if (sameGroup(a, b)) {
			$linkBtn.disabled = true;
			$ignoreBtn.disabled = true;
			$status.textContent = "Already linked: both SKUs are in the same group.";
			return;
		}

		$linkBtn.disabled = false;
		$ignoreBtn.disabled = false;

		if (isIgnoredPair(a, b)) {
			$status.textContent = "This pair is already ignored.";
		} else if ($status.textContent === "Pin one item on each side to enable linking / ignoring.") {
			$status.textContent = "";
		}

		if ($pr) {
			const c = pendingCounts();
			$pr.disabled = c.total === 0;
		}
	}

	if ($clearPendingBtn) {
		$clearPendingBtn.addEventListener("click", async () => {
			const c0 = pendingCounts();
			if (c0.total === 0) return;

			clearPendingEdits();

			clearSkuRulesCache();
			rules = await loadSkuRules();
			ignoreSet = rules.ignoreSet;

			rebuildCachesAfterRulesReload();

			const rebuilt = buildMappedSkuSet(rules.links || [], rules);
			mappedSkus.clear();
			for (const x of rebuilt) mappedSkus.add(x);

			const $pr = document.getElementById("createPrBtn");
			if ($pr) {
				const c = pendingCounts();
				$pr.disabled = c.total === 0;
			}

			pinnedL = null;
			pinnedR = null;
			$status.textContent = "Cleared pending staged edits.";
			updateAll();
		});
	}

	const $createPrBtn = document.getElementById("createPrBtn");
	if ($createPrBtn) {
		$createPrBtn.addEventListener("click", async () => {
			const c = pendingCounts();
			if (c.total === 0) return;

			const { owner, repo } = inferGithubOwnerRepo();

			const editsToSend = movePendingToSubmitted();

			const payload = JSON.stringify(
				{
					schema: "stviz-sku-edits-v1",
					createdAt: editsToSend.createdAt || new Date().toISOString(),
					links: editsToSend.links,
					ignores: editsToSend.ignores,
				},
				null,
				2,
			);

			const title = `[stviz] sku link updates (${editsToSend.links.length} link, ${editsToSend.ignores.length} ignore)`;
			const body =
				`Automated request from GitHub Pages SKU Linker.\n\n` +
				`<!-- stviz-sku-edits:BEGIN -->\n` +
				payload +
				`\n<!-- stviz-sku-edits:END -->\n`;

			const u =
				`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
				`/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

			window.open(u, "_blank", "noopener,noreferrer");

			clearSkuRulesCache();
			rules = await loadSkuRules();
			ignoreSet = rules.ignoreSet;

			rebuildCachesAfterRulesReload();

			const rebuilt = buildMappedSkuSet(rules.links || [], rules);
			mappedSkus.clear();
			for (const x of rebuilt) mappedSkus.add(x);

			const c2 = pendingCounts();
			$createPrBtn.disabled = c2.total === 0;

			$status.textContent = "PR request opened. Staged edits moved to submitted (won’t re-suggest).";
			pinnedL = null;
			pinnedR = null;
			updateAll();
		});
	}

	function findAggForPreselectSku(rawSku) {
		const want = String(rawSku || "").trim();
		if (!want) return null;

		let it = allAgg.find((x) => String(x?.sku || "") === want);
		if (it) return it;

		const canonWant = String(rules.canonicalSku(want) || want).trim();
		if (!canonWant) return null;

		it = allAgg.find((x) => String(x?.sku || "") === canonWant);
		if (it) return it;

		return allAgg.find((x) => String(rules.canonicalSku(String(x?.sku || "")) || "") === canonWant) || null;
	}

	function updateAll() {
		if (!updateAll._didPreselect) {
			updateAll._didPreselect = true;

			const h = String(location.hash || "");
			const qi = h.indexOf("?");
			if (qi !== -1) {
				const qs = new URLSearchParams(h.slice(qi + 1));
				const leftSkuRaw = qs.get("left") || qs.get("sku");
				const leftSku = String(leftSkuRaw || "").trim();

				if (leftSku) shouldReloadAfterLink = true;

				if (leftSku && !pinnedL) {
					const it = findAggForPreselectSku(leftSku);
					if (it) pinnedL = it;
				}
			}
		}

		renderSide("L");
		renderSide("R");
		updateButtons();
	}

	let tL = null,
		tR = null;
	$qL.addEventListener("input", () => {
		if (tL) clearTimeout(tL);
		tL = setTimeout(() => {
			$status.textContent = "";
			updateAll();
		}, 60);
	});
	$qR.addEventListener("input", () => {
		if (tR) clearTimeout(tR);
		tR = setTimeout(() => {
			$status.textContent = "";
			updateAll();
		}, 60);
	});

	// ✅ NEW: unified link runner (normal + same-store override)
	async function runLink({ forceSameStore }) {
		if (!(pinnedL && pinnedR)) return;

		const a = String(pinnedL.sku || "");
		const b = String(pinnedR.sku || "");

		if (!a || !b) {
			$status.textContent = "Not allowed: missing SKU.";
			return;
		}
		if (a === b) {
			$status.textContent = "Not allowed: both sides cannot be the same SKU.";
			return;
		}
		if (sameGroup(a, b)) {
			$status.textContent = "Already linked: both SKUs are in the same group.";
			return;
		}
		if (isIgnoredPair(a, b)) {
			$status.textContent = "This pair is already ignored.";
			return;
		}

		if (sameStoreCanon(a, b)) {
			if (!forceSameStore) {
				$status.textContent = "Not allowed: both items belong to the same store.";
				return;
			}
			if (!sameStoreOverrideAllowed(pinnedL, pinnedR)) {
				$status.textContent = "Not allowed: same-store override gate failed.";
				return;
			}
		}

		const aCanon = rules.canonicalSku(a);
		const bCanon = rules.canonicalSku(b);

		const preferred = pickPreferredCanonical(allRows, [a, b, aCanon, bCanon]);
		if (!preferred) {
			$status.textContent = "Write failed: could not choose a canonical SKU.";
			return;
		}

		const writes = [];
		function addWrite(fromSku, toSku) {
			const f = String(fromSku || "").trim();
			const t = String(toSku || "").trim();
			if (!f || !t || f === t) return;
			if (rules.canonicalSku(f) === t) return;
			writes.push({ fromSku: f, toSku: t });
		}

		addWrite(aCanon, preferred);
		addWrite(bCanon, preferred);
		addWrite(a, preferred);
		addWrite(b, preferred);

		const seenW = new Set();
		const uniq = [];
		for (const w of writes) {
			const k = `${w.fromSku}→${w.toSku}`;
			if (seenW.has(k)) continue;
			seenW.add(k);
			uniq.push(w);
		}

		if (!localWrite) {
			for (const w of uniq) addPendingLink(w.fromSku, w.toSku);

			clearSkuRulesCache();
			rules = await loadSkuRules();
			ignoreSet = rules.ignoreSet;

			rebuildCachesAfterRulesReload();

			const rebuilt = buildMappedSkuSet(rules.links || [], rules);
			mappedSkus.clear();
			for (const x of rebuilt) mappedSkus.add(x);

			const c = pendingCounts();
			$status.textContent = `Staged locally. Pending: ${c.links} link(s), ${c.ignores} ignore(s).`;

			const $pr = document.getElementById("createPrBtn");
			if ($pr) $pr.disabled = c.total === 0;

			pinnedL = null;
			pinnedR = null;
			updateAll();

			location.reload();
			return;
		}

		$status.textContent = `Writing ${uniq.length} link(s) to canonical ${displaySku(preferred)} …`;

		try {
			for (let i = 0; i < uniq.length; i++) {
				const w = uniq[i];
				$status.textContent = `Writing (${i + 1}/${uniq.length}): ${displaySku(
					w.fromSku,
				)} → ${displaySku(w.toSku)} …`;
				await apiWriteSkuLink(w.fromSku, w.toSku);
			}

			clearSkuRulesCache();
			rules = await loadSkuRules();
			ignoreSet = rules.ignoreSet;

			rebuildCachesAfterRulesReload();

			const meta2 = await loadSkuMetaBestEffort();
			const rebuilt = buildMappedSkuSet(meta2?.links || [], rules);
			mappedSkus.clear();
			for (const x of rebuilt) mappedSkus.add(x);

			$status.textContent = `Saved. Canonical is now ${displaySku(preferred)}.`;
			pinnedL = null;
			pinnedR = null;
			updateAll();

			location.reload();
		} catch (e) {
			$status.textContent = `Write failed: ${String(e && e.message ? e.message : e)}`;
		}
	}

	$linkBtn.addEventListener("click", () => runLink({ forceSameStore: false }));
	$forceLinkBtn.addEventListener("click", () => runLink({ forceSameStore: true })); // ✅ NEW

	$ignoreBtn.addEventListener("click", async () => {
		if (!(pinnedL && pinnedR)) return;

		const a = String(pinnedL.sku || "");
		const b = String(pinnedR.sku || "");

		if (!a || !b) {
			$status.textContent = "Not allowed: missing SKU.";
			return;
		}
		if (a === b) {
			$status.textContent = "Not allowed: both sides cannot be the same SKU.";
			return;
		}
		if (sameStoreCanon(a, b)) {
			$status.textContent = "Not allowed: both items belong to the same store.";
			return;
		}
		if (sameGroup(a, b)) {
			$status.textContent = "Already linked: both SKUs are in the same group.";
			return;
		}
		if (isIgnoredPair(a, b)) {
			$status.textContent = "This pair is already ignored.";
			return;
		}

		if (!localWrite) {
			$status.textContent = `Staging ignore: ${displaySku(a)} × ${displaySku(b)} …`;

			addPendingIgnore(a, b);

			clearSkuRulesCache();
			rules = await loadSkuRules();
			ignoreSet = rules.ignoreSet;

			rebuildCachesAfterRulesReload();

			const rebuilt = buildMappedSkuSet(rules.links || [], rules);
			mappedSkus.clear();
			for (const x of rebuilt) mappedSkus.add(x);

			const c = pendingCounts();
			$status.textContent = `Staged locally. Pending: ${c.links} link(s), ${c.ignores} ignore(s).`;

			const $pr = document.getElementById("createPrBtn");
			if ($pr) $pr.disabled = c.total === 0;

			pinnedL = null;
			pinnedR = null;
			updateAll();
			location.reload();

			return;
		}

		$status.textContent = `Ignoring: ${displaySku(a)} × ${displaySku(b)} …`;

		try {
			const out = await apiWriteSkuIgnore(a, b);
			ignoreSet.add(rules.canonicalPairKey(a, b));
			$status.textContent = `Ignored: ${displaySku(a)} × ${displaySku(b)} (ignores=${out.count}).`;
			pinnedL = null;
			pinnedR = null;
			updateAll();
			location.reload();
		} catch (e) {
			$status.textContent = `Ignore failed: ${String(e && e.message ? e.message : e)}`;
		}
	});

	updateAll();

	/* ---------------- Mapping helpers (kept local) ---------------- */

	function buildMappedSkuSet(links, rules0) {
		const s = new Set();

		function add(k) {
			const x = String(k || "").trim();
			if (!x) return;
			s.add(x);
			if (rules0 && typeof rules0.canonicalSku === "function") {
				const c = String(rules0.canonicalSku(x) || "").trim();
				if (c) s.add(c);
			}
		}

		// ✅ NEW: always include rules.links (meta can be incomplete)
		const merged = [
			...(rules0 && Array.isArray(rules0.links) ? rules0.links : []),
			...(Array.isArray(links) ? links : []),
		];

		for (const x of merged) {
			add(x?.fromSku);
			add(x?.toSku);
		}

		return s;
	}
}