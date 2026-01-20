/* viz/app/linker_page.js */
import { esc, renderThumbHtml } from "./dom.js";
import {
  tokenizeQuery,
  matchesAllTokens,
  isUnknownSkuKey,
  displaySku,
  keySkuForRow,
  normSearchText,
} from "./sku.js";
import { loadIndex } from "./state.js";
import { aggregateBySku } from "./catalog.js";
import {
  isLocalWriteMode,
  loadSkuMetaBestEffort,
  apiWriteSkuLink,
  apiWriteSkuIgnore,
} from "./api.js";
import { loadSkuRules } from "./mapping.js";

/* ---------------- Similarity helpers ---------------- */

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  const n = a.length,
    m = b.length;
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
  const overlap = inter / denom;

  const d = levenshtein(a, b);
  const maxLen = Math.max(1, Math.max(a.length, b.length));
  const levSim = 1 - d / maxLen;

  return overlap * 2.2 + levSim * 1.0;
}

function fastSimilarityScore(aTokens, bTokens, aNormName, bNormName) {
  if (!aTokens.length || !bTokens.length) return 0;

  let inter = 0;
  const bSet = new Set(bTokens);
  for (const t of aTokens) if (bSet.has(t)) inter++;

  const denom = Math.max(1, Math.max(aTokens.length, bTokens.length));
  const overlap = inter / denom;

  const a = String(aNormName || "");
  const b = String(bNormName || "");
  const pref =
    a.slice(0, 10) && b.slice(0, 10) && a.slice(0, 10) === b.slice(0, 10)
      ? 0.2
      : 0;

  return overlap * 2.0 + pref;
}

/* ---------------- Store-overlap rule ---------------- */

function storesOverlap(aItem, bItem) {
  const a = aItem?.stores;
  const b = bItem?.stores;
  if (!a || !b) return false;

  for (const s of a) {
    if (b.has(s)) return true;
  }
  return false;
}

/* ---------------- Mapping helpers ---------------- */

function buildMappedSkuSet(links) {
  const s = new Set();
  for (const x of Array.isArray(links) ? links : []) {
    const a = String(x?.fromSku || "").trim();
    const b = String(x?.toSku || "").trim();
    if (a) s.add(a);
    if (b) s.add(b);
  }
  return s;
}

function isBCStoreLabel(label) {
  const s = String(label || "").toLowerCase();
  return s.includes("bcl") || s.includes("strath");
}

function skuIsBC(allRows, skuKey) {
  for (const r of allRows) {
    if (keySkuForRow(r) !== skuKey) continue;
    const lab = String(r.storeLabel || r.store || "");
    if (isBCStoreLabel(lab)) return true;
  }
  return false;
}

/* ---------------- Suggestion helpers ---------------- */

function topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus) {
  const scored = [];
  for (const it of allAgg) {
    if (!it) continue;
    if (isUnknownSkuKey(it.sku)) continue;
    if (mappedSkus && mappedSkus.has(String(it.sku))) continue;
    if (otherPinnedSku && String(it.sku) === String(otherPinnedSku)) continue;

    const stores = it.stores ? it.stores.size : 0;
    const hasPrice = it.cheapestPriceNum !== null ? 1 : 0;
    const hasName = it.name ? 1 : 0;
    scored.push({ it, s: stores * 2 + hasPrice * 1.2 + hasName * 1.0 });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.it);
}

function recommendSimilar(allAgg, pinned, limit, otherPinnedSku, mappedSkus, isIgnoredPairFn) {
  if (!pinned || !pinned.name) return topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus);

  const base = String(pinned.name || "");
  const pinnedSku = String(pinned.sku || "");
  const scored = [];

  for (const it of allAgg) {
    if (!it) continue;
    if (isUnknownSkuKey(it.sku)) continue;
    if (mappedSkus && mappedSkus.has(String(it.sku))) continue;
    if (it.sku === pinned.sku) continue;
    if (otherPinnedSku && String(it.sku) === String(otherPinnedSku)) continue;

    if (storesOverlap(pinned, it)) continue;
    if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(pinnedSku, String(it.sku || ""))) continue;

    const s = similarityScore(base, it.name || "");
    if (s > 0) scored.push({ it, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.it);
}

