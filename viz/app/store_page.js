import { esc, renderThumbHtml } from "./dom.js";
import { goBack, navigateTo } from "./nav.js";
import {
	tokenizeQuery,
	matchesAllTokens,
	displaySku,
	keySkuForRow,
	parsePriceToNumber,
} from "./sku.js";
import { loadIndex, loadRecent } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";
import { favStarHtml, loadMyFavouritesSet, installFavStars } from "./fav_star.js";
import { normalizeStoreId, storeById } from "./stores.js";

let rulesCache = null;

export async function renderStore($app, storeLabelRaw) {
	const storeLabel = String(storeLabelRaw || "").trim();
	const storeLabelShort = storeById(normalizeStoreId(storeLabel))?.label || storeLabel || "Store";

	$app.innerHTML = `
    <div class="container containerStoreWide">
      <div class="topbar">
        <button id="back" class="btn">← Back</button>
        <span class="badge">${esc(storeLabelShort || "Store")}</span>
      </div>

      <div class="card">
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div id="priceWrap" style="display:flex; align-items:center; gap:10px; width:100%;">
            <div class="small" style="white-space:nowrap; opacity:.75;">Max price</div>

            <input
              id="maxPrice"
              type="range"
              min="0"
              max="1000"
              step="1"
              value="1000"
              style="
                flex: 1 1 auto;
                width: 100%;
                height: 18px;
                accent-color: #9aa3b2;
                opacity: .85;
              "
            />

            <div
              class="badge mono"
              id="maxPriceLabel"
              style="
                width: 120px;
                text-align: right;
                white-space: nowrap;
                opacity: .9;
                flex: 0 0 auto;
              "
            ></div>
          </div>

          <div style="display:flex; gap:10px; align-items:center; width:100%;">
            <input id="q" class="input" placeholder="Search in this store..." autocomplete="off" style="flex: 1 1 auto;" />
            <button id="clearSearch" class="btn btnSm" type="button" style="flex: 0 0 auto;">Clear</button>
          </div>
        </div>

        <div class="small" id="status" style="margin-top:10px;"></div>

        <div id="results" class="storeGrid">
          <div class="storeCol">
            <div class="storeColHeader">
              <div>
                <span class="badge badgeExclusive">Exclusive</span>
                <span class="small">and</span>
                <span class="badge badgeLastStock">Last Stock</span>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="small">Sort</span>
                <select id="exSort" class="selectSmall" aria-label="Sort exclusives">
                  <option value="priceDesc">Highest Price</option>
                  <option value="priceAsc">Lowest Price</option>
                  <option value="dateDesc">Newest</option>
                  <option value="dateAsc">Oldest</option>
                  <option value="salePct">Sale %</option>
                  <option value="saleAbs">Sale $</option>
                </select>
              </div>
            </div>
            <div id="resultsExclusive" class="storeColList"></div>
          </div>

          <div class="storeCol">
            <div class="storeColHeader">
              <span class="badge">Price compare</span>
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="small">Comparison</span>
                <select id="cmpMode" class="selectSmall" aria-label="Comparison technique">
                  <option value="dollar">Dollar Amount</option>
                  <option value="percent">Percentage Difference</option>
                </select>
              </div>
            </div>
            <div id="resultsCompare" class="storeColList"></div>
          </div>
        </div>

        <div id="sentinel" class="small" style="text-align:center; padding:12px 0;"></div>
      </div>
    </div>
  `;

	document.getElementById("back").addEventListener("click", () => goBack());

	const $q = document.getElementById("q");
	const $status = document.getElementById("status");
	const $resultsExclusive = document.getElementById("resultsExclusive");
	const $resultsCompare = document.getElementById("resultsCompare");
	const $sentinel = document.getElementById("sentinel");
	const $resultsWrap = document.getElementById("results");
	const favSet = new Set();
	installFavStars($resultsWrap, favSet);

	const $maxPrice = document.getElementById("maxPrice");
	const $maxPriceLabel = document.getElementById("maxPriceLabel");
	const $priceWrap = document.getElementById("priceWrap");

	const $clearSearch = document.getElementById("clearSearch");
	const $exSort = document.getElementById("exSort");
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

	// Persist exclusives sort per store
	const LS_EX_SORT = `viz:storeExclusiveSort:${storeNorm}`;
	const savedExSort = String(localStorage.getItem(LS_EX_SORT) || "");
	if (savedExSort) $exSort.value = savedExSort;

	// Persist comparison technique per store
	const LS_CMP_MODE = `viz:storeCompareMode:${storeNorm}`;
	const savedCmpMode = String(localStorage.getItem(LS_CMP_MODE) || "");
	if (savedCmpMode) $cmpMode.value = savedCmpMode;

	$resultsExclusive.innerHTML = `<div class="small">Loading…</div>`;
	$resultsCompare.innerHTML = ``;

	const [idx, rulesLoaded, fav] = await Promise.all([
		loadIndex(),
		loadSkuRules(),
		loadMyFavouritesSet(),
	]);

	rulesCache = rulesLoaded;
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

	// canonicalSku -> storeNorm -> recentRow (latest)
	const recentBySkuStore = new Map();

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

	const listingsAll = Array.isArray(idx.items) ? idx.items : [];
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
		const mode = String($exSort.value || "priceDesc");

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

	// ---- Infinite scroll paging (shared across both columns) ----
	const PAGE_SIZE = 140;
	const PAGE_EACH = Math.max(1, Math.floor(PAGE_SIZE / 2));

	let filteredExclusive = [];
	let filteredCompare = [];
	let shownExclusive = 0;
	let shownCompare = 0;

	function totalFiltered() {
		return filteredExclusive.length + filteredCompare.length;
	}
	function totalShown() {
		return shownExclusive + shownCompare;
	}

	function setStatus() {
		const total = totalFiltered();
		if (!total) {
			$status.textContent = "No in-stock items for this store.";
			return;
		}

		if (pageMax !== null) {
			$status.textContent = `In stock: ${total} item(s) (≤ ${formatDollars(selectedMaxPrice)}).`;
			return;
		}

		$status.textContent = `In stock: ${total} item(s).`;
	}

	function renderNext(reset) {
		if (reset) {
			$resultsExclusive.innerHTML = "";
			$resultsCompare.innerHTML = "";
			shownExclusive = 0;
			shownCompare = 0;
		}

		const sliceEx = filteredExclusive.slice(shownExclusive, shownExclusive + PAGE_EACH);
		const sliceCo = filteredCompare.slice(shownCompare, shownCompare + PAGE_EACH);

		shownExclusive += sliceEx.length;
		shownCompare += sliceCo.length;

		if (sliceEx.length)
			$resultsExclusive.insertAdjacentHTML("beforeend", sliceEx.map(renderCard).join(""));
		if (sliceCo.length)
			$resultsCompare.insertAdjacentHTML("beforeend", sliceCo.map(renderCard).join(""));

		const total = totalFiltered();
		const shown = totalShown();

		if (!total) {
			$sentinel.textContent = "";
		} else if (shown >= total) {
			$sentinel.textContent = `Showing ${shown} / ${total}`;
		} else {
			$sentinel.textContent = `Showing ${shown} / ${total}…`;
		}
	}

	$resultsWrap.addEventListener("click", (e) => {
		if (e.target.closest(".favStarBtn")) return;
		const el = e.target.closest(".item");
		if (!el) return;
		const sku = el.getAttribute("data-sku") || "";
		if (!sku) return;
		navigateTo(`#/item/${encodeURIComponent(sku)}`);
	});

	function sortExclusiveInPlace(arr) {
		const mode = String($exSort.value || "priceDesc");

		if (mode === "salePct") {
			arr.sort((a, b) => {
				const ap = Number.isFinite(a._salePct) ? a._salePct : 0; // negative = better
				const bp = Number.isFinite(b._salePct) ? b._salePct : 0;
				if (ap !== bp) return ap - bp; // best deal first
				const an = (String(a.name) + a.sku).toLowerCase();
				const bn = (String(b.name) + b.sku).toLowerCase();
				return an.localeCompare(bn);
			});
			return;
		}

		if (mode === "saleAbs") {
			arr.sort((a, b) => {
				const ad = Number.isFinite(a._saleDelta) ? a._saleDelta : 0; // negative = better
				const bd = Number.isFinite(b._saleDelta) ? b._saleDelta : 0;
				if (ad !== bd) return ad - bd; // best deal first
				const an = (String(a.name) + a.sku).toLowerCase();
				const bn = (String(b.name) + b.sku).toLowerCase();
				return an.localeCompare(bn);
			});
			return;
		}

		if (mode === "priceAsc" || mode === "priceDesc") {
			arr.sort((a, b) => {
				const ap = Number.isFinite(a._storePrice) ? a._storePrice : null;
				const bp = Number.isFinite(b._storePrice) ? b._storePrice : null;
				const aKey = ap === null ? (mode === "priceAsc" ? 9e15 : -9e15) : ap;
				const bKey = bp === null ? (mode === "priceAsc" ? 9e15 : -9e15) : bp;
				if (aKey !== bKey) return mode === "priceAsc" ? aKey - bKey : bKey - aKey;
				return (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku);
			});
			return;
		}

		if (mode === "dateAsc" || mode === "dateDesc") {
			arr.sort((a, b) => {
				const ad = Number.isFinite(a._firstSeenMs) ? a._firstSeenMs : null;
				const bd = Number.isFinite(b._firstSeenMs) ? b._firstSeenMs : null;
				const aKey = ad === null ? (mode === "dateAsc" ? 9e15 : -9e15) : ad;
				const bKey = bd === null ? (mode === "dateAsc" ? 9e15 : -9e15) : bd;
				if (aKey !== bKey) return mode === "dateAsc" ? aKey - bKey : bKey - aKey;
				return (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku);
			});
		}
	}

	function sortCompareInPlace(arr) {
		const mode = compareMode();
		arr.sort((a, b) => {
			const da = mode === "percent" ? a._diffVsOtherPct : a._diffVsOtherDollar;
			const db = mode === "percent" ? b._diffVsOtherPct : b._diffVsOtherDollar;

			const sa = da === null || !Number.isFinite(da) ? 999999 : da;
			const sb = db === null || !Number.isFinite(db) ? 999999 : db;
			if (sa !== sb) return sa - sb;

			return (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku);
		});
	}

	function applyFilter() {
		const raw = String($q.value || "");
		localStorage.setItem(LS_KEY, raw);

		const tokens = tokenizeQuery(raw);

		let base = items;

		if (tokens.length) {
			base = base.filter((it) => matchesAllTokens(it.searchText, tokens));
		}

		if (pageMax !== null && Number.isFinite(selectedMaxPrice)) {
			const cap = selectedMaxPrice + 0.0001;
			base = base.filter((it) => {
				const p = it && Number.isFinite(it._storePrice) ? it._storePrice : null;
				return p === null ? true : p <= cap;
			});
		}

		filteredExclusive = base.filter((it) => it._exclusive || it._lastStock);
		filteredCompare = base.filter((it) => !it._exclusive && !it._lastStock);

		sortExclusiveInPlace(filteredExclusive);
		sortCompareInPlace(filteredCompare);

		setStatus();
		renderNext(true);
	}

	applyFilter();

	const io = new IntersectionObserver(
		(entries) => {
			const hit = entries.some((x) => x.isIntersecting);
			if (!hit) return;
			if (totalShown() >= totalFiltered()) return;
			renderNext(false);
		},
		{ root: null, rootMargin: "600px 0px", threshold: 0.01 },
	);
	io.observe($sentinel);

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

	$exSort.addEventListener("change", () => {
		localStorage.setItem(LS_EX_SORT, String($exSort.value || ""));
		applyFilter();
	});

	$cmpMode.addEventListener("change", () => {
		localStorage.setItem(LS_CMP_MODE, String($cmpMode.value || ""));
		applyFilter();
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
}
