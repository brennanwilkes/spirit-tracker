import { esc, renderThumbHtml } from "./dom.js";
import { goBack, peekBack, openOrNavigateTo } from "./nav.js";
import { spiritFilterHtml, installSpiritFilter } from "./components/spirit_filter.js";
import { decorateRarity } from "./rarity_decorate.js";
import {
	tokenizeQuery,
	matchesAllTokens,
	displaySku,
	keySkuForRow,
	parsePriceToNumber,
	normSearchText,
} from "./sku.js";
import { loadIndex, loadRecent, loadRarity } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";
import { favStarHtml, loadMyFavouritesSet, installFavStars } from "./fav_star.js";
import { normalizeStoreId, storeById } from "./stores.js";
import { loadHiddenSet, isHiddenListing } from "./hidden.js";
import { createInfiniteScroll } from "./components/infinite_scroll.js";
import { effectiveRarity } from "./rarity.js";

let rulesCache = null;
let rarityCache = null;

export async function renderStore($app, storeLabelRaw) {
	const storeLabel = String(storeLabelRaw || "").trim();
	const storeLabelShort = storeById(normalizeStoreId(storeLabel))?.label || storeLabel || "Store";

	$app.innerHTML = `
    <div class="container containerStoreWide">
      <div class="topbar">
        <a id="back" class="btn" href="${peekBack()}"><span class="backArrow">← </span>Back</a>
        <span class="badge">${esc(storeLabelShort || "Store")}</span>
      </div>

      <div class="card">
        <div class="storeSearchRow">
          <input id="q" class="input" placeholder="Search in this store..." autocomplete="off" />
          <button id="clearSearch" class="btn btnSm" type="button">Clear</button>
        </div>

        <div class="storeTabs" id="storeTabs" role="tablist">
          <button class="storeTab" type="button" role="tab" data-tab="all">
            <span class="storeTabName">All</span><span class="storeTabCount"></span>
          </button>
          <button class="storeTab" type="button" role="tab" data-tab="exclusive">
            <span class="storeTabName">Exclusive</span><span class="storeTabCount"></span>
          </button>
          <button class="storeTab" type="button" role="tab" data-tab="compare">
            <span class="storeTabName">Price</span><span class="storeTabCount"></span>
          </button>
          <button class="storeTab" type="button" role="tab" data-tab="laststock">
            <span class="storeTabName">Last Stock</span><span class="storeTabCount"></span>
          </button>
        </div>

        <div class="storeFilterRow">
          <label class="storeControl" id="sortWrap">
            <span class="storeControlLabel">Sort</span>
            <select id="sort" class="selectSmall" aria-label="Sort">
              <option value="priceDesc">Price (high)</option>
              <option value="priceAsc">Price (low)</option>
              <option value="dateDesc">Newest</option>
              <option value="dateAsc">Oldest</option>
              <option value="rarityDesc">Rarest</option>
              <option value="rarityAsc">Common</option>
              <option value="salePct">Sale %</option>
              <option value="saleAbs">Sale $</option>
            </select>
          </label>

          <label class="storeControl" id="cmpModeWrap">
            <span class="storeControlLabel">Difference</span>
            <select id="cmpMode" class="selectSmall" aria-label="Price difference units">
              <option value="dollar">Dollars</option>
              <option value="percent">Percent</option>
            </select>
          </label>

          <div class="storeControl storeTypeFilter">
            <span class="storeControlLabel">Type</span>
            ${spiritFilterHtml()}
          </div>
        </div>

        <div class="storePriceRow" id="priceWrap">
          <span class="storeControlLabel">Max price</span>
          <div class="storePriceTrack">
            <input id="maxPrice" type="range" min="0" max="1000" step="1" value="1000" class="storePriceSlider" />
            <span class="badge mono storePriceLabel" id="maxPriceLabel"></span>
          </div>
        </div>

        <div class="small" id="status" style="margin-top:12px;"></div>

        <div id="results" class="storeList"></div>

        <div id="sentinel" class="small storeSentinel"></div>
      </div>
    </div>
  `;

	document.getElementById("back").addEventListener("click", (e) => {
		if (e.ctrlKey || e.metaKey || e.shiftKey) return;
		e.preventDefault();
		goBack();
	});

	const $q = document.getElementById("q");
	const $status = document.getElementById("status");
	const $results = document.getElementById("results");
	const $sentinel = document.getElementById("sentinel");
	const $tabs = document.getElementById("storeTabs");
	const $sortWrap = document.getElementById("sortWrap");
	const $cmpModeWrap = document.getElementById("cmpModeWrap");
	const favSet = new Set();
	installFavStars($results, favSet);

	const $maxPrice = document.getElementById("maxPrice");
	const $maxPriceLabel = document.getElementById("maxPriceLabel");
	const $priceWrap = document.getElementById("priceWrap");

	const $clearSearch = document.getElementById("clearSearch");
	const $sort = document.getElementById("sort");
	const $cmpMode = document.getElementById("cmpMode");

	// Persist query per store
	const storeNorm = normalizeStoreId(storeLabel);
	const LS_KEY = `viz:storeQuery:${storeNorm}`;
	const savedQ = String(localStorage.getItem(LS_KEY) || "");
	if (savedQ) $q.value = savedQ;

	// Persist max price per store (clamped later once bounds known)
	const LS_MAX_PRICE = `viz:storeMaxPrice:${storeNorm}`;
	const savedMaxPriceRaw = localStorage.getItem(LS_MAX_PRICE);
	let savedMaxPrice = savedMaxPriceRaw !== null ? Number(savedMaxPriceRaw) : null;
	if (!Number.isFinite(savedMaxPrice)) savedMaxPrice = null;

	// Persist sort per store
	const LS_SORT = `viz:storeSort:${storeNorm}`;
	const savedSort = String(localStorage.getItem(LS_SORT) || "");
	if (savedSort) $sort.value = savedSort;

	// Persist active tab per store
	const LS_TAB = `viz:storeTab:${storeNorm}`;
	const TAB_IDS = ["all", "exclusive", "compare", "laststock"];
	let activeTab = String(localStorage.getItem(LS_TAB) || "all");
	if (!TAB_IDS.includes(activeTab)) activeTab = "all";

	// Persist comparison technique per store
	const LS_CMP_MODE = `viz:storeCompareMode:${storeNorm}`;
	const savedCmpMode = String(localStorage.getItem(LS_CMP_MODE) || "");
	if (savedCmpMode) $cmpMode.value = savedCmpMode;

	// Persist spirit type filter per store
	const LS_TYPE = `viz:storeType:${storeNorm}`;
	const $spiritFilter = document.getElementById("spiritFilter");
	const $spiritTrigger = document.getElementById("spiritFilterTrigger");
	const $spiritPanel   = document.getElementById("spiritFilterPanel");
	const $spiritLabel   = document.getElementById("spiritFilterLabel");
	let selectedTypeSet = new Set();
	try {
		const saved = JSON.parse(localStorage.getItem(LS_TYPE) || "[]");
		if (Array.isArray(saved)) selectedTypeSet = new Set(saved);
	} catch {}

	$results.innerHTML = `<div class="small">Loading…</div>`;

	const [idx, rulesLoaded, fav, rarity, hiddenSet] = await Promise.all([
		loadIndex(),
		loadSkuRules(),
		loadMyFavouritesSet(),
		loadRarity().catch(() => null),
		loadHiddenSet().catch(() => new Set()),
	]);

	rulesCache = rulesLoaded;
	rarityCache = rarity;
	const rules = rulesCache;

	for (const k of fav.set) {
		const raw = String(k || "");
		favSet.add(String(rules.canonicalSku(raw) || raw));
	}

	// --- Recent (7d), most-recent per canonicalSku + store ---
	const recent = await loadRecent().catch(() => null);
	const recentItems = Array.isArray(recent?.items) ? recent.items : [];

	function eventMs(r) {
		const t = String(r?.ts || "");
		const ms = t ? Date.parse(t) : NaN;
		if (Number.isFinite(ms)) return ms;

		const d = String(r?.date || "");
		const ms2 = d ? Date.parse(d + "T00:00:00Z") : NaN;
		return Number.isFinite(ms2) ? ms2 : 0;
	}

	const RECENT_DAYS = 7;
	const nowMs = Date.now();
	const cutoffMs = nowMs - RECENT_DAYS * 24 * 60 * 60 * 1000;

	// canonicalSku -> storeNorm -> recentRow (latest of any kind)
	const recentBySkuStore = new Map();
	// canonicalSku -> storeNorm -> ms of latest "new" or "restored" event.
	// Tracked separately so the newest sort still surfaces an allocated item
	// that restocked and immediately sold out — the removed event lands later
	// in `recentBySkuStore` and would otherwise shadow the restock.
	const latestAvailMsBySkuStore = new Map();

	for (const r of recentItems) {
		const ms = eventMs(r);
		if (!(ms >= cutoffMs && ms <= nowMs)) continue;

		const rawSku = String(r?.sku || "").trim();
		if (!rawSku) continue;
		const sku = String(rules.canonicalSku(rawSku) || rawSku);

		const stNorm = normalizeStoreId(r?.storeLabel || r?.store || "");
		if (!stNorm) continue;

		let sm = recentBySkuStore.get(sku);
		if (!sm) recentBySkuStore.set(sku, (sm = new Map()));

		const prev = sm.get(stNorm);
		if (!prev || eventMs(prev) < ms) sm.set(stNorm, r);

		const rawKind = String(r?.kind || "");
		if (rawKind === "new" || rawKind === "restored") {
			let am = latestAvailMsBySkuStore.get(sku);
			if (!am) latestAvailMsBySkuStore.set(sku, (am = new Map()));
			const prevMs = am.get(stNorm);
			if (prevMs === undefined || prevMs < ms) am.set(stNorm, ms);
		}
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

	function saleMetaFor(it) {
		const sku = String(it?.sku || "");
		const r = recentBySkuStore.get(sku)?.get(storeNorm) || null;
		if (!r) return null;

		const kind = normalizeKindForPrice(r);
		if (kind !== "price_down" && kind !== "price_up" && kind !== "price_change") return null;

		const oldStr = String(r?.oldPrice || "").trim();
		const newStr = String(r?.newPrice || "").trim();
		const oldN = parsePriceToNumber(oldStr);
		const newN = parsePriceToNumber(newStr);
		if (!Number.isFinite(oldN) || !Number.isFinite(newN) || !(oldN > 0)) return null;

		const delta = newN - oldN; // negative = down
		const pct = Math.round(((newN - oldN) / oldN) * 100); // negative = down

		return {
			_saleDelta: Number.isFinite(delta) ? delta : 0,
			_salePct: Number.isFinite(pct) ? pct : 0,
		};
	}

	const rawListingsAll = Array.isArray(idx.items) ? idx.items : [];
	const listingsAll = hiddenSet && hiddenSet.size > 0
		? rawListingsAll.filter((r) => !isHiddenListing(hiddenSet, normalizeStoreId(r?.storeLabel || r?.store || ""), keySkuForRow(r)))
		: rawListingsAll;
	const liveAll = listingsAll.filter((r) => r && !r.removed);

	function dateMsFromRow(r) {
		const t = String(r?.firstSeenAt || "");
		const ms = t ? Date.parse(t) : NaN;
		return Number.isFinite(ms) ? ms : null;
	}

	// Build firstSeenBySkuInStore and everStoresBySku in one pass (includes removed rows)
	const firstSeenBySkuInStore = new Map(); // sku -> ms
	const everStoresBySku = new Map(); // sku -> Set(storeLabelNorm)
	for (const r of listingsAll) {
		if (!r) continue;
		const store = normalizeStoreId(r.storeLabel || r.store || "");
		if (!store) continue;

		const skuKey = keySkuForRow(r);
		const sku = String(rules.canonicalSku(skuKey) || skuKey);

		let ss = everStoresBySku.get(sku);
		if (!ss) everStoresBySku.set(sku, (ss = new Set()));
		ss.add(store);

		if (store === storeNorm) {
			const ms = dateMsFromRow(r);
			if (ms !== null) {
				const prev = firstSeenBySkuInStore.get(sku);
				if (prev === undefined || ms < prev) firstSeenBySkuInStore.set(sku, ms);
			}
		}
	}

	// Build global per-canonical-SKU live store presence + min prices
	const storesBySku = new Map(); // sku -> Set(storeLabelNorm)
	const minPriceBySkuStore = new Map(); // sku -> Map(storeLabelNorm -> minPrice)

	for (const r of liveAll) {
		const store = normalizeStoreId(r.storeLabel || r.store || "");
		if (!store) continue;

		const skuKey = keySkuForRow(r);
		const sku = String(rules.canonicalSku(skuKey) || skuKey);

		let ss = storesBySku.get(sku);
		if (!ss) storesBySku.set(sku, (ss = new Set()));
		ss.add(store);

		const p = parsePriceToNumber(r.price);
		if (p !== null) {
			let m = minPriceBySkuStore.get(sku);
			if (!m) minPriceBySkuStore.set(sku, (m = new Map()));
			const prev = m.get(store);
			if (prev === undefined || p < prev) m.set(store, p);
		}
	}

	function bestAllPrice(sku) {
		const m = minPriceBySkuStore.get(sku);
		if (!m) return null;
		let best = null;
		for (const v of m.values()) best = best === null ? v : Math.min(best, v);
		return best;
	}

	function bestOtherPrice(sku, store) {
		const m = minPriceBySkuStore.get(sku);
		if (!m) return null;
		let best = null;
		for (const [k, v] of m.entries()) {
			if (k === store) continue;
			best = best === null ? v : Math.min(best, v);
		}
		return best;
	}

	// Store-specific live rows only (in-stock for that store)
	const rowsStoreLive = liveAll.filter(
		(r) => normalizeStoreId(r.storeLabel || r.store || "") === storeNorm,
	);

	// Build href map in one pass through rowsStoreLive (already filtered to this store)
	const _hrefBySku = new Map(); // sku -> { u, sc }
	for (const r of rowsStoreLive) {
		const skuKey = keySkuForRow(r);
		const sku = String(rules.canonicalSku(skuKey) || skuKey);
		const u = String(r.url || "").trim();
		if (!u) continue;
		let sc = u.length;
		if (/\bproduct\/\d+\//.test(u)) sc += 50;
		if (/[a-z0-9-]{8,}/i.test(u)) sc += 10;
		const prev = _hrefBySku.get(sku);
		if (!prev || sc > prev.sc || (sc === prev.sc && u < prev.u)) {
			_hrefBySku.set(sku, { u, sc });
		}
	}

	// Aggregate in this store, grouped by canonical SKU (so mappings count as same bottle)
	let items = aggregateBySku(rowsStoreLive, rules.canonicalSku);

	// Supplement each item's searchText with names from all live stores for the same
	// canonical SKU. Fixes: a product named differently at this store (e.g., "CRN57° - 18
	// Years Old") is still findable by its globally-known name ("THE CAIRN 18YO").
	{
		const globalNamesBySku = new Map();
		for (const r of liveAll) {
			const skuKey = keySkuForRow(r);
			const sku = String(rules.canonicalSku(skuKey) || skuKey);
			const name = normSearchText(String(r?.name || ""));
			if (!name || !sku) continue;
			let names = globalNamesBySku.get(sku);
			if (!names) globalNamesBySku.set(sku, (names = []));
			names.push(name);
		}
		for (const it of items) {
			const extras = globalNamesBySku.get(String(it.sku || "")) || [];
			if (extras.length > 0) it.searchText = it.searchText + " " + extras.join(" ");
		}
	}

	// Flatten href map to strings, with sampleUrl fallback from aggregated items
	const hrefBySku = new Map();
	for (const it of items) {
		const sku = String(it.sku || "");
		const entry = _hrefBySku.get(sku);
		hrefBySku.set(sku, entry?.u || String(it.sampleUrl || "").trim());
	}

	// Decorate each item with pricing comparisons + exclusivity
	const EPS = 0.01;

	items = items.map((it) => {
		const sku = String(it.sku || "");
		const liveStoreSet = storesBySku.get(sku) || new Set([storeNorm]);
		const everStoreSet = everStoresBySku.get(sku) || liveStoreSet;

		const soloLiveHere = liveStoreSet.size === 1 && liveStoreSet.has(storeNorm);
		const lastStock = soloLiveHere && everStoreSet.size > 1;
		const exclusive = soloLiveHere && !lastStock;

		const storePrice = Number.isFinite(it.cheapestPriceNum) ? it.cheapestPriceNum : null;
		const bestAll = bestAllPrice(sku);
		const other = bestOtherPrice(sku, storeNorm);

		const isBest = storePrice !== null && bestAll !== null ? storePrice <= bestAll + EPS : false;

		const diffVsOtherDollar = storePrice !== null && other !== null ? storePrice - other : null;
		const diffVsOtherPct =
			storePrice !== null && other !== null && other > 0
				? ((storePrice - other) / other) * 100
				: null;

		const diffVsBestDollar = storePrice !== null && bestAll !== null ? storePrice - bestAll : null;
		const diffVsBestPct =
			storePrice !== null && bestAll !== null && bestAll > 0
				? ((storePrice - bestAll) / bestAll) * 100
				: null;

		const firstSeenMs = firstSeenBySkuInStore.get(sku);
		const firstSeen = firstSeenMs !== undefined ? firstSeenMs : null;

		// Availability-based "newest" signal: max of firstSeenAt and the most
		// recent new/restored event for this (sku, store). Price changes and
		// removals do NOT bump newest. Flap-coalesced upstream so a flapping
		// item can't keep re-promoting itself, but a single restock followed
		// by a quick sellout (allocated-item pattern) still surfaces because
		// we track availability events in a dedicated map.
		const recMs = latestAvailMsBySkuStore.get(sku)?.get(storeNorm) ?? null;
		const latestAvailMs = recMs !== null && (firstSeen === null || recMs > firstSeen)
			? recMs
			: firstSeen;

		const sm = saleMetaFor(it); // { _saleDelta, _salePct } or null

		return {
			...it,
			_exclusive: exclusive,
			_lastStock: lastStock,
			_storePrice: storePrice,
			_bestAll: bestAll,
			_bestOther: other,
			_isBest: isBest,
			_diffVsOtherDollar: diffVsOtherDollar,
			_diffVsOtherPct: diffVsOtherPct,
			_diffVsBestDollar: diffVsBestDollar,
			_diffVsBestPct: diffVsBestPct,
			_firstSeenMs: firstSeen,
			_latestAvailMs: latestAvailMs,
			_saleDelta: sm ? sm._saleDelta : 0,
			_salePct: sm ? sm._salePct : 0,
			_hasSaleMeta: !!sm,
		};
	});

	// ---- Max price slider (exponential mapping + clicky rounding) ----
	const MIN_PRICE = 25;

	function maxStorePriceOnPage() {
		let mx = null;
		for (const it of items) {
			const p = it && Number.isFinite(it._storePrice) ? it._storePrice : null;
			if (p === null) continue;
			mx = mx === null ? p : Math.max(mx, p);
		}
		return mx;
	}

	const pageMax = maxStorePriceOnPage();
	const boundMax = pageMax !== null ? Math.max(MIN_PRICE, pageMax) : MIN_PRICE;

	function stepForPrice(p) {
		const x = Number.isFinite(p) ? p : boundMax;
		if (x < 120)  return 5;
		if (x < 250)  return 10;
		if (x < 600)  return 25;
		if (x < 2000) return 100;
		return 1000;
	}
	function roundToStep(p) {
		const step = stepForPrice(p);
		return Math.round(p / step) * step;
	}

	function priceFromT(t) {
		t = Math.max(0, Math.min(1, t));
		if (boundMax <= MIN_PRICE) return MIN_PRICE;
		const ratio = boundMax / MIN_PRICE;
		return MIN_PRICE * Math.exp(Math.log(ratio) * t);
	}
	function tFromPrice(price) {
		if (!Number.isFinite(price)) return 1;
		if (boundMax <= MIN_PRICE) return 1;
		const p = Math.max(MIN_PRICE, Math.min(boundMax, price));
		const ratio = boundMax / MIN_PRICE;
		return Math.log(p / MIN_PRICE) / Math.log(ratio);
	}

	function clampPrice(p) {
		if (!Number.isFinite(p)) return boundMax;
		return Math.max(MIN_PRICE, Math.min(boundMax, p));
	}

	function clampAndRound(p) {
		const c = clampPrice(p);
		const r = roundToStep(c);
		return clampPrice(r);
	}

	function formatDollars(p) {
		if (!Number.isFinite(p)) return "";
		return `$${Math.round(p)}`;
	}

	let selectedMaxPrice = clampAndRound(savedMaxPrice !== null ? savedMaxPrice : boundMax);

	function setSliderFromPrice(p) {
		const t = tFromPrice(p);
		const v = Math.round(t * 1000);
		$maxPrice.value = String(v);
	}

	function getRawPriceFromSlider() {
		const v = Number($maxPrice.value);
		const t = Number.isFinite(v) ? v / 1000 : 1;
		return clampPrice(priceFromT(t));
	}

	function updateMaxPriceLabel() {
		if (pageMax === null) {
			$maxPriceLabel.textContent = "No prices";
			return;
		}
		$maxPriceLabel.textContent = `${formatDollars(selectedMaxPrice)}`;
	}

	if (pageMax === null) {
		$maxPrice.disabled = true;
		$priceWrap.title = "No priced items in this store.";
		selectedMaxPrice = boundMax;
		setSliderFromPrice(boundMax);
		localStorage.setItem(LS_MAX_PRICE, String(selectedMaxPrice));
		updateMaxPriceLabel();
	} else {
		selectedMaxPrice = clampAndRound(selectedMaxPrice);
		localStorage.setItem(LS_MAX_PRICE, String(selectedMaxPrice));
		setSliderFromPrice(selectedMaxPrice);
		updateMaxPriceLabel();
	}

	// ---- Listing display price: keep cents (no rounding) ----
	function listingPriceStr(it) {
		const p = it && Number.isFinite(it._storePrice) ? it._storePrice : null;
		if (p === null) return it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)";
		return `$${p.toFixed(2)}`;
	}

	function compareMode() {
		return $cmpMode && $cmpMode.value === "percent" ? "percent" : "dollar";
	}

	function sortMode() {
		return String($sort?.value || "priceDesc");
	}

	function rarityForSku(rawSku) {
		if (!rarityCache || !rules) return null;
		const canon = rules.canonicalSku(String(rawSku || ""));
		const entry = rarityCache.byCanon?.[canon];
		if (!entry) return null;
		return effectiveRarity(entry.r, entry.c);
	}

	function priceBadgeHtml(it) {
		if (it._exclusive || it._lastStock) return "";

		const mode = compareMode();

		if (mode === "percent") {
			const d = it._diffVsOtherPct;
			if (d === null || !Number.isFinite(d)) return "";
			const abs = Math.abs(d);
			if (abs <= 5) {
				return `<span class="badge badgeNeutral">within 5%</span>`;
			}
			const pct = Math.round(abs);
			if (d < 0) return `<span class="badge badgeGood">${esc(pct)}% lower</span>`;
			return `<span class="badge badgeBad">${esc(pct)}% higher</span>`;
		}

		const d = it._diffVsOtherDollar;
		if (d === null || !Number.isFinite(d)) return "";

		const abs = Math.abs(d);
		if (abs <= 5) {
			return `<span class="badge badgeNeutral">within $5</span>`;
		}

		const dollars = Math.round(abs);
		if (d < 0) {
			return `<span class="badge badgeGood">$${esc(dollars)} lower</span>`;
		}
		return `<span class="badge badgeBad">$${esc(dollars)} higher</span>`;
	}

	function exclusiveAnnotHtml(it) {
		const mode = sortMode();

		// Sale sorts: show price change for THIS store (7d recent), unchanged => nothing.
		if (mode === "salePct") {
			const p = Number.isFinite(it._salePct) ? it._salePct : 0;
			if (!p) return "";
			const abs = Math.abs(p);
			if (p < 0) return `<span class="badge badgeGood">${esc(abs)}% off</span>`;
			return `<span class="badge badgeBad">+${esc(abs)}%</span>`;
		}

		if (mode === "saleAbs") {
			const d = Number.isFinite(it._saleDelta) ? it._saleDelta : 0;
			if (!d) return "";
			const abs = Math.round(Math.abs(d));
			if (!abs) return "";
			if (d < 0) return `<span class="badge badgeGood">$${esc(abs)} off</span>`;
			return `<span class="badge badgeBad">+$${esc(abs)}</span>`;
		}

		// Any NON-sale sort: still show the % badge (same as Sale %) when there was a change.
		const p = Number.isFinite(it._salePct) ? it._salePct : 0;
		if (!p) return "";
		const abs = Math.abs(p);
		if (p < 0) return `<span class="badge badgeGood">${esc(abs)}% off</span>`;
		return `<span class="badge badgeBad">+${esc(abs)}%</span>`;
	}

	function renderCard(it) {
		const price = listingPriceStr(it);

		// Link the store badge consistently (respects SKU linking / canonical SKU)
		const href = hrefBySku.get(String(it.sku || "")) || "";

		const specialBadge = it._lastStock
			? `<span class="badge badgeLastStock">Last Stock</span>`
			: it._exclusive
				? `<span class="badge badgeExclusive">Exclusive</span>`
				: "";

		const bestBadge =
			!it._exclusive && !it._lastStock && it._isBest
				? `<span class="badge badgeBest">Best Price</span>`
				: "";

		const diffBadge = priceBadgeHtml(it);
		const exAnnot = it._exclusive || it._lastStock ? exclusiveAnnotHtml(it) : "";

		const skuLink = `#/link/?left=${encodeURIComponent(String(it.sku || ""))}`;
		return `
		<div class="item itemHasStar" data-sku="${esc(it.sku)}">
		<div class="itemTitle">
          <div class="itemName">${esc(it.name || "(no name)")}</div>
          <a class="badge mono skuLink" target="_blank" rel="noopener noreferrer"
             href="${esc(skuLink)}" onclick="event.stopPropagation()">${esc(displaySku(it.sku))}</a>
          ${favStarHtml(it.sku, favSet.has(it.sku))}
        </div>
		<div class="itemRow">
          <div class="thumbBox">${renderThumbHtml(it.img)}</div>
          <div class="itemBody">
            <div class="itemLine1">
              ${(() => {
                const otherStores = (storesBySku.get(String(it.sku || ""))?.size ?? 1) - 1;
                const linkLabel = storeLabelShort + (otherStores > 0 ? ` +${otherStores}` : "");
                return href
                  ? `<a class="itemStore" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(linkLabel)}</a>`
                  : `<span class="itemStore">${esc(linkLabel)}</span>`;
              })()}
              <span class="price">${esc(price)}</span>
            </div>
            <div class="metaRow">${specialBadge}${bestBadge}${diffBadge}${exAnnot}</div>
          </div>
        </div>
      </div>
    `;
	}

	// ---- Single-list infinite scroll (one list per active tab) ----
	const PAGE_SIZE = 80;

	let filtered = [];
	let shown = 0;

	function setStatus() {
		const total = filtered.length;
		if (!total) {
			$status.textContent = "No matching items for this store.";
			return;
		}
		const cap = pageMax !== null ? ` (≤ ${formatDollars(selectedMaxPrice)})` : "";
		$status.textContent = `${total} item(s)${cap}.`;
	}

	function renderNext(reset) {
		if (reset) {
			$results.innerHTML = "";
			shown = 0;
		}

		const slice = filtered.slice(shown, shown + PAGE_SIZE);
		shown += slice.length;
		if (slice.length) {
			$results.insertAdjacentHTML("beforeend", slice.map(renderCard).join(""));
			decorateRarity($results);
		}

		const total = filtered.length;
		if (!total) $sentinel.textContent = "";
		else if (shown >= total) $sentinel.textContent = total > PAGE_SIZE ? `Showing all ${total}` : "";
		else $sentinel.textContent = `Showing ${shown} / ${total}…`;
	}

	$results.addEventListener("click", (e) => {
		if (e.target.closest(".favStarBtn")) return;
		const el = e.target.closest(".item");
		if (!el) return;
		const sku = el.getAttribute("data-sku") || "";
		if (!sku) return;
		openOrNavigateTo(e, `#/item/${encodeURIComponent(sku)}`);
	});

	function sortItemsInPlace(arr) {
		const nameKey = (x) => (String(x.name) + x.sku).toLowerCase();

		// Price tab: always best deal vs other stores first (most below others), in the
		// unit the Difference toggle picks. The generic Sort dropdown is hidden here.
		if (activeTab === "compare") {
			const pct = compareMode() === "percent";
			arr.sort((a, b) => {
				const da = pct ? a._diffVsOtherPct : a._diffVsOtherDollar;
				const db = pct ? b._diffVsOtherPct : b._diffVsOtherDollar;
				const aKey = da === null || !Number.isFinite(da) ? 9e15 : da;
				const bKey = db === null || !Number.isFinite(db) ? 9e15 : db;
				if (aKey !== bKey) return aKey - bKey;
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		const mode = sortMode();

		if (mode === "salePct" || mode === "saleAbs") {
			const key = (x) =>
				mode === "salePct"
					? Number.isFinite(x._salePct) ? x._salePct : 0
					: Number.isFinite(x._saleDelta) ? x._saleDelta : 0;
			arr.sort((a, b) => {
				const ka = key(a);
				const kb = key(b);
				if (ka !== kb) return ka - kb; // biggest drop (most negative) first
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		if (mode === "rarityDesc" || mode === "rarityAsc") {
			arr.sort((a, b) => {
				const ar = rarityForSku(a.sku);
				const br = rarityForSku(b.sku);
				if (ar === null && br === null) return nameKey(a).localeCompare(nameKey(b));
				if (ar === null) return 1;
				if (br === null) return -1;
				if (ar !== br) return mode === "rarityDesc" ? br - ar : ar - br;
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		if (mode === "dateAsc" || mode === "dateDesc") {
			// dateAsc ("oldest first") stays anchored to firstSeenAt — "added
			// longest ago", which restocks shouldn't disturb. dateDesc ("newest")
			// uses the availability-aware signal so allocated restocks float up.
			arr.sort((a, b) => {
				const aField = mode === "dateAsc" ? a._firstSeenMs : a._latestAvailMs;
				const bField = mode === "dateAsc" ? b._firstSeenMs : b._latestAvailMs;
				const ad = Number.isFinite(aField) ? aField : null;
				const bd = Number.isFinite(bField) ? bField : null;
				const aKey = ad === null ? (mode === "dateAsc" ? 9e15 : -9e15) : ad;
				const bKey = bd === null ? (mode === "dateAsc" ? 9e15 : -9e15) : bd;
				if (aKey !== bKey) return mode === "dateAsc" ? aKey - bKey : bKey - aKey;
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		// Price (absolute in-store price) — All / Exclusive / Last Stock tabs.
		arr.sort((a, b) => {
			const ap = Number.isFinite(a._storePrice) ? a._storePrice : null;
			const bp = Number.isFinite(b._storePrice) ? b._storePrice : null;
			const aKey = ap === null ? (mode === "priceAsc" ? 9e15 : -9e15) : ap;
			const bKey = bp === null ? (mode === "priceAsc" ? 9e15 : -9e15) : bp;
			if (aKey !== bKey) return mode === "priceAsc" ? aKey - bKey : bKey - aKey;
			return nameKey(a).localeCompare(nameKey(b));
		});
	}

	function tabPredicate(tab) {
		if (tab === "exclusive") return (it) => it._exclusive;
		if (tab === "laststock") return (it) => it._lastStock;
		if (tab === "compare") return (it) => !it._exclusive && !it._lastStock;
		return () => true; // all
	}

	// base items after type/search/price filters (tab-independent), cached so a
	// tab switch doesn't re-run the whole filter chain.
	let baseFiltered = [];

	function computeBase() {
		const raw = String($q.value || "");
		localStorage.setItem(LS_KEY, raw);
		const tokens = tokenizeQuery(raw);

		let base = items;
		if (selectedTypeSet.size) {
			base = base.filter((it) => {
				const st = it?.spiritTypes;
				if (!st || !st.size) return true;
				for (const t of selectedTypeSet) { if (st.has(t)) return true; }
				return false;
			});
		}
		if (tokens.length) base = base.filter((it) => matchesAllTokens(it.searchText, tokens));
		if (pageMax !== null && Number.isFinite(selectedMaxPrice)) {
			const cap = selectedMaxPrice + 0.0001;
			base = base.filter((it) => {
				const p = it && Number.isFinite(it._storePrice) ? it._storePrice : null;
				return p === null ? true : p <= cap;
			});
		}
		baseFiltered = base;
	}

	function syncTabs() {
		const counts = { all: baseFiltered.length, exclusive: 0, compare: 0, laststock: 0 };
		for (const it of baseFiltered) {
			if (it._exclusive) counts.exclusive++;
			else if (it._lastStock) counts.laststock++;
			else counts.compare++;
		}
		for (const btn of $tabs.querySelectorAll(".storeTab")) {
			const tab = btn.getAttribute("data-tab");
			const cnt = btn.querySelector(".storeTabCount");
			if (cnt) cnt.textContent = String(counts[tab] ?? 0);
			btn.classList.toggle("isOn", tab === activeTab);
			btn.setAttribute("aria-selected", String(tab === activeTab));
		}
		// On the Price tab the list is always sorted by best deal vs other stores,
		// so the generic Sort dropdown is hidden and the $/% Difference toggle (which
		// picks the sort/badge unit) takes its place. Everywhere else: the reverse.
		const onCompare = activeTab === "compare";
		$sortWrap.style.display = onCompare ? "none" : "";
		$cmpModeWrap.style.display = onCompare ? "" : "none";
	}

	function applyTab() {
		filtered = baseFiltered.filter(tabPredicate(activeTab));
		sortItemsInPlace(filtered);
		setStatus();
		renderNext(true);
	}

	function applyFilter() {
		computeBase();
		syncTabs();
		applyTab();
	}

	applyFilter();

	createInfiniteScroll({
		sentinel: $sentinel,
		onLoadMore: () => {
			if (shown >= filtered.length) return;
			renderNext(false);
		},
	});

	$tabs.addEventListener("click", (e) => {
		const btn = e.target.closest(".storeTab");
		if (!btn) return;
		const tab = btn.getAttribute("data-tab");
		if (!TAB_IDS.includes(tab) || tab === activeTab) return;
		activeTab = tab;
		localStorage.setItem(LS_TAB, activeTab);
		syncTabs();
		applyTab();
	});

	let t = null;
	$q.addEventListener("input", () => {
		if (t) clearTimeout(t);
		t = setTimeout(applyFilter, 60);
	});

	$clearSearch.addEventListener("click", () => {
		let changed = false;

		if ($q.value) {
			$q.value = "";
			localStorage.setItem(LS_KEY, "");
			changed = true;
		}

		// reset max price too (only if slider is active)
		if (pageMax !== null) {
			selectedMaxPrice = clampAndRound(boundMax);
			localStorage.setItem(LS_MAX_PRICE, String(selectedMaxPrice));
			setSliderFromPrice(selectedMaxPrice);
			updateMaxPriceLabel();
			changed = true;
		}

		if (changed) applyFilter();
		$q.focus();
	});

	$sort.addEventListener("change", () => {
		localStorage.setItem(LS_SORT, String($sort.value || ""));
		applyTab();
	});

	$cmpMode.addEventListener("change", () => {
		localStorage.setItem(LS_CMP_MODE, String($cmpMode.value || ""));
		// Affects both the diff badge AND (on the Price tab) the price sort metric.
		applyTab();
	});

	let tp = null;
	function setSelectedMaxPriceFromSlider() {
		const raw = getRawPriceFromSlider();
		const rounded = clampAndRound(raw);
		if (Math.abs(rounded - selectedMaxPrice) > 0.001) {
			selectedMaxPrice = rounded;
			localStorage.setItem(LS_MAX_PRICE, String(selectedMaxPrice));
			updateMaxPriceLabel();
		} else {
			updateMaxPriceLabel();
		}
	}

	$maxPrice.addEventListener("input", () => {
		if (pageMax === null) return;
		setSelectedMaxPriceFromSlider();

		if (tp) clearTimeout(tp);
		tp = setTimeout(applyFilter, 40);
	});

	$maxPrice.addEventListener("change", () => {
		if (pageMax === null) return;
		setSelectedMaxPriceFromSlider();
		setSliderFromPrice(selectedMaxPrice);
		updateMaxPriceLabel();
		applyFilter();
	});

	if ($spiritFilter) {
		installSpiritFilter({
			$container: $spiritFilter,
			$trigger:   $spiritTrigger,
			$panel:     $spiritPanel,
			$label:     $spiritLabel,
			selectedSet: selectedTypeSet,
			onChange: () => {
				try { localStorage.setItem(LS_TYPE, JSON.stringify([...selectedTypeSet])); } catch {}
				applyFilter();
			},
		});
	}
}
