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

const STORE_Q_LS_PREFIX = "stviz:v1:store:q:";

function storeQKey(storeLabel) {
  return STORE_Q_LS_PREFIX + String(storeLabel || "").trim().toLowerCase();
}

function loadStoreQuery(storeLabel) {
  try {
    return localStorage.getItem(storeQKey(storeLabel)) || "";
  } catch {
    return "";
  }
}

function saveStoreQuery(storeLabel, v) {
  try {
    localStorage.setItem(storeQKey(storeLabel), String(v ?? ""));
  } catch {}
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

    const skuKey = String(rulesCache?.canonicalSku(keySkuForRow(r)) || keySkuForRow(r));
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
        <input id="q" class="input" placeholder="Search in this store..." autocomplete="off" />
        <div class="small" id="status" style="margin-top:10px;"></div>
        <div id="results" class="list"></div>
        <div id="sentinel" class="small" style="text-align:center; padding:12px 0;"></div>
      </div>
    </div>
  `;

  document.getElementById("back").addEventListener("click", () => {
    sessionStorage.setItem("viz:lastRoute", location.hash);
    location.hash = "#/"
});

  const $q = document.getElementById("q");
  $q.value = loadStoreQuery(storeLabel);
  
  const $status = document.getElementById("status");
  const $results = document.getElementById("results");
  const $sentinel = document.getElementById("sentinel");

  $results.innerHTML = `<div class="small">Loading…</div>`;

  const idx = await loadIndex();
  rulesCache = await loadSkuRules();
  const rules = rulesCache;

  const listingsAll = Array.isArray(idx.items) ? idx.items : [];
  const liveAll = listingsAll.filter((r) => r && !r.removed);

  const storeNorm = normStoreLabel(storeLabel);

  // Build global per-canonical-SKU store presence + min prices
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
  const rowsStoreLive = liveAll.filter((r) => normStoreLabel(r.storeLabel || r.store || "") === storeNorm);

  // Aggregate in this store, grouped by canonical SKU (so mappings count as same bottle)
  let items = aggregateBySku(rowsStoreLive, rules.canonicalSku);

  // Decorate each item with pricing comparisons + exclusivity
  const EPS = 0.01;

  items = items
    .map((it) => {
      const sku = String(it.sku || "");
      const storeSet = storesBySku.get(sku) || new Set([storeNorm]);
      const exclusive = storeSet.size === 1 && storeSet.has(storeNorm);

      const storePrice = Number.isFinite(it.cheapestPriceNum) ? it.cheapestPriceNum : null;
      const bestAll = bestAllPrice(sku);
      const other = bestOtherPrice(sku, storeNorm);

      const isBest = storePrice !== null && bestAll !== null ? storePrice <= bestAll + EPS : false;

      // Sort key: compare vs cheapest alternative store (if we're best, that's "next best"; else that's "best")
      const pctVsOther =
        storePrice !== null && other !== null && other > 0 ? ((storePrice - other) / other) * 100 : null;

      const pctVsBest =
        storePrice !== null && bestAll !== null && bestAll > 0 ? ((storePrice - bestAll) / bestAll) * 100 : null;

      return {
        ...it,
        _exclusive: exclusive,
        _storePrice: storePrice,
        _bestAll: bestAll,
        _bestOther: other,
        _isBest: isBest,
        _pctVsOther: pctVsOther,
        _pctVsBest: pctVsBest,
      };
    })
    .sort((a, b) => {
      if (a._exclusive !== b._exclusive) return a._exclusive ? -1 : 1;

      const pa = a._pctVsOther;
      const pb = b._pctVsOther;
      const sa = pa === null ? 999999 : pa;
      const sb = pb === null ? 999999 : pb;
      if (sa !== sb) return sa - sb;

      return (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku);
    });

  function priceBadgeHtml(it) {
    if (it._exclusive) return "";

    const pOther = it._pctVsOther;
    const pBest = it._pctVsBest;

    // If we can't compare, skip the % badge.
    if (pOther === null || !Number.isFinite(pOther)) return "";

    // Grey zone: -5% .. +5% => "same as next best price"
    if (Math.abs(pOther) <= 5) {
      return `<span class="badge badgeNeutral">same as next best price</span>`;
    }

    // Deals: we're best (cheaper than other)
    if (pOther < 0 && it._bestOther !== null && it._bestOther > 0 && it._storePrice !== null) {
      const pct = Math.round(((it._bestOther - it._storePrice) / it._bestOther) * 100);
      if (pct <= 0) return `<span class="badge badgeNeutral">same as next best price</span>`;
      return `<span class="badge badgeGood">${esc(pct)}% vs next best price</span>`;
    }

    // More expensive: show vs best price
    if (pBest !== null && Number.isFinite(pBest) && pBest > 0) {
      const pct = Math.round(pBest);
      if (pct <= 5) return `<span class="badge badgeNeutral">same as next best price</span>`;
      return `<span class="badge badgeBad">${esc(pct)}% vs best price</span>`;
    }

    return "";
  }

  function renderCard(it) {
    const price = it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)";
    const href = String(it.sampleUrl || "").trim();

    const exclusiveBadge = it._exclusive ? `<span class="badge badgeGood">Exclusive</span>` : "";
    const bestBadge = !it._exclusive && it._isBest ? `<span class="badge badgeBest">Best Price</span>` : "";
    const pctBadge = priceBadgeHtml(it);

    const skuLink =
      `#/link/?left=${encodeURIComponent(String(it.sku || ""))}`;

    return `
      <div class="item" data-sku="${esc(it.sku)}">
        <div class="itemRow">
          <div class="thumbBox">${renderThumbHtml(it.img)}</div>
          <div class="itemBody">
            <div class="itemTop">
              <div class="itemName">${esc(it.name || "(no name)")}</div>
              <a class="badge mono skuLink" target="_blank" rel="noopener noreferrer" href="${esc(skuLink)}" onclick="event.stopPropagation()">${esc(
                displaySku(it.sku)
              )}</a>
            </div>
            <div class="metaRow">
              ${exclusiveBadge}
              ${bestBadge}
              ${pctBadge}
              <span class="mono price">${esc(price)}</span>
              ${
                href
                  ? `<a class="badge" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Open</a>`
                  : ``
              }
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---- Infinite scroll paging ----
  const PAGE_SIZE = 140;

  let filtered = items.slice();
  let shown = 0;

  function setStatus() {
    const total = filtered.length;
    if (!total) {
      $status.textContent = "No in-stock items for this store.";
      return;
    }
    $status.textContent = `In stock: ${total} item(s).`;
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
    }

    if (!filtered.length) {
      $sentinel.textContent = "";
    } else if (shown >= filtered.length) {
      $sentinel.textContent = `Showing ${shown} / ${filtered.length}`;
    } else {
      $sentinel.textContent = `Showing ${shown} / ${filtered.length}…`;
    }
  }

  // Click -> item page (delegated). SKU + Open links stopPropagation already.
  $results.addEventListener("click", (e) => {
    const el = e.target.closest(".item");
    if (!el) return;
    const sku = el.getAttribute("data-sku") || "";
    if (!sku) return;
    sessionStorage.setItem("viz:lastRoute", location.hash);
    location.hash = `#/item/${encodeURIComponent(sku)}`;
  });

  function applyFilter() {
    const tokens = tokenizeQuery($q.value);

    if (!tokens.length) {
      filtered = items.slice();
    } else {
      filtered = items.filter((it) => matchesAllTokens(it.searchText, tokens));
    }
    setStatus();
    renderNext(true);
  }

  // Initial render
  setStatus();
  renderNext(true);

  const io = new IntersectionObserver(
    (entries) => {
      const hit = entries.some((x) => x.isIntersecting);
      if (!hit) return;
      if (shown >= filtered.length) return;
      renderNext(false);
    },
    { root: null, rootMargin: "600px 0px", threshold: 0.01 }
  );
  io.observe($sentinel);

  let t = null;
  $q.addEventListener("input", () => {
    saveStoreQuery(storeLabel, $q.value);
    if (t) clearTimeout(t);
    t = setTimeout(applyFilter, 60);
  });
}
