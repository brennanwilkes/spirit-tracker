import { esc, renderThumbHtml, prettyTs } from "./dom.js";
import { tokenizeQuery, matchesAllTokens, displaySku } from "./sku.js";
import { loadIndex, loadRecent, loadSavedQuery, saveQuery } from "./state.js";
import { aggregateBySku } from "./catalog.js";

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
                <div class="meta">
                  <span class="mono">${esc(price)}</span>
                  <span class="badge">${esc(store)}${esc(plus)}</span>
                </div>
                <div class="meta">
                  <span class="mono">${esc(it.sampleUrl || "")}</span>
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

  function renderRecent(recent) {
    const items = Array.isArray(recent?.items) ? recent.items : [];
    if (!items.length) {
      $results.innerHTML = `<div class="small">Type to search…</div>`;
      return;
    }

    const days = Number.isFinite(Number(recent?.windowDays)) ? Number(recent.windowDays) : 3;
    const limited = items.slice(0, 140);

    $results.innerHTML =
      `<div class="small">Recently changed (last ${esc(days)} day(s)):</div>` +
      limited
        .map((r) => {
          const kind =
            r.kind === "new"
              ? "NEW"
              : r.kind === "restored"
              ? "RESTORED"
              : r.kind === "removed"
              ? "REMOVED"
              : r.kind === "price_down"
              ? "PRICE ↓"
              : r.kind === "price_up"
              ? "PRICE ↑"
              : r.kind === "price_change"
              ? "PRICE"
              : "CHANGE";

          const priceLine =
            r.kind === "new" || r.kind === "restored" || r.kind === "removed"
              ? `${esc(r.price || "")}`
              : `${esc(r.oldPrice || "")} → ${esc(r.newPrice || "")}`;

          const when = r.ts ? prettyTs(r.ts) : r.date || "";

          const sku = String(r.sku || "");
          const img = aggBySku.get(sku)?.img || "";

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
                  <div class="meta">
                    <span class="badge">${esc(kind)}</span>
                    <span class="badge">${esc(r.storeLabel || "")}</span>
                    <span class="mono">${esc(priceLine)}</span>
                  </div>
                  <div class="meta">
                    <span class="mono">${esc(when)}</span>
                  </div>
                  <div class="meta">
                    <span class="mono">${esc(r.url || "")}</span>
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
    if (!tokens.length) {
      loadRecent()
        .then(renderRecent)
        .catch(() => {
          $results.innerHTML = `<div class="small">Type to search…</div>`;
        });
      return;
    }

    const matches = allAgg.filter((it) => matchesAllTokens(it.searchText, tokens));
    renderAggregates(matches);
  }

  $results.innerHTML = `<div class="small">Loading index…</div>`;

  loadIndex()
    .then((idx) => {
      const listings = Array.isArray(idx.items) ? idx.items : [];
      allAgg = aggregateBySku(listings);
      aggBySku = new Map(allAgg.map((x) => [String(x.sku || ""), x]));
      indexReady = true;
      $q.focus();
      applySearch();
      return loadRecent();
    })
    .then((recent) => {
      if (!tokenizeQuery($q.value).length) renderRecent(recent);
    })
    .catch((e) => {
      $results.innerHTML = `<div class="small">Failed to load: ${esc(e.message)}</div>`;
    });

  let t = null;
  $q.addEventListener("input", () => {
    saveQuery($q.value);
    if (t) clearTimeout(t);
    t = setTimeout(applySearch, 50);
  });
}
