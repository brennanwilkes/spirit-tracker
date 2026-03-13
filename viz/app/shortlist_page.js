// viz/app/shortlist_page.js
import { esc, renderThumbHtml } from "./dom.js";
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
import {
	AuthError,
	getAuthStatus,
	getStoredToken,
	getDetails,
	getScore,
	getSampled,
	setScore,
	setSampled,
	getFavourites,
	getShortlists,
} from "./cloud.js";
import { computeScore } from "./shortlist_page/shortlist_scoring.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
			<div class="container shortlistPage">
				<div class="card">
					<div class="h1">Shortlist</div>
					<div class="small" style="margin-top:8px;">Invalid account UUID.</div>
				</div>
			</div>
		`;
		return;
	}

	$app.innerHTML = `
        <div class="container shortlistPage">
            <div class="topbar">
                <button id="back" class="btn">← Back</button>

                <div style="display:flex; align-items:center; gap:10px; margin-left:10px; min-width:0;">
                    <div id="slTitle" class="h1" style="margin:0; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Shortlist</div>
                </div>
            </div>

			<div class="card">
				<div style="display:flex; flex-direction:column; gap:10px;">
					<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
						<span class="small" style="opacity:.8;">Store</span>
						<select id="storeFilter" class="selectSmall" aria-label="Store filter">
							<option value="">-</option>
						</select>

						<span class="mobileBreak" aria-hidden="true"></span>

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

					<div id="priceWrap" style="align-items:center; gap:10px; width:100%;">
						<div class="small" style="white-space:nowrap; opacity:.75;">Max price</div>

						<input id="maxPrice" type="range" min="0" max="1000" step="1" value="1000"
							style="height:18px; accent-color:#9aa3b2; opacity:.85;" />

						<div class="badge mono" id="maxPriceLabel"
							style="width:120px; text-align:right; white-space:nowrap; opacity:.9;">$120</div>
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
	if (localStorage.getItem(LS_STORE))
		$storeFilter.value = String(localStorage.getItem(LS_STORE) || "");

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

	const [idx, rules, fav, scoreMap, sampledArr, recent] = await Promise.all([
		loadIndex(),
		loadSkuRules(),
		getFavourites(accountUuid).catch((e) => e),
		getScore(accountUuid).catch((e) => e),
		getSampled(accountUuid).catch((e) => e),
		loadRecent().catch(() => null),
	]);

	function isAuthErr(e) {
		return e && (e.name === "AuthError" || e instanceof AuthError);
	}

	// ---- Title: try authed details first; fallback to public /shortlists list ----
	(async () => {
		const $t = document.getElementById("slTitle");
		if (!$t) return;

		const setTitle = (name) => {
			const clean = String(name || "").trim();
			$t.textContent = clean || "Shortlist";
		};

		try {
			const a = getAuthStatus();
			if (a && a.ok && a.token) {
				const d = await getDetails(accountUuid, { token: a.token });
				setTitle(d?.shortlistName);
				return;
			}
			throw new Error("no auth");
		} catch {
			try {
				const list = await getShortlists({ cacheTtlMs: 6 * 60 * 60 * 1000 });
				const rec = Array.isArray(list)
					? list.find((x) => String(x?.uuid || "") === accountUuid)
					: null;
				setTitle(rec?.shortlistName);
			} catch {
				setTitle("");
			}
		}
	})();

	// backend decides if this page is public/private
	// (public pages will allow GET on favourites/score/sampled without auth)
	if (isAuthErr(fav) || isAuthErr(scoreMap) || isAuthErr(sampledArr)) {
		location.hash = "#/login";
		return;
	}

	// normalize
	const scoreObj = scoreMap && typeof scoreMap === "object" ? scoreMap : {};
	const sampledList = Array.isArray(sampledArr) ? sampledArr : [];

	// Canonicalize favourites
	const favArr = Array.isArray(fav) ? fav : Array.isArray(fav?.set) ? fav.set : [];

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

	// Populate store dropdown (live stores only) — grouped by province
	{
		const BC_STORE_NORMS = new Set(
			[
				"ARC Liquor",
				"BCL",
				"Gull Liquor",
				"Legacy Liquor",
				"Strath Liquor",
				"Tudor House",
				"Vessel Liquor",
				"Vintage Spirits",
			].map(normStoreLabel),
		);

		const AB_STORE_NORMS = new Set(
			[
				"BSW",
				"Co-op World of Whisky",
				"Craft Cellars",
				"Keg N Cork",
				"Kensington Wine Market",
				"Malts & Grains",
				"Sierra Springs",
				"Willow Park",
			].map(normStoreLabel),
		);

		const opts = Array.from(storeDisplayByNorm.entries())
			.map(([norm, label]) => ({ norm, label }))
			.sort((a, b) => a.label.localeCompare(b.label));

		const bc = opts.filter((o) => BC_STORE_NORMS.has(o.norm));
		const ab = opts.filter((o) => AB_STORE_NORMS.has(o.norm));
		const other = opts.filter((o) => !BC_STORE_NORMS.has(o.norm) && !AB_STORE_NORMS.has(o.norm));

		const optHtml = (list) =>
			list.map((o) => `<option value="${esc(o.norm)}">${esc(o.label)}</option>`).join("");

		const groupHtml = (label, list) =>
			list.length ? `<optgroup label="${esc(label)}">${optHtml(list)}</optgroup>` : "";

		$storeFilter.innerHTML =
			`<option value="">-</option>` +
			groupHtml("BC", bc) +
			groupHtml("Alberta", ab) +
			groupHtml("Other", other);

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

	function storeMinPrice(sku, storeNorm) {
		if (!storeNorm) return null;
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m) return null;
		const p = m.get(storeNorm);
		return Number.isFinite(p) ? p : null;
	}

	function urlForSkuStore(sku, storeNorm) {
		const label = storeNorm ? storeDisplayByNorm.get(storeNorm) || "" : "";
		if (!label) return "";
		const u = URL_BY_SKU_STORE.get(sku)?.get(label) || "";
		return String(u || "");
	}

	function bestAllPrice(sku) {
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m) return null;
		return minFinite(m.values());
	}
	function bestOtherPrice(sku, storeNorm) {
		if (!storeNorm) return null;
		const m = liveMinPriceBySkuStore.get(sku);
		if (!m) return null;
		let best = null;
		for (const [st, p] of m.entries()) {
			if (st === storeNorm) continue;
			if (!Number.isFinite(p)) continue;
			best = best === null ? p : Math.min(best, p);
		}
		return best;
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
		const wScore = computeScore({ priceNum: bestPriceNum, scoreNum, sampled });

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

			_bestStoreNorm: bestStoreNorm,

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

	function compareModeForShortlist() {
		// When store-filtered, reuse Sale % / Sale $ as the compare-mode selector.
		const mode = String($sort.value || "");
		if (mode === "salePct") return "percent";
		if (mode === "saleAbs") return "dollar";
		return "dollar";
	}

	function diffVsOtherBadgeHtml(it) {
		// Match store page behavior: no compare badge for Exclusive/Last Stock.
		if (it._exclusive || it._lastStock) return "";

		const mode = compareModeForShortlist();

		if (mode === "percent") {
			const d = it._diffVsOtherPct;
			if (d === null || !Number.isFinite(d)) return "";
			const abs = Math.abs(d);
			if (abs <= 5) return `<span class="badge badgeNeutral">within 5%</span>`;
			const pct = Math.round(abs);
			if (d < 0) return `<span class="badge badgeGood">${esc(pct)}% lower</span>`;
			return `<span class="badge badgeBad">${esc(pct)}% higher</span>`;
		}

		const d = it._diffVsOtherDollar;
		if (d === null || !Number.isFinite(d)) return "";
		const abs = Math.abs(d);
		if (abs <= 5) return `<span class="badge badgeNeutral">within $5</span>`;
		const dollars = Math.round(abs);
		if (d < 0) return `<span class="badge badgeGood">$${esc(dollars)} lower</span>`;
		return `<span class="badge badgeBad">$${esc(dollars)} higher</span>`;
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
		const p = it && Number.isFinite(it._viewPriceNum) ? it._viewPriceNum : null;
		if (p === null) return "";
		return `$${p.toFixed(2)}`;
	}

	function renderCard(it) {
		const storeCount = it._storeCount || 0;
		const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";
		const price = priceStr(it);
		const storeNeed = String($storeFilter.value || "");
		// When store-filtered: hide sale badges, show compare-vs-best badge instead.
		const saleBadge = storeNeed ? diffVsOtherBadgeHtml(it) : saleBadgeHtml(it);
		const isSmall = !!window.matchMedia?.("(max-width: 640px)")?.matches;
		const showWInline = !isSmall && String($sort.value || "") === "weightedDesc";
		const wDock =
			showWInline && Number.isFinite(it._viewWeighted)
				? `<span class="badge mono badgeNeutral">Weighted: ${esc(it._viewWeighted)}</span>`
				: "";

		const storeLabel = String(it._viewStoreLabel || it._bestStoreLabel || "").trim();
		const href =
			String(it._viewUrl || it._bestUrl || "").trim() || String(it.sampleUrl || "").trim();

		const storeHtml =
			storeLabel && !it._outOfStock
				? href
					? `<a class="itemStore" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(storeLabel)}${esc(plus)}</a>`
					: `<div class="itemStore">${esc(storeLabel)}${esc(plus)}</div>`
				: "";

		const skuLink = `#/link/?left=${encodeURIComponent(String(it.sku || ""))}`;
		const skuDisp = displaySku(it.sku);

		const stockBadge = it._outOfStock ? `<span class="badge badgeBad">OUT OF STOCK</span>` : "";
		const specialBadge = it._lastStock
			? `<span class="badge badgeLastStock">Last Stock</span>`
			: it._exclusive
				? `<span class="badge badgeExclusive">Exclusive</span>`
				: "";

		const sampledPill = `<button
					class="pillBtn sampledBtn ${it._sampled ? "isOn" : ""}"
					type="button"
					data-sku="${esc(it.sku)}"
					aria-pressed="${it._sampled ? "true" : "false"}"
					title="Toggle sampled"
					style="flex:0 0 auto;"
				>
					<span class="pillMark pillMarkOff">×</span>
					<span class="pillMark pillMarkOn">✓</span>
					<span>Sampled</span>
				</button>`;

		const scoreVal = Number.isFinite(it._score) ? String(Math.round(it._score)) : "";
		const scorePill = `<div
					class="pillInput scoreWrap"
					role="button"
					tabindex="0"
					data-sku="${esc(it.sku)}"
					aria-label="Score"
					style="flex:0 0 auto; min-width:108px;"
				>
					<span class="pillMarkNum">#</span>
					<input
						class="pillNumber scoreInput"
						type="number"
						min="0"
						max="100"
						step="1"
						inputmode="numeric"
						placeholder="Score"
						value="${esc(scoreVal)}"
						data-sku="${esc(it.sku)}"
						style="width:64px;"
					/>
				</div>`;

		return `
			<div class="item itemHasStar" data-sku="${esc(it.sku)}">
				<div class="starDock">
					${wDock}
					${favStarHtml(it.sku, favSet.has(it.sku))}
				</div>
				<div class="itemTitle">
					<div class="itemName">${esc(it.name || "(no name)")}</div>
					${sampledPill}
					${scorePill}
					<a class="badge mono skuLink"
						style="flex:0 0 9ch; width:9ch; min-width:9ch; max-width:9ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
						title="${esc(skuDisp)}"
						href="${esc(skuLink)}"
						target="_blank"
						rel="noopener noreferrer"
						onclick="event.stopPropagation()"
					>${esc(skuDisp)}</a>
				</div>
				<div class="itemRow">
					<div class="thumbBox">${renderThumbHtml(it.img)}</div>
					<div class="itemBody">
						<div class="itemLine1">${storeHtml}${price ? `<span class="price">${esc(price)}</span>` : ""}</div>
						<div class="metaRow">${stockBadge}${saleBadge}${specialBadge}</div>
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
		const storeNeed = String($storeFilter.value || "");
		const storeFiltered = !!storeNeed;

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
				const av = Number.isFinite(a._viewWeighted) ? a._viewWeighted : null;
				const bv = Number.isFinite(b._viewWeighted) ? b._viewWeighted : null;
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
				const ap = Number.isFinite(a._viewPriceNum) ? a._viewPriceNum : null;
				const bp = Number.isFinite(b._viewPriceNum) ? b._viewPriceNum : null;

				const aKey = ap === null ? (mode === "priceAsc" ? 9e15 : -9e15) : ap;
				const bKey = bp === null ? (mode === "priceAsc" ? 9e15 : -9e15) : bp;

				if (aKey !== bKey) return mode === "priceAsc" ? aKey - bKey : bKey - aKey;
				return nameKey(a).localeCompare(nameKey(b));
			});
			return;
		}

		if (mode === "salePct") {
			arr.sort((a, b) => {
				if (storeFiltered) {
					const ap = Number.isFinite(a._diffVsOtherPct) ? a._diffVsOtherPct : 999999;
					const bp = Number.isFinite(b._diffVsOtherPct) ? b._diffVsOtherPct : 999999;
					if (ap !== bp) return ap - bp; // smallest difference (best) first
					return nameKey(a).localeCompare(nameKey(b));
				}

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
				if (storeFiltered) {
					const ad = Number.isFinite(a._diffVsOtherDollar) ? a._diffVsOtherDollar : 999999;
					const bd = Number.isFinite(b._diffVsOtherDollar) ? b._diffVsOtherDollar : 999999;
					if (ad !== bd) return ad - bd; // smallest difference (best) first
					return nameKey(a).localeCompare(nameKey(b));
				}

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
		// Empty-state: no favourites at all (not just "no matches" after filtering)
		if (!favSet || favSet.size === 0) {
			$status.textContent = "No favourites yet.";
			$results.innerHTML = `
				<div class="small" style="padding:10px 0; opacity:.9;">
					You don't have any favourites yet — go click the <span class="favStarIcon">☆</span> on some bottle listings to add them here.
				</div>
			`;
			$sentinel.textContent = "";
			if ($priceWrap) $priceWrap.style.display = "none";
			return;
		} else {
			if ($priceWrap) $priceWrap.style.display = "";
		}

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

		// Compute "view" fields based on store filter
		const EPS = 0.01;
		for (const it of base) {
			const sku = String(it.sku || "");

			const activeStore = storeNeed || String(it._bestStoreNorm || "");
			const storePrice = storeNeed ? storeMinPrice(sku, storeNeed) : null;

			const viewPrice =
				storeNeed && Number.isFinite(storePrice)
					? storePrice
					: Number.isFinite(it._priceNum)
						? it._priceNum
						: null;

			it._viewStoreNorm = activeStore;
			it._viewStoreLabel = activeStore
				? storeDisplayByNorm.get(activeStore) || it._bestStoreLabel || ""
				: it._bestStoreLabel || "";
			it._viewUrl = activeStore
				? urlForSkuStore(sku, activeStore) || it._bestUrl || it.sampleUrl || ""
				: it._bestUrl || it.sampleUrl || "";
			it._viewPriceNum = Number.isFinite(viewPrice) ? viewPrice : null;

			// When store-filtered, compare vs cheapest OTHER store (matches store page)
			const vp = it._viewPriceNum;
			const other = storeNeed ? bestOtherPrice(sku, storeNeed) : null;
			it._diffVsOtherDollar = vp !== null && other !== null ? vp - other : null;
			it._diffVsOtherPct =
				vp !== null && other !== null && other > 0 ? ((vp - other) / other) * 100 : null;

			it._viewWeighted = computeScore({
				priceNum: it._viewPriceNum,
				scoreNum: it._score,
				sampled: it._sampled,
			});
		}

		// Search tokens
		const tokens = tokenizeQuery($q.value);
		if (tokens.length) base = base.filter((it) => matchesAllTokens(it.searchText || "", tokens));

		// Max price (based on VIEW price: store price when filtered, else global lowest)
		if (pageMax !== null && Number.isFinite(selectedMaxPrice)) {
			const cap = selectedMaxPrice + 0.0001;
			base = base.filter((it) => {
				const p = it && Number.isFinite(it._viewPriceNum) ? it._viewPriceNum : null;
				return p === null ? true : p <= cap;
			});
		}

		sortInPlace(base);

		filtered = base;
		setStatus();
		renderNext(true);
	}

	applyFilter();

	function setSaving(el, on) {
		if (!el) return;
		el.classList.toggle("isSaving", !!on);
	}

	function flashSaved(el) {
		if (!el) return;
		el.classList.remove("isSaved");
		// restart animation
		void el.offsetWidth;
		el.classList.add("isSaved");
		setTimeout(() => el && el.classList.remove("isSaved"), 650);
	}

	let refreshAfterFlashT = null;
	function refreshAfterFlash() {
		if (refreshAfterFlashT) clearTimeout(refreshAfterFlashT);
		refreshAfterFlashT = setTimeout(refreshAfterEdit, 680);
	}

	async function refreshAfterEdit() {
		// re-decorate score/sample only and re-sort
		for (const sku of favSet) {
			const it = decoratedBySku.get(sku);
			if (!it) continue;

			const raw = scoreMap && typeof scoreMap === "object" ? Number(scoreMap[sku]) : NaN;
			it._score = Number.isFinite(raw) ? raw : null;
			it._sampled = sampledSet.has(sku);
			it._weighted = computeScore({
				priceNum: it._priceNum,
				scoreNum: it._score,
				sampled: it._sampled,
			});
		}
		applyFilter();
	}

	function setSampledUi(btn, isOn) {
		if (!btn) return;
		const on = !!isOn;
		btn.classList.toggle("isOn", on);
		btn.setAttribute("aria-pressed", on ? "true" : "false");
	}

	// Score pill: click focuses input (and MUST NOT trigger row navigation)
	$results.addEventListener("click", (e) => {
		const wrap = e.target.closest(".scoreWrap");
		if (!wrap) return;

		// Stop the row click handler (same element) from running
		e.stopImmediatePropagation();

		const inp = wrap.querySelector(".scoreInput");
		if (!inp) return;

		// Don't break normal input focusing/caret
		const isInput = e.target === inp;
		if (!isInput) {
			e.preventDefault();
			inp.focus();
		}
	});

	$results.addEventListener("keydown", (e) => {
		const wrap = e.target.closest(".scoreWrap");
		if (!wrap) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			e.stopImmediatePropagation();
			const inp = wrap.querySelector(".scoreInput");
			if (inp) inp.focus();
		}
	});

	// Auto-select score on focus (and keep selection after mouseup)
	$results.addEventListener("focusin", (e) => {
		const inp = e.target.closest(".scoreInput");
		if (!inp) return;
		setTimeout(() => {
			try {
				inp.select();
			} catch {}
		}, 0);
	});

	$results.addEventListener("mouseup", (e) => {
		const inp = e.target.closest(".scoreInput");
		if (!inp) return;
		e.preventDefault(); // prevents mouseup from clearing the selection
	});

	async function saveScore(sku, wrap, inp) {
		const raw = String(inp?.value || "").trim();
		let toSend = null;

		if (raw !== "") {
			const n = Number(raw);
			if (Number.isFinite(n)) {
				toSend = Math.max(0, Math.min(100, Math.round(n)));
				inp.value = String(toSend);
			} else {
				inp.value = "";
				toSend = null;
			}
		}

		setSaving(wrap, true);
		try {
			await setScore(accountUuid, sku, toSend);
			if (scoreMap && typeof scoreMap === "object") {
				if (toSend === null) delete scoreMap[sku];
				else scoreMap[sku] = toSend;
			}
			flashSaved(wrap);
			refreshAfterFlash();
		} catch (err) {
			if (isAuthErr(err)) location.hash = "#/login";
		} finally {
			setSaving(wrap, false);
		}
	}

	$results.addEventListener("change", (e) => {
		const inp = e.target.closest(".scoreInput");
		if (!inp) return;
		e.stopImmediatePropagation();

		const sku = String(inp.getAttribute("data-sku") || "");
		if (!sku) return;
		const wrap = inp.closest(".scoreWrap");
		if (!wrap) return;
		saveScore(sku, wrap, inp);
	});

	$results.addEventListener("keydown", (e) => {
		const inp = e.target.closest(".scoreInput");
		if (!inp) return;
		if (e.key === "Enter") {
			e.preventDefault();
			e.stopImmediatePropagation();
			inp.blur(); // triggers change
		}
	});

	// Sampled toggle (with saving + saved flash) and MUST NOT trigger row navigation
	$results.addEventListener("click", async (e) => {
		const btn = e.target.closest(".sampledBtn");
		if (!btn) return;
		e.preventDefault();
		e.stopImmediatePropagation();

		const sku = String(btn.getAttribute("data-sku") || "");
		if (!sku) return;

		const next = !btn.classList.contains("isOn");
		setSampledUi(btn, next);

		setSaving(btn, true);
		try {
			await setSampled(accountUuid, sku, next);
			if (next) sampledSet.add(sku);
			else sampledSet.delete(sku);
			flashSaved(btn);
			refreshAfterFlash();
		} catch (err) {
			setSampledUi(btn, !next);
			if (isAuthErr(err)) location.hash = "#/login";
		} finally {
			setSaving(btn, false);
		}
	});

	// Click -> item page (ignore fav star / links)
	$results.addEventListener("click", (e) => {
		if (e.defaultPrevented) return;
		if (
			e.target.closest(".sampledBtn") ||
			e.target.closest(".scoreWrap") ||
			e.target.closest(".scoreInput")
		)
			return;
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
