// viz/app/search_page.js
import { esc, renderThumbHtml, prettyTs } from "./dom.js";
import {
	tokenizeQuery,
	matchesAllTokens,
	displaySku,
	keySkuForRow,
	parsePriceToNumber,
} from "./sku.js";
import { loadIndex, loadRecent, loadRarity, loadSavedQuery, saveQuery } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";
import { loadHiddenSet, isHiddenListing } from "./hidden.js";
import { normalizeStoreId } from "./stores.js";
import { smwsDistilleryCodesForQueryPrefix, smwsDistilleryCodeFromName } from "./smws.js";
import { favStarHtml, loadMyFavouritesSet, installFavStars } from "./fav_star.js";
import { getAuthStatus, logoutAndReload, getMyStores } from "./cloud.js";
import { saveCurrentRoute, openOrNavigateTo } from "./nav.js";
import { spiritFilterHtml, installSpiritFilter } from "./components/spirit_filter.js";
import { decorateRarity } from "./rarity_decorate.js";
import { effectiveRarity } from "./rarity.js";
import { createInfiniteScroll } from "./components/infinite_scroll.js";
import { storeSetSelectorHtml, installStoreSetSelector } from "./components/store_set_selector.js";
import { parseStoreSet, serializeStoreSet, resolveStoreSet } from "./store_set.js";


