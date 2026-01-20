// viz/app/linker_page.js
import { esc, renderThumbHtml } from "./dom.js";
import {
  tokenizeQuery,
  matchesAllTokens,
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
import { loadSkuRules, clearSkuRulesCache } from "./mapping.js";

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

  const aToks = tokenizeQuery(a);
  const bToks = tokenizeQuery(b);
  if (!aToks.length || !bToks.length) return 0;

  const aFirst = aToks[0] || "";
  const bFirst = bToks[0] || "";
  const firstMatch = aFirst && bFirst && aFirst === bFirst ? 1 : 0;

  // Compare tails (everything after first token)
  const A = new Set(aToks.slice(1));
  const B = new Set(bToks.slice(1));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const denom = Math.max(1, Math.max(A.size, B.size));
  const overlapTail = inter / denom;

  const d = levenshtein(a, b);
  const maxLen = Math.max(1, Math.max(a.length, b.length));
  const levSim = 1 - d / maxLen;

  // Gate tail similarity hard unless first word matches
  const gate = firstMatch ? 1.0 : 0.12;

  return (
    firstMatch * 3.0 + // first word dominates
    overlapTail * 2.2 * gate + // tail matters mostly after first word match
    levSim * (firstMatch ? 1.0 : 0.15) // edit-sim also mostly after first word match
  );
}

function fastSimilarityScore(aTokens, bTokens, aNormName, bNormName) {
  if (!aTokens.length || !bTokens.length) return 0;

  const aFirst = aTokens[0] || "";
  const bFirst = bTokens[0] || "";
  const firstMatch = aFirst && bFirst && aFirst === bFirst ? 1 : 0;

  // Tail overlap only
  const aTail = aTokens.slice(1);
  const bTail = bTokens.slice(1);

  let inter = 0;
  const bSet = new Set(bTail);
  for (const t of aTail) if (bSet.has(t)) inter++;

  const denom = Math.max(1, Math.max(aTail.length, bTail.length));
  const overlapTail = inter / denom;

  // Existing prefix bonus, but only when first word matches
  const a = String(aNormName || "");
  const b = String(bNormName || "");
  const pref =
    firstMatch && a.slice(0, 10) && b.slice(0, 10) && a.slice(0, 10) === b.slice(0, 10)
      ? 0.2
      : 0;

  const gate = firstMatch ? 1.0 : 0.12;

  return firstMatch * 2.4 + overlapTail * 2.0 * gate + pref;
}

/* ---------------- Store-overlap rule ---------------- */

function storesOverlap(aItem, bItem) {
  const a = aItem?.stores;
  const b = bItem?.stores;
  if (!a || !b) return false;

  // stores are Set(storeLabel). Exact-label overlap is the intended rule.
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

// infer BC-ness by checking any row for that skuKey in current index
function skuIsBC(allRows, skuKey) {
  for (const r of allRows) {
    if (keySkuForRow(r) !== skuKey) continue;
    const lab = String(r.storeLabel || r.store || "");
    if (isBCStoreLabel(lab)) return true;
  }
  return false;
}

/* ---------------- Canonical preference (AB real > other real > BC real > u:) ---------------- */

function isRealSkuKey(skuKey) {
  return !String(skuKey || "").startsWith("u:");
}

function isABStoreLabel(label) {
  const s = String(label || "").toLowerCase();
  // heuristic: tune as needed for your dataset
  return (
    s.includes("alberta") ||
    s.includes("calgary") ||
    s.includes("edmonton") ||
    /\bab\b/.test(s)
  );
}

function skuIsAB(allRows, skuKey) {
  for (const r of allRows) {
    if (keySkuForRow(r) !== skuKey) continue;
    const lab = String(r.storeLabel || r.store || "");
    if (isABStoreLabel(lab)) return true;
  }
  return false;
}

function scoreCanonical(allRows, skuKey) {
  const s = String(skuKey || "");
  const real = isRealSkuKey(s) ? 1 : 0;
  const ab = skuIsAB(allRows, s) ? 1 : 0;
  const bc = skuIsBC(allRows, s) ? 1 : 0;

  // Prefer: real AB > real non-BC > real BC > u:
  return real * 100 + ab * 25 - bc * 10 + (real ? 0 : -1000);
}

function pickPreferredCanonical(allRows, skuKeys) {
  let best = "";
  let bestScore = -Infinity;

  for (const k of skuKeys) {
    const s = String(k || "").trim();
    if (!s) continue;
    const sc = scoreCanonical(allRows, s);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    } else if (sc === bestScore && s && best && s < best) {
      best = s; // stable tie-break
    }
  }

  return best;
}

