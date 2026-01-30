import { esc, renderThumbHtml } from "./dom.js";
import {
  tokenizeQuery,
  matchesAllTokens,
  displaySku,
  keySkuForRow,
  parsePriceToNumber,
  normSearchText,
} from "./sku.js";
import { loadIndex } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";

function storeLabelForRow(r) {
  return String(r?.storeLabel || r?.store || "").trim();
}

function extractStores(listings) {
  const s = new Set();
  for (const r of Array.isArray(listings) ? listings : []) {
    const lab = storeLabelForRow(r);
    if (lab) s.add(lab);
  }
  return Array.from(s).sort((a, b) => a.localeCompare(b));
}

function urlQuality(u) {
  const s = String(u || "").trim();
  if (!s) return -1;
  let sc = 0;
  sc += s.length;
  if (/\bproduct\/\d+\//.test(s)) sc += 50;
  if (/[a-z0-9-]{8,}/i.test(s)) sc += 10;
  return sc;
}

function pctClass(pct) {
  if (!Number.isFinite(pct)) return "neutral";
  if (pct >= 5) return "good";
  if (pct <= -5) return "bad";
  return "neutral";
}

function pctLabel(pct) {
  if (!Number.isFinite(pct)) return "No compare";
  const s = pct > 0 ? `+${pct}` : `${pct}`;
  return `${s}% vs next`;
}

export async function renderStore($app, storeLabelInput) {
  $app.innerHTML = `
    <div class="container">
      <div class="topbar">
        <button id="back" class="btn">← Back</button>
        <span class="badge">${esc(storeLabelInput || "Store")}</span>
        <div style="flex:1"></div>
      </div>

      <div class="card">
        <div class="small" id="subtitle">Loading…</div>
        <input id="q" class="input" placeholder="Search this store (name / url / sku)..." autocomplete="off" />
        <div id="results" class="list"></div>
      </div>
    </div>
  `;

  document.getElementById("back").addEventListener("click", () => (location.hash = "#/"));

  const $subtitle = document.getElementById("subtitle");
  const $q = document.getElementById("q");
  const $results = document.getElementById("results");

  $results.innerHTML = `<div class="small">Loading index…</div>`;

  let idx, rules;
  try {
    [idx, rules] = await Promise.all([loadIndex(), loadSkuRules()]);
  } catch (e) {
    $results.innerHTML = `<div class="small">Failed to load: ${esc(e?.message || String(e))}</div>`;
    $subtitle.textContent = "";
    return;
  }

  const listings = Array.isArray(idx?.items) ? idx.items : [];
  const stores = extractStores(listings);

  // Normalize store label by case-insensitive match (helps if someone edits hash by hand)
  const wantLower = String(storeLabelInput || "").trim().toLowerCase();
  const storeLabel =
    stores.find((s) => String(s).toLowerCase() === wantLower) || String(storeLabelInput || "").trim();

  // Update header badge text (if normalized)
  const $badge = document.querySelector(".topbar .badge");
  if ($badge) $badge.textContent = storeLabel || "Store";

  if (!storeLabel || !stores.includes(storeLabel)) {
    $subtitle.textContent = "Unknown store.";
    $results.innerHTML =
      `<div class="small">Pick a store:</div>` +
      `<div class="storeList" style="margin-top:10px;">` +
      stores.map((s) => `<a class="badge storeChip" href="#/store/${encodeURIComponent(s)}">${esc(s)}</a>`).join("") +
      `</div>`;
    return;
  }

  // Build canonical aggregates
  const allAgg = aggregateBySku(listings, rules.canonicalSku);

  // Build per-(canonical sku)->store min price + best URL (LIVE only)
  const PRICE_BY_SKU_STORE = new Map(); // sku -> Map(store -> {priceNum, priceStr})
  const URL_BY_SKU_STORE = new Map(); // sku -> Map(store -> url)

  for (const r of listings) {
    if (!r || r.removed) continue;

    const skuKey = String(keySkuForRow(r) || "").trim();
    if (!skuKey) continue;

    const sku = String(rules.canonicalSku(skuKey) || "").trim();
    if (!sku) continue;

    const lab = storeLabelForRow(r);
    if (!lab) continue;

    // price
    const pNum = parsePriceToNumber(r.price);
    const pStr = String(r.price || "").trim();

    let sm = PRICE_BY_SKU_STORE.get(sku);
    if (!sm) PRICE_BY_SKU_STORE.set(sku, (sm = new Map()));

    if (pNum !== null) {
      const prev = sm.get(lab);
      if (!prev || pNum < prev.priceNum) sm.set(lab, { priceNum: pNum, priceStr: pStr });
      else if (prev && pNum === prev.priceNum && pStr && (!prev.priceStr || pStr.length < prev.priceStr.length))
        sm.set(lab, { priceNum: pNum, priceStr: pStr });
    }

    // url (prefer better)
    const url = String(r.url || "").trim();
    if (url) {
      let um = URL_BY_SKU_STORE.get(sku);
      if (!um) URL_BY_SKU_STORE.set(sku, (um = new Map()));

      const prev = um.get(lab);
      if (!prev) um.set(lab, url);
      else {
        const a = urlQuality(prev);
        const b = urlQuality(url);
        if (b > a) um.set(lab, url);
        else if (b === a && url < prev) um.set(lab, url);
      }
    }
  }

  // Build store-only list (in stock in this store), compute exclusive + pct vs next cheapest other store
  const EPS = 0.01;

  const base = [];
  for (const it of allAgg) {
    if (!it || !it.stores || !it.stores.has(storeLabel)) continue;

    const pm = PRICE_BY_SKU_STORE.get(String(it.sku || ""));
    const storeRec = pm?.get(storeLabel) || null;
    const storePriceNum = storeRec?.priceNum ?? null;
    const storePriceStr = storeRec?.priceStr || it.cheapestPriceStr || "(no price)";

    let globalMin = null;
    let otherMin = null;

    if (pm) {
      for (const [lab, rec] of pm.entries()) {
        const v = rec?.priceNum;
        if (!Number.isFinite(v)) continue;

        globalMin = globalMin === null ? v : Math.min(globalMin, v);

        if (lab !== storeLabel) {
          otherMin = otherMin === null ? v : Math.min(otherMin, v);
        }
      }
    }

    const bestHere = globalMin !== null && storePriceNum !== null && Math.abs(storePriceNum - globalMin) <= EPS;

    let pct = null;
    if (storePriceNum !== null && otherMin !== null && otherMin > 0) {
      pct = Math.round(((otherMin - storePriceNum) / otherMin) * 100);
    }

    const exclusive = it.stores.size === 1;

    const href =
      URL_BY_SKU_STORE.get(String(it.sku || ""))?.get(storeLabel) ||
      String(it.sampleUrl || "").trim() ||
      "";

    const storeSearchText = normSearchText([it.searchText || "", href || ""].join(" | "));

    base.push({
      ...it,
      _exclusive: exclusive,
      _bestHere: bestHere,
      _pct: pct,
      _storePriceNum: storePriceNum,
      _storePriceStr: storePriceStr,
      _href: href,
      _storeSearchText: storeSearchText,
    });
  }

  base.sort((a, b) => {
    const ax = a._exclusive ? 0 : 1;
    const bx = b._exclusive ? 0 : 1;
    if (ax !== bx) return ax - bx;

    // Exclusives: stable by name
    if (ax === 0) return (String(a.name) + String(a.sku)).localeCompare(String(b.name) + String(b.sku));

    const ap = Number.isFinite(a._pct) ? a._pct : -1e9;
    const bp = Number.isFinite(b._pct) ? b._pct : -1e9;
    if (bp !== ap) return bp - ap;

    return (String(a.name) + String(a.sku)).localeCompare(String(b.name) + String(b.sku));
  });

  $subtitle.textContent = `In-stock items for ${storeLabel} — Exclusives first, then best deals.`;

  function renderList(query) {
    const tokens = tokenizeQuery(query);

    const items = !tokens.length
      ? base
      : base.filter((it) => matchesAllTokens(String(it._storeSearchText || ""), tokens));

    if (!items.length) {
      $results.innerHTML = `<div class="small">No matches.</div>`;
      return;
    }

    $results.innerHTML = items
      .map((it) => {
        const exclusiveBadge = it._exclusive ? `<span class="badge exclusive">EXCLUSIVE</span>` : ``;
        const bestBadge = it._bestHere ? `<span class="badge good">Best Price</span>` : ``;

        const pct = it._pct;
        const pctBadge =
          it._exclusive
            ? ``
            : `<span class="badge ${pctClass(pct)}">${esc(pctLabel(pct))}</span>`;

        const href = String(it._href || "").trim();
        const storeBadge = href
          ? `<a class="badge" href="${esc(
              href
            )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(storeLabel)}</a>`
          : `<span class="badge">${esc(storeLabel)}</span>`;

        const price = String(it._storePriceStr || "(no price)");

        return `
          <div class="item" data-sku="${esc(it.sku)}">
            <div class="itemRow">
              <div class="thumbBox">${renderThumbHtml(it.img)}</div>
              <div class="itemBody">
                <div class="itemTop">
                  <div class="itemName">${esc(it.name || "(no name)")}</div>
                  <span class="badge mono">${esc(displaySku(it.sku))}</span>
                </div>
                <div class="metaRow">
                  ${exclusiveBadge}
                  ${bestBadge}
                  ${pctBadge}
                  <span class="mono price">${esc(price)}</span>
                  ${storeBadge}
                </div>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    for (const el of Array.from($results.querySelectorAll(".item"))) {
      el.addEventListener("click", () => {
        const sku = el.getAttribute("data-sku") || "";
        if (!sku) return;
        location.hash = `#/item/${encodeURIComponent(sku)}`;
      });
    }
  }

  renderList("");

  let t = null;
  $q.addEventListener("input", () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => renderList($q.value), 50);
  });
}