export function renderSearch($app) {
	const auth = getAuthStatus();
	const authed = auth.ok;
	const shortlistHref = authed ? `#/shortlist/${encodeURIComponent(auth.userId)}` : "#/login";

	$app.innerHTML = `
    <div class="container">
      <div class="header">
        <!-- Row 1 -->
        <div class="headerRow1">
          <div class="headerLeft">
            <h1 class="h1">Brennan's Spirit Tracker</h1>
            <div class="small">Search name / url / sku / store</div>
          </div>

          <div class="headerRight headerButtons">
			<a class="tabDup btn btnIcon" href="#/stats" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;">
				<i class="fa-solid fa-chart-line" aria-hidden="true"></i>
				<span class="srOnly">Statistics</span>
			</a>
			<a class="hideMobile btn btnIcon" href="#/link" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;">
				<i class="fa-solid fa-link" aria-hidden="true"></i>
				<span class="srOnly">Link SKUs</span>
			</a>
			<a id="storesBtn" class="tabDup btn btnIcon" href="#/stores" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;" aria-label="Stores">
				<i class="fa-solid fa-store" aria-hidden="true"></i>
				<span class="srOnly">Stores</span>
			</a>
			<a class="tabDup btn btnIcon" href="#/shortlists" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;" aria-label="Public shortlists">
				<i class="fa-solid fa-people-group" aria-hidden="true"></i>
				<span class="srOnly">Public Shortlists</span>
			</a>

			${
				authed
					? `

		<a id="shortlistBtn" class="tabDup btn btnWide" href="${shortlistHref}" style="text-decoration:none;">My Shortlist</a>
		<a class="tabDup btn btnIcon" href="#/settings" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;" aria-label="Settings">
		<i class="fa-solid fa-gear" aria-hidden="true"></i>
		<span class="srOnly">Settings</span>
	  </a>
	  <a id="logoutBtn" class="btn btnIcon" type="button" aria-label="Log out"><i class="fa-solid fa-arrow-right-from-bracket" aria-hidden="true"></i></a>
	`
					: `
	  <a class="btn btnWide" href="#/login" style="text-decoration:none;">Login</a>
	  <a class="btn btnWide" href="#/signup" style="text-decoration:none;">Signup</a>
	`
			}
		</div>
        </div>

      </div>

      <div class="card">
        <div style="display:flex; flex-direction:column; gap:10px; width:100%;">
          <!-- Row 1: search -->
          <div style="display:flex; gap:10px; align-items:center; width:100%;">
            <input id="q" class="input" type="search" placeholder="e.g. bowmore sherry, 303821" autocomplete="off" style="flex: 1 1 auto;" />
            <button id="clearSearch" class="btn btnSm" type="button" style="flex: 0 0 auto;">Clear</button>
          </div>

          <div class="searchControls">
            <div class="searchControl">
              <span class="small searchControlLabel">Stores</span>
              ${storeSetSelectorHtml()}
            </div>

            <div class="searchControl">
              <span class="small searchControlLabel">Sort</span>
              <select id="sort" class="selectSmall" aria-label="Sort">
                <option value="newest">Newest</option>
                <option value="activity">Recent activity</option>
                <option value="salePct">Sale %</option>
                <option value="saleAbs">Sale $</option>
                <option value="priceAsc">Price (low)</option>
                <option value="priceDesc">Price (high)</option>
                <option value="rarityDesc">Rarest</option>
                <option value="rarityAsc">Common</option>
              </select>
            </div>

            <div class="searchControl">
              <span class="small searchControlLabel">Availability</span>
              <select id="avail" class="selectSmall" aria-label="Availability">
                <option value="all">All</option>
                <option value="in">In stock only</option>
                <option value="out">Out of stock only</option>
              </select>
            </div>

            <div class="searchControl searchControlType">
              <span class="small searchControlLabel">Type</span>
              ${spiritFilterHtml()}
            </div>
          </div>

        </div>

        <div id="results" class="list"></div>
      </div>
    </div>
  `;

	const $q = document.getElementById("q");
	const $results = document.getElementById("results");
	const $clearSearch = document.getElementById("clearSearch");
	const $sort = document.getElementById("sort");
	const $avail = document.getElementById("avail");

	const LS_SORT = "viz:searchSort";
	const LS_AVAIL = "viz:searchAvail";
	const LS_TYPE  = "viz:searchType";
	const LS_STORESET = "viz:searchStoreSet";
	if ($sort && localStorage.getItem(LS_SORT))
		$sort.value = String(localStorage.getItem(LS_SORT) || "newest");
	if ($avail && localStorage.getItem(LS_AVAIL))
		$avail.value = String(localStorage.getItem(LS_AVAIL) || "all");

	const $spiritFilter  = document.getElementById("spiritFilter");
	const $spiritTrigger = document.getElementById("spiritFilterTrigger");
	const $spiritPanel   = document.getElementById("spiritFilterPanel");
	const $spiritLabel   = document.getElementById("spiritFilterLabel");

	let selectedTypeSet = new Set();
	try {
		const saved = JSON.parse(localStorage.getItem(LS_TYPE) || "[]");
		if (Array.isArray(saved)) selectedTypeSet = new Set(saved);
	} catch {}

	// Store-set filter: a shared spec (presets / ad-hoc). Seed from the URL hash
	// (?stores=…) so a filtered view is shareable, falling back to localStorage.
	function readStoreSetFromUrl() {
		const h = location.hash || "";
		const qi = h.indexOf("?");
		if (qi === -1) return null;
		return new URLSearchParams(h.slice(qi + 1)).get("stores");
	}
	const urlStoreSet = readStoreSetFromUrl();
	let storeSetSpec = parseStoreSet(urlStoreSet != null ? urlStoreSet : localStorage.getItem(LS_STORESET) || "");
	// The signed-in user's saved "My Stores" ids (loaded with page data; null until known).
	let myStoresRef = null;
	// Set<storeId> | null (null = all stores, no filter).
	let resolvedStoreIdSet = resolveStoreSet(storeSetSpec, { myStores: myStoresRef });

	const favSet = new Set();
	installFavStars($results, favSet);

	// Delegated navigation — items are appended incrementally by the pager, so a
	// single listener on the container covers all current and future cards.
	$results.addEventListener("click", (e) => {
		if (e.target.closest(".favStarBtn")) return;
		const el = e.target.closest(".item");
		if (!el) return;
		const sku = el.getAttribute("data-sku") || "";
		if (!sku) return;
		saveQuery($q.value);
		openOrNavigateTo(e, `#/item/${encodeURIComponent(sku)}`);
	});

	const $logoutBtn = document.getElementById("logoutBtn");
	if ($logoutBtn) {
		$logoutBtn.addEventListener("click", (e) => {
			e.preventDefault();
			logoutAndReload();
		});
	}

	const $storesBtn = document.getElementById("storesBtn");
	if ($storesBtn) {
		$storesBtn.addEventListener("click", () => saveCurrentRoute());
	}

	const $shortlistBtn = document.getElementById("shortlistBtn");
	if ($shortlistBtn) {
		$shortlistBtn.addEventListener("click", () => saveCurrentRoute());
	}

	$q.value = loadSavedQuery();

	let aggBySku = new Map();
	let allAgg = [];
	let indexReady = false;
	let rulesRef = null;
	let recentCache = null;
	let rarityRef = null;
	let hiddenSetRef = new Set();

	// storeNorm -> canonical storeId (built during data loading)
	let storeNormToStoreId = new Map();
	// Set<storeNorm> | null (null = no filter, all stores)
	let resolvedStoreNorms = null;

	// sku -> earliest firstSeenAt across any row (ms)
	let firstSeenMsBySku = new Map();
	// sku -> latest event ms (any kind, within recent window we build)
	let latestEventMsBySku = new Map();
	// sku -> most recent event that changed GLOBAL min price (across stores), within window
	let globalSaleMetaBySku = new Map(); // sku -> { ms, pct, delta }
	// sku -> events[] (kept for filter-aware sale recompute)
	let recentEventsBySku = new Map();

	// canonicalSku -> storeLabel -> url
	let URL_BY_SKU_STORE = new Map();

	// sku -> Set(storeNorm) / etc (LIVE = !removed)
	let liveStoresBySku = new Map();
	let everStoresBySku = new Map();
	let storeDisplayByNorm = new Map(); // norm -> display label
	let liveMinPriceBySkuStore = new Map(); // sku -> Map(storeNorm -> min price)
	// sku -> cheapest last-known price across REMOVED rows. Out-of-stock items have no
	// live price, so this is what price-sort + the card fall back to for them.
	let lastKnownMinPriceBySku = new Map();

	function buildUrlMap(listings, canonicalSkuFn) {
		const out = new Map();
		for (const r of Array.isArray(listings) ? listings : []) {
			if (!r || r.removed) continue;

			const skuKey = String(keySkuForRow(r) || "").trim();
			if (!skuKey) continue;

			const sku = String(canonicalSkuFn ? canonicalSkuFn(skuKey) : skuKey);
			if (!sku) continue;

			const storeLabel = String(r.storeLabel || r.store || "").trim();
			const url = String(r.url || "").trim();
			if (!storeLabel || !url) continue;

			let m = out.get(sku);
			if (!m) out.set(sku, (m = new Map()));
			if (!m.has(storeLabel)) m.set(storeLabel, url);
		}
		return out;
	}

	function urlForAgg(it, storeLabel) {
		const sku = String(it?.sku || "");
		const s = String(storeLabel || "");
		return URL_BY_SKU_STORE.get(sku)?.get(s) || "";
	}

	function normStoreKey(s) {
		return String(s || "")
			.trim()
			.toLowerCase();
	}

	function stockMetaForSku(sku) {
		const live = liveStoresBySku.get(sku) || new Set();
		const ever = everStoresBySku.get(sku) || new Set();
		const storeCount = live.size || 0;
		const outOfStock = storeCount === 0;
		const soloLive = storeCount === 1;
		const lastStock = !outOfStock && soloLive && ever.size > 1;
		const exclusive = !outOfStock && soloLive && !lastStock;
		return { storeCount, outOfStock, lastStock, exclusive };
	}

	function bestLiveStoreForSku(sku, normsSet) {
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m) return { storeNorm: "", storeLabel: "", priceNum: null };

		const EPS = 0.01;
		let best = null;
		let bestStore = "";
		for (const [st, p] of m.entries()) {
			if (!Number.isFinite(p)) continue;
			if (normsSet && !normsSet.has(st)) continue;
			if (best === null || p < best - EPS || (Math.abs(p - best) <= EPS && st < bestStore)) {
				best = p;
				bestStore = st;
			}
		}
		const storeLabel = bestStore ? storeDisplayByNorm.get(bestStore) || "" : "";
		return { storeNorm: bestStore, storeLabel, priceNum: best };
	}

	function priceStrFromNum(n) {
		return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
	}

	function sortMode() {
		return String($sort?.value || "newest");
	}

	function availMode() {
		return String($avail?.value || "all");
	}

	// Availability is the ONLY membership gate. The store selection is a scoping lens,
	// not a filter: under "all" it never removes an item. Under "in"/"out" it scopes the
	// stock test to the selected stores (in = live at a selected store; out = ever carried
	// at a selected store but not currently live there — "carried-but-OOS").
	function passesAvailability(sku) {
		const m = availMode();
		if (m === "all") return true;
		const s = String(sku || "");

		if (resolvedStoreNorms) {
			const live = liveStoresBySku.get(s);
			let inSelected = false;
			if (live) {
				for (const st of resolvedStoreNorms) {
					if (live.has(st)) { inSelected = true; break; }
				}
			}
			if (m === "in") return inSelected;
			if (m === "out") {
				if (inSelected) return false;
				const ever = everStoresBySku.get(s);
				if (!ever) return false;
				for (const st of resolvedStoreNorms) {
					if (ever.has(st)) return true;
				}
				return false;
			}
			return true;
		}

		const st = stockMetaForSku(s);
		if (m === "in") return !st.outOfStock;
		if (m === "out") return !!st.outOfStock;
		return true;
	}

	function computeResolvedStoreNorms() {
		if (!resolvedStoreIdSet || !storeNormToStoreId.size) return null;
		const norms = new Set();
		for (const [norm, id] of storeNormToStoreId) {
			if (resolvedStoreIdSet.has(id)) norms.add(norm);
		}
		return norms.size > 0 ? norms : null;
	}

	function passesType(it) {
		if (!selectedTypeSet.size) return true;
		const st = it?.spiritTypes;
		if (!st || !st.size) return true;
		for (const t of selectedTypeSet) {
			if (st.has(t)) return true;
		}
		return false;
	}

	function eventMsRecent(r) {
		const t = String(r?.ts || "");
		const ms = t ? Date.parse(t) : NaN;
		if (Number.isFinite(ms)) return ms;
		const d = String(r?.date || "");
		const ms2 = d ? Date.parse(d + "T00:00:00Z") : NaN;
		return Number.isFinite(ms2) ? ms2 : 0;
	}

	function normalizeKindForPrice(r) {
		let kind = String(r?.kind || "");
		if (kind === "price_change") {
			const o = parsePriceToNumber(r?.oldPrice || "");
			const n = parsePriceToNumber(r?.newPrice || "");
			if (Number.isFinite(o) && Number.isFinite(n)) {
				if (n < o) kind = "price_down";
				else if (n > o) kind = "price_up";
				else kind = "price_change";
			}
		}
		return kind;
	}

	function minFinite(vals) {
		let best = null;
		for (const v of vals) {
			if (!Number.isFinite(v)) continue;
			best = best === null ? v : Math.min(best, v);
		}
		return best;
	}

	// Find most recent event (within window) that changed the GLOBAL min price (across stores)
	// Find most recent event (within window) that changed the CURRENT GLOBAL min price (across stores),
	// but only when that min change was caused by a store price change (up/down), not stock churn.
	function computeGlobalSaleMetaForSku(sku, evts, normsSet) {
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m || m.size === 0) return null;
		if (!Array.isArray(evts) || !evts.length) return null;

		// state = storeNorm -> current live min price for that store
		let state;
		if (normsSet) {
			state = new Map();
			for (const [st, p] of m.entries()) {
				if (normsSet.has(st)) state.set(st, p);
			}
			if (state.size === 0) return null;
		} else {
			state = new Map(m);
		}
		const EPS = 0.01;

		function globalMin(st) {
			return minFinite(st.values());
		}

		// CURRENT cheapest price (now)
		const currentMin = globalMin(state);
		if (!Number.isFinite(currentMin)) return null;

		const sorted = evts.slice()
			.filter((e) => !normsSet || normsSet.has(e.storeNorm))
			.sort((a, b) => {
				if (b.ms !== a.ms) return b.ms - a.ms;
				return String(a.storeNorm).localeCompare(String(b.storeNorm));
			});

		for (const e of sorted) {
			const afterMin = globalMin(state);
			if (!Number.isFinite(afterMin)) return null;

			// Once we've rolled back past the chain that produces *current* cheapest,
			// older events are not relevant for "recent cheapest price change".
			if (Math.abs(afterMin - currentMin) > EPS) break;

			// rollback e
			const next = new Map(state);

			if (e.kind === "removed") {
				// store was removed after this event; rollback = restore its prior price
				if (Number.isFinite(e.priceNum)) next.set(e.storeNorm, e.priceNum);
			} else if (e.kind === "new" || e.kind === "restored") {
				// store didn't exist before this event; rollback = remove it
				next.delete(e.storeNorm);
			} else if (e.kind === "price_down" || e.kind === "price_up" || e.kind === "price_change") {
				// rollback = restore old price
				if (Number.isFinite(e.oldNum)) next.set(e.storeNorm, e.oldNum);
			}

			const beforeMin = globalMin(next);
			if (!Number.isFinite(beforeMin)) return null;

			if (Math.abs(beforeMin - afterMin) > EPS) {
				const isPriceEvt =
					e.kind === "price_down" || e.kind === "price_up" || e.kind === "price_change";
				// If the first movement of the CURRENT cheapest was caused by stock churn, do not badge/sort.
				if (!isPriceEvt) return null;

				const delta = afterMin - beforeMin; // negative = down
				const pct = beforeMin > 0 ? Math.round(((afterMin - beforeMin) / beforeMin) * 100) : 0;
				return { delta, pct, ms: e.ms };
			}

			state = next;
		}

		return null;
	}

	// Build cross-page sort metadata from /recent:
	// - newest (for recent preload): latestEventMsBySku
	// - sale: only when the changed price is the CURRENT GLOBAL min price
	function rebuildRecentMeta(recent, canonSkuFn) {
		latestEventMsBySku = new Map();
		globalSaleMetaBySku = new Map();
		recentEventsBySku = new Map();

		const rawItems = Array.isArray(recent?.items) ? recent.items : [];
		const items = hiddenSetRef && hiddenSetRef.size > 0
			? rawItems.filter((r) => !isHiddenListing(hiddenSetRef, normalizeStoreId(r?.storeLabel || r?.store || ""), String(r?.sku || "").trim()))
			: rawItems;
		if (!items.length) return;

		const RECENT_DAYS = 7;
		const nowMs = Date.now();
		const cutoffMs = nowMs - RECENT_DAYS * 24 * 60 * 60 * 1000;

		const canon = typeof canonSkuFn === "function" ? canonSkuFn : (x) => x;

		// sku -> events[]
		const eventsBySku = new Map();

		for (const r of items) {
			const ms = eventMsRecent(r);
			if (!(ms >= cutoffMs && ms <= nowMs)) continue;

			const rawSku = String(r?.sku || "").trim();
			if (!rawSku) continue;
			const sku = String(canon(rawSku) || "").trim();
			if (!sku) continue;

			// newest (any kind)
			{
				const prev = latestEventMsBySku.get(sku) || 0;
				if (ms > prev) latestEventMsBySku.set(sku, ms);
			}

			const storeLabel = String(r?.storeLabel || r?.store || "").trim();
			const storeNorm = normStoreKey(storeLabel);
			if (!storeNorm) continue;

			const kind = normalizeKindForPrice(r);

			const oldNum = parsePriceToNumber(r?.oldPrice || "");
			const newNum = parsePriceToNumber(r?.newPrice || "");
			const priceNum = parsePriceToNumber(r?.price || "");

			let arr = eventsBySku.get(sku);
			if (!arr) eventsBySku.set(sku, (arr = []));
			arr.push({ ms, storeNorm, kind, oldNum, newNum, priceNum });
		}

		recentEventsBySku = eventsBySku;

		for (const [sku, evts] of eventsBySku.entries()) {
			const meta = computeGlobalSaleMetaForSku(sku, evts);
			if (meta) globalSaleMetaBySku.set(sku, meta);
		}
	}

	function addedMsForSku(sku) {
		const raw = String(sku || "");
		const s = rulesRef?.canonicalSku ? String(rulesRef.canonicalSku(raw) || raw) : raw;

		const ms = firstSeenMsBySku.get(s);
		if (Number.isFinite(ms)) return ms;

		const fallback = latestEventMsBySku.get(s);
		return Number.isFinite(fallback) ? fallback : 0;
	}

	function salePctForSku(sku) {
		const s = String(sku || "");
		if (resolvedStoreNorms) {
			const evts = recentEventsBySku.get(s) || [];
			const meta = computeGlobalSaleMetaForSku(s, evts, resolvedStoreNorms);
			return meta && Number.isFinite(meta.pct) ? meta.pct : null;
		}
		const m = globalSaleMetaBySku.get(s);
		return m && Number.isFinite(m.pct) ? m.pct : null;
	}

	function saleDeltaForSku(sku) {
		const s = String(sku || "");
		if (resolvedStoreNorms) {
			const evts = recentEventsBySku.get(s) || [];
			const meta = computeGlobalSaleMetaForSku(s, evts, resolvedStoreNorms);
			return meta && Number.isFinite(meta.delta) ? meta.delta : null;
		}
		const m = globalSaleMetaBySku.get(s);
		return m && Number.isFinite(m.delta) ? m.delta : null;
	}

	function saleBadgeHtmlForSku(sku, mode) {
		const s = String(sku || "");
		let sm;
		if (resolvedStoreNorms) {
			const evts = recentEventsBySku.get(s) || [];
			sm = computeGlobalSaleMetaForSku(s, evts, resolvedStoreNorms) || null;
		} else {
			sm = globalSaleMetaBySku.get(s) || null;
		}
		if (!sm) return "";

		const pct = Number.isFinite(sm.pct) ? sm.pct : 0;
		const delta = Number.isFinite(sm.delta) ? sm.delta : 0;

		if (mode === "saleAbs") {
			const abs = Math.round(Math.abs(delta));
			if (!abs) return "";
			if (delta < 0) return `<span class="badge badgeGood">$${esc(abs)} off</span>`;
			return `<span class="badge badgeBad">+$${esc(abs)}</span>`;
		}

		const abs = Math.abs(pct);
		if (!abs) return "";
		if (pct < 0) return `<span class="badge badgeGood">${esc(abs)}% off</span>`;
		return `<span class="badge badgeBad">+${esc(abs)}%</span>`;
	}

	const priceNumCache = new Map(); // sku -> priceNum|null
	function priceNumForSku(sku) {
		const s = String(sku || "");
		if (priceNumCache.has(s)) return priceNumCache.get(s);
		const best = bestLiveStoreForSku(s, resolvedStoreNorms);
		let n = Number.isFinite(best?.priceNum) ? best.priceNum : null;
		if (n === null) {
			// Out of stock everywhere — sort by its cheapest last-known price.
			const last = lastKnownMinPriceBySku.get(s);
			if (Number.isFinite(last)) n = last;
		}
		priceNumCache.set(s, n);
		return n;
	}

	function rarityForSku(rawSku) {
		if (!rarityRef || !rulesRef) return null;
		const canon = rulesRef.canonicalSku(String(rawSku || ""));
		const entry = rarityRef.byCanon?.[canon];
		if (!entry) return null;
		// Sort by effective rarity (confidence-shrunk) so the order matches the
		// tier classification used for styling.
		return effectiveRarity(entry.r, entry.c);
	}

	// ---- Shared infinite-scroll pager ----
	// Both renderAggregates (full catalog) and renderRecent (activity feed) page
	// through a sorted array instead of slicing to a hard cap, so every sort/filter
	// combination is effectively infinite.
	const PAGE_SIZE = 60;
	let pager = null; // { destroy } | null

	function clearPager() {
		if (pager) {
			pager.destroy();
			pager = null;
		}
	}

	function startPager(list, renderItemHtml, { headerHtml = "", emptyHtml = `<div class="small" style="padding: 18px 4px;">No matches. Try fewer words, or widen the store and availability filters.</div>` } = {}) {
		clearPager();

		if (!list.length) {
			$results.innerHTML = headerHtml + emptyHtml;
			return;
		}

		$results.innerHTML = headerHtml + `<div id="searchSentinel" class="small searchSentinel"></div>`;
		const $sentinel = document.getElementById("searchSentinel");
		let shown = 0;

		function renderNext() {
			const slice = list.slice(shown, shown + PAGE_SIZE);
			shown += slice.length;
			if (slice.length) {
				$sentinel.insertAdjacentHTML("beforebegin", slice.map(renderItemHtml).join(""));
				decorateRarity($results);
			}
			if (shown >= list.length) {
				$sentinel.textContent = list.length > PAGE_SIZE ? `Showing all ${list.length}` : "";
				if (pager) {
					pager.destroy();
					pager = null;
				}
			} else {
				$sentinel.textContent = `Showing ${shown} / ${list.length}…`;
			}
		}

		renderNext();
		if (shown < list.length) {
			pager = createInfiniteScroll({ sentinel: $sentinel, onLoadMore: renderNext });
		}
	}

	function aggregateCardHtml(it, mode) {
		const sku = String(it?.sku || "");
		const stock = stockMetaForSku(sku);
		const plus = stock.storeCount > 1 ? ` +${stock.storeCount - 1}` : "";

		const best = bestLiveStoreForSku(sku, resolvedStoreNorms);
		const store = !stock.outOfStock
			? best.storeLabel || it.cheapestStoreLabel || [...(it.stores || [])][0] || "Store"
			: "";

		const lastKnown = lastKnownMinPriceBySku.get(sku);
		const price =
			(best.priceNum !== null ? priceStrFromNum(best.priceNum) : "") ||
			(it.cheapestPriceStr ? it.cheapestPriceStr : "") ||
			(stock.outOfStock && Number.isFinite(lastKnown) ? priceStrFromNum(lastKnown) : "") ||
			"(no price)";

		const saleBadge = saleBadgeHtmlForSku(sku, mode);

		const stockBadge = stock.outOfStock
			? `<span class="badge badgeBad">OUT OF STOCK</span>`
			: "";
		const specialBadge = stock.lastStock
			? `<span class="badge badgeLastStock">Last Stock</span>`
			: stock.exclusive
				? `<span class="badge badgeExclusive">Exclusive</span>`
				: "";

		const storeHref =
			store && !stock.outOfStock
				? urlForAgg(it, store) || String(it.sampleUrl || "").trim()
				: "";
		const storeHtml =
			store && !stock.outOfStock
				? storeHref
					? `<a class="itemStore" href="${esc(storeHref)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(store)}${esc(plus)}</a>`
					: `<span class="itemStore">${esc(store)}${esc(plus)}</span>`
				: "";

		const skuLink = `#/link/?left=${encodeURIComponent(String(it.sku || ""))}`;

		return `
			<div class="item itemHasStar" data-sku="${esc(it.sku)}">
				<div class="itemTitle">
          <div class="itemName">${esc(it.name || "(no name)")}</div>
          <a class="badge mono skuLink" href="${esc(skuLink)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(displaySku(it.sku))}</a>
          ${favStarHtml(it.sku, favSet.has(it.sku))}
        </div>
				<div class="itemRow">
          <div class="thumbBox">
            ${renderThumbHtml(it.img)}
          </div>
          <div class="itemBody">
            <div class="itemLine1">${storeHtml}<span class="price">${esc(price)}</span></div>
            <div class="metaRow">${saleBadge}${stockBadge}${specialBadge}</div>
          </div>
        </div>
      </div>
    `;
	}

	function renderAggregates(items) {
		priceNumCache.clear();

		let list = items.filter((it) => passesAvailability(String(it?.sku || "")));

		// "activity" only governs the empty-query feed; if a sort-with-query lands
		// here while activity is selected, order by recency (newest) like the feed.
		const mode = sortMode() === "activity" ? "newest" : sortMode();

		function nameKey(it) {
			return (String(it?.name || "") + "|" + String(it?.sku || "")).toLowerCase();
		}

		list = list.slice().sort((a, b) => {
			const as = String(a?.sku || "");
			const bs = String(b?.sku || "");

			// SEARCH RESULTS: newest = firstSeenAt (added to DB)
			if (mode === "newest") {
				const av = addedMsForSku(as);
				const bv = addedMsForSku(bs);
				if (bv !== av) return bv - av;
				return nameKey(a).localeCompare(nameKey(b));
			}

			if (mode === "priceAsc" || mode === "priceDesc") {
				const ap = priceNumForSku(as);
				const bp = priceNumForSku(bs);
				if (ap === null && bp === null) return nameKey(a).localeCompare(nameKey(b));
				if (ap === null) return 1;
				if (bp === null) return -1;
				if (ap !== bp) return mode === "priceAsc" ? ap - bp : bp - ap;
				return nameKey(a).localeCompare(nameKey(b));
			}

			if (mode === "salePct") {
				const ap = salePctForSku(as);
				const bp = salePctForSku(bs);
				const aKey = ap === null ? 999999 : ap;
				const bKey = bp === null ? 999999 : bp;
				if (aKey !== bKey) return aKey - bKey;
				return nameKey(a).localeCompare(nameKey(b));
			}

			if (mode === "saleAbs") {
				const ad = saleDeltaForSku(as);
				const bd = saleDeltaForSku(bs);
				const aKey = ad === null ? 999999 : ad;
				const bKey = bd === null ? 999999 : bd;
				if (aKey !== bKey) return aKey - bKey;
				return nameKey(a).localeCompare(nameKey(b));
			}

			if (mode === "rarityDesc" || mode === "rarityAsc") {
				const ar = rarityForSku(as);
				const br = rarityForSku(bs);
				if (ar === null && br === null) return nameKey(a).localeCompare(nameKey(b));
				if (ar === null) return 1;
				if (br === null) return -1;
				if (ar !== br) return mode === "rarityDesc" ? br - ar : ar - br;
				return nameKey(a).localeCompare(nameKey(b));
			}

			return nameKey(a).localeCompare(nameKey(b));
		});

		startPager(list, (it) => aggregateCardHtml(it, mode));
	}

	function renderRecent(recent, canonicalSkuFn) {
		const rawItems = Array.isArray(recent?.items) ? recent.items : [];
		const items = hiddenSetRef && hiddenSetRef.size > 0
			? rawItems.filter((r) => !isHiddenListing(hiddenSetRef, normalizeStoreId(r?.storeLabel || r?.store || ""), String(r?.sku || "").trim()))
			: rawItems;
		if (!items.length) {
			clearPager();
			$results.innerHTML = `<div class="small">Type to search…</div>`;
			return;
		}

		const canon = typeof canonicalSkuFn === "function" ? canonicalSkuFn : (x) => x;

		// Use everything in recent.json — the backend already bounds the window
		// (RECENT_DAYS in tools/build_viz_recent.js). Client-side, we let the
		// 140-item display cap below provide the natural cutoff so the feed
		// surfaces older legitimate restocks/arrivals when nothing fresh is
		// happening today.
		const nowMs = Date.now();
		// "In stock only" must not surface removal events — a removal at one store badges
		// the row OUT OF STOCK even when the item is still live elsewhere. Dropping them
		// from the pool (before the per-SKU latest pick) lets an older in-stock-relevant
		// event surface instead, or the row falls away entirely.
		const hideRemovals = availMode() === "in";
		const inWindow = items.filter((r) => {
			const ms = eventMsRecent(r);
			if (ms > nowMs) return false;
			if (hideRemovals && normalizeKindForPrice(r) === "removed") return false;
			return true;
		});

		if (!inWindow.length) {
			clearPager();
			$results.innerHTML = `<div class="small">No recent changes.</div>`;
			return;
		}

		// "Recent activity" surfaces the latest notable event of ANY kind per sku
		// (new / restored / removed / price up / price down) — not just market-wide
		// arrivals. Keeping the single most-recent event per sku keeps the feed one
		// row per product rather than a flood of per-store churn.
		// Activity is store-scoped: an event only counts for the filtered set if it
		// HAPPENED at a store in the set. (A canonical item can be carried at a
		// filtered store while the recent change occurred at a different store — e.g.
		// an AMRUT price flap at ARC must not surface under a Tudor-only filter.)
		// So the per-SKU "latest event" is the latest one at a filtered store, and an
		// item with no events at any filtered store drops out entirely.
		const eventStoreId = (r) => normalizeStoreId(String(r?.storeLabel || r?.store || "").trim());

		// Store selection is a SCOPE here, not a hard drop: an event at a selected store
		// ("scoped") sorts first, but non-selected activity is still reachable by scrolling
		// (under "all"). We track the latest event per SKU twice — latest at ANY store and
		// latest at a SELECTED store — and display/order by the scoped one when present. The
		// in/out availability test below is what actually narrows the set store-scoped; under
		// "all" it narrows nothing, so every item remains and only the ORDER reflects the set.
		const bySku = new Map(); // sku -> { rAny, msAny, rScoped, msScoped }
		for (const r of inWindow) {
			const rawSku = String(r?.sku || "").trim();
			if (!rawSku) continue;
			const sku = String(canon(rawSku) || "").trim();
			if (!sku) continue;
			const ms = eventMsRecent(r);
			let e = bySku.get(sku);
			if (!e) bySku.set(sku, (e = { rAny: null, msAny: -1, rScoped: null, msScoped: -1 }));
			if (ms > e.msAny) { e.msAny = ms; e.rAny = r; }
			if (resolvedStoreIdSet && resolvedStoreIdSet.has(eventStoreId(r)) && ms > e.msScoped) {
				e.msScoped = ms;
				e.rScoped = r;
			}
		}

		let picked = Array.from(bySku.entries()).map(([sku, e]) => {
			const scoped = e.rScoped != null;
			return { sku, scoped, r: scoped ? e.rScoped : e.rAny, ms: scoped ? e.msScoped : e.msAny };
		});

		// Spirit type filter (applied before market-wide filter for efficiency)
		if (selectedTypeSet.size) {
			picked = picked.filter(({ sku }) => {
				const agg = aggBySku.get(sku);
				if (!agg?.spiritTypes?.size) return true;
				for (const t of selectedTypeSet) {
					if (agg.spiritTypes.has(t)) return true;
				}
				return false;
			});
		}

		// Market-wide gate applies only to arrivals/restocks: a "new" event surfaces
		// only if the item is at <=1 store overall (truly new to market, not just new
		// at one store), and a "restored" event only if it's currently at <=1 store
		// (gone everywhere, just back). Removals and price moves are inherently
		// notable, so they always pass.
		picked = picked.filter((x) => {
			const sku = String(x.sku || "");
			if (!passesAvailability(sku)) return false;
			const k = normalizeKindForPrice(x.r);
			const agg = aggBySku.get(sku) || null;
			const stock = stockMetaForSku(sku);
			if (k === "new") return (agg?.stores?.size ?? stock.storeCount) <= 1;
			if (k === "restored") return stock.storeCount <= 1;
			return true;
		});

		const mode = sortMode();

		function nameKey(r, sku) {
			return (String(r?.name || "") + "|" + String(sku || "")).toLowerCase();
		}

		// RECENT PRELOAD: newest = event time
		picked.sort((a, b) => {
			const as = String(a.sku || "");
			const bs = String(b.sku || "");

			// Selected-store activity always surfaces first (scope, not filter).
			if (a.scoped !== b.scoped) return a.scoped ? -1 : 1;

			if (mode === "salePct") {
				const ap = salePctForSku(as);
				const bp = salePctForSku(bs);
				const aKey = ap === null ? 999999 : ap;
				const bKey = bp === null ? 999999 : bp;
				if (aKey !== bKey) return aKey - bKey;
				if (b.ms !== a.ms) return b.ms - a.ms;
				return nameKey(a.r, as).localeCompare(nameKey(b.r, bs));
			}

			if (mode === "saleAbs") {
				const ad = saleDeltaForSku(as);
				const bd = saleDeltaForSku(bs);
				const aKey = ad === null ? 999999 : ad;
				const bKey = bd === null ? 999999 : bd;
				if (aKey !== bKey) return aKey - bKey;
				if (b.ms !== a.ms) return b.ms - a.ms;
				return nameKey(a.r, as).localeCompare(nameKey(b.r, bs));
			}

			if (mode === "newest") {
				if (b.ms !== a.ms) return b.ms - a.ms;
				return nameKey(a.r, as).localeCompare(nameKey(b.r, bs));
			}

			if (b.ms !== a.ms) return b.ms - a.ms;
			return nameKey(a.r, as).localeCompare(nameKey(b.r, bs));
		});

		startPager(picked, ({ r, sku, scoped }) => recentCardHtml(r, sku, mode, scoped), {
			headerHtml: `<div class="small">Recently changed:</div>`,
			emptyHtml: `<div class="small">No recent changes.</div>`,
		});
	}

	function recentCardHtml(r, sku, mode, scoped) {
		const kind = normalizeKindForPrice(r);

		const kindLabel =
			kind === "new"
				? "JUST LANDED"
				: kind === "restored"
					? "BACK IN STOCK"
					: kind === "removed"
						? "OUT OF STOCK"
						: kind === "price_down"
							? "ON SALE"
							: kind === "price_up"
								? "PRICE UP"
								: "CHANGE";

		const kindBadgeClass =
			kind === "new" || kind === "restored"
				? "badgeAccent"
				: kind === "removed" || kind === "price_up"
					? "badgeBad"
					: kind === "price_down"
						? "badgeGood"
						: "";

		const agg = aggBySku.get(sku) || null;
		const img = agg?.img || "";

		// Scoped rows show the cheapest price within the selected stores; non-scoped rows
		// (surfaced under "all" because their activity was at a non-selected store) fall back
		// to the global cheapest so the card isn't priceless.
		let priceLine;
		if (resolvedStoreNorms && scoped) {
			const best = bestLiveStoreForSku(sku, resolvedStoreNorms);
			priceLine = best.priceNum !== null
				? priceStrFromNum(best.priceNum)
				: (agg?.cheapestPriceStr || r.newPrice || r.price || "");
		} else {
			priceLine = agg?.cheapestPriceStr || r.newPrice || r.price || "";
		}

		const stock = stockMetaForSku(sku);
		const plus = stock.storeCount > 1 ? ` +${stock.storeCount - 1}` : "";

		const stockBadge = stock.outOfStock
			? `<span class="badge badgeBad">OUT OF STOCK</span>`
			: "";
		const specialBadge = stock.lastStock
			? `<span class="badge badgeLastStock">Last Stock</span>`
			: stock.exclusive
				? `<span class="badge badgeExclusive">Exclusive</span>`
				: "";

		const storeHref = String(r.url || "").trim();
		const storeLabel = (r.storeLabel || r.store || "") + plus;
		const storeHtml = storeLabel
			? storeHref
				? `<a class="itemStore" href="${esc(storeHref)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(storeLabel)}</a>`
				: `<span class="itemStore">${esc(storeLabel)}</span>`
			: "";

		const saleBadge = saleBadgeHtmlForSku(sku, mode);

		const skuLink = `#/link/?left=${encodeURIComponent(String(sku || ""))}`;

		return `
			<div class="item itemHasStar" data-sku="${esc(sku)}">
			<div class="itemTitle">
        <div class="itemName">${esc(r.name || "(no name)")}</div>
        <a class="badge mono skuLink" href="${esc(skuLink)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(displaySku(sku))}</a>
        ${favStarHtml(sku, favSet.has(sku))}
      </div>
			<div class="itemRow">
        <div class="thumbBox">
          ${renderThumbHtml(img)}
        </div>
        <div class="itemBody">
          <div class="itemLine1">${storeHtml}<span class="price">${esc(priceLine)}</span></div>
          <div class="metaRow"><span class="badge ${kindBadgeClass}">${esc(kindLabel)}</span>${saleBadge}${kind !== "removed" ? stockBadge : ""}${specialBadge}</div>
        </div>
      </div>
    </div>
  `;
	}

	function renderCurrent() {
		if (!indexReady) return;

		const tokens = tokenizeQuery($q.value);
		if (!tokens.length) {
			// "Recent activity" is the only mode that shows the curated event feed.
			// Every other sort (incl. Newest) lists the FULL catalog with infinite
			// scroll, so "Newest + Rum + In stock" returns the whole rum catalog,
			// not just the handful of market-wide arrivals in recent.json.
			if (sortMode() === "activity") {
				if (recentCache) renderRecent(recentCache, rulesRef?.canonicalSku);
				else {
					clearPager();
					$results.innerHTML = `<div class="small">No recent changes.</div>`;
				}
			} else {
				const typeFiltered = selectedTypeSet.size ? allAgg.filter(passesType) : allAgg;
				renderAggregates(typeFiltered);
			}
			return;
		}

		const typeFiltered = selectedTypeSet.size ? allAgg.filter(passesType) : allAgg;
		const matches = typeFiltered.filter((it) => matchesAllTokens(it.searchText, tokens));

		const wantCodes = new Set(smwsDistilleryCodesForQueryPrefix($q.value));
		if (!wantCodes.size) {
			renderAggregates(matches);
			return;
		}

		const seen = new Set(matches.map((it) => String(it?.sku || "")));
		const extra = [];
		for (const it of typeFiltered) {
			const sku = String(it?.sku || "");
			if (!sku || seen.has(sku)) continue;
			const dCode = smwsDistilleryCodeFromName(it?.name || "");
			if (dCode && wantCodes.has(String(dCode))) {
				extra.push(it);
				seen.add(sku);
			}
		}

		renderAggregates([...extra, ...matches]);
	}

	$results.innerHTML = `<div class="small">Loading index…</div>`;


	Promise.all([
		loadIndex(),
		loadSkuRules(),
		loadMyFavouritesSet(),
		loadRecent().catch(() => null),
		loadRarity().catch(() => null),
		loadHiddenSet().catch(() => new Set()),
		authed ? getMyStores().catch(() => []) : Promise.resolve([]),
	])
		.then(([idx, rules, fav, recent, rarity, hiddenSet, myStores]) => {
			rulesRef = rules;
			recentCache = recent;
			rarityRef = rarity;
			hiddenSetRef = hiddenSet || new Set();
			myStoresRef = Array.isArray(myStores) ? myStores.filter((x) => typeof x === "string") : [];
			resolvedStoreIdSet = resolveStoreSet(storeSetSpec, { myStores: myStoresRef });

			favSet.clear();
			for (const k of fav.set) {
				const raw = String(k || "");
				favSet.add(String(rules.canonicalSku(raw) || raw));
			}

			const rawListings = Array.isArray(idx.items) ? idx.items : [];
			const listings = hiddenSet && hiddenSet.size > 0
				? rawListings.filter((r) => !isHiddenListing(hiddenSet, normalizeStoreId(r?.storeLabel || r?.store || ""), keySkuForRow(r)))
				: rawListings;

			liveStoresBySku = new Map();
			everStoresBySku = new Map();
			storeNormToStoreId = new Map();
			storeDisplayByNorm = new Map();
			liveMinPriceBySkuStore = new Map();
			lastKnownMinPriceBySku = new Map();
			firstSeenMsBySku = new Map();

			for (const r of listings) {
				if (!r) continue;

				// --- KEY FIX FOR "NEWEST" ---
				// Compute sku + firstSeenAt even if storeLabel is missing (common on removed/out-of-stock rows)
				const skuKeyRaw = String(r?.sku || keySkuForRow(r) || "").trim();
				if (!skuKeyRaw) continue;

				const sku = String(rules.canonicalSku(skuKeyRaw) || skuKeyRaw);
				if (!sku) continue;

				{
					const t = String(r?.firstSeenAt || "").trim();
					const ms = t ? Date.parse(t) : NaN;
					if (Number.isFinite(ms)) {
						const prev = firstSeenMsBySku.get(sku);
						if (prev === undefined || ms < prev) firstSeenMsBySku.set(sku, ms);
					}
				}

				// Everything below needs a store label
				const storeLabel = String(r.storeLabel || r.store || "").trim();
				const stNorm = normStoreKey(storeLabel);
				if (!stNorm) continue;

				// ever stores includes removed
				{
					let ss = everStoresBySku.get(sku);
					if (!ss) everStoresBySku.set(sku, (ss = new Set()));
					ss.add(stNorm);
				}

				if (r.removed) {
					// Capture the last-known price so out-of-stock items remain sortable
					// (and showable) by price.
					const rp = parsePriceToNumber(r.price);
					if (rp !== null) {
						const prev = lastKnownMinPriceBySku.get(sku);
						if (prev === undefined || rp < prev) lastKnownMinPriceBySku.set(sku, rp);
					}
					continue;
				}

				// display label for store
				if (!storeDisplayByNorm.has(stNorm)) storeDisplayByNorm.set(stNorm, storeLabel);

				// live stores
				{
					let ss = liveStoresBySku.get(sku);
					if (!ss) liveStoresBySku.set(sku, (ss = new Set()));
					ss.add(stNorm);
				}

				// norm -> canonical storeId, for resolving the selected store set to norms
				{
					const storeId = normalizeStoreId(storeLabel);
					if (storeId && !storeNormToStoreId.has(stNorm)) storeNormToStoreId.set(stNorm, storeId);
				}

				// per-store live min price
				const p = parsePriceToNumber(r.price);
				if (p !== null) {
					let m = liveMinPriceBySkuStore.get(sku);
					if (!m) liveMinPriceBySkuStore.set(sku, (m = new Map()));
					const prev = m.get(stNorm);
					if (prev === undefined || p < prev) m.set(stNorm, p);
				}
			}

			resolvedStoreNorms = computeResolvedStoreNorms();

			allAgg = aggregateBySku(listings, rules.canonicalSku);
			const missing = allAgg
				.map((it) => String(it?.sku || ""))
				.filter((sku) => sku && !firstSeenMsBySku.has(sku));

			if (missing.length) console.warn("Missing firstSeenAt for SKUs:", missing.slice(0, 50));
			aggBySku = new Map(allAgg.map((x) => [String(x.sku || ""), x]));
			URL_BY_SKU_STORE = buildUrlMap(listings, rules.canonicalSku);

			indexReady = true;
			$q.focus();

			if (recentCache) rebuildRecentMeta(recentCache, rules.canonicalSku);
			renderCurrent();

			const $storeSet = document.querySelector(".searchControl .storeSet");
			if ($storeSet) {
				installStoreSetSelector({
					$container: $storeSet,
					spec: storeSetSpec,
					myStores: myStoresRef,
					authed,
					onChange: (next) => {
						storeSetSpec = next;
						resolvedStoreIdSet = resolveStoreSet(next, { myStores: myStoresRef });
						resolvedStoreNorms = computeResolvedStoreNorms();
						try { localStorage.setItem(LS_STORESET, serializeStoreSet(next)); } catch {}
						renderCurrent();
					},
				});
			}
		})
		.catch((e) => {
			$results.innerHTML = `<div class="small">Failed to load: ${esc(e.message)}</div>`;
		});

	$clearSearch.addEventListener("click", () => {
		if ($q.value) {
			$q.value = "";
			saveQuery("");
		}
		loadRecent()
			.then((recent) => {
				recentCache = recent;
				if (rulesRef) rebuildRecentMeta(recentCache, rulesRef.canonicalSku);
				renderCurrent();
			})
			.catch(() => renderCurrent());
		$q.focus();
	});

	let t = null;
	$q.addEventListener("input", () => {
		saveQuery($q.value);
		if (t) clearTimeout(t);
		t = setTimeout(() => {
			renderCurrent();
		}, 50);
	});

	if ($sort) {
		$sort.addEventListener("change", () => {
			localStorage.setItem(LS_SORT, String($sort.value || "newest"));
			renderCurrent();
		});
	}
	if ($avail) {
		$avail.addEventListener("change", () => {
			localStorage.setItem(LS_AVAIL, String($avail.value || "all"));
			renderCurrent();
		});
	}

	if ($spiritFilter) {
		installSpiritFilter({
			$container: $spiritFilter,
			$trigger:   $spiritTrigger,
			$panel:     $spiritPanel,
			$label:     $spiritLabel,
			selectedSet: selectedTypeSet,
			onChange: () => {
				try { localStorage.setItem(LS_TYPE, JSON.stringify([...selectedTypeSet])); } catch {}
				renderCurrent();
			},
		});
	}

}