/* ---------------- Randomization helpers (avoid same suggestion subset) ---------------- */

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/* ---------------- Suggestion helpers ---------------- */

function topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus) {
  const scored = [];
  for (const it of allAgg) {
    if (!it) continue;
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

function recommendSimilar(
  allAgg,
  pinned,
  limit,
  otherPinnedSku,
  mappedSkus,
  isIgnoredPairFn
) {
  if (!pinned || !pinned.name)
    return topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus);

  const base = String(pinned.name || "");
  const pinnedSku = String(pinned.sku || "");
  const scored = [];

  for (const it of allAgg) {
    if (!it) continue;
    if (mappedSkus && mappedSkus.has(String(it.sku))) continue;
    if (it.sku === pinned.sku) continue;
    if (otherPinnedSku && String(it.sku) === String(otherPinnedSku)) continue;

    // never suggest same-store pairs
    if (storesOverlap(pinned, it)) continue;

    if (
      typeof isIgnoredPairFn === "function" &&
      isIgnoredPairFn(pinnedSku, String(it.sku || ""))
    )
      continue;

    const s = similarityScore(base, it.name || "");
    if (s > 0) scored.push({ it, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.it);
}

// FAST initial pairing (approx) with ignore-pair exclusion + same-store exclusion
function computeInitialPairsFast(allAgg, mappedSkus, limitPairs, isIgnoredPairFn) {
  // Only exclude already-linked SKUs from auto-suggestions
  const items = allAgg.filter((it) => {
    if (!it) return false;
    if (mappedSkus && mappedSkus.has(String(it.sku))) return false;
    return true;
  });

  // randomize the "subset" each load so we don't get stuck in the same chunk
  const seed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
  const rnd = mulberry32(seed);

  const itemsShuf = items.slice();
  shuffleInPlace(itemsShuf, rnd);

  // sample a bounded working set for speed
  const WORK_CAP = 1400;
  const work = itemsShuf.length > WORK_CAP ? itemsShuf.slice(0, WORK_CAP) : itemsShuf;

  const seeds = topSuggestions(work, Math.min(220, work.length), "", mappedSkus);

  const TOKEN_BUCKET_CAP = 180;
  const tokMap = new Map();
  const itemTokens = new Map();
  const itemNormName = new Map();

  for (const it of work) {
    const toks = Array.from(new Set(tokenizeQuery(it.name || "")))
      .filter(Boolean)
      .slice(0, 10);
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

        if (
          typeof isIgnoredPairFn === "function" &&
          isIgnoredPairFn(aSku, bSku)
        )
          continue;

        // never suggest same-store pairs
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
    if (!prev || bestS > prev.score)
      bestByPair.set(key, { a, b: bestB, score: bestS });
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
  let rules = await loadSkuRules();

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
          Existing mapped SKUs are excluded from auto-suggestions. Same-store pairs are never suggested. LINK SKU writes map (can merge groups); IGNORE PAIR writes a "do-not-suggest" pair (local only).
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

  // skuKey -> storeLabel -> url  (used to ensure store badge uses matching URL)
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

  // candidates for this page (allow u: so KegNCork can be linked)
  const allAgg = aggregateBySku(allRows, (x) => x);

  const meta = await loadSkuMetaBestEffort();
  const mappedSkus = buildMappedSkuSet(meta.links || []);
  let ignoreSet = rules.ignoreSet; // already canonicalized as "a|b"

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

    // IMPORTANT: link must match displayed store label
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

    const pinnedBadge = pinned ? `<span class="badge">PINNED</span>` : ``;

    return `
      <div class="item ${pinned ? "pinnedItem" : ""}" data-sku="${esc(it.sku)}">
        <div class="itemRow">
          <div class="thumbBox">${renderThumbHtml(it.img)}</div>
          <div class="itemBody">
            <div class="itemTop">
              <div class="itemName">${esc(it.name || "(no name)")}</div>
              <span class="badge mono">${esc(displaySku(it.sku))}</span>
            </div>
            <div class="metaRow">
              ${pinnedBadge}
              <span class="mono price">${esc(price)}</span>
              ${storeBadge}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function sideItems(side, query, otherPinned) {
    const tokens = tokenizeQuery(query);
    const otherSku = otherPinned ? String(otherPinned.sku || "") : "";

    // manual search: allow mapped SKUs so you can merge groups
    if (tokens.length) {
      let out = allAgg
        .filter(
          (it) =>
            it &&
            it.sku !== otherSku &&
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

    // auto-suggestions: never include mapped skus
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

    // link is allowed even if either sku is already in a link (merges groups)
    $linkBtn.disabled = false;
    $ignoreBtn.disabled = false;

    if (isIgnoredPair(a, b)) {
      $status.textContent = "This pair is already ignored.";
    } else if ($status.textContent === "Pin one item on each side to enable linking / ignoring.") {
      $status.textContent = "";
    }
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

    if (!a || !b) {
      $status.textContent = "Not allowed: missing SKU.";
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

    // Determine current group canonicals (if already linked)
    const aCanon = rules.canonicalSku(a);
    const bCanon = rules.canonicalSku(b);

    // Choose canonical to render/group by: prefer Alberta real, never BC if avoidable, never u: if any real exists
    const preferred = pickPreferredCanonical(allRows, [a, b, aCanon, bCanon]);

    if (!preferred) {
      $status.textContent = "Write failed: could not choose a canonical SKU.";
      return;
    }

    // Build minimal writes to merge everything under `preferred`
    const writes = [];
    function addWrite(fromSku, toSku) {
      const f = String(fromSku || "").trim();
      const t = String(toSku || "").trim();
      if (!f || !t || f === t) return;
      if (rules.canonicalSku(f) === t) return; // already resolves to target
      writes.push({ fromSku: f, toSku: t });
    }

    // Merge existing groups (if their canonicals differ)
    addWrite(aCanon, preferred);
    addWrite(bCanon, preferred);

    // Ensure the pinned SKUs end up in the preferred group too
    addWrite(a, preferred);
    addWrite(b, preferred);

    // de-dupe
    const seenW = new Set();
    const uniq = [];
    for (const w of writes) {
      const k = `${w.fromSku}→${w.toSku}`;
      if (seenW.has(k)) continue;
      seenW.add(k);
      uniq.push(w);
    }

    $status.textContent = `Writing ${uniq.length} link(s) to canonical ${displaySku(preferred)} …`;

    try {
      for (let i = 0; i < uniq.length; i++) {
        const w = uniq[i];
        $status.textContent = `Writing (${i + 1}/${uniq.length}): ${displaySku(w.fromSku)} → ${displaySku(w.toSku)} …`;
        await apiWriteSkuLink(w.fromSku, w.toSku);
      }

      // refresh rules/meta in-memory
      clearSkuRulesCache();
      rules = await loadSkuRules();
      ignoreSet = rules.ignoreSet;

      // rebuild mapped set from updated links
      const meta2 = await loadSkuMetaBestEffort();
      const rebuilt = buildMappedSkuSet(meta2?.links || []);
      mappedSkus.clear();
      for (const x of rebuilt) mappedSkus.add(x);

      $status.textContent = `Saved. Canonical is now ${displaySku(preferred)}.`;
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

    if (!a || !b) {
      $status.textContent = "Not allowed: missing SKU.";
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
