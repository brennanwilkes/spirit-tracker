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
import { smwsDistilleryCodesForQueryPrefix, smwsDistilleryCodeFromName } from "./smws.js";
import { favStarHtml, loadMyFavouritesSet, installFavStars } from "./fav_star.js";
import { getAuthStatus, logoutAndReload } from "./cloud.js";
import { saveCurrentRoute, openOrNavigateTo } from "./nav.js";
import { spiritFilterHtml, installSpiritFilter } from "./components/spirit_filter.js";
import { decorateRarity } from "./rarity_decorate.js";
import { effectiveRarity } from "./rarity.js";


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
			<a class="btn btnIcon" href="#/stats" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;">
				<i class="fa-solid fa-chart-line" aria-hidden="true"></i>
				<span class="srOnly">Statistics</span>
			</a>
			<a class="hideMobile btn btnIcon" href="#/link" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;">
				<i class="fa-solid fa-link" aria-hidden="true"></i>
				<span class="srOnly">Link SKUs</span>
			</a>
			<a id="storesBtn" class="btn btnIcon" href="#/stores" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;" aria-label="Stores">
				<i class="fa-solid fa-store" aria-hidden="true"></i>
				<span class="srOnly">Stores</span>
			</a>
			<a class="btn btnIcon" href="#/shortlists" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;" aria-label="Public shortlists">
				<i class="fa-solid fa-people-group" aria-hidden="true"></i>
				<span class="srOnly">Public Shortlists</span>
			</a>

			${
				authed
					? `

		<a id="shortlistBtn" class="btn btnWide" href="${shortlistHref}" style="text-decoration:none;">My Shortlist</a>
		<a class="btn btnIcon" href="#/settings" style="text-decoration:none; display:inline-flex; align-items:center; gap:8px;" aria-label="Settings">
		<i class="fa-solid fa-gear" aria-hidden="true"></i>
		<span class="srOnly">Settings</span>
	  </a>
	  <a id="logoutBtn" class="btn btnIcon" type="button"><i class="fa-solid fa-arrow-right-from-bracket"></i></a>
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
            <input id="q" class="input" placeholder="e.g. bowmore sherry, 303821, sierrasprings..." autocomplete="off" style="flex: 1 1 auto;" />
            <button id="clearSearch" class="btn btnSm" type="button" style="flex: 0 0 auto;">Clear</button>
          </div>

          <div class="searchControls">
            <div class="searchControl">
              <span class="small searchControlLabel">Sort</span>
              <select id="sort" class="selectSmall" aria-label="Sort">
                <option value="newest">Newest</option>
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

	const favSet = new Set();
	installFavStars($results, favSet);

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

	// sku -> earliest firstSeenAt across any row (ms)
	let firstSeenMsBySku = new Map();
	// sku -> latest event ms (any kind, within recent window we build)
	let latestEventMsBySku = new Map();
	// sku -> most recent event that changed GLOBAL min price (across stores), within window
	let globalSaleMetaBySku = new Map(); // sku -> { ms, pct, delta }

	// canonicalSku -> storeLabel -> url
	let URL_BY_SKU_STORE = new Map();

	// sku -> Set(storeNorm) / etc (LIVE = !removed)
	let liveStoresBySku = new Map();
	let everStoresBySku = new Map();
	let storeDisplayByNorm = new Map(); // norm -> display label
	let liveMinPriceBySkuStore = new Map(); // sku -> Map(storeNorm -> min price)

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

	function bestLiveStoreForSku(sku) {
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m) return { storeNorm: "", storeLabel: "", priceNum: null };

		const EPS = 0.01;
		let best = null;
		let bestStore = "";
		for (const [st, p] of m.entries()) {
			if (!Number.isFinite(p)) continue;
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

	function passesAvailability(sku) {
		const m = availMode();
		if (m === "all") return true;
		const st = stockMetaForSku(String(sku || ""));
		if (m === "in") return !st.outOfStock;
		if (m === "out") return !!st.outOfStock;
		return true;
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
	function computeGlobalSaleMetaForSku(sku, evts) {
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m || m.size === 0) return null;
		if (!Array.isArray(evts) || !evts.length) return null;

		// state = storeNorm -> current live min price for that store
		let state = new Map(m);
		const EPS = 0.01;

		function globalMin(st) {
			return minFinite(st.values());
		}

		// CURRENT cheapest price (now)
		const currentMin = globalMin(state);
		if (!Number.isFinite(currentMin)) return null;

		const sorted = evts.slice().sort((a, b) => {
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

		const items = Array.isArray(recent?.items) ? recent.items : [];
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
		const m = globalSaleMetaBySku.get(String(sku || ""));
		return m && Number.isFinite(m.pct) ? m.pct : null;
	}

	function saleDeltaForSku(sku) {
		const m = globalSaleMetaBySku.get(String(sku || ""));
		return m && Number.isFinite(m.delta) ? m.delta : null;
	}

	function saleBadgeHtmlForSku(sku, mode) {
		const sm = globalSaleMetaBySku.get(String(sku || "")) || null;
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
		const best = bestLiveStoreForSku(s);
		const n = Number.isFinite(best?.priceNum) ? best.priceNum : null;
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

	function renderAggregates(items) {
		if (!items.length) {
			$results.innerHTML = `<div class="small">No matches.</div>`;
			return;
		}

		let list = items.filter((it) => passesAvailability(String(it?.sku || "")));

		const mode = sortMode();

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

		const limited = list.slice(0, 80);
		$results.innerHTML = limited
			.map((it) => {
				const sku = String(it?.sku || "");
				const stock = stockMetaForSku(sku);
				const plus = stock.storeCount > 1 ? ` +${stock.storeCount - 1}` : "";

				const best = bestLiveStoreForSku(sku);
				const store = !stock.outOfStock
					? best.storeLabel || it.cheapestStoreLabel || [...(it.stores || [])][0] || "Store"
					: "";

				const price =
					(best.priceNum !== null ? priceStrFromNum(best.priceNum) : "") ||
					(it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)");

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
			})
			.join("");

		for (const el of Array.from($results.querySelectorAll(".item"))) {
			el.addEventListener("click", (e) => {
				if (e.target.closest(".favStarBtn")) return;
				const sku = el.getAttribute("data-sku") || "";
				if (!sku) return;
				saveQuery($q.value);
				openOrNavigateTo(e, `#/item/${encodeURIComponent(sku)}`);
			});
		}

		decorateRarity($results);
	}

	function renderRecent(recent, canonicalSkuFn) {
		const items = Array.isArray(recent?.items) ? recent.items : [];
		if (!items.length) {
			$results.innerHTML = `<div class="small">Type to search…</div>`;
			return;
		}

		const canon = typeof canonicalSkuFn === "function" ? canonicalSkuFn : (x) => x;

		const nowMs = Date.now();
		const cutoffMs = nowMs - 3 * 24 * 60 * 60 * 1000;

		const inWindow = items.filter((r) => {
			const ms = eventMsRecent(r);
			return ms >= cutoffMs && ms <= nowMs;
		});

		if (!inWindow.length) {
			$results.innerHTML = `<div class="small">No changes in the last 3 days.</div>`;
			return;
		}

		const bySku = new Map(); // sku -> { r, ms, sku }
		for (const r of inWindow) {
			const rawSku = String(r?.sku || "").trim();
			if (!rawSku) continue;
			const sku = String(canon(rawSku) || "").trim();
			if (!sku) continue;
			const ms = eventMsRecent(r);
			const prev = bySku.get(sku);
			if (!prev || ms > prev.ms) bySku.set(sku, { r, ms, sku });
		}

		let picked = Array.from(bySku.values());

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

		// Market-wide filter: only surface events that represent a global change
		picked = picked.filter((x) => {
			const sku = String(x.sku || "");
			const k = normalizeKindForPrice(x.r);
			if (k === "price_up" || k === "price_change") return false;
			if (!passesAvailability(sku)) return false;
			const agg = aggBySku.get(sku) || null;
			const stock = stockMetaForSku(sku);
			if (k === "new") {
				// Only show if truly new to market (only at this one store)
				return (agg?.stores?.size ?? stock.storeCount) <= 1;
			}
			if (k === "removed") {
				// Only show if now globally out of stock
				return stock.outOfStock;
			}
			if (k === "restored") {
				// Only show if returning market-wide (single store now = was gone everywhere)
				return stock.storeCount <= 1;
			}
			if (k === "price_down") {
				// Only show if this drops the global cheapest price
				const newP = parsePriceToNumber(x.r.newPrice || "");
				const cheapestP = parsePriceToNumber(agg?.cheapestPriceStr || "");
				if (newP === null || cheapestP === null) return true;
				return newP <= cheapestP + 0.01;
			}
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

		const limited = picked.slice(0, 140);

		$results.innerHTML =
			`<div class="small">Recently changed (last 3 days):</div>` +
			limited
				.map(({ r, sku }) => {
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
										: "CHANGE";

					const kindBadgeClass =
						kind === "new" || kind === "restored"
							? "badgeAccent"
							: kind === "removed"
								? "badgeBad"
								: kind === "price_down"
									? "badgeGood"
									: "";

					const when = r.ts ? prettyTs(r.ts) : r.date || "";

					const agg = aggBySku.get(sku) || null;
					const img = agg?.img || "";

					// Always show the global cheapest price for this SKU
					const priceLine = agg?.cheapestPriceStr || r.newPrice || r.price || "";

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

					const dateBadge = when ? `<span class="badge mono">${esc(when)}</span>` : "";

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
				})
				.join("");

		for (const el of Array.from($results.querySelectorAll(".item"))) {
			el.addEventListener("click", (e) => {
				if (e.target.closest(".favStarBtn")) return;
				const sku = el.getAttribute("data-sku") || "";
				if (!sku) return;
				saveQuery($q.value);
				openOrNavigateTo(e, `#/item/${encodeURIComponent(sku)}`);
			});
		}

		decorateRarity($results);
	}

	function renderCurrent() {
		if (!indexReady) return;

		const tokens = tokenizeQuery($q.value);
		if (!tokens.length) {
			if (sortMode() === "newest") {
				if (recentCache) renderRecent(recentCache, rulesRef?.canonicalSku);
				else $results.innerHTML = `<div class="small">Type to search…</div>`;
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
	])
		.then(([idx, rules, fav, recent, rarity]) => {
			rulesRef = rules;
			recentCache = recent;
			rarityRef = rarity;

			favSet.clear();
			for (const k of fav.set) {
				const raw = String(k || "");
				favSet.add(String(rules.canonicalSku(raw) || raw));
			}

			const listings = Array.isArray(idx.items) ? idx.items : [];

			liveStoresBySku = new Map();
			everStoresBySku = new Map();
			storeDisplayByNorm = new Map();
			liveMinPriceBySkuStore = new Map();
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

				if (r.removed) continue;

				// display label for store
				if (!storeDisplayByNorm.has(stNorm)) storeDisplayByNorm.set(stNorm, storeLabel);

				// live stores
				{
					let ss = liveStoresBySku.get(sku);
					if (!ss) liveStoresBySku.set(sku, (ss = new Set()));
					ss.add(stNorm);
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