function computeInitialPairsFast(allAgg, mappedSkus, limitPairs, isIgnoredPairFn) {
  const items = allAgg.filter((it) => {
    if (!it) return false;
    if (isUnknownSkuKey(it.sku)) return false;
    if (mappedSkus && mappedSkus.has(String(it.sku))) return false;
    return true;
  });

  const seeds = topSuggestions(items, Math.min(220, items.length), "", mappedSkus);

  const TOKEN_BUCKET_CAP = 180;
  const tokMap = new Map();
  const itemTokens = new Map();
  const itemNormName = new Map();

  for (const it of items) {
    const toks = Array.from(new Set(tokenizeQuery(it.name || ""))).filter(Boolean).slice(0, 10);
    itemTokens.set(it.sku, toks);
    itemNormName.set(it.sku, normSearchText(it.name || ""));
    for (const t of toks) {
      let arr = tokMap.get(t);
      if (!arr) tokMap.set(t, (arr = []));
      if (arr.length < TOKEN_BUCKET_CAP) arr.push(it);
    }
  }

  const bestByPair = new Map();
  const MAX_CAND_TOTAL = 90;
  const MAX_FINE = 6;

  for (const a of seeds) {
    const aSku = String(a.sku || "");
    const aToks = itemTokens.get(aSku) || [];
    if (!aSku || !aToks.length) continue;

    const cand = new Map();
    for (const t of aToks) {
      const arr = tokMap.get(t);
      if (!arr) continue;

      for (let i = 0; i < arr.length && cand.size < MAX_CAND_TOTAL; i++) {
        const b = arr[i];
        if (!b) continue;
        const bSku = String(b.sku || "");
        if (!bSku || bSku === aSku) continue;
        if (mappedSkus && mappedSkus.has(bSku)) continue;
        if (isUnknownSkuKey(bSku)) continue;

        if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(aSku, bSku)) continue;
        if (storesOverlap(a, b)) continue;

        cand.set(bSku, b);
      }
      if (cand.size >= MAX_CAND_TOTAL) break;
    }
    if (!cand.size) continue;

    const aNameN = itemNormName.get(aSku) || "";
    const cheap = [];
    for (const b of cand.values()) {
      const bSku = String(b.sku || "");
      const bToks = itemTokens.get(bSku) || [];
      const bNameN = itemNormName.get(bSku) || "";
      const s = fastSimilarityScore(aToks, bToks, aNameN, bNameN);
      if (s > 0) cheap.push({ b, s });
    }
    if (!cheap.length) continue;
    cheap.sort((x, y) => y.s - x.s);

    let bestB = null;
    let bestS = 0;
    for (const x of cheap.slice(0, MAX_FINE)) {
      const s = similarityScore(a.name || "", x.b.name || "");
      if (s > bestS) {
        bestS = s;
        bestB = x.b;
      }
    }

    if (!bestB || bestS < 0.6) continue;

    const bSku = String(bestB.sku || "");
    const key = aSku < bSku ? `${aSku}|${bSku}` : `${bSku}|${aSku}`;
    const prev = bestByPair.get(key);
    if (!prev || bestS > prev.score) bestByPair.set(key, { a, b: bestB, score: bestS });
  }

  const pairs = Array.from(bestByPair.values());
  pairs.sort((x, y) => y.score - x.score);

  const used = new Set();
  const out = [];
  for (const p of pairs) {
    const aSku = String(p.a.sku || "");
    const bSku = String(p.b.sku || "");
    if (!aSku || !bSku || aSku === bSku) continue;
    if (used.has(aSku) || used.has(bSku)) continue;
    if (storesOverlap(p.a, p.b)) continue;

    used.add(aSku);
    used.add(bSku);
    out.push({ a: p.a, b: p.b, score: p.score });
    if (out.length >= limitPairs) break;
  }
  return out;
}

/* ---------------- Page ---------------- */

