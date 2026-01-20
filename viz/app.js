"use strict";

/**
 * Hash routes:
 *   #/                search
 *   #/item/<sku>      detail
 *   #/link            sku linker (local-write only)
 */

const $app = document.getElementById("app");

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

function parsePriceToNumber(v) {
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function dateOnly(iso) {
  const m = String(iso ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function prettyTs(iso) {
  const s = String(iso || "");
  if (!s) return "";
  return s.replace("T", " ");
}

function makeUnknownSku(r) {
  const store = String(r?.storeLabel || r?.store || "store").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const url = String(r?.url || "");
  const h = url ? btoa(unescape(encodeURIComponent(url))).replace(/=+$/g, "").slice(0, 16) : "no-url";
  return `unknown:${store}:${h}`;
}
function fnv1a32(str) {
  let h = 0x811c9dc5; // offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  // unsigned -> 8 hex chars
  return (h >>> 0).toString(16).padStart(8, "0");
}

function makeSyntheticSku(r) {
  const store = String(r?.storeLabel || r?.store || "store");
  const url = String(r?.url || "");
  const key = `${store}|${url}`;
  return `u:${fnv1a32(key)}`; // stable per store+url
}

function keySkuForRow(r) {
  const real = String(r?.sku || "").trim();
  return real ? real : makeSyntheticSku(r);
}

function displaySku(key) {
  return String(key || "").startsWith("u:") ? "unknown" : String(key || "");
}

function isUnknownSkuKey(key) {
  return String(key || "").startsWith("u:");
}

// Normalize for search: lowercase, punctuation -> space, collapse spaces
function normSearchText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeQuery(q) {
  const n = normSearchText(q);
  return n ? n.split(" ").filter(Boolean) : [];
}

function inferGithubOwnerRepo() {
  const host = location.hostname || "";
  const m = host.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (m) {
    const owner = m[1];
    const parts = (location.pathname || "/").split("/").filter(Boolean);
    const repo = parts.length >= 1 ? parts[0] : `${owner}.github.io`;
    return { owner, repo };
  }
  return { owner: "brennanwilkes", repo: "spirit-tracker" };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function route() {
  const h = location.hash || "#/";
  const parts = h.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts.length === 0) return renderSearch();
  if (parts[0] === "item" && parts[1]) return renderItem(decodeURIComponent(parts[1]));
  if (parts[0] === "link") return renderSkuLinker();
  return renderSearch();
}

/* ---------------- Search ---------------- */

let INDEX = null;
let RECENT = null;

// persist search box value across navigation
const Q_LS_KEY = "stviz:v1:search:q";
function loadSavedQuery() {
  try {
    return localStorage.getItem(Q_LS_KEY) || "";
  } catch {
    return "";
  }
}
function saveQuery(v) {
  try {
    localStorage.setItem(Q_LS_KEY, String(v ?? ""));
  } catch {}
}

async function loadIndex() {
  if (INDEX) return INDEX;
  INDEX = await fetchJson("./data/index.json");
  return INDEX;
}

async function loadRecent() {
  if (RECENT) return RECENT;
  try {
    RECENT = await fetchJson("./data/recent.json");
  } catch {
    RECENT = { count: 0, items: [] };
  }
  return RECENT;
}

function normImg(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  if (/^data:/i.test(v)) return "";
  return v;
}

// Build one row per SKU + combined searchable text across all listings of that SKU
function aggregateBySku(listings) {
  const bySku = new Map();

  for (const r of listings) {
    const sku = keySkuForRow(r);

    const name = String(r?.name || "");
    const url = String(r?.url || "");
    const storeLabel = String(r?.storeLabel || r?.store || "");

    const img = normImg(r?.img || r?.image || r?.thumb || "");

    const pNum = parsePriceToNumber(r?.price);
    const pStr = String(r?.price || "");

    let agg = bySku.get(sku);
    if (!agg) {
      agg = {
        sku,
        name: name || "",
        img: "",
        cheapestPriceStr: pStr || "",
        cheapestPriceNum: pNum,
        cheapestStoreLabel: storeLabel || "",
        stores: new Set(),
        sampleUrl: url || "",
        _searchParts: [],
        searchText: "", // normalized blob

        _imgByName: new Map(), // name -> img
        _imgAny: "",
      };
      bySku.set(sku, agg);
    }

    if (storeLabel) agg.stores.add(storeLabel);
    if (!agg.sampleUrl && url) agg.sampleUrl = url;

    // Keep the first non-empty name (existing behavior), but make sure img matches that chosen name
    if (!agg.name && name) {
      agg.name = name;
      if (img) agg.img = img;
    } else if (agg.name && name === agg.name && img && !agg.img) {
      agg.img = img;
    }

    if (img) {
      if (!agg._imgAny) agg._imgAny = img;
      if (name) agg._imgByName.set(name, img);
    }

    // cheapest
    if (pNum !== null) {
      if (agg.cheapestPriceNum === null || pNum < agg.cheapestPriceNum) {
        agg.cheapestPriceNum = pNum;
        agg.cheapestPriceStr = pStr || "";
        agg.cheapestStoreLabel = storeLabel || agg.cheapestStoreLabel;
      }
    }

    // search parts (include everything we might want to match)
    agg._searchParts.push(sku);
    if (name) agg._searchParts.push(name);
    if (url) agg._searchParts.push(url);
    if (storeLabel) agg._searchParts.push(storeLabel);
  }

  const out = [...bySku.values()];

  for (const it of out) {
    // Ensure thumbnail matches chosen name when possible
    if (!it.img) {
      const m = it._imgByName;
      if (it.name && m && m.has(it.name)) it.img = m.get(it.name) || "";
      else it.img = it._imgAny || "";
    }

    delete it._imgByName;
    delete it._imgAny;

    // Ensure at least these are in the blob even if index rows are already aggregated
    it._searchParts.push(it.sku);
    it._searchParts.push(it.name || "");
    it._searchParts.push(it.sampleUrl || "");
    it._searchParts.push(it.cheapestStoreLabel || "");

    it.searchText = normSearchText(it._searchParts.join(" | "));
    delete it._searchParts;
  }

  out.sort((a, b) => (String(a.name) + a.sku).localeCompare(String(b.name) + b.sku));
  return out;
}

function matchesAllTokens(hayNorm, tokens) {
  if (!tokens.length) return true;
  for (const t of tokens) {
    if (!hayNorm.includes(t)) return false;
  }
  return true;
}

function renderThumbHtml(imgUrl, cls = "thumb") {
  const img = normImg(imgUrl);
  if (!img) return `<div class="thumbPlaceholder"></div>`;
  return `<img class="${esc(cls)}" src="${esc(img)}" alt="" loading="lazy" onerror="this.style.display='none'" />`;
}

function renderSearch() {
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
        console.log("[nav] skuKey=", sku, "hash=", `#/item/${encodeURIComponent(sku)}`);
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

  let allAgg = [];
  let indexReady = false;

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

/* ---------------- SKU Linker ---------------- */

function isLocalWriteMode() {
  const h = String(location.hostname || "").toLowerCase();
  return (location.protocol === "http:" || location.protocol === "https:") && (h === "127.0.0.1" || h === "localhost");
}

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[m];
}

function similarityScore(aName, bName) {
  const a = normSearchText(aName);
  const b = normSearchText(bName);
  if (!a || !b) return 0;

  const A = new Set(tokenizeQuery(a));
  const B = new Set(tokenizeQuery(b));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const denom = Math.max(1, Math.max(A.size, B.size));
  const overlap = inter / denom; // 0..1

  const d = levenshtein(a, b);
  const maxLen = Math.max(1, Math.max(a.length, b.length));
  const levSim = 1 - d / maxLen; // ~0..1

  return overlap * 2.2 + levSim * 1.0;
}

function isBCStoreLabel(label) {
  const s = String(label || "").toLowerCase();
  return s.includes("bcl") || s.includes("strath");
}

// infer BC-ness by checking any row for that skuKey in current index
function skuIsBC(allRows, skuKey) {
  for (const r of allRows) {
    if (keySkuForRow(r) !== skuKey) continue;
    const lab = String(r.storeLabel || r.store || "");
    if (isBCStoreLabel(lab)) return true;
  }
  return false;
}

function topSuggestions(allAgg, limit, otherPinnedSku) {
  const scored = [];
  for (const it of allAgg) {
    if (!it) continue;
    if (isUnknownSkuKey(it.sku)) continue;
    if (otherPinnedSku && String(it.sku) === String(otherPinnedSku)) continue;

    const stores = it.stores ? it.stores.size : 0;
    const hasPrice = it.cheapestPriceNum !== null ? 1 : 0;
    const hasName = it.name ? 1 : 0;
    scored.push({ it, s: stores * 2 + hasPrice * 1.2 + hasName * 1.0 });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.it);
}

function recommendSimilar(allAgg, pinned, limit, otherPinnedSku) {
  if (!pinned || !pinned.name) return topSuggestions(allAgg, limit, otherPinnedSku);

  const base = String(pinned.name || "");
  const scored = [];
  for (const it of allAgg) {
    if (!it) continue;
    if (isUnknownSkuKey(it.sku)) continue;
    if (it.sku === pinned.sku) continue;
    if (otherPinnedSku && String(it.sku) === String(otherPinnedSku)) continue;

    const s = similarityScore(base, it.name || "");
    if (s > 0) scored.push({ it, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.it);
}

async function apiWriteSkuLink(fromSku, toSku) {
  const res = await fetch("/__stviz/sku-links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fromSku, toSku }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function renderSkuLinker() {
  destroyChart();

  const localWrite = isLocalWriteMode();

  $app.innerHTML = `
    <div class="container" style="max-width:1200px;">
      <div class="topbar">
        <button id="back" class="btn">← Back</button>
        <div style="flex:1"></div>
        <span class="badge">SKU Linker</span>
        <span class="badge mono">${esc(localWrite ? "LOCAL WRITE" : "READ-ONLY")}</span>
      </div>

      <div class="card" style="padding:14px;">
        <div class="small" style="margin-bottom:10px;">
          Unknown SKUs are hidden. With both pinned, LINK SKU writes to data/sku_links.json (local only).
        </div>

        <div style="display:flex; gap:16px;">
          <div style="flex:1; min-width:0;">
            <div class="small" style="margin-bottom:6px;">Left</div>
            <input id="qL" class="input" placeholder="Search (name / url / sku)..." autocomplete="off" />
            <div id="listL" class="list" style="margin-top:10px;"></div>
          </div>

          <div style="flex:1; min-width:0;">
            <div class="small" style="margin-bottom:6px;">Right</div>
            <input id="qR" class="input" placeholder="Search (name / url / sku)..." autocomplete="off" />
            <div id="listR" class="list" style="margin-top:10px;"></div>
          </div>
        </div>
      </div>

      <div class="card linkBar" style="padding:10px;">
        <button id="linkBtn" class="btn" style="width:100%;" disabled>LINK SKU</button>
        <div id="status" class="small" style="margin-top:8px;"></div>
      </div>
    </div>
  `;

  document.getElementById("back").addEventListener("click", () => (location.hash = "#/"));

  const $qL = document.getElementById("qL");
  const $qR = document.getElementById("qR");
  const $listL = document.getElementById("listL");
  const $listR = document.getElementById("listR");
  const $linkBtn = document.getElementById("linkBtn");
  const $status = document.getElementById("status");

  $listL.innerHTML = `<div class="small">Loading index…</div>`;
  $listR.innerHTML = `<div class="small">Loading index…</div>`;

  const idx = await loadIndex();
  const allRows = Array.isArray(idx.items) ? idx.items : [];

  // Build candidates; hide unknown (u:...) entirely for this page
  const allAgg = aggregateBySku(allRows).filter((it) => !isUnknownSkuKey(it.sku));

  let pinnedL = null;
  let pinnedR = null;

  function openLinkHtml(url) {
    const u = String(url || "").trim();
    if (!u) return "";
    return `<a class="badge" href="${esc(u)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">open</a>`;
  }

  function renderCard(it, pinned) {
    const storeCount = it.stores.size || 0;
    const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";
    const price = it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)";
    const store = it.cheapestStoreLabel || ([...it.stores][0] || "Store");
    const open = openLinkHtml(it.sampleUrl || "");
    return `
      <div class="item ${pinned ? "pinnedItem" : ""}" data-sku="${esc(it.sku)}">
        <div class="itemRow">
          <div class="thumbBox">${renderThumbHtml(it.img)}</div>
          <div class="itemBody">
            <div class="itemTop">
              <div class="itemName">${esc(it.name || "(no name)")}</div>
              <span class="badge mono">${esc(displaySku(it.sku))}</span>
            </div>
            <div class="meta">
              <span class="mono">${esc(price)}</span>
              <span class="badge">${esc(store)}${esc(plus)}</span>
              ${open}
            </div>
            <div class="meta"><span class="mono">${esc(it.sampleUrl || "")}</span></div>
            ${pinned ? `<div class="small">Pinned (click again to unpin)</div>` : ``}
          </div>
        </div>
      </div>
    `;
  }

  function sideItems(query, otherPinned) {
    const tokens = tokenizeQuery(query);

    // Never show same sku as other pinned
    const otherSku = otherPinned ? String(otherPinned.sku || "") : "";

    if (tokens.length) {
      return allAgg
        .filter((it) => it && it.sku !== otherSku && matchesAllTokens(it.searchText, tokens))
        .slice(0, 80);
    }

    if (otherPinned) return recommendSimilar(allAgg, otherPinned, 60, otherSku);
    return topSuggestions(allAgg, 60, "");
  }

  function attachHandlers($root, side) {
    for (const el of Array.from($root.querySelectorAll(".item"))) {
      el.addEventListener("click", () => {
        const skuKey = el.getAttribute("data-sku") || "";
        const it = allAgg.find((x) => String(x.sku || "") === skuKey);
        if (!it) return;

        if (isUnknownSkuKey(it.sku)) return;

        const other = side === "L" ? pinnedR : pinnedL;
        if (other && String(other.sku || "") === String(it.sku || "")) {
          $status.textContent = "Not allowed: both sides cannot be the same SKU.";
          return;
        }

        if (side === "L") pinnedL = pinnedL && pinnedL.sku === it.sku ? null : it;
        else pinnedR = pinnedR && pinnedR.sku === it.sku ? null : it;

        updateAll();
      });
    }
  }

  function renderSide(side) {
    const pinned = side === "L" ? pinnedL : pinnedR;
    const other = side === "L" ? pinnedR : pinnedL;
    const query = side === "L" ? $qL.value : $qR.value;
    const $list = side === "L" ? $listL : $listR;

    if (pinned) {
      $list.innerHTML = renderCard(pinned, true);
      attachHandlers($list, side);
      return;
    }

    const items = sideItems(query, other);
    $list.innerHTML = items.length ? items.map((it) => renderCard(it, false)).join("") : `<div class="small">No matches.</div>`;
    attachHandlers($list, side);
  }

  function updateButton() {
    if (!localWrite) {
      $linkBtn.disabled = true;
      $status.textContent = "Write disabled on GitHub Pages. Use: node viz/serve.js and open 127.0.0.1.";
      return;
    }
    if (!(pinnedL && pinnedR)) {
      $linkBtn.disabled = true;
      if (!$status.textContent) $status.textContent = "Pin one item on each side to enable linking.";
      return;
    }
    if (String(pinnedL.sku || "") === String(pinnedR.sku || "")) {
      $linkBtn.disabled = true;
      $status.textContent = "Not allowed: both sides cannot be the same SKU.";
      return;
    }
    $linkBtn.disabled = false;
    if ($status.textContent === "Pin one item on each side to enable linking.") $status.textContent = "";
  }

  function updateAll() {
    renderSide("L");
    renderSide("R");
    updateButton();
  }

  let tL = null, tR = null;
  $qL.addEventListener("input", () => {
    if (tL) clearTimeout(tL);
    tL = setTimeout(() => {
      $status.textContent = "";
      updateAll();
    }, 50);
  });
  $qR.addEventListener("input", () => {
    if (tR) clearTimeout(tR);
    tR = setTimeout(() => {
      $status.textContent = "";
      updateAll();
    }, 50);
  });

  $linkBtn.addEventListener("click", async () => {
    if (!(pinnedL && pinnedR) || !localWrite) return;

    const a = String(pinnedL.sku || "");
    const b = String(pinnedR.sku || "");

    if (!a || !b || isUnknownSkuKey(a) || isUnknownSkuKey(b)) {
      $status.textContent = "Not allowed: unknown SKUs cannot be linked.";
      return;
    }
    if (a === b) {
      $status.textContent = "Not allowed: both sides cannot be the same SKU.";
      return;
    }

    // Direction: if either is BC-based (BCL/Strath appears), FROM is BC sku.
    const aBC = skuIsBC(allRows, a);
    const bBC = skuIsBC(allRows, b);

    let fromSku = a, toSku = b;
    if (aBC && !bBC) { fromSku = a; toSku = b; }
    else if (bBC && !aBC) { fromSku = b; toSku = a; }

    $status.textContent = `Writing: ${displaySku(fromSku)} → ${displaySku(toSku)} …`;

    try {
      const out = await apiWriteSkuLink(fromSku, toSku);
      $status.textContent = `Saved: ${displaySku(fromSku)} → ${displaySku(toSku)} (links=${out.count}) to data/sku_links.json.`;
    } catch (e) {
      $status.textContent = `Write failed: ${String(e && e.message ? e.message : e)}`;
    }
  });

  updateAll();
}

/* ---------------- Detail (chart) ---------------- */

let CHART = null;

function destroyChart() {
  if (CHART) {
    CHART.destroy();
    CHART = null;
  }
}

async function githubListCommits({ owner, repo, branch, path }) {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`;
  const u1 = `${base}?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=100&page=1`;
  const page1 = await fetchJson(u1);

  if (Array.isArray(page1) && page1.length === 100) {
    const u2 = `${base}?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=100&page=2`;
    const page2 = await fetchJson(u2);
    return [...page1, ...(Array.isArray(page2) ? page2 : [])];
  }

  return Array.isArray(page1) ? page1 : [];
}

async function githubFetchFileAtSha({ owner, repo, sha, path }) {
  const raw = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(
    sha
  )}/${path}`;
  const txt = await fetchText(raw);
  return JSON.parse(txt);
}

function findItemBySkuInDb(obj, skuKey, dbFile, storeLabel) {
  const items = Array.isArray(obj?.items) ? obj.items : [];
  for (const it of items) {
    if (!it || it.removed) continue;

    const real = String(it.sku || "").trim();
    if (real && real === skuKey) return it;

    // synthetic match for blank sku items: hash storeLabel|url
    if (!real && String(skuKey || "").startsWith("u:")) {
      const row = {
        sku: "",
        url: String(it.url || ""),
        storeLabel: storeLabel || "",
        store: "",
      };
      const k = keySkuForRow(row);
      if (k === skuKey) return it;
    }
  }
  return null;
}

function computeSuggestedY(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return { suggestedMin: undefined, suggestedMax: undefined };
  let min = nums[0],
    max = nums[0];
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
  }
  if (min === max) return { suggestedMin: min * 0.95, suggestedMax: max * 1.05 };
  const pad = (max - min) * 0.08;
  return { suggestedMin: Math.max(0, min - pad), suggestedMax: max + pad };
}

// Collapse commit list down to 1 commit per day (keep the most recent commit for that day)
function collapseCommitsToDaily(commits) {
  // commits should be oldest -> newest.
  const byDate = new Map();
  for (const c of commits) {
    const d = String(c?.date || "");
    const sha = String(c?.sha || "");
    if (!d || !sha) continue;
    byDate.set(d, { sha, date: d, ts: String(c?.ts || "") });
  }
  return [...byDate.values()];
}

function cacheKeySeries(sku, dbFile, cacheBust) {
  return `stviz:v2:series:${cacheBust}:${sku}:${dbFile}`;
}

function loadSeriesCache(sku, dbFile, cacheBust) {
  try {
    const raw = localStorage.getItem(cacheKeySeries(sku, dbFile, cacheBust));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.points)) return null;
    const savedAt = Number(obj.savedAt || 0);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > 7 * 24 * 3600 * 1000) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveSeriesCache(sku, dbFile, cacheBust, points) {
  try {
    localStorage.setItem(cacheKeySeries(sku, dbFile, cacheBust), JSON.stringify({ savedAt: Date.now(), points }));
  } catch {}
}

let DB_COMMITS = null;

async function loadDbCommitsManifest() {
  if (DB_COMMITS) return DB_COMMITS;
  try {
    DB_COMMITS = await fetchJson("./data/db_commits.json");
    return DB_COMMITS;
  } catch {
    DB_COMMITS = null;
    return null;
  }
}

async function renderItem(sku) {
  destroyChart();
  console.log("[renderItem] skuKey=", sku);

  $app.innerHTML = `
    <div class="container">
      <div class="topbar">
        <button id="back" class="btn">← Back</button>
        <span class="badge mono">${esc(displaySku(sku))}</span>
        </div>

      <div class="card detailCard">
        <div class="detailHeader">
          <div id="thumbBox" class="detailThumbBox"></div>
          <div class="detailHeaderText">
            <div id="title" class="h1">Loading…</div>
            <div id="links" class="links"></div>
            <div class="small" id="status"></div>
          </div>
        </div>

        <div class="chartBox">
          <canvas id="chart"></canvas>
        </div>
      </div>
    </div>
  `;

  document.getElementById("back").addEventListener("click", () => {
    location.hash = "#/";
  });

  const $title = document.getElementById("title");
  const $links = document.getElementById("links");
  const $status = document.getElementById("status");
  const $canvas = document.getElementById("chart");
  const $thumbBox = document.getElementById("thumbBox");

  const idx = await loadIndex();
  const all = Array.isArray(idx.items) ? idx.items : [];
  const want = String(sku || "");
  let cur = all.filter((x) => keySkuForRow(x) === want);

  if (!cur.length) {
    const knc = all.filter(
      (x) => String(x.storeLabel || x.store || "").toLowerCase().includes("keg") && !String(x.sku || "").trim()
    );

    console.log("[renderItem] NOT FOUND. want=", want, "totalRows=", all.length, "kncBlankSkuRows=", knc.length);

    console.log(
      "[renderItem] sample KNC computed keys:",
      knc.slice(0, 20).map((x) => ({
        key: keySkuForRow(x),
        storeLabel: x.storeLabel,
        url: x.url,
        name: x.name,
      }))
    );
  }
  if (!cur.length) {
    $title.textContent = "Item not found in current index";
    $status.textContent = "Tip: index.json only includes current (non-removed) items.";
    if ($thumbBox) $thumbBox.innerHTML = `<div class="thumbPlaceholder"></div>`;
    return;
  }

  const nameCounts = new Map();
  for (const r of cur) {
    const n = String(r.name || "");
    if (!n) continue;
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  let bestName = cur[0].name || `(SKU ${sku})`;
  let bestCount = -1;
  for (const [n, c] of nameCounts.entries()) {
    if (c > bestCount) {
      bestName = n;
      bestCount = c;
    }
  }
  $title.textContent = bestName;

  // Pick image that matches the picked name (fallback: any)
  let bestImg = "";
  for (const r of cur) {
    if (String(r?.name || "") === String(bestName || "") && normImg(r?.img)) {
      bestImg = normImg(r.img);
      break;
    }
  }
  if (!bestImg) {
    for (const r of cur) {
      if (normImg(r?.img)) {
        bestImg = normImg(r.img);
        break;
      }
    }
  }
  if ($thumbBox) {
    $thumbBox.innerHTML = bestImg ? renderThumbHtml(bestImg, "detailThumb") : `<div class="thumbPlaceholder"></div>`;
  }

  $links.innerHTML = cur
    .slice()
    .sort((a, b) => String(a.storeLabel || "").localeCompare(String(b.storeLabel || "")))
    .map(
      (r) =>
        `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.storeLabel || r.store || "Store")}</a>`
    )
    .join("");

  const gh = inferGithubOwnerRepo();
  const owner = gh.owner;
  const repo = gh.repo;
  const branch = "data";

  const byDbFile = new Map();
  for (const r of cur) {
    if (!r.dbFile) continue;
    if (!byDbFile.has(r.dbFile)) byDbFile.set(r.dbFile, r);
  }
  const dbFiles = [...byDbFile.keys()].sort();

  $status.textContent = `Loading history for ${dbFiles.length} store file(s)…`;

  const manifest = await loadDbCommitsManifest();

  const allDatesSet = new Set();
  const series = [];

  const fileJsonCache = new Map();

  const cacheBust = String(idx.generatedAt || new Date().toISOString());
  const today = dateOnly(idx.generatedAt || new Date().toISOString());

  for (const dbFile of dbFiles) {
    const row = byDbFile.get(dbFile);
    const storeLabel = String(row.storeLabel || row.store || dbFile);

    const cached = loadSeriesCache(sku, dbFile, cacheBust);
    if (cached && Array.isArray(cached.points) && cached.points.length) {
      const points = new Map();
      const values = [];
      for (const p of cached.points) {
        const d = String(p.date || "");
        const v = p.price === null ? null : Number(p.price);
        if (!d) continue;
        points.set(d, Number.isFinite(v) ? v : null);
        if (Number.isFinite(v)) values.push(v);
        allDatesSet.add(d);
      }
      series.push({ label: storeLabel, points, values });
      continue;
    }

    let commits = [];
    if (manifest && manifest.files && Array.isArray(manifest.files[dbFile])) {
      commits = manifest.files[dbFile];
    } else {
      try {
        let apiCommits = await githubListCommits({ owner, repo, branch, path: dbFile });
        apiCommits = apiCommits.slice().reverse(); // oldest -> newest
        commits = apiCommits
          .map((c) => {
            const sha = String(c?.sha || "");
            const dIso = c?.commit?.committer?.date || c?.commit?.author?.date || "";
            const d = dateOnly(dIso);
            return sha && d ? { sha, date: d, ts: String(dIso || "") } : null;
          })
          .filter(Boolean);
      } catch {
        commits = [];
      }
    }

    commits = collapseCommitsToDaily(commits);

    const points = new Map();
    const values = [];
    const compactPoints = [];

    const MAX_POINTS = 260; // daily points (~8-9 months)
    if (commits.length > MAX_POINTS) commits = commits.slice(commits.length - MAX_POINTS);

    for (const c of commits) {
      const sha = String(c.sha || "");
      const d = String(c.date || "");
      if (!sha || !d) continue;

      const ck = `${sha}|${dbFile}`;
      let obj = fileJsonCache.get(ck) || null;
      if (!obj) {
        try {
          obj = await githubFetchFileAtSha({ owner, repo, sha, path: dbFile });
          fileJsonCache.set(ck, obj);
        } catch {
          continue;
        }
      }

      const it = findItemBySkuInDb(obj, sku, dbFile, storeLabel);
      const pNum = it ? parsePriceToNumber(it.price) : null;

      points.set(d, pNum);
      if (pNum !== null) values.push(pNum);
      allDatesSet.add(d);

      compactPoints.push({ date: d, price: pNum });
    }

    // Always add "today" from the current index
    const curP = parsePriceToNumber(row.price);
    if (curP !== null) {
      points.set(today, curP);
      values.push(curP);
      allDatesSet.add(today);
      compactPoints.push({ date: today, price: curP });
    }

    saveSeriesCache(sku, dbFile, cacheBust, compactPoints);
    series.push({ label: storeLabel, points, values });
  }

  const labels = [...allDatesSet].sort();
  if (!labels.length) {
    $status.textContent = "No historical points found.";
    return;
  }

  const allVals = [];
  for (const s of series) for (const v of s.values) allVals.push(v);
  const ySug = computeSuggestedY(allVals);

  const datasets = series.map((s) => ({
    label: s.label,
    data: labels.map((d) => (s.points.has(d) ? s.points.get(d) : null)),
    spanGaps: false,
    tension: 0.15,
  }));

  const ctx = $canvas.getContext("2d");
  CHART = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: true },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed?.y;
              if (!Number.isFinite(v)) return `${ctx.dataset.label}: (no data)`;
              return `${ctx.dataset.label}: $${v.toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          grid: { display: false },
        },
        y: {
          ...ySug,
          ticks: { callback: (v) => `$${Number(v).toFixed(0)}` },
        },
      },
    },
  });

  $status.textContent = manifest
    ? `History loaded from prebuilt manifest (1 point/day) + current run. Points=${labels.length}.`
    : `History loaded (GitHub API fallback; 1 point/day) + current run. Points=${labels.length}.`;
}

/* ---------------- boot ---------------- */

window.addEventListener("hashchange", route);
route();
