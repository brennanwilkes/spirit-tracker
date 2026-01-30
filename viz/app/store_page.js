import { esc, renderThumbHtml } from "./dom.js";
import { tokenizeQuery, matchesAllTokens, displaySku, keySkuForRow, parsePriceToNumber } from "./sku.js";
import { loadIndex } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";

function normStoreLabel(s) {
  return String(s || "").trim().toLowerCase();
}

function storeLabelFromRow(r) {
  return String(r?.storeLabel || r?.store || "").trim();
}

function storeQueryKey(storeNorm) {
  return `stviz:v1:store:q:${storeNorm}`;
}

function loadStoreQuery(storeNorm) {
  try {
    return localStorage.getItem(storeQueryKey(storeNorm)) || "";
  } catch {
    return "";
  }
}

function saveStoreQuery(storeNorm, v) {
  try {
    localStorage.setItem(storeQueryKey(storeNorm), String(v ?? ""));
  } catch {}
}

function urlQuality(u) {
  u = String(u || "").trim();
  if (!u) return -1;
  let s = 0;
  s += u.length;
  if (/\bproduct\/\d+\//.test(u)) s += 50;
  if (/[a-z0-9-]{8,}/i.test(u)) s += 10;
  return s;
}

export async function renderStore($app, storeParamRaw) {
  const storeParam = String(storeParamRaw || "").trim();
  const storeNorm = normStoreLabel(storeParam);

  $app.innerHTML = `
    <div class="container" style="max-width:980px;">
      <div class="topbar">
        <button id="back" class="btn">← Back</button>
        <span class="badge">${esc(storeParam || "Store")}</span>
        <div style="flex:1"></div>
      </div>

      <div class="card">
        <input id="q" class="input" placeholder="Search this store…" autocomplete="off" />
        <div id="status" class="small" style="margin-top:10px;"></div>
        <div id="results" class="list"></div>
      </div>
    </div>
  `;

  document.getElementById("back").addEventListener("click", () => (location.hash = "#/"));

  const $q = document.getElementById("q");
  const $results = document.getElementById("results");
  const $status = document.getElementById("status");

  $q.value = loadStoreQuery(storeNorm);

  $results.innerHTML = `<div class="small">Loading…</div>`;

  const [idx, rules] = await Promise.all([loadIndex(), loadSkuRules()]);
  const allRows = Array.isArray(idx.items) ? idx.items : [];

  // Live only
  const liveAll = allRows.filter((r) => r && !r.removed);

  // Resolve store display label (in case casing differs)
  let storeDisplay = storeParam || "Store";
  {
    const dispByNorm = new Map();
    for (const r of liveAll) {
      const lab = storeLabelFromRow(r);
      if (!lab) continue;
      const n = normStoreLabel(lab);
      if (!dispByNorm.has(n)) dispByNorm.set(n, lab);
    }
    storeDisplay = dispByNorm.get(storeNorm) || storeDisplay;
  }

  // Filter rows for this store
  const liveStore = liveAll.filter((r) => normStoreLabel(storeLabelFromRow(r)) === storeNorm);

  if (!liveStore.length) {
    $results.innerHTML = `<div class="small">No in-stock items for this store.</div>`;
    $status.textContent = "";
    return;
  }

  // Global presence + min-price map (by canonical sku)
  const presenceBySku = new Map(); // sku -> Set(storeNorm)
  const minPriceBySkuStore = new Map(); // sku -> Map(storeNorm -> minPrice)

  for (const r of liveAll) {
    const storeLab = storeLabelFromRow(r);
    const sNorm = normStoreLabel(storeLab);
    if (!sNorm) continue;

    const skuKey = String(keySkuForRow(r) || "").trim();
    if (!skuKey) continue;

    const sku = String(rules.canonicalSku(skuKey) || "").trim();
    if (!sku) continue;

    let pres = presenceBySku.get(sku);
    if (!pres) presenceBySku.set(sku, (pres = new Set()));
    pres.add(sNorm);

    const p = parsePriceToNumber(r?.price);
    if (p === null) continue;

    let m = minPriceBySkuStore.get(sku);
    if (!m) minPriceBySkuStore.set(sku, (m = new Map()));

    const prev = m.get(sNorm);
    if (!Number.isFinite(prev) || p < prev) m.set(sNorm, p);
  }

  // Build store-only aggregates (canonicalized)
  const storeAgg = aggregateBySku(liveStore, rules.canonicalSku);

  // Best URL for this store per canonical SKU
  const urlBySku = new Map(); // sku -> url
  for (const r of liveStore) {
    const skuKey = String(keySkuForRow(r) || "").trim();
    if (!skuKey) continue;
    const sku = String(rules.canonicalSku(skuKey) || "").trim();
    if (!sku) continue;

    const u = String(r?.url || "").trim();
    if (!u) continue;

    const prev = urlBySku.get(sku);
    if (!prev) {
      urlBySku.set(sku, u);
      continue;
    }

    const a = urlQuality(prev);
    const b = urlQuality(u);
    if (b > a) urlBySku.set(sku, u);
    else if (b === a && u < prev) urlBySku.set(sku, u);
  }

  function computeCompare(it) {
    const sku = String(it?.sku || "");
    const pres = presenceBySku.get(sku) || new Set([storeNorm]);
    const exclusive = pres.size === 1 && pres.has(storeNorm);

    const storePrice = Number.isFinite(it?.cheapestPriceNum) ? it.cheapestPriceNum : null;

    const m = minPriceBySkuStore.get(sku) || new Map();
    let bestAll = null;
    let bestOther = null;

    for (const [sNorm, p] of m.entries()) {
      if (!Number.isFinite(p)) continue;
      bestAll = bestAll === null ? p : Math.min(bestAll, p);
      if (sNorm !== storeNorm) bestOther = bestOther === null ? p : Math.min(bestOther, p);
    }

    // pct: (this - nextBestOther)/nextBestOther * 100
    const pct =
      storePrice !== null && bestOther !== null && bestOther > 0
        ? ((storePrice - bestOther) / bestOther) * 100
        : null;

    const EPS = 0.01;
    const isBestPrice = storePrice !== null && bestAll !== null ? storePrice <= bestAll + EPS : false;

    return { exclusive, pct, isBestPrice };
  }

  const items = storeAgg
    .map((it) => {
      const c = computeCompare(it);
      return {
        ...it,
        _exclusive: c.exclusive,
        _pct: c.pct,
        _isBestPrice: c.isBestPrice,
      };
    })
    .sort((a, b) => {
      if (a._exclusive !== b._exclusive) return a._exclusive ? -1 : 1;

      const ap = Number.isFinite(a._pct) ? a._pct : Infinity;
      const bp = Number.isFinite(b._pct) ? b._pct : Infinity;
      if (ap !== bp) return ap - bp;

      return (String(a.name) + String(a.sku)).localeCompare(String(b.name) + String(b.sku));
    });

  function pctBadge(pct) {
    if (!Number.isFinite(pct)) return null;

    const p = Math.round(pct);
    const txt = `${p >= 0 ? "+" : ""}${p}% vs next`;

    if (pct < -5) return { cls: "badge badgeGood", txt };
    if (pct > 5) return { cls: "badge badgeBad", txt };
    return { cls: "badge badgeNeutral", txt }; // -5%..+5%
  }

  function renderCard(it) {
    const price = it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)";
    const href = urlBySku.get(String(it.sku || "")) || String(it.sampleUrl || "").trim();

    const storeBadge = href
      ? `<a class="badge" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
          storeDisplay
        )}</a>`
      : `<span class="badge">${esc(storeDisplay)}</span>`;

    const badges = [];

    if (it._exclusive) badges.push(`<span class="badge badgeExclusive">EXCLUSIVE</span>`);
    if (!it._exclusive && it._isBestPrice) badges.push(`<span class="badge badgeGood">Best Price</span>`);

    if (!it._exclusive) {
      const pb = pctBadge(it._pct);
      if (pb) badges.push(`<span class="${esc(pb.cls)}">${esc(pb.txt)}</span>`);
    }

    return `
      <div class="item" data-sku="${esc(it.sku)}">
        <div class="itemRow">
          <div class="thumbBox">${renderThumbHtml(it.img)}</div>
          <div class="itemBody">
            <div class="itemTop">
              <div class="itemName">${esc(it.name || "(no name)")}</div>
              <span class="badge mono">${esc(displaySku(it.sku))}</span>
            </div>
            <div class="metaRow metaRowWrap">
              ${badges.join("")}
              <span class="mono price">${esc(price)}</span>
              ${storeBadge}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderList(filtered) {
    if (!filtered.length) {
      $results.innerHTML = `<div class="small">No matches.</div>`;
      return;
    }

    const limited = filtered.slice(0, 120);
    $results.innerHTML = limited.map(renderCard).join("");

    for (const el of Array.from($results.querySelectorAll(".item"))) {
      el.addEventListener("click", () => {
        const sku = el.getAttribute("data-sku") || "";
        if (!sku) return;
        saveStoreQuery(storeNorm, $q.value);
        location.hash = `#/item/${encodeURIComponent(sku)}`;
      });
    }
  }

  function applySearch() {
    const tokens = tokenizeQuery($q.value);
    saveStoreQuery(storeNorm, $q.value);

    const filtered = tokens.length ? items.filter((it) => matchesAllTokens(it.searchText, tokens)) : items;

    $status.textContent = `In stock: ${items.length}. Showing: ${filtered.length}.`;
    renderList(filtered);
  }

  $q.focus();
  applySearch();

  let t = null;
  $q.addEventListener("input", () => {
    if (t) clearTimeout(t);
    t = setTimeout(applySearch, 50);
  });
}
