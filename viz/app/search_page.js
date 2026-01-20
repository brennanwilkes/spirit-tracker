/* viz/app/search_page.js */
import { esc, renderThumbHtml, prettyTs } from "./dom.js";
import { tokenizeQuery, matchesAllTokens, displaySku } from "./sku.js";
import { loadIndex, loadRecent, loadSavedQuery, saveQuery } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import { loadSkuRules } from "./mapping.js";

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

        // NEW: store badge is the link (use first store url)
        const href = String(it.sampleUrl || "").trim();
        const storeBadge = href
          ? `<a class="badge" href="${esc(
              href
            )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
              store
            )}${esc(plus)}</a>`
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
                <div class="meta">
                  <span class="mono">${esc(price)}</span>
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

  function renderRecent(recent, canonicalSkuFn) {
    const items = Array.isArray(recent?.items) ? recent.items : [];
    if (!items.length) {
      $results.innerHTML = `<div class="small">Type to search…</div>`;
      return;
    }

    const canon = typeof canonicalSkuFn === "function" ? canonicalSkuFn : (x) => x;

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

          const rawSku = String(r.sku || "");
          const sku = canon(rawSku);

          const img = aggBySku.get(sku)?.img || "";

          // NEW: store badge links to this row's url
          const href = String(r.url || "").trim();
          const storeBadge = href
            ? `<a class="badge" href="${esc(
                href
              )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
                r.storeLabel || ""
              )}</a>`
            : `<span class="badge">${esc(r.storeLabel || "")}</span>`;

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
                    ${storeBadge}
                    <span class="mono">${esc(priceLine)}</span>
                  </div>
                  <div class="meta">
                    <span class="mono">${esc(when)}</span>
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
      // recent gets rendered later after rules load
      return;
    }

    const matches = allAgg.filter((it) => matchesAllTokens(it.searchText, tokens));
    renderAggregates(matches);
  }

  $results.innerHTML = `<div class="small">Loading index…</div>`;

  Promise.all([loadIndex(), loadSkuRules()])
    .then(([idx, rules]) => {
      const listings = Array.isArray(idx.items) ? idx.items : [];
      allAgg = aggregateBySku(listings, rules.canonicalSku);
      aggBySku = new Map(allAgg.map((x) => [String(x.sku || ""), x]));
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
