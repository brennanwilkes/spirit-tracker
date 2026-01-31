import { esc, renderThumbHtml } from "./dom.js";
import {
  tokenizeQuery,
  matchesAllTokens,
  displaySku,
  keySkuForRow,
  parsePriceToNumber,
} from "./sku.js";
import { loadIndex } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";

function normStoreLabel(s) {
  return String(s || "").trim().toLowerCase();
}

function readLinkHrefForSkuInStore(listingsLive, canonSku, storeLabelNorm) {
  // Prefer the most recent-ish url if multiple exist; stable enough for viz.
  let bestUrl = "";
  let bestScore = -1;

  function scoreUrl(u) {
    if (!u) return -1;
    let s = u.length;
    if (/\bproduct\/\d+\//.test(u)) s += 50;
    if (/[a-z0-9-]{8,}/i.test(u)) s += 10;
    return s;
  }

  for (const r of listingsLive) {
    if (!r || r.removed) continue;
    const store = normStoreLabel(r.storeLabel || r.store || "");
    if (store !== storeLabelNorm) continue;

    const skuKey = String(
      rulesCache?.canonicalSku(keySkuForRow(r)) || keySkuForRow(r)
    );
    if (skuKey !== canonSku) continue;

    const u = String(r.url || "").trim();
    const sc = scoreUrl(u);
    if (sc > bestScore) {
      bestScore = sc;
      bestUrl = u;
    } else if (sc === bestScore && u && bestUrl && u < bestUrl) {
      bestUrl = u;
    }
  }
  return bestUrl;
}

// small module-level cache so we can reuse in readLinkHrefForSkuInStore
let rulesCache = null;

export async function renderStore($app, storeLabelRaw) {
  const storeLabel = String(storeLabelRaw || "").trim();

  $app.innerHTML = `
    <div class="container">
      <div class="topbar">
        <button id="back" class="btn">← Back</button>
        <span class="badge">${esc(storeLabel || "Store")}</span>
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

          <input id="q" class="input" placeholder="Search in this store..." autocomplete="off" />
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
              <span class="small">Only sold here</span>
            </div>
            <div id="resultsExclusive" class="storeColList"></div>
          </div>

          <div class="storeCol">
            <div class="storeColHeader">
              <span class="badge">Price compare</span>
              <span class="small">Cross-store pricing</span>
            </div>
            <div id="resultsCompare" class="storeColList"></div>
          </div>
        </div>

        <div id="sentinel" class="small" style="text-align:center; padding:12px 0;"></div>
      </div>
    </div>
  `;

  document.getElementById("back").addEventListener("click", () => {
    sessionStorage.setItem("viz:lastRoute", location.hash);
    location.hash = "#/";
  });

  const $q = document.getElementById("q");
  const $status = document.getElementById("status");
  const $resultsExclusive = document.getElementById("resultsExclusive");
  const $resultsCompare = document.getElementById("resultsCompare");
  const $sentinel = document.getElementById("sentinel");
  const $resultsWrap = document.getElementById("results");

  const $maxPrice = document.getElementById("maxPrice");
  const $maxPriceLabel = document.getElementById("maxPriceLabel");
  const $priceWrap = document.getElementById("priceWrap");

  // Persist query per store
  const storeNorm = normStoreLabel(storeLabel);
  const LS_KEY = `viz:storeQuery:${storeNorm}`;
  const savedQ = String(localStorage.getItem(LS_KEY) || "");
  if (savedQ) $q.value = savedQ;

  // Persist max price per store (clamped later once bounds known)
  const LS_MAX_PRICE = `viz:storeMaxPrice:${storeNorm}`;
  const savedMaxPriceRaw = localStorage.getItem(LS_MAX_PRICE);
  let savedMaxPrice = savedMaxPriceRaw !== null ? Number(savedMaxPriceRaw) : null;
  if (!Number.isFinite(savedMaxPrice)) savedMaxPrice = null;

  $resultsExclusive.innerHTML = `<div class="small">Loading…</div>`;
  $resultsCompare.innerHTML = ``;

  const idx = await loadIndex();
  rulesCache = await loadSkuRules();
  const rules = rulesCache;

  const listingsAll = Array.isArray(idx.items) ? idx.items : [];
  const liveAll = listingsAll.filter((r) => r && !r.removed);

  // Build "ever seen" store presence per canonical SKU (includes removed rows)
  const everStoresBySku = new Map(); // sku -> Set(storeLabelNorm)
  for (const r of listingsAll) {
    if (!r) continue;
    const store = normStoreLabel(r.storeLabel || r.store || "");
    if (!store) continue;

    const skuKey = keySkuForRow(r);
    const sku = String(rules.canonicalSku(skuKey) || skuKey);

    let ss = everStoresBySku.get(sku);
    if (!ss) everStoresBySku.set(sku, (ss = new Set()));
    ss.add(store);
  }

  // Build global per-canonical-SKU live store presence + min prices
  const storesBySku = new Map(); // sku -> Set(storeLabelNorm)
  const minPriceBySkuStore = new Map(); // sku -> Map(storeLabelNorm -> minPrice)

  for (const r of liveAll) {
    const store = normStoreLabel(r.storeLabel || r.store || "");
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
    (r) => normStoreLabel(r.storeLabel || r.store || "") === storeNorm
  );

  // Aggregate in this store, grouped by canonical SKU (so mappings count as same bottle)
  let items = aggregateBySku(rowsStoreLive, rules.canonicalSku);

  // Decorate each item with pricing comparisons + exclusivity
  const EPS = 0.01;

  items = items
    .map((it) => {
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

      const diffVsOther = storePrice !== null && other !== null ? storePrice - other : null;
      const diffVsBest = storePrice !== null && bestAll !== null ? storePrice - bestAll : null;

      return {
        ...it,
        _exclusive: exclusive,
        _lastStock: lastStock,
        _storePrice: storePrice,
        _bestAll: bestAll,
        _bestOther: other,
        _isBest: isBest,
        _diffVsOther: diffVsOther,
        _diffVsBest: diffVsBest,
      };
    })
    .sort((a, b) => {
      const aSpecial = !!(a._exclusive || a._lastStock);
      const bSpecial = !!(b._exclusive || b._lastStock);
      if (aSpecial !== bSpecial) return aSpecial ? -1 : 1;

      const da = a._diffVsOther;
      const db = b._diffVsOther;
      const sa = da === null ? 999999 : da;
      const sb = db === null ? 999999 : db;
      if (sa !== sb) return sa - sb;

      return (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku);
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

  let selectedMaxPrice = clampAndRound(
    savedMaxPrice !== null ? savedMaxPrice : boundMax
  );

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

  function priceBadgeHtml(it) {
    if (it._exclusive || it._lastStock) return "";

    const d = it._diffVsOther;
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

  function renderCard(it) {
    const price = listingPriceStr(it);
    const href = String(it.sampleUrl || "").trim();

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

    const skuLink = `#/link/?left=${encodeURIComponent(String(it.sku || ""))}`;
    return `
      <div class="item" data-sku="${esc(it.sku)}">
        <div class="itemRow">
          <div class="thumbBox">${renderThumbHtml(it.img)}</div>
          <div class="itemBody">
            <div class="itemTop">
              <div class="itemName">${esc(it.name || "(no name)")}</div>
              <a class="badge mono skuLink" target="_blank" rel="noopener noreferrer"
                 href="${esc(skuLink)}" onclick="event.stopPropagation()">${esc(displaySku(it.sku))}</a>
            </div>
            <div class="metaRow">
              ${specialBadge}
              ${bestBadge}
              ${diffBadge}
              <span class="mono price">${esc(price)}</span>
              ${
                href
                  ? `<a class="badge" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(storeLabel)}</a>`
                  : ``
              }
            </div>
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
      $resultsExclusive.insertAdjacentHTML(
        "beforeend",
        sliceEx.map(renderCard).join("")
      );
    if (sliceCo.length)
      $resultsCompare.insertAdjacentHTML(
        "beforeend",
        sliceCo.map(renderCard).join("")
      );

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
    const el = e.target.closest(".item");
    if (!el) return;
    const sku = el.getAttribute("data-sku") || "";
    if (!sku) return;
    sessionStorage.setItem("viz:lastRoute", location.hash);
    location.hash = `#/item/${encodeURIComponent(sku)}`;
  });

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
    { root: null, rootMargin: "600px 0px", threshold: 0.01 }
  );
  io.observe($sentinel);

  let t = null;
  $q.addEventListener("input", () => {
    if (t) clearTimeout(t);
    t = setTimeout(applyFilter, 60);
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
