// viz/app/shortlist_page.js
import { esc, renderThumbHtml } from "./dom.js";
import { tokenizeQuery, matchesAllTokens, displaySku, keySkuForRow, parsePriceToNumber } from "./sku.js";
import { loadIndex, loadRecent } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";
import { favStarHtml, loadMyFavouritesSet, installFavStars } from "./fav_star.js";
import { AuthError, getAuthStatus, getStoredToken, getDetails, getScore, getSampled, setScore, setSampled, getFavourites } from "./cloud.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MEDIAN_PRICE = 202.74;
const LOG_PENALTY = 7;
const LOG_SAMPLE_BONUS = 0.1;

function weightedScore({ priceNum, scoreNum, sampled }) {
	if (!Number.isFinite(scoreNum)) return null;
	if (!Number.isFinite(priceNum)) return null;

	const base = scoreNum * (1 + (sampled ? LOG_SAMPLE_BONUS : 0));
	const penalty = LOG_PENALTY * Math.log(Math.max(1, priceNum) / MEDIAN_PRICE);
	const w = Math.round(base - penalty);
	return Number.isFinite(w) ? w : null;
}

function normStoreLabel(s) {
	return String(s || "")
		.trim()
		.toLowerCase();
}

// canonicalSku -> storeLabel -> url (LIVE rows only)
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