export async function renderSkuLinker($app) {
  const localWrite = isLocalWriteMode();
  const rules = await loadSkuRules();

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
          Unknown SKUs are hidden. Existing mapped SKUs are excluded. Same-store pairs are never suggested. LINK SKU writes map; IGNORE PAIR writes a "do-not-suggest" pair (local only).
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
        <button id="ignoreBtn" class="btn" style="width:100%; margin-top:8px;" disabled>IGNORE PAIR</button>
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
  const $ignoreBtn = document.getElementById("ignoreBtn");
  const $status = document.getElementById("status");

  $listL.innerHTML = `<div class="small">Loading index…</div>`;
  $listR.innerHTML = `<div class="small">Loading index…</div>`;

  const idx = await loadIndex();
  const allRows = Array.isArray(idx.items) ? idx.items : [];

  // skuKey -> storeLabel -> url
  const URL_BY_SKU_STORE = new Map();
  for (const r of allRows) {
    if (!r || r.removed) continue;
    const skuKey = String(keySkuForRow(r) || "").trim();
    if (!skuKey) continue;

    const storeLabel = String(r.storeLabel || r.store || "").trim();
    const url = String(r.url || "").trim();
    if (!storeLabel || !url) continue;

    let m = URL_BY_SKU_STORE.get(skuKey);
    if (!m) URL_BY_SKU_STORE.set(skuKey, (m = new Map()));
    if (!m.has(storeLabel)) m.set(storeLabel, url);
  }

  const allAgg = aggregateBySku(allRows, (x) => x).filter((it) => !isUnknownSkuKey(it.sku));

  const meta = await loadSkuMetaBestEffort();
  const mappedSkus = buildMappedSkuSet(meta.links || []);
  const ignoreSet = rules.ignoreSet;

  function isIgnoredPair(a, b) {
    return rules.isIgnoredPair(String(a || ""), String(b || ""));
  }

  const initialPairs = computeInitialPairsFast(allAgg, mappedSkus, 28, isIgnoredPair);

  let pinnedL = null;
  let pinnedR = null;

  function renderCard(it, pinned) {
    const storeCount = it.stores.size || 0;
    const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";
    const price = it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)";
    const store = it.cheapestStoreLabel || ([...it.stores][0] || "Store");

    const href =
      URL_BY_SKU_STORE.get(String(it.sku || ""))?.get(String(store || "")) ||
      String(it.sampleUrl || "").trim() ||
      "";

    const storeBadge = href
      ? `<a class="badge" href="${esc(
          href
        )}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
          store
        )}${esc(plus)}</a>`
      : `<span class="badge">${esc(store)}${esc(plus)}</span>`;

    return `
      <div class="item ${pinned ? "pinnedItem" : ""}" data-sku="${esc(it.sku)}">
        <div class="itemRow">
          <div class="thumbBox">${renderThumbHtml(it.img)}</div>

          <div class="itemBody">
            <div class="itemMain">
              <div class="itemName">${esc(it.name || "(no name)")}</div>
              ${pinned ? `<div class="small">Pinned (click again to unpin)</div>` : ``}
            </div>

            <div class="itemFacts">
              <div class="mono priceBig">${esc(price)}</div>
              ${storeBadge}
              <span class="badge mono">${esc(displaySku(it.sku))}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function sideItems(side, query, otherPinned) {
    const tokens = tokenizeQuery(query);
    const otherSku = otherPinned ? String(otherPinned.sku || "") : "";

    if (tokens.length) {
      let out = allAgg
        .filter(
          (it) =>
            it &&
            it.sku !== otherSku &&
            !mappedSkus.has(String(it.sku)) &&
            matchesAllTokens(it.searchText, tokens)
        )
        .slice(0, 80);

      if (otherPinned) {
        const oSku = String(otherPinned.sku || "");
        out = out.filter((it) => !isIgnoredPair(oSku, String(it.sku || "")));
        out = out.filter((it) => !storesOverlap(otherPinned, it));
      }
      return out;
    }

    if (otherPinned) return recommendSimilar(allAgg, otherPinned, 60, otherSku, mappedSkus, isIgnoredPair);

    if (initialPairs && initialPairs.length) {
      const list = side === "L" ? initialPairs.map((p) => p.a) : initialPairs.map((p) => p.b);
      return list.filter((it) => it && it.sku !== otherSku && !mappedSkus.has(String(it.sku)));
    }

    return topSuggestions(allAgg, 60, otherSku, mappedSkus);
  }

  function attachHandlers($root, side) {
    for (const el of Array.from($root.querySelectorAll(".item"))) {
      el.addEventListener("click", () => {
        const skuKey = el.getAttribute("data-sku") || "";
        const it = allAgg.find((x) => String(x.sku || "") === skuKey);
        if (!it) return;

        if (isUnknownSkuKey(it.sku)) return;

        if (mappedSkus.has(String(it.sku))) {
          $status.textContent = "This SKU is already mapped; choose an unmapped SKU.";
          return;
        }

        const other = side === "L" ? pinnedR : pinnedL;

        if (other && String(other.sku || "") === String(it.sku || "")) {
          $status.textContent = "Not allowed: both sides cannot be the same SKU.";
          return;
        }

        if (other && storesOverlap(other, it)) {
          $status.textContent = "Not allowed: both items belong to the same store.";
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

    const items = sideItems(side, query, other);
    $list.innerHTML = items.length
      ? items.map((it) => renderCard(it, false)).join("")
      : `<div class="small">No matches.</div>`;
    attachHandlers($list, side);
  }

  function updateButtons() {
    if (!localWrite) {
      $linkBtn.disabled = true;
      $ignoreBtn.disabled = true;
      $status.textContent = "Write disabled on GitHub Pages. Use: node viz/serve.js and open 127.0.0.1.";
      return;
    }

    if (!(pinnedL && pinnedR)) {
      $linkBtn.disabled = true;
      $ignoreBtn.disabled = true;
      if (!$status.textContent) $status.textContent = "Pin one item on each side to enable linking / ignoring.";
      return;
    }

    const a = String(pinnedL.sku || "");
    const b = String(pinnedR.sku || "");

    if (a === b) {
      $linkBtn.disabled = true;
      $ignoreBtn.disabled = true;
      $status.textContent = "Not allowed: both sides cannot be the same SKU.";
      return;
    }

    if (storesOverlap(pinnedL, pinnedR)) {
      $linkBtn.disabled = true;
      $ignoreBtn.disabled = true;
      $status.textContent = "Not allowed: both items belong to the same store.";
      return;
    }

    if (mappedSkus.has(a) || mappedSkus.has(b)) {
      $linkBtn.disabled = true;
      $ignoreBtn.disabled = false;
    } else {
      $linkBtn.disabled = false;
      $ignoreBtn.disabled = false;
    }

    if (isIgnoredPair(a, b)) $status.textContent = "This pair is already ignored.";
    else if ($status.textContent === "Pin one item on each side to enable linking / ignoring.") $status.textContent = "";
  }

  function updateAll() {
    renderSide("L");
    renderSide("R");
    updateButtons();
  }

  let tL = null, tR = null;
  $qL.addEventListener("input", () => {
    if (tL) clearTimeout(tL);
    tL = setTimeout(() => {
      $status.textContent = "";
      updateAll();
    }, 60);
  });
  $qR.addEventListener("input", () => {
    if (tR) clearTimeout(tR);
    tR = setTimeout(() => {
      $status.textContent = "";
      updateAll();
    }, 60);
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
    if (storesOverlap(pinnedL, pinnedR)) {
      $status.textContent = "Not allowed: both items belong to the same store.";
      return;
    }
    if (mappedSkus.has(a) || mappedSkus.has(b)) {
      $status.textContent = "Not allowed: one of these SKUs is already mapped.";
      return;
    }
    if (isIgnoredPair(a, b)) {
      $status.textContent = "This pair is already ignored.";
      return;
    }

    const aBC = skuIsBC(allRows, a);
    const bBC = skuIsBC(allRows, b);

    let fromSku = a, toSku = b;
    if (aBC && !bBC) { fromSku = a; toSku = b; }
    else if (bBC && !aBC) { fromSku = b; toSku = a; }

    $status.textContent = `Writing: ${displaySku(fromSku)} → ${displaySku(toSku)} …`;

    try {
      const out = await apiWriteSkuLink(fromSku, toSku);
      mappedSkus.add(fromSku);
      mappedSkus.add(toSku);
      $status.textContent = `Saved: ${displaySku(fromSku)} → ${displaySku(toSku)} (links=${out.count}).`;
      pinnedL = null;
      pinnedR = null;
      updateAll();
    } catch (e) {
      $status.textContent = `Write failed: ${String(e && e.message ? e.message : e)}`;
    }
  });

  $ignoreBtn.addEventListener("click", async () => {
    if (!(pinnedL && pinnedR) || !localWrite) return;

    const a = String(pinnedL.sku || "");
    const b = String(pinnedR.sku || "");

    if (!a || !b || isUnknownSkuKey(a) || isUnknownSkuKey(b)) {
      $status.textContent = "Not allowed: unknown SKUs cannot be ignored.";
      return;
    }
    if (a === b) {
      $status.textContent = "Not allowed: both sides cannot be the same SKU.";
      return;
    }
    if (storesOverlap(pinnedL, pinnedR)) {
      $status.textContent = "Not allowed: both items belong to the same store.";
      return;
    }
    if (isIgnoredPair(a, b)) {
      $status.textContent = "This pair is already ignored.";
      return;
    }

    $status.textContent = `Ignoring: ${displaySku(a)} × ${displaySku(b)} …`;

    try {
      const out = await apiWriteSkuIgnore(a, b);
      ignoreSet.add(rules.canonicalPairKey(a, b));
      $status.textContent = `Ignored: ${displaySku(a)} × ${displaySku(b)} (ignores=${out.count}).`;
      pinnedL = null;
      pinnedR = null;
      updateAll();
    } catch (e) {
      $status.textContent = `Ignore failed: ${String(e && e.message ? e.message : e)}`;
    }
  });

  updateAll();
}
