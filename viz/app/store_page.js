import { esc, renderThumbHtml, prettyTs } from "./dom.js";
import {
  tokenizeQuery,
  matchesAllTokens,
  displaySku,
  keySkuForRow,
  parsePriceToNumber,
} from "./sku.js";
import { loadIndex, loadRecent, saveQuery, loadSavedQuery } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";

export function renderStore($app, storeLabelParam) {
  $app.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="headerRow1">
          <div class="headerLeft">
            <h1 class="h1">Store</h1>
            <div class="small" id="storeSub">Loading…</div>
          </div>

          <div class="headerRight headerButtons">
            <a class="btn btnWide" href="#/" style="text-decoration:none;">Search</a>
            <a class="btn btnWide" href="#/stats" style="text-decoration:none;">Statistics</a>
            <a class="btn btnWide" href="#/link" style="text-decoration:none;">Link SKUs</a>
          </div>
        </div>
      </div>

      <div class="card" style="display:flex; gap:14px; align-items:flex-start;">
        <!-- Left: store catalog -->
        <div style="flex: 1 1 62%; min-width: 360px;">
          <div style="display:flex; gap:10px; align-items:center; width:100%; margin-bottom:10px;">
            <input id="q" class="input" placeholder="Filter this store…" autocomplete="off" style="flex: 1 1 auto;" />
            <button id="clearSearch" class="btn btnSm" type="button" style="flex: 0 0 auto;">Clear</button>
          </div>
          <div id="storeResults" class="list"></div>
        </div>

        <!-- Right: exclusives / last stock -->
        <div style="flex: 0 0 38%; min-width: 320px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
            <div class="small">Exclusives / Last stock</div>
            <select id="rightSort" class="input" style="max-width: 160px;">
              <option value="time">Time</option>
              <option value="price">Price</option>
              <option value="sale_pct">Sale %</option>
              <option value="sale_abs">Sale $</option>
            </select>
          </div>

          <div class="small" style="margin: 8px 0 6px;">Exclusives</div>
          <div id="exclusiveResults" class="list"></div>

          <div class="small" style="margin: 14px 0 6px;">Last stock</div>
          <div id="lastStockResults" class="list"></div>
        </div>
      </div>
    </div>
  `;

  const $q = document.getElementById("q");
  const $storeSub = document.getElementById("storeSub");
  const $storeResults = document.getElementById("storeResults");
  const $exclusiveResults = document.getElementById("exclusiveResults");
  const $lastStockResults = document.getElementById("lastStockResults");
  const $clearSearch = document.getElementById("clearSearch");
  const $rightSort = document.getElementById("rightSort");

  // Keep store-page filter consistent with the app's saved query (optional).
  $q.value = loadSavedQuery() || "";

  const SORT_KEY = "viz:storeRightSort";
  $rightSort.value = sessionStorage.getItem(SORT_KEY) || "time";

  let indexReady = false;

  let STORE_LABEL = String(storeLabelParam || "").trim();
  let CANON = (x) => x;

  // canonicalSku -> agg
  let aggBySku = new Map();
  // canonicalSku -> storeLabel -> { priceNum, priceStr, url }
  let PRICE_BY_SKU_STORE = new Map();
  // canonicalSku -> storeLabel -> url (for badge href)
  let URL_BY_SKU_STORE = new Map();

  // canonicalSku -> storeLabel -> most recent recent-row (within 7d)
  let RECENT_BY_SKU_STORE = new Map();

  // For left list: canonicalSku -> best row for this store (cheapest priceNum; tie -> newest)
  let STORE_ROW_BY_SKU = new Map();

  // Derived right-side lists
  let exclusives = [];
  let lastStock = [];
  let storeItems = []; // left list items

  function normStoreLabel(s) {
    return String(s || "").trim().toLowerCase();
  }

  function resolveStoreLabel(listings, wanted) {
    const w = normStoreLabel(wanted);
    if (!w) return "";
    for (const r of Array.isArray(listings) ? listings : []) {
      const lab = String(r?.storeLabel || r?.store || "").trim();
      if (lab && normStoreLabel(lab) === w) return lab;
    }
    return wanted;
  }

  function tsValue(r) {
    const t = String(r?.ts || "");
    const ms = t ? Date.parse(t) : NaN;
    if (Number.isFinite(ms)) return ms;
    const d = String(r?.date || "");
    const ms2 = d ? Date.parse(d) : NaN;
    return Number.isFinite(ms2) ? ms2 : 0;
  }

  function eventMs(r) {
    const t = String(r?.ts || "");
    const ms = t ? Date.parse(t) : NaN;
    if (Number.isFinite(ms)) return ms;

    const d = String(r?.date || "");
    const ms2 = d ? Date.parse(d + "T00:00:00Z") : NaN;
    return Number.isFinite(ms2) ? ms2 : 0;
  }

  function buildUrlMap(listings, canonicalSkuFn) {
    const out = new Map();
    for (const r of Array.isArray(listings) ? listings : []) {
      if (!r || r.removed) continue;

      const skuKey = String(keySkuForRow(r) || "").trim();
      if (!skuKey) continue;

      const sku = String(canonicalSkuFn ? canonicalSkuFn(skuKey) : skuKey).trim();
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

  function urlForSkuStore(sku, storeLabel) {
    const s = String(sku || "");
    const lab = String(storeLabel || "");
    return URL_BY_SKU_STORE.get(s)?.get(lab) || "";
  }

  function buildPriceMap(listings, canonicalSkuFn) {
    const out = new Map();
    for (const r of Array.isArray(listings) ? listings : []) {
      if (!r || r.removed) continue;

      const rawSku = String(keySkuForRow(r) || "").trim();
      if (!rawSku) continue;

      const sku = String(canonicalSkuFn ? canonicalSkuFn(rawSku) : rawSku).trim();
      if (!sku) continue;

      const storeLabel = String(r.storeLabel || r.store || "").trim();
      if (!storeLabel) continue;

      const priceStr = String(r.price || "").trim();
      const priceNum = parsePriceToNumber(priceStr);
      if (!Number.isFinite(priceNum)) continue;

      const url = String(r.url || "").trim();

      let m = out.get(sku);
      if (!m) out.set(sku, (m = new Map()));

      const prev = m.get(storeLabel);
      if (!prev || priceNum < prev.priceNum) {
        m.set(storeLabel, { priceNum, priceStr, url });
      }
    }
    return out;
  }

  function pickBestStoreRowForSku(listings, canonicalSkuFn, storeLabel) {
    const out = new Map();
    const want = normStoreLabel(storeLabel);

    for (const r of Array.isArray(listings) ? listings : []) {
      if (!r || r.removed) continue;

      const lab = String(r.storeLabel || r.store || "").trim();
      if (!lab || normStoreLabel(lab) !== want) continue;

      const rawSku = String(keySkuForRow(r) || "").trim();
      if (!rawSku) continue;

      const sku = String(canonicalSkuFn ? canonicalSkuFn(rawSku) : rawSku).trim();
      if (!sku) continue;

      const priceStr = String(r.price || "").trim();
      const priceNum = parsePriceToNumber(priceStr);
      const ms = tsValue(r);

      const prev = out.get(sku);
      if (!prev) {
        out.set(sku, { r, priceNum, ms });
        continue;
      }

      const prevPrice = prev.priceNum;
      const prevMs = prev.ms;

      const priceOk = Number.isFinite(priceNum);
      const prevOk = Number.isFinite(prevPrice);

      if (priceOk && !prevOk) out.set(sku, { r, priceNum, ms });
      else if (priceOk && prevOk && priceNum < prevPrice) out.set(sku, { r, priceNum, ms });
      else if (
        (priceOk && prevOk && Math.abs(priceNum - prevPrice) <= 0.01 && ms > prevMs) ||
        (!priceOk && !prevOk && ms > prevMs)
      ) {
        out.set(sku, { r, priceNum, ms });
      }
    }

    return out;
  }

  function buildRecentBySkuStore(recentItems, canonicalSkuFn, days) {
    const nowMs = Date.now();
    const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

    // sku -> storeLabel -> row
    const out = new Map();

    for (const r of Array.isArray(recentItems) ? recentItems : []) {
      const ms = eventMs(r);
      if (!(ms >= cutoffMs && ms <= nowMs)) continue;

      const rawSku = String(r?.sku || "").trim();
      if (!rawSku) continue;

      const sku = String(canonicalSkuFn ? canonicalSkuFn(rawSku) : rawSku).trim();
      if (!sku) continue;

      const storeLabel = String(r?.storeLabel || r?.store || "").trim();
      if (!storeLabel) continue;

      let storeMap = out.get(sku);
      if (!storeMap) out.set(sku, (storeMap = new Map()));

      const prev = storeMap.get(storeLabel);
      if (!prev || eventMs(prev) < ms) storeMap.set(storeLabel, r);
    }

    return out;
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

  function salePctOff(oldRaw, newRaw) {
    const oldN = parsePriceToNumber(oldRaw);
    const newN = parsePriceToNumber(newRaw);
    if (!Number.isFinite(oldN) || !Number.isFinite(newN)) return null;
    if (!(oldN > 0)) return null;
    if (!(newN < oldN)) return null;
    const pct = Math.round(((oldN - newN) / oldN) * 100);
    return Number.isFinite(pct) && pct > 0 ? pct : null;
  }

  function pctChange(oldRaw, newRaw) {
    const oldN = parsePriceToNumber(oldRaw);
    const newN = parsePriceToNumber(newRaw);
    if (!Number.isFinite(oldN) || !Number.isFinite(newN)) return null;
    if (!(oldN > 0)) return null;
    const pct = Math.round(((newN - oldN) / oldN) * 100);
    return Number.isFinite(pct) ? pct : null;
  }

  function fmtUsd(n) {
    const abs = Math.abs(Number(n) || 0);
    if (!Number.isFinite(abs)) return "";
    const s = abs.toFixed(2);
    return s.endsWith(".00") ? s.slice(0, -3) : s;
  }

  function recentSaleMetaForSkuStore(sku, storeLabel) {
    const r = RECENT_BY_SKU_STORE.get(String(sku || ""))?.get(String(storeLabel || ""));
    if (!r) return null;

    const kind = normalizeKindForPrice(r);
    if (kind !== "price_down" && kind !== "price_up" && kind !== "price_change") return null;

    const oldStr = String(r?.oldPrice || "").trim();
    const newStr = String(r?.newPrice || "").trim();
    const oldN = parsePriceToNumber(oldStr);
    const newN = parsePriceToNumber(newStr);

    if (!Number.isFinite(oldN) || !Number.isFinite(newN) || !(oldN > 0)) return null;

    // signedPct: down => negative; up => positive; unchanged => 0
    let signedPct = 0;
    let signedDelta = newN - oldN; // down => negative

    if (newN < oldN) {
      const off = salePctOff(oldStr, newStr);
      signedPct = off !== null ? -off : Math.round(((newN - oldN) / oldN) * 100);
    } else if (newN > oldN) {
      const up = pctChange(oldStr, newStr);
      signedPct = up !== null ? up : Math.round(((newN - oldN) / oldN) * 100);
    } else {
      signedPct = 0;
      signedDelta = 0;
    }

    const when = r.ts ? prettyTs(r.ts) : r.date || "";

    return {
      r,
      kind,
      oldStr,
      newStr,
      oldN,
      newN,
      signedPct,
      signedDelta,
      when,
    };
  }

  function pctOffVsNextBest(sku, storeLabel) {
    const m = PRICE_BY_SKU_STORE.get(String(sku || ""));
    if (!m) return null;

    const here = m.get(String(storeLabel || ""));
    if (!here || !Number.isFinite(here.priceNum)) return null;

    const prices = [];
    for (const v of m.values()) {
      if (Number.isFinite(v?.priceNum)) prices.push(v.priceNum);
    }
    prices.sort((a, b) => a - b);

    if (!prices.length) return null;

    const EPS = 0.01;
    const min = prices[0];
    if (Math.abs(here.priceNum - min) > EPS) return null;

    // find second distinct
    let second = null;
    for (let i = 1; i < prices.length; i++) {
      if (Math.abs(prices[i] - min) > EPS) {
        second = prices[i];
        break;
      }
    }
    if (!Number.isFinite(second) || !(second > 0) || !(min < second)) return null;

    const pct = Math.round(((second - min) / second) * 100);
    return Number.isFinite(pct) && pct > 0 ? pct : null;
  }

  function badgeHtmlForSale(sortMode, saleMeta) {
    if (!saleMeta) return "";
    if (sortMode === "sale_pct") {
      const v = saleMeta.signedPct;
      if (!Number.isFinite(v) || v === 0) return "";
      const isDown = v < 0;
      const abs = Math.abs(v);
      const style = isDown
        ? ` style="margin-left:6px; color:rgba(20,110,40,0.95); background:rgba(20,110,40,0.10); border:1px solid rgba(20,110,40,0.20);"`
        : ` style="margin-left:6px; color:rgba(170,40,40,0.95); background:rgba(170,40,40,0.10); border:1px solid rgba(170,40,40,0.20);"`;
      const txt = isDown ? `[${abs}% Off]` : `[+${abs}%]`;
      return `<span class="badge"${style}>${esc(txt)}</span>`;
    }

    if (sortMode === "sale_abs") {
      const d = saleMeta.signedDelta;
      if (!Number.isFinite(d) || d === 0) return "";
      const isDown = d < 0;
      const abs = fmtUsd(d);
      if (!abs) return "";
      const style = isDown
        ? ` style="margin-left:6px; color:rgba(20,110,40,0.95); background:rgba(20,110,40,0.10); border:1px solid rgba(20,110,40,0.20);"`
        : ` style="margin-left:6px; color:rgba(170,40,40,0.95); background:rgba(170,40,40,0.10); border:1px solid rgba(170,40,40,0.20);"`;
      const txt = isDown ? `[$${abs} Off]` : `[+$${abs}]`;
      return `<span class="badge"${style}>${esc(txt)}</span>`;
    }

    return "";
  }

  function badgeHtmlForExclusivePctOff(sku) {
    const pct = pctOffVsNextBest(sku, STORE_LABEL);
    if (!Number.isFinite(pct) || pct <= 0) return "";
    return `<span class="badge" style="margin-left:6px; color:rgba(20,110,40,0.95); background:rgba(20,110,40,0.10); border:1px solid rgba(20,110,40,0.20);">[${esc(
      pct
    )}% Off]</span>`;
  }

  function itemCardHtml(it, { annotateMode }) {
    // annotateMode: "sale_pct" | "sale_abs" | "default"
    const sku = String(it?.sku || "");
    const name = String(it?.name || "(no name)");
    const img = String(it?.img || "");
    const priceStr = it.priceStr ? it.priceStr : "(no price)";

    const href = urlForSkuStore(sku, STORE_LABEL) || String(it?.url || "").trim();
    const storeBadge = href
      ? `<a class="badge" href="${esc(
          href
        )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
          STORE_LABEL
        )}</a>`
      : `<span class="badge">${esc(STORE_LABEL)}</span>`;

    const skuLink = `#/link/?left=${encodeURIComponent(sku)}`;

    let annot = "";
    if (annotateMode === "sale_pct" || annotateMode === "sale_abs") {
      annot = badgeHtmlForSale(annotateMode, it.saleMeta);
    } else {
      // default annotation is % off for exclusives only (and only if >0)
      if (it.isExclusive) annot = badgeHtmlForExclusivePctOff(sku);
    }

    return `
      <div class="item" data-sku="${esc(sku)}">
        <div class="itemRow">
          <div class="thumbBox">
            ${renderThumbHtml(img)}
          </div>
          <div class="itemBody">
            <div class="itemTop">
              <div class="itemName">${esc(name)}</div>
              <a class="badge mono skuLink" href="${esc(
                skuLink
              )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
      displaySku(sku)
    )}</a>
            </div>
            <div class="metaRow">
              <span class="mono price">${esc(priceStr)}</span>
              ${annot}
              ${storeBadge}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderList($el, items, annotateMode) {
    if (!items.length) {
      $el.innerHTML = `<div class="small">No matches.</div>`;
      return;
    }

    const limited = items.slice(0, 80);
    $el.innerHTML = limited.map((it) => itemCardHtml(it, { annotateMode })).join("");

    for (const el of Array.from($el.querySelectorAll(".item"))) {
      el.addEventListener("click", () => {
        const sku = el.getAttribute("data-sku") || "";
        if (!sku) return;
        saveQuery($q.value);
        sessionStorage.setItem("viz:lastRoute", location.hash);
        location.hash = `#/item/${encodeURIComponent(sku)}`;
      });
    }
  }

  function renderStoreCatalog(items) {
    if (!items.length) {
      $storeResults.innerHTML = `<div class="small">No matches.</div>`;
      return;
    }

    const limited = items.slice(0, 160);
    $storeResults.innerHTML = limited
      .map((it) => {
        const sku = String(it?.sku || "");
        const href = urlForSkuStore(sku, STORE_LABEL) || String(it?.url || "").trim();
        const storeBadge = href
          ? `<a class="badge" href="${esc(
              href
            )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
              STORE_LABEL
            )}</a>`
          : `<span class="badge">${esc(STORE_LABEL)}</span>`;

        const skuLink = `#/link/?left=${encodeURIComponent(sku)}`;

        return `
          <div class="item" data-sku="${esc(sku)}">
            <div class="itemRow">
              <div class="thumbBox">
                ${renderThumbHtml(it.img)}
              </div>
              <div class="itemBody">
                <div class="itemTop">
                  <div class="itemName">${esc(it.name || "(no name)")}</div>
                  <a class="badge mono skuLink" href="${esc(
                    skuLink
                  )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
          displaySku(sku)
        )}</a>
                </div>
                <div class="metaRow">
                  <span class="mono price">${esc(it.priceStr || "(no price)")}</span>
                  ${storeBadge}
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    for (const el of Array.from($storeResults.querySelectorAll(".item"))) {
      el.addEventListener("click", () => {
        const sku = el.getAttribute("data-sku") || "";
        if (!sku) return;
        saveQuery($q.value);
        sessionStorage.setItem("viz:lastRoute", location.hash);
        location.hash = `#/item/${encodeURIComponent(sku)}`;
      });
    }
  }

  function sortRightList(items, mode) {
    const m = String(mode || "time");

    const getTime = (it) => Number(it?.timeMs || 0);
    const getPrice = (it) => (Number.isFinite(it?.priceNum) ? it.priceNum : Number.POSITIVE_INFINITY);

    const getSignedPct = (it) => {
      const v = it?.saleMeta?.signedPct;
      return Number.isFinite(v) ? v : 0; // unchanged/no-event => 0 (middle)
    };

    const getSignedDelta = (it) => {
      const v = it?.saleMeta?.signedDelta;
      return Number.isFinite(v) ? v : 0; // unchanged/no-event => 0 (middle)
    };

    const out = items.slice();

    if (m === "sale_pct") {
      out.sort((a, b) => {
        // deals (negative) first; unchanged (0) middle; increases (+) last
        const av = getSignedPct(a);
        const bv = getSignedPct(b);
        if (av !== bv) return av - bv;
        const ap = getPrice(a);
        const bp = getPrice(b);
        if (ap !== bp) return ap - bp;
        return String(a.sku || "").localeCompare(String(b.sku || ""));
      });
      return out;
    }

    if (m === "sale_abs") {
      out.sort((a, b) => {
        const av = getSignedDelta(a);
        const bv = getSignedDelta(b);
        if (av !== bv) return av - bv; // negative (down) first, positive (up) last
        const ap = getPrice(a);
        const bp = getPrice(b);
        if (ap !== bp) return ap - bp;
        return String(a.sku || "").localeCompare(String(b.sku || ""));
      });
      return out;
    }

    if (m === "price") {
      out.sort((a, b) => {
        const ap = getPrice(a);
        const bp = getPrice(b);
        if (ap !== bp) return ap - bp;
        return String(a.sku || "").localeCompare(String(b.sku || ""));
      });
      return out;
    }

    // time (default): newest first
    out.sort((a, b) => {
      const at = getTime(a);
      const bt = getTime(b);
      if (bt !== at) return bt - at;
      return String(a.sku || "").localeCompare(String(b.sku || ""));
    });
    return out;
  }

  function rebuildDerivedLists() {
    const tokens = tokenizeQuery($q.value);

    const filteredStoreItems = !tokens.length
      ? storeItems
      : storeItems.filter((it) => matchesAllTokens(it.searchText, tokens));

    renderStoreCatalog(filteredStoreItems);

    const rightSortMode = String($rightSort.value || "time");
    const annotMode =
      rightSortMode === "sale_pct"
        ? "sale_pct"
        : rightSortMode === "sale_abs"
        ? "sale_abs"
        : "default";

    const ex = !tokens.length
      ? exclusives
      : exclusives.filter((it) => matchesAllTokens(it.searchText, tokens));

    const ls = !tokens.length
      ? lastStock
      : lastStock.filter((it) => matchesAllTokens(it.searchText, tokens));

    renderList($exclusiveResults, sortRightList(ex, rightSortMode), annotMode);
    renderList($lastStockResults, sortRightList(ls, rightSortMode), annotMode);
  }

  $storeResults.innerHTML = `<div class="small">Loading…</div>`;
  $exclusiveResults.innerHTML = `<div class="small">Loading…</div>`;
  $lastStockResults.innerHTML = `<div class="small">Loading…</div>`;

  Promise.all([loadIndex(), loadSkuRules(), loadRecent()])
    .then(([idx, rules, recent]) => {
      const listings = Array.isArray(idx?.items) ? idx.items : [];

      CANON = typeof rules?.canonicalSku === "function" ? rules.canonicalSku : (x) => x;

      STORE_LABEL = resolveStoreLabel(listings, STORE_LABEL);
      $storeSub.textContent = STORE_LABEL ? `Browsing: ${STORE_LABEL}` : `Browsing store`;

      // Global aggregates (for "exclusive" / "last stock" determination)
      const allAgg = aggregateBySku(listings, CANON);
      aggBySku = new Map(allAgg.map((x) => [String(x.sku || ""), x]));

      URL_BY_SKU_STORE = buildUrlMap(listings, CANON);
      PRICE_BY_SKU_STORE = buildPriceMap(listings, CANON);

      // Store rows
      STORE_ROW_BY_SKU = pickBestStoreRowForSku(listings, CANON, STORE_LABEL);

      // Recent (7 days)
      const recentItems = Array.isArray(recent?.items) ? recent.items : [];
      RECENT_BY_SKU_STORE = buildRecentBySkuStore(recentItems, CANON, 7);

      // Build store item objects
      storeItems = [];
      exclusives = [];
      lastStock = [];

      for (const [sku, best] of STORE_ROW_BY_SKU.entries()) {
        const r = best?.r || null;
        if (!r) continue;

        const global = aggBySku.get(String(sku || "")) || null;
        const globalStoreCount = global?.stores?.size || 0;

        const storePriceStr = String(r.price || "").trim();
        const storePriceNum = parsePriceToNumber(storePriceStr);

        const saleMeta = recentSaleMetaForSkuStore(sku, STORE_LABEL);

        const searchText = String(
          [
            r.name || global?.name || "",
            r.url || "",
            sku,
            STORE_LABEL,
          ].join(" ")
        ).toLowerCase();

        const it = {
          sku: String(sku || ""),
          name: r.name || global?.name || "",
          img: global?.img || r.img || "",
          url: r.url || "",
          priceStr: storePriceStr,
          priceNum: storePriceNum,
          timeMs: tsValue(r),
          searchText,
          saleMeta,
          isExclusive: false,
          isLastStock: false,
          globalStoreCount,
        };

        // Determine exclusives / last stock
        const EPS = 0.01;
        const bestGlobalNum = Number.isFinite(global?.cheapestPriceNum) ? global.cheapestPriceNum : null;
        const storeIsCheapest =
          Number.isFinite(storePriceNum) && Number.isFinite(bestGlobalNum)
            ? Math.abs(storePriceNum - bestGlobalNum) <= EPS
            : false;

        if (globalStoreCount <= 1) {
          it.isLastStock = true;
          lastStock.push(it);
        } else if (storeIsCheapest) {
          it.isExclusive = true;
          exclusives.push(it);
        }

        storeItems.push(it);
      }

      // Default sort for store catalog: by name
      storeItems.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      indexReady = true;
      $q.focus();
      rebuildDerivedLists();
    })
    .catch((e) => {
      const msg = `Failed to load: ${esc(e?.message || String(e))}`;
      $storeResults.innerHTML = `<div class="small">${msg}</div>`;
      $exclusiveResults.innerHTML = `<div class="small">${msg}</div>`;
      $lastStockResults.innerHTML = `<div class="small">${msg}</div>`;
    });

  $clearSearch.addEventListener("click", () => {
    if ($q.value) {
      $q.value = "";
      saveQuery("");
      rebuildDerivedLists();
    }
    $q.focus();
  });

  let t = null;
  $q.addEventListener("input", () => {
    saveQuery($q.value);
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      if (!indexReady) return;
      rebuildDerivedLists();
    }, 50);
  });

  $rightSort.addEventListener("change", () => {
    sessionStorage.setItem(SORT_KEY, String($rightSort.value || "time"));
    if (!indexReady) return;
    rebuildDerivedLists();
  });
}