function tsValue(r) {
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

export async function renderShortlist($app, accountUuidRaw) {
	const accountUuid = String(accountUuidRaw || "").trim();

	if (!UUID_RE.test(accountUuid)) {
		$app.innerHTML = `
			<div class="container">
				<div class="card">
					<div class="h1">Shortlist</div>
					<div class="small" style="margin-top:8px;">Invalid account UUID.</div>
				</div>
			</div>
		`;
		return;
	}

	$app.innerHTML = `
        <div class="container">
            <div class="topbar">
            <button id="back" class="btn">← Back</button>

            <div style="display:flex; flex-direction:column; gap:4px; margin-left:10px;">
                <div class="h1" style="margin:0;">Shortlist</div>
                    <span
                        id="copyLink"
                        class="badge mono badgeClick"
                        role="button"
                        tabindex="0"
                        title="Copy page link"
                    >
                        ${esc(accountUuid)}
                    </span>
                </div>
            </div>


			<div class="card">
				<div style="display:flex; flex-direction:column; gap:10px;">
					<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
						<span class="small" style="opacity:.8;">Store</span>
						<select id="storeFilter" class="selectSmall" aria-label="Store filter">
							<option value="">-</option>
						</select>

						<span class="small" style="opacity:.8;">Sort</span>
						<select id="sort" class="selectSmall" aria-label="Shortlist sort">
							<option value="weightedDesc">Weighted Score</option>
							<option value="scoreDesc">Score</option>
							<option value="priceAsc">Lowest Price</option>
							<option value="priceDesc">Highest Price</option>
							<option value="salePct">Sale %</option>
							<option value="saleAbs">Sale $</option>
						</select>
					</div>

					<div id="priceWrap" style="display:flex; align-items:center; gap:10px; width:100%;">
						<div class="small" style="white-space:nowrap; opacity:.75;">Max price</div>

						<input
							id="maxPrice"
							type="range"
							min="0"
							max="1000"
							step="1"
							value="1000"
							style="flex: 1 1 auto; width: 100%; height: 18px; accent-color: #9aa3b2; opacity: .85;"
						/>

						<div
							class="badge mono"
							id="maxPriceLabel"
							style="width: 120px; text-align: right; white-space: nowrap; opacity: .9; flex: 0 0 auto;"
						></div>
					</div>

					<div style="display:flex; gap:10px; align-items:center; width:100%;">
						<input id="q" class="input" placeholder="Search shortlist..." autocomplete="off" style="flex: 1 1 auto;" />
						<button id="clearSearch" class="btn btnSm" type="button" style="flex: 0 0 auto;">Clear</button>
					</div>
				</div>

				<div class="small" id="status" style="margin-top:10px;"></div>
				<div id="results" class="list"></div>
				<div id="sentinel" class="small" style="text-align:center; padding:12px 0;"></div>
			</div>
		</div>
	`;

    const copy = document.getElementById("copyLink");
    const doCopy = async () => {
        await navigator.clipboard.writeText(window.location.href);
        const $status = document.getElementById("status");
        if ($status) $status.textContent = "Copied page link to clipboard.";
    };

    copy.addEventListener("click", doCopy);
    copy.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            doCopy();
        }
    });


	document.getElementById("back").addEventListener("click", () => {
		const last = sessionStorage.getItem("viz:lastRoute");
		if (last && last !== location.hash) location.hash = last;
		else location.hash = "#/";
	});

	const $q = document.getElementById("q");
	const $clear = document.getElementById("clearSearch");
	const $results = document.getElementById("results");
	const $status = document.getElementById("status");
	const $sentinel = document.getElementById("sentinel");
	const $storeFilter = document.getElementById("storeFilter");
	const $sort = document.getElementById("sort");

	const $maxPrice = document.getElementById("maxPrice");
	const $maxPriceLabel = document.getElementById("maxPriceLabel");
	const $priceWrap = document.getElementById("priceWrap");

	// Persist per-account
	const LS_Q = `viz:shortlistQuery:${accountUuid}`;
	const LS_SORT = `viz:shortlistSort:${accountUuid}`;
	const LS_STORE = `viz:shortlistStore:${accountUuid}`;
	const LS_MAX = `viz:shortlistMaxPrice:${accountUuid}`;

	$q.value = String(localStorage.getItem(LS_Q) || "");
	if (localStorage.getItem(LS_SORT)) $sort.value = String(localStorage.getItem(LS_SORT) || "");
	if (localStorage.getItem(LS_STORE)) $storeFilter.value = String(localStorage.getItem(LS_STORE) || "");

	let savedMaxPrice = null;
	{
		const raw = localStorage.getItem(LS_MAX);
		const n = raw !== null ? Number(raw) : null;
		savedMaxPrice = Number.isFinite(n) ? n : null;
	}

	// favourites set for stars + shortlist content
	const favSet = new Set();
	installFavStars($results, favSet);

	$results.innerHTML = `<div class="small">Loading…</div>`;

    const token = getStoredToken(); // may be null
    const [idx, rules, details, fav, scoreMap, sampledArr, recent] = await Promise.all([
        loadIndex(),
		loadSkuRules(),
        getDetails(accountUuid, { token }).catch((e) => e),
        getFavourites(accountUuid).catch((e) => e),
        getScore(accountUuid).catch((e) => e),
        getSampled(accountUuid).catch((e) => e),
        loadRecent().catch(() => null),
	]);

    function isAuthErr(e) {
        return e && (e.name === "AuthError" || e instanceof AuthError);
    }
    
    // backend decides if this page is public/private
    if (isAuthErr(details) || isAuthErr(fav) || isAuthErr(scoreMap) || isAuthErr(sampledArr)) {
        location.hash = "#/login";
        return;
    }
    if (!(details && typeof details === "object")) details = { public: false };
    
    // normalize
    const scoreObj = scoreMap && typeof scoreMap === "object" ? scoreMap : {};
    const sampledList = Array.isArray(sampledArr) ? sampledArr : [];
    

	// Canonicalize favourites
    const favArr =
        Array.isArray(fav) ? fav :
        Array.isArray(fav?.set) ? fav.set :
        [];
    
    favSet.clear();
    for (const k of favArr) {
        const raw = String(k || "");
        favSet.add(String(rules.canonicalSku(raw) || raw));
    }
  
    

	const sampledSet = new Set(
		(Array.isArray(sampledArr) ? sampledArr : []).map((k) => String(rules.canonicalSku(k) || k)),
	);

	const listingsAll = Array.isArray(idx?.items) ? idx.items : [];
	const liveAll = listingsAll.filter((r) => r && !r.removed);

	// URL map for store badge links
	const URL_BY_SKU_STORE = buildUrlMap(listingsAll, rules.canonicalSku);

	// Store display labels for dropdown + sku store presence
	const storeDisplayByNorm = new Map(); // storeNorm -> display label
	const liveStoresBySku = new Map(); // sku -> Set(storeNorm)
	const everStoresBySku = new Map(); // sku -> Set(storeNorm)
	const liveMinPriceBySkuStore = new Map(); // sku -> Map(storeNorm -> minPrice)

	for (const r of listingsAll) {
		if (!r) continue;
		const storeLabel = String(r.storeLabel || r.store || "").trim();
		const stNorm = normStoreLabel(storeLabel);
		if (!stNorm) continue;

		const skuKey = String(keySkuForRow(r) || "").trim();
		const sku = String(rules.canonicalSku(skuKey) || skuKey);
		if (!sku) continue;

		// ever stores (includes removed)
		{
			let ss = everStoresBySku.get(sku);
			if (!ss) everStoresBySku.set(sku, (ss = new Set()));
			ss.add(stNorm);
		}

		if (r.removed) continue;

		// display map
		if (!storeDisplayByNorm.has(stNorm)) storeDisplayByNorm.set(stNorm, storeLabel);

		// live store presence
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

	// Populate store dropdown (live stores only)
	{
		const opts = Array.from(storeDisplayByNorm.entries())
			.map(([norm, label]) => ({ norm, label }))
			.sort((a, b) => a.label.localeCompare(b.label));

		$storeFilter.innerHTML =
			`<option value="">-</option>` +
			opts.map((o) => `<option value="${esc(o.norm)}">${esc(o.label)}</option>`).join("");

		// restore persisted selection if still exists
		const want = String(localStorage.getItem(LS_STORE) || "");
		if (want && storeDisplayByNorm.has(want)) $storeFilter.value = want;
		else $storeFilter.value = "";
	}

	// Aggregates for name/img/searchText; includes removed (so out-of-stock still renders)
	const allAgg = aggregateBySku(listingsAll, rules.canonicalSku);
	const aggBySku = new Map(allAgg.map((x) => [String(x.sku || ""), x]));

	// --- Recent events (7d) for GLOBAL lowest-price change simulation ---
	const recentItems = Array.isArray(recent?.items) ? recent.items : [];

	const RECENT_DAYS = 7;
	const nowMs = Date.now();
	const cutoffMs = nowMs - RECENT_DAYS * 24 * 60 * 60 * 1000;

	// sku -> events[]
	const eventsBySku = new Map();

	for (const r of recentItems) {
		const ms = tsValue(r);
		if (!(ms >= cutoffMs && ms <= nowMs)) continue;

		const rawSku = String(r?.sku || "").trim();
		if (!rawSku) continue;

		const sku = String(rules.canonicalSku(rawSku) || rawSku);
		if (!sku) continue;

		// Only care about favourites (performance + relevance)
		if (!favSet.has(sku)) continue;

		const storeLabel = String(r?.storeLabel || r?.store || "").trim();
		const storeNorm = normStoreLabel(storeLabel);
		if (!storeNorm) continue;

		const kind = normalizeKindForPrice(r);

		const oldNum = parsePriceToNumber(r?.oldPrice || "");
		const newNum = parsePriceToNumber(r?.newPrice || "");
		const priceNum = parsePriceToNumber(r?.price || "");

		let arr = eventsBySku.get(sku);
		if (!arr) eventsBySku.set(sku, (arr = []));
		arr.push({ ms, storeNorm, kind, oldNum, newNum, priceNum });
	}

	function bestAllPrice(sku) {
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m) return null;
		return minFinite(m.values());
	}

	function bestStoreForSku(sku) {
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m) return { storeNorm: "", price: null };
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
		return { storeNorm: bestStore, price: best };
	}

	// Find most recent event that changed the GLOBAL min price (across stores)
	function computeGlobalSaleMeta(sku) {
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m) return null;

		const evts = eventsBySku.get(sku);
		if (!Array.isArray(evts) || !evts.length) return null;

		// state = storeNorm -> current live min price for that store
		let state = new Map(m);

		const EPS = 0.01;

		function globalMin(st) {
			return minFinite(st.values());
		}

		const startAfter = globalMin(state);
		if (!Number.isFinite(startAfter)) return null;

		const sorted = evts.slice().sort((a, b) => {
			if (b.ms !== a.ms) return b.ms - a.ms;
			// stable-ish tie-break
			return String(a.storeNorm).localeCompare(String(b.storeNorm));
		});

		for (const e of sorted) {
			const afterMin = globalMin(state);
			if (!Number.isFinite(afterMin)) return null;

			// rollback e
			const next = new Map(state);

			if (e.kind === "removed") {
				if (Number.isFinite(e.priceNum)) next.set(e.storeNorm, e.priceNum);
			} else if (e.kind === "new" || e.kind === "restored") {
				next.delete(e.storeNorm);
			} else if (e.kind === "price_down" || e.kind === "price_up" || e.kind === "price_change") {
				if (Number.isFinite(e.oldNum)) next.set(e.storeNorm, e.oldNum);
			}

			const beforeMin = globalMin(next);

			if (Number.isFinite(beforeMin) && Math.abs(beforeMin - afterMin) > EPS) {
				const delta = afterMin - beforeMin; // negative = down
				const pct = beforeMin > 0 ? Math.round(((afterMin - beforeMin) / beforeMin) * 100) : 0;
				return { delta, pct, ms: e.ms };
			}

			state = next;
		}

		return null;
	}

	// Decorate favourite items (once)
	const decoratedBySku = new Map();

	for (const sku of favSet) {
		const base = aggBySku.get(sku) || {
			sku,
			name: `(SKU ${sku})`,
			img: "",
			searchText: String(sku || "").toLowerCase(),
			sampleUrl: "",
		};

		const liveStores = liveStoresBySku.get(sku) || new Set();
		const everStores = everStoresBySku.get(sku) || new Set();

		const storeCount = liveStores.size || 0;
		const outOfStock = storeCount === 0;

		const best = bestStoreForSku(sku);
		const bestStoreNorm = String(best.storeNorm || "");
		const bestPriceNum = bestAllPrice(sku);

		const bestStoreLabel = bestStoreNorm ? storeDisplayByNorm.get(bestStoreNorm) || "" : "";
		const bestUrl =
			bestStoreLabel && URL_BY_SKU_STORE.get(sku)?.get(bestStoreLabel)
				? URL_BY_SKU_STORE.get(sku).get(bestStoreLabel)
				: "";

		const soloLive = storeCount === 1;
		const lastStock = !outOfStock && soloLive && everStores.size > 1;
		const exclusive = !outOfStock && soloLive && !lastStock;

		const scoreRaw = scoreMap && typeof scoreMap === "object" ? Number(scoreMap[sku]) : NaN;
		const scoreNum = Number.isFinite(scoreRaw) ? scoreRaw : null;

		const sampled = sampledSet.has(sku);

		const saleMeta = computeGlobalSaleMeta(sku);
		const wScore = weightedScore({ priceNum: bestPriceNum, scoreNum, sampled });

		decoratedBySku.set(sku, {
			...base,

			_priceNum: Number.isFinite(bestPriceNum) ? bestPriceNum : null,
			_bestStoreLabel: bestStoreLabel,
			_bestUrl: bestUrl,
			_storeCount: storeCount,
			_liveStoreNorms: liveStores,

			_outOfStock: outOfStock,
			_exclusive: exclusive,
			_lastStock: lastStock,

			_score: scoreNum,
			_sampled: sampled,
			_weighted: wScore,

			_hasSaleMeta: !!saleMeta,
			_saleDelta: saleMeta ? Number(saleMeta.delta || 0) : 0,
			_salePct: saleMeta ? Number(saleMeta.pct || 0) : 0,
		});
	}

	// ---- Max price slider (same feel as store page) ----
	const MIN_PRICE = 25;

	function maxPriceOnPage() {
		let mx = null;
		for (const it of decoratedBySku.values()) {
			const p = it && Number.isFinite(it._priceNum) ? it._priceNum : null;
			if (p === null) continue;
			mx = mx === null ? p : Math.max(mx, p);
		}
		return mx;
	}

	const pageMax = maxPriceOnPage();
	const boundMax = pageMax !== null ? Math.max(MIN_PRICE, pageMax) : MIN_PRICE;

	function stepForPrice(p) {
		const x = Number.isFinite(p) ? p : boundMax;
		if (x < 120) return 5;
		if (x < 250) return 10;
		if (x < 600) return 25;
		return 100;
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
		$priceWrap.title = "No priced items in shortlist.";
		selectedMaxPrice = boundMax;
		setSliderFromPrice(boundMax);
		localStorage.setItem(LS_MAX, String(selectedMaxPrice));
		updateMaxPriceLabel();
	} else {
		selectedMaxPrice = clampAndRound(selectedMaxPrice);
		localStorage.setItem(LS_MAX, String(selectedMaxPrice));
		setSliderFromPrice(selectedMaxPrice);
		updateMaxPriceLabel();
	}

	function saleBadgeHtml(it) {
		if (!it._hasSaleMeta) return "";

		const mode = String($sort.value || "weightedDesc");
		const pct = Number.isFinite(it._salePct) ? it._salePct : 0;
		const delta = Number.isFinite(it._saleDelta) ? it._saleDelta : 0;

		// Only show $ badge if sorting by Sale $
		if (mode === "saleAbs") {
			const abs = Math.round(Math.abs(delta));
			if (!abs) return "";
			if (delta < 0) return `<span class="badge badgeGood">$${esc(abs)} off</span>`;
			return `<span class="badge badgeBad">+$${esc(abs)}</span>`;
		}

		// Otherwise show % (including non-sale sorts)
		const abs = Math.abs(pct);
		if (!abs) return "";
		if (pct < 0) return `<span class="badge badgeGood">${esc(abs)}% off</span>`;
		return `<span class="badge badgeBad">+${esc(abs)}%</span>`;
	}

	function priceStr(it) {
		const p = it && Number.isFinite(it._priceNum) ? it._priceNum : null;
		if (p === null) return "";
		return `$${p.toFixed(2)}`;
	}

	function renderCard(it) {
		const storeCount = it._storeCount || 0;
		const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";
		const price = priceStr(it);
        const saleBadge = saleBadgeHtml(it);

		const storeLabel = String(it._bestStoreLabel || "").trim();
		const href = String(it._bestUrl || "").trim() || String(it.sampleUrl || "").trim();

		const storeBadge =
			storeLabel && !it._outOfStock
				? href
					? `<a class="badge" href="${esc(
							href,
						)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
							storeLabel,
						)}${esc(plus)}</a>`
					: `<span class="badge">${esc(storeLabel)}${esc(plus)}</span>`
				: "";

		const skuLink = `#/link/?left=${encodeURIComponent(String(it.sku || ""))}`;

		const stockBadge = it._outOfStock ? `<span class="badge badgeBad">OUT OF STOCK</span>` : "";
		const specialBadge = it._lastStock
			? `<span class="badge badgeLastStock">Last Stock</span>`
			: it._exclusive
				? `<span class="badge badgeExclusive">Exclusive</span>`
				: "";

		const scoreBadge = Number.isFinite(it._score)
			? `<span class="badge mono">Score ${esc(Math.round(it._score))}</span>`
			: "";
		const wBadge = Number.isFinite(it._weighted) ? `<span class="badge mono">W ${esc(it._weighted)}</span>` : "";
        const sampledPill = it._outOfStock
        ? ""
        : `<button
              class="pillBtn sampledBtn ${it._sampled ? "isOn" : ""}"
              type="button"
              data-sku="${esc(it.sku)}"
              aria-pressed="${it._sampled ? "true" : "false"}"
              title="Toggle sampled"
           >
              <span class="pillMark pillMarkOff">×</span>
              <span class="pillMark pillMarkOn">✓</span>
              <span>Sampled</span>
           </button>`;
      
      const scoreNum = Number.isFinite(it._score) ? Math.round(it._score) : null;
      
      const scorePill = `
        <button
          class="pillInput scoreBtn"
          type="button"
          data-sku="${esc(it.sku)}"
          title="${scoreNum === null ? "Set score" : "Edit score"}"
        >
          <span class="pillMarkNum">#</span>
          <span class="pillNumberText">${scoreNum === null ? "Score" : String(scoreNum)}</span>
        </button>
      `;
              
        
		return `
			<div class="item itemHasStar" data-sku="${esc(it.sku)}">
				${favStarHtml(it.sku, favSet.has(it.sku))}
				<div class="itemRow">
					<div class="thumbBox">${renderThumbHtml(it.img)}</div>
					<div class="itemBody">
                        <div class="itemTop" style="display:flex; align-items:center; gap:8px;">
                            <div class="itemName" style="flex:1 1 auto;">${esc(it.name || "(no name)")}</div>
                        
                            ${sampledPill}
                            ${scorePill}
                                                  
                            <a class="badge mono skuLink"
                            href="${esc(skuLink)}"
                            target="_blank"
                            rel="noopener noreferrer"
                            onclick="event.stopPropagation()"
                            >${esc(displaySku(it.sku))}</a>
                        </div>
						<div class="metaRow">
							${stockBadge}
							${specialBadge}
							${sampledBadge}
							${price ? `<span class="mono price">${esc(price)}</span>` : ""}
							${saleBadge}
							${storeBadge}
						</div>
					</div>
				</div>
			</div>
		`;
	}

	// ---- Paging ----
	const PAGE_SIZE = 140;
	let filtered = [];
	let shown = 0;

	function setStatus() {
		const total = filtered.length;
		const storeVal = String($storeFilter.value || "");
		const storeLabel = storeVal ? storeDisplayByNorm.get(storeVal) || "" : "-";
		const maxLabel = pageMax !== null ? `≤ ${formatDollars(selectedMaxPrice)}` : "";

		$status.textContent = total
			? `Favourites: ${total} item(s) ${maxLabel}${storeVal ? ` (in stock at ${storeLabel})` : ""}`
			: `No matches.`;
	}

	function renderNext(reset) {
		if (reset) {
			$results.innerHTML = "";
			shown = 0;
		}

		const slice = filtered.slice(shown, shown + PAGE_SIZE);
		shown += slice.length;

		if (slice.length) $results.insertAdjacentHTML("beforeend", slice.map(renderCard).join(""));

		if (!filtered.length) {
			$sentinel.textContent = "";
		} else if (shown >= filtered.length) {
			$sentinel.textContent = `Showing ${shown} / ${filtered.length}`;
		} else {
			$sentinel.textContent = `Showing ${shown} / ${filtered.length}…`;
		}
	}

	function sortInPlace(arr) {
		const mode = String($sort.value || "weightedDesc");

		function nameKey(x) {
			return (String(x.name || "") + "|" + String(x.sku || "")).toLowerCase();
		}

		if (mode === "scoreDesc") {
			arr.sort((a, b) => {
				const av = Number.isFinite(a._score) ? a._score : null;
				const bv = Number.isFinite(b._score) ? b._score : null;
				if (av === null && bv === null) return nameKey(a).localeCompare(nameKey(b));
				if (av === null) return 1;
				if (bv === null) return -1;
				if (bv !== av) return bv - av;
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		if (mode === "weightedDesc") {
			arr.sort((a, b) => {
				const av = Number.isFinite(a._weighted) ? a._weighted : null;
				const bv = Number.isFinite(b._weighted) ? b._weighted : null;
				if (av === null && bv === null) return nameKey(a).localeCompare(nameKey(b));
				if (av === null) return 1;
				if (bv === null) return -1;
				if (bv !== av) return bv - av;
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		if (mode === "priceAsc" || mode === "priceDesc") {
			arr.sort((a, b) => {
				const ap = Number.isFinite(a._priceNum) ? a._priceNum : null;
				const bp = Number.isFinite(b._priceNum) ? b._priceNum : null;

				const aKey = ap === null ? (mode === "priceAsc" ? 9e15 : -9e15) : ap;
				const bKey = bp === null ? (mode === "priceAsc" ? 9e15 : -9e15) : bp;

				if (aKey !== bKey) return mode === "priceAsc" ? aKey - bKey : bKey - aKey;
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		if (mode === "salePct") {
			arr.sort((a, b) => {
				const ah = a._hasSaleMeta ? 0 : 1;
				const bh = b._hasSaleMeta ? 0 : 1;
				if (ah !== bh) return ah - bh;

				const ap = Number.isFinite(a._salePct) ? a._salePct : 999999;
				const bp = Number.isFinite(b._salePct) ? b._salePct : 999999;
				if (ap !== bp) return ap - bp; // most negative (best) first
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		if (mode === "saleAbs") {
			arr.sort((a, b) => {
				const ah = a._hasSaleMeta ? 0 : 1;
				const bh = b._hasSaleMeta ? 0 : 1;
				if (ah !== bh) return ah - bh;

				const ad = Number.isFinite(a._saleDelta) ? a._saleDelta : 999999;
				const bd = Number.isFinite(b._saleDelta) ? b._saleDelta : 999999;
				if (ad !== bd) return ad - bd; // most negative (best) first
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}
	}

	function applyFilter() {
		localStorage.setItem(LS_Q, String($q.value || ""));
		localStorage.setItem(LS_SORT, String($sort.value || ""));
		localStorage.setItem(LS_STORE, String($storeFilter.value || ""));

		// Base = favourites (current favSet), from decorated map
		let base = [];
		for (const sku of favSet) {
			const it = decoratedBySku.get(sku);
			if (it) base.push(it);
		}

		// Store filter: only show items IN STOCK at that store
		const storeNeed = String($storeFilter.value || "");
		if (storeNeed) {
			base = base.filter((it) => it && it._liveStoreNorms && it._liveStoreNorms.has(storeNeed));
		}

		// Search tokens
		const tokens = tokenizeQuery($q.value);
		if (tokens.length) base = base.filter((it) => matchesAllTokens(it.searchText || "", tokens));

		// Max price (based on global lowest in-stock price)
		if (pageMax !== null && Number.isFinite(selectedMaxPrice)) {
			const cap = selectedMaxPrice + 0.0001;
			base = base.filter((it) => {
				const p = it && Number.isFinite(it._priceNum) ? it._priceNum : null;
				return p === null ? true : p <= cap;
			});
		}

		sortInPlace(base);

		filtered = base;
		setStatus();
		renderNext(true);
	}

	applyFilter();

    async function refreshAfterEdit() {
        // re-decorate score/sample only and re-sort
        for (const sku of favSet) {
            const it = decoratedBySku.get(sku);
            if (!it) continue;
    
            const raw = scoreMap && typeof scoreMap === "object" ? Number(scoreMap[sku]) : NaN;
            it._score = Number.isFinite(raw) ? raw : null;
            it._sampled = sampledSet.has(sku);
        }
        applyFilter();
    }
    
    // SCORE edit
    $results.addEventListener("click", async (e) => {
        const btn = e.target.closest(".scoreBtn");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
    
        const sku = btn.getAttribute("data-sku") || "";
        if (!sku) return;
    
        const cur = decoratedBySku.get(sku)?._score;
        const nextRaw = window.prompt(
            `Set score for ${sku} (blank to clear):`,
            cur === null || cur === undefined ? "" : String(Math.round(cur)),
        );
    
        if (nextRaw === null) return; // cancelled
    
        const trimmed = String(nextRaw).trim();
        try {
            if (!trimmed) {
                // clear
                await setScore(accountUuid, sku, null);
                if (scoreMap && typeof scoreMap === "object") delete scoreMap[sku];
            } else {
                const n = Number(trimmed);
                if (!Number.isFinite(n)) return;
                await setScore(accountUuid, sku, n);
                if (scoreMap && typeof scoreMap === "object") scoreMap[sku] = n;
            }
            await refreshAfterEdit();
        } catch {
            location.hash = "#/login";
        }
    });
    
    // SAMPLED toggle
    $results.addEventListener("click", async (e) => {
        const btn = e.target.closest(".sampledBtn");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
    
        const sku = btn.getAttribute("data-sku") || "";
        if (!sku) return;
    
        const next = !sampledSet.has(sku);
    
        try {
            await setSampled(accountUuid, sku, next);
            if (next) sampledSet.add(sku);
            else sampledSet.delete(sku);
    
            await refreshAfterEdit();
        } catch (e) {
            if (isAuthErr(e)) location.hash = "#/login";
            else throw e;
        }
    });
    

	// Click -> item page (ignore fav star / links)
	$results.addEventListener("click", (e) => {
		if (e.target.closest(".favStarBtn")) {
			// allow fav_star.js to update, then re-filter to remove unfavourited rows
			setTimeout(applyFilter, 550);
			return;
		}
		const el = e.target.closest(".item");
		if (!el) return;
		const sku = el.getAttribute("data-sku") || "";
		if (!sku) return;
		sessionStorage.setItem("viz:lastRoute", location.hash);
		location.hash = `#/item/${encodeURIComponent(sku)}`;
	});

	// Infinite scroll
	const io = new IntersectionObserver(
		(entries) => {
			const hit = entries.some((x) => x.isIntersecting);
			if (!hit) return;
			if (shown >= filtered.length) return;
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

	$sort.addEventListener("change", applyFilter);
	$storeFilter.addEventListener("change", applyFilter);

	$clear.addEventListener("click", () => {
		let changed = false;

		if ($q.value) {
			$q.value = "";
			localStorage.setItem(LS_Q, "");
			changed = true;
		}

		if ($storeFilter.value) {
			$storeFilter.value = "";
			localStorage.setItem(LS_STORE, "");
			changed = true;
		}

		if (pageMax !== null) {
			selectedMaxPrice = clampAndRound(boundMax);
			localStorage.setItem(LS_MAX, String(selectedMaxPrice));
			setSliderFromPrice(selectedMaxPrice);
			updateMaxPriceLabel();
			changed = true;
		}

		if (changed) applyFilter();
		$q.focus();
	});

	let tp = null;
	function setSelectedMaxPriceFromSlider() {
		const raw = getRawPriceFromSlider();
		const rounded = clampAndRound(raw);
		if (Math.abs(rounded - selectedMaxPrice) > 0.001) {
			selectedMaxPrice = rounded;
			localStorage.setItem(LS_MAX, String(selectedMaxPrice));
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
