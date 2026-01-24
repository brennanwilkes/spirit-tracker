import { esc, renderThumbHtml, prettyTs } from "./dom.js";
import { tokenizeQuery, matchesAllTokens, displaySku, keySkuForRow, parsePriceToNumber } from "./sku.js";
import { loadIndex, loadRecent, loadSavedQuery, saveQuery } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";
import { smwsDistilleryCodesForQueryPrefix, smwsDistilleryCodeFromName } from "./smws.js";

export function renderSearch($app) {
  $app.innerHTML = `
    <div class="container">
      <div class="header">
        <div>
          <h1 class="h1">Spirit Tracker Viz</h1>
          <div class="small">Search name / url / sku (word AND)</div>
        </div>
        <a class="btn" href="#/link" style="text-decoration:none;">Link SKUs</a>
      </div>

      <div class="card">
        <input id="q" class="input" placeholder="e.g. bowmore sherry, 303821, sierrasprings..." autocomplete="off" />
        <div id="results" class="list"></div>
      </div>
    </div>
  `;

  const $q = document.getElementById("q");
  const $results = document.getElementById("results");

  $q.value = loadSavedQuery();

  let aggBySku = new Map();
  let allAgg = [];
  let indexReady = false;

  // canonicalSku -> storeLabel -> url
  let URL_BY_SKU_STORE = new Map();

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

  function renderAggregates(items) {
    if (!items.length) {
      $results.innerHTML = `<div class="small">No matches.</div>`;
      return;
    }

    const limited = items.slice(0, 80);
    $results.innerHTML = limited
      .map((it) => {
        const storeCount = it.stores.size || 0;
        const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";
        const price = it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)";
        const store = it.cheapestStoreLabel || ([...it.stores][0] || "Store");

        // link must match the displayed store label
        const href = urlForAgg(it, store) || String(it.sampleUrl || "").trim();
        const storeBadge = href
          ? `<a class="badge" href="${esc(
              href
            )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(store)}${esc(
              plus
            )}</a>`
          : `<span class="badge">${esc(store)}${esc(plus)}</span>`;

        return `
          <div class="item" data-sku="${esc(it.sku)}">
            <div class="itemRow">
              <div class="thumbBox">
                ${renderThumbHtml(it.img)}
              </div>
              <div class="itemBody">
                <div class="itemTop">
                  <div class="itemName">${esc(it.name || "(no name)")}</div>
                  <span class="badge mono">${esc(displaySku(it.sku))}</span>
                </div>
                <div class="metaRow">
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
        saveQuery($q.value);
        location.hash = `#/item/${encodeURIComponent(sku)}`;
      });
    }
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

  function tsValue(r) {
    const t = String(r?.ts || "");
    const ms = t ? Date.parse(t) : NaN;
    if (Number.isFinite(ms)) return ms;
    const d = String(r?.date || "");
    const ms2 = d ? Date.parse(d) : NaN;
    return Number.isFinite(ms2) ? ms2 : 0;
  }

  // Custom priority:
  // - Sales that make this store cheapest (or tied cheapest) are most interesting
  // - New unique (no other stores have canonical SKU)
  // - Other sales (not cheapest) are demoted
  // - Removed
  // - Price increases
  // - New (available elsewhere)
  function rankRecent(r, canonSkuFn) {
    const rawSku = String(r?.sku || "");
    const sku = String(canonSkuFn ? canonSkuFn(rawSku) : rawSku);
  
    const agg = aggBySku.get(sku) || null;
  
    const storeLabelRaw = String(r?.storeLabel || r?.store || "").trim();
    const bestStoreRaw = String(agg?.cheapestStoreLabel || "").trim();
  
    const normStore = (s) => String(s || "").trim().toLowerCase();
  
    // Normalize kind
    let kind = String(r?.kind || "");
    if (kind === "price_change") {
      const o = parsePriceToNumber(r?.oldPrice || "");
      const n = parsePriceToNumber(r?.newPrice || "");
      if (Number.isFinite(o) && Number.isFinite(n)) {
        if (n < o) kind = "price_down";
        else if (n > o) kind = "price_up";
      }
    }
  
    const pctOff = kind === "price_down" ? salePctOff(r?.oldPrice || "", r?.newPrice || "") : null;
    const pctUp = kind === "price_up" ? pctChange(r?.oldPrice || "", r?.newPrice || "") : null;
  
    const isNew = kind === "new";
    const storeCount = agg?.stores?.size || 0;
    const isNewUnique = isNew && storeCount <= 1;
  
    // Cheapest checks (use aggregate index)
    const newPriceNum = kind === "price_down" || kind === "price_up" ? parsePriceToNumber(r?.newPrice || "") : null;
    const bestPriceNum = Number.isFinite(agg?.cheapestPriceNum) ? agg.cheapestPriceNum : null;
  
    const EPS = 0.01;
    const priceMatchesBest =
      Number.isFinite(newPriceNum) && Number.isFinite(bestPriceNum) ? Math.abs(newPriceNum - bestPriceNum) <= EPS : false;
  
    const storeIsBest =
      normStore(storeLabelRaw) && normStore(bestStoreRaw) && normStore(storeLabelRaw) === normStore(bestStoreRaw);
  
    const saleIsCheapestHere = kind === "price_down" && storeIsBest && priceMatchesBest;
    const saleIsTiedCheapest = kind === "price_down" && !storeIsBest && priceMatchesBest;
    const saleIsCheapest = saleIsCheapestHere || saleIsTiedCheapest;
  
    // Bucketed scoring (higher = earlier)
    let score = 0;
  
    // Helper for sales buckets
    function saleBucketScore(isCheapest, pct) {
      const p = Number.isFinite(pct) ? pct : 0;
  
      if (isCheapest) {
        if (p >= 20) return 9000 + p;      // Bucket #1
        if (p >= 10) return 7000 + p;      // Bucket #3
        if (p > 0) return 6000 + p;        // Bucket #4
        return 5900;                       // weird but keep below real pct
      } else {
        if (p >= 20) return 4500 + p;      // Bucket #5 (below NEW unique)
        if (p >= 10) return 1500 + p;      // Bucket #8
        if (p > 0) return 1200 + p;        // Bucket #9
        return 1000;                       // bottom-ish
      }
    }
  
    if (kind === "price_down") {
      score = saleBucketScore(saleIsCheapest, pctOff);
    } else if (isNewUnique) {
      score = 8000;                        // Bucket #2
    } else if (kind === "removed") {
      score = 3000;                        // Bucket #6
    } else if (kind === "price_up") {
      score = 2000 + Math.min(99, Math.max(0, pctUp || 0)); // Bucket #7
    } else if (kind === "new") {
      score = 1100;                        // Bucket #10
    } else if (kind === "restored") {
      // not in your bucket list, but keep it reasonably high (below NEW unique, above removals)
      score = 5000;
    } else {
      score = 0;
    }
  
    // Tie-breaks: within bucket prefer bigger % for sales, then recency
    let tie = 0;
    if (kind === "price_down") tie = (pctOff || 0) * 100000 + tsValue(r);
    else if (kind === "price_up") tie = (pctUp || 0) * 100000 + tsValue(r);
    else tie = tsValue(r);
  
    return { sku, kind, pctOff, storeCount, isNewUnique, score, tie };
  }
  
  function renderRecent(recent, canonicalSkuFn) {
    const items = Array.isArray(recent?.items) ? recent.items : [];
    if (!items.length) {
      $results.innerHTML = `<div class="small">Type to search…</div>`;
      return;
    }

    const canon = typeof canonicalSkuFn === "function" ? canonicalSkuFn : (x) => x;

    const nowMs = Date.now();
    const cutoffMs = nowMs - 24 * 60 * 60 * 1000;

    function eventMs(r) {
      const t = String(r?.ts || "");
      const ms = t ? Date.parse(t) : NaN;
      if (Number.isFinite(ms)) return ms;

      // fallback: date-only => treat as start of day UTC-ish
      const d = String(r?.date || "");
      const ms2 = d ? Date.parse(d + "T00:00:00Z") : NaN;
      return Number.isFinite(ms2) ? ms2 : 0;
    }

    const inWindow = items.filter((r) => {
      const ms = eventMs(r);
      return ms >= cutoffMs && ms <= nowMs;
    });

    if (!inWindow.length) {
      $results.innerHTML = `<div class="small">No changes in the last 3 days.</div>`;
      return;
    }

    // --- DEDUPE: canonical SKU -> (store -> most recent event for that store) ---
    const bySkuStore = new Map();

    for (const r of inWindow) {
      const rawSku = String(r?.sku || "").trim();
      if (!rawSku) continue;

      const sku = String(canon(rawSku) || "").trim();
      if (!sku) continue;

      const storeLabel = String(r?.storeLabel || r?.store || "Store").trim() || "Store";
      const ms = eventMs(r);

      let storeMap = bySkuStore.get(sku);
      if (!storeMap) bySkuStore.set(sku, (storeMap = new Map()));

      const prev = storeMap.get(storeLabel);
      if (!prev || eventMs(prev) < ms) storeMap.set(storeLabel, r);
    }

    // --- PICK ONE PER SKU: choose the most "important" among latest-per-store events ---
    const picked = [];
    for (const [sku, storeMap] of bySkuStore.entries()) {
      let best = null;

      for (const r of storeMap.values()) {
        const meta = rankRecent(r, canon);
        const ms = eventMs(r);

        if (
          !best ||
          meta.score > best.meta.score ||
          (meta.score === best.meta.score && meta.tie > best.meta.tie) ||
          (meta.score === best.meta.score && meta.tie === best.meta.tie && ms > best.ms)
        ) {
          best = { r, meta, ms };
        }
      }

      if (best) picked.push(best);
    }

    const ranked = picked.sort((a, b) => {
      if (b.meta.score !== a.meta.score) return b.meta.score - a.meta.score;
      if (b.meta.tie !== a.meta.tie) return b.meta.tie - a.meta.tie;
      return String(a.meta.sku || "").localeCompare(String(b.meta.sku || ""));
    });

    const limited = ranked.slice(0, 140);

    $results.innerHTML =
      `<div class="small">Recently changed (last 24 hours):</div>` +
      limited
        .map(({ r, meta }) => {
          const kindLabel =
            meta.kind === "new"
              ? "NEW"
              : meta.kind === "restored"
              ? "RESTORED"
              : meta.kind === "removed"
              ? "REMOVED"
              : meta.kind === "price_down"
              ? "PRICE ↓"
              : meta.kind === "price_up"
              ? "PRICE ↑"
              : meta.kind === "price_change"
              ? "PRICE"
              : "CHANGE";

          const priceLine =
            meta.kind === "new" || meta.kind === "restored" || meta.kind === "removed"
              ? `${esc(r.price || "")}`
              : `${esc(r.oldPrice || "")} → ${esc(r.newPrice || "")}`;

          const when = r.ts ? prettyTs(r.ts) : r.date || "";

          const sku = meta.sku; // canonical SKU
          const agg = aggBySku.get(sku) || null;
          const img = agg?.img || "";

          const storeCount = agg?.stores?.size || 0;
          const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";

          const href = String(r.url || "").trim();
          const storeBadge = href
            ? `<a class="badge" href="${esc(
                href
              )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
                (r.storeLabel || r.store || "") + plus
              )}</a>`
            : `<span class="badge">${esc((r.storeLabel || r.store || "") + plus)}</span>`;

          const dateBadge = when ? `<span class="badge mono">${esc(when)}</span>` : "";

          const offBadge =
            meta.kind === "price_down" && meta.pctOff !== null
              ? `<span class="badge" style="margin-left:6px; color:rgba(20,110,40,0.95); background:rgba(20,110,40,0.10); border:1px solid rgba(20,110,40,0.20);">[${esc(
                  meta.pctOff
                )}% Off]</span>`
              : "";

          const kindBadgeStyle =
            meta.kind === "new" && meta.isNewUnique
              ? ` style="color:rgba(20,110,40,0.95); background:rgba(20,110,40,0.10); border:1px solid rgba(20,110,40,0.20);"`
              : "";

          return `
            <div class="item" data-sku="${esc(sku)}">
              <div class="itemRow">
                <div class="thumbBox">
                  ${renderThumbHtml(img)}
                </div>
                <div class="itemBody">
                  <div class="itemTop">
                    <div class="itemName">${esc(r.name || "(no name)")}</div>
                    <span class="badge mono">${esc(displaySku(sku))}</span>
                  </div>
                  <div class="metaRow">
                    <span class="badge"${kindBadgeStyle}>${esc(kindLabel)}</span>
                    <span class="mono price">${esc(priceLine)}</span>
                    ${offBadge}
                    ${storeBadge}
                    ${dateBadge}
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
        saveQuery($q.value);
        location.hash = `#/item/${encodeURIComponent(sku)}`;
      });
    }
  }


  function applySearch() {
    if (!indexReady) return;

    const tokens = tokenizeQuery($q.value);
    if (!tokens.length) return;

    const matches = allAgg.filter((it) => matchesAllTokens(it.searchText, tokens));

    // If query prefixes an SMWS distillery name, also surface SMWS bottles by code XXX.YYY where XXX matches.
    const wantCodes = new Set(smwsDistilleryCodesForQueryPrefix($q.value));
    if (!wantCodes.size) {
      renderAggregates(matches);
      return;
    }

    const seen = new Set(matches.map((it) => String(it?.sku || "")));
    const extra = [];
    for (const it of allAgg) {
      const sku = String(it?.sku || "");
      if (!sku || seen.has(sku)) continue;
      const dCode = smwsDistilleryCodeFromName(it?.name || "");
      if (dCode && wantCodes.has(String(dCode))) {
        extra.push(it);
        seen.add(sku);
      }
    }

    // Put SMWS distillery matches first, then normal search matches.
    renderAggregates([...extra, ...matches]);
  }

  $results.innerHTML = `<div class="small">Loading index…</div>`;

  Promise.all([loadIndex(), loadSkuRules()])
    .then(([idx, rules]) => {
      const listings = Array.isArray(idx.items) ? idx.items : [];
      allAgg = aggregateBySku(listings, rules.canonicalSku);
      aggBySku = new Map(allAgg.map((x) => [String(x.sku || ""), x]));
      URL_BY_SKU_STORE = buildUrlMap(listings, rules.canonicalSku);

      indexReady = true;
      $q.focus();

      const tokens = tokenizeQuery($q.value);
      if (tokens.length) {
        applySearch();
      } else {
        return loadRecent().then((recent) => renderRecent(recent, rules.canonicalSku));
      }
    })
    .catch((e) => {
      $results.innerHTML = `<div class="small">Failed to load: ${esc(e.message)}</div>`;
    });

  let t = null;
  $q.addEventListener("input", () => {
    saveQuery($q.value);
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      const tokens = tokenizeQuery($q.value);
      if (!tokens.length) {
        loadSkuRules()
          .then((rules) => loadRecent().then((recent) => renderRecent(recent, rules.canonicalSku)))
          .catch(() => {
            $results.innerHTML = `<div class="small">Type to search…</div>`;
          });
        return;
      }
      applySearch();
    }, 50);
  });
}
