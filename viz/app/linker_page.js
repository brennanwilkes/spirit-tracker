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
import { loadSkuRules, clearSkuRulesCache } from "./mapping.js";
import {
  inferGithubOwnerRepo,
  isLocalWriteMode,
  loadSkuMetaBestEffort,
  apiWriteSkuLink,
  apiWriteSkuIgnore,
} from "./api.js";
import {
  addPendingLink,
  addPendingIgnore,
  pendingCounts,
  movePendingToSubmitted,
} from "./pending.js";

/* ---------------- Similarity helpers ---------------- */
// Ignore ultra-common / low-signal tokens in bottle names.
const SIM_STOP_TOKENS = new Set([
  "the",
  "a",
  "an",
  "and",
  "of",
  "to",
  "in",
  "for",
  "with",
  "year",
  "years",
  "old",
]);

const SMWS_WORD_RE = /\bsmws\b/i;
const SMWS_CODE_RE = /\b(\d{1,3}\.\d{1,4})\b/;

function smwsKeyFromName(name) {
  const s = String(name || "");
  if (!SMWS_WORD_RE.test(s)) return "";
  const m = s.match(SMWS_CODE_RE);
  return m ? m[1] : "";
}


function isNumberToken(t) {
  return /^\d+$/.test(String(t || ""));
}

function filterSimTokens(tokens) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(tokens) ? tokens : []) {
    const t = String(raw || "").trim().toLowerCase();
    if (!t) continue;
    // keep numbers (we handle mismatch separately)
    if (!isNumberToken(t) && SIM_STOP_TOKENS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function numberMismatchPenalty(aTokens, bTokens) {
  const aNums = new Set(aTokens.filter(isNumberToken));
  const bNums = new Set(bTokens.filter(isNumberToken));
  if (!aNums.size || !bNums.size) return 1.0; // no penalty if either has no numbers
  for (const n of aNums) if (bNums.has(n)) return 1.0; // at least one number matches
  return 0.55; // mismatch (e.g. "18" vs "12") => penalize
}

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

  const aToks = filterSimTokens(tokenizeQuery(a));
  const bToks = filterSimTokens(tokenizeQuery(b));
  if (!aToks.length || !bToks.length) return 0;

  const aFirst = aToks[0] || "";
  const bFirst = bToks[0] || "";
  const firstMatch = aFirst && bFirst && aFirst === bFirst ? 1 : 0;

  const A = new Set(aToks.slice(1));
  const B = new Set(bToks.slice(1));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const denom = Math.max(1, Math.max(A.size, B.size));
  const overlapTail = inter / denom;

  const d = levenshtein(a, b);
  const maxLen = Math.max(1, Math.max(a.length, b.length));
  const levSim = 1 - d / maxLen;

  const gate = firstMatch ? 1.0 : 0.12;
  const numGate = numberMismatchPenalty(aToks, bToks);

  return numGate * (
    firstMatch * 3.0 +
    overlapTail * 2.2 * gate +
    levSim * (firstMatch ? 1.0 : 0.15)
  );
}

function fastSimilarityScore(aTokens, bTokens, aNormName, bNormName) {
  aTokens = filterSimTokens(aTokens);
  bTokens = filterSimTokens(bTokens);
  if (!aTokens.length || !bTokens.length) return 0;

  const aFirst = aTokens[0] || "";
  const bFirst = bTokens[0] || "";
  const firstMatch = aFirst && bFirst && aFirst === bFirst ? 1 : 0;

  const aTail = aTokens.slice(1);
  const bTail = bTokens.slice(1);

  let inter = 0;
  const bSet = new Set(bTail);
  for (const t of aTail) if (bSet.has(t)) inter++;

  const denom = Math.max(1, Math.max(aTail.length, bTail.length));
  const overlapTail = inter / denom;

  const a = String(aNormName || "");
  const b = String(bNormName || "");
  const pref =
    firstMatch &&
    a.slice(0, 10) &&
    b.slice(0, 10) &&
    a.slice(0, 10) === b.slice(0, 10)
      ? 0.2
      : 0;

  const gate = firstMatch ? 1.0 : 0.12;
  const numGate = numberMismatchPenalty(aTokens, bTokens);

  return numGate * (firstMatch * 2.4 + overlapTail * 2.0 * gate + pref);
}

/* ---------------- Store-overlap rule ---------------- */

function storesOverlap(aItem, bItem) {
  const a = aItem?.stores;
  const b = bItem?.stores;
  if (!a || !b) return false;
  for (const s of a) if (b.has(s)) return true;
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
  return s.includes("bcl") || s.includes("strath")|| s.includes("gull")|| s.includes("legacy");
}

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
      best = s;
    }
  }
  return best;
}

/* ---------------- Randomization helpers ---------------- */

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

    const unknown = String(it.sku || "").startsWith("u:") ? 1 : 0;

    scored.push({ it, s: stores * 2 + hasPrice * 1.2 + hasName * 1.0 + unknown * 0.6 });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.it);
}

function recommendSimilar(allAgg, pinned, limit, otherPinnedSku, mappedSkus, isIgnoredPairFn) {
  if (!pinned || !pinned.name)
    return topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus);

  const base = String(pinned.name || "");
  const pinnedSku = String(pinned.sku || "");
  const pinnedSmws = smwsKeyFromName(pinned.name || "");
  const scored = [];

  for (const it of allAgg) {
    if (!it) continue;
    if (mappedSkus && mappedSkus.has(String(it.sku))) continue;
    if (it.sku === pinned.sku) continue;
    if (otherPinnedSku && String(it.sku) === String(otherPinnedSku)) continue;
    if (storesOverlap(pinned, it)) continue;

    if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(pinnedSku, String(it.sku || "")))
      continue;

    // SMWS exact NUM.NUM match => force to top (requires SMWS + code match)
    if (pinnedSmws) {
      const k = smwsKeyFromName(it.name || "");
      if (k && k === pinnedSmws) {
        const stores = it.stores ? it.stores.size : 0;
        const hasPrice = it.cheapestPriceNum != null ? 1 : 0;
        const s = 1e9 + stores * 10 + hasPrice; // tie-break within exact matches
        scored.push({ it, s });
        continue;
      }
    }

    let s = similarityScore(base, it.name || "");

    // Small boost if either side is an unknown sku (u:...)
    const aUnknown = String(pinnedSku || "").startsWith("u:");
    const bUnknown = String(it.sku || "").startsWith("u:");
    if (aUnknown || bUnknown) s *= 1.12;

    if (s > 0) scored.push({ it, s });
  }

  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.it);
}


function computeInitialPairsFast(allAgg, mappedSkus, limitPairs, isIgnoredPairFn) {
  const itemsAll = allAgg.filter((it) => !!it);

  const seed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
  const rnd = mulberry32(seed);
  const itemsShuf = itemsAll.slice();
  shuffleInPlace(itemsShuf, rnd);

  const WORK_CAP = 5000;
  const workAll = itemsShuf.length > WORK_CAP ? itemsShuf.slice(0, WORK_CAP) : itemsShuf;

  // Unmapped-only view for the normal similarity stage
  const work = workAll.filter((it) => {
    if (!it) return false;
    return !(mappedSkus && mappedSkus.has(String(it.sku)));
  });

  // --- NEW: SMWS exact-code pairs first (including mapped anchors) ---
  function itemRank(it) {
    const stores = it.stores ? it.stores.size : 0;
    const hasPrice = it.cheapestPriceNum != null ? 1 : 0;
    const hasName = it.name ? 1 : 0;
    const unknown = String(it.sku || "").startsWith("u:") ? 1 : 0;
    return stores * 3 + hasPrice * 2 + hasName * 0.5 + unknown * 0.25;
  }

  function smwsPairsFirst(workArr, limit) {
    const buckets = new Map(); // code -> items[]
    for (const it of workArr) {
      if (!it) continue;
      const sku = String(it.sku || "");
      if (!sku) continue;

      const code = smwsKeyFromName(it.name || "");
      if (!code) continue;

      let arr = buckets.get(code);
      if (!arr) buckets.set(code, (arr = []));
      arr.push(it);
    }

    const candPairs = [];

    for (const arr0 of buckets.values()) {
      if (!arr0 || arr0.length < 2) continue;

      // Bound bucket size
      const arr = arr0.slice().sort((a, b) => itemRank(b) - itemRank(a)).slice(0, 80);

      const mapped = [];
      const unmapped = [];
      for (const it of arr) {
        const sku = String(it.sku || "");
        if (mappedSkus && mappedSkus.has(sku)) mapped.push(it);
        else unmapped.push(it);
      }

      // Pick best anchor (prefer mapped if available)
      const anchor =
        (mapped.length ? mapped : unmapped).slice().sort((a, b) => itemRank(b) - itemRank(a))[0];

      if (!anchor) continue;

      // If we have an anchor + at least 1 unmapped, pair each unmapped to the anchor
      if (unmapped.length) {
        for (const u of unmapped) {
          const a = anchor;
          const b = u;
          const aSku = String(a.sku || "");
          const bSku = String(b.sku || "");
          if (!aSku || !bSku || aSku === bSku) continue;
          if (storesOverlap(a, b)) continue;
          if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(aSku, bSku)) continue;

          const s = 1e9 + itemRank(a) + itemRank(b);
          candPairs.push({ a, b, score: s, aIsMapped: mappedSkus && mappedSkus.has(aSku) });
        }
      } else {
        // No unmapped left (all mapped) => skip; nothing to link
        continue;
      }
    }

    candPairs.sort((x, y) => y.score - x.score);

    const usedUnmapped = new Set();
    const anchorUse = new Map();
    const ANCHOR_REUSE_CAP = 6;

    const out0 = [];
    for (const p of candPairs) {
      const aSku = String(p.a.sku || "");
      const bSku = String(p.b.sku || "");
      if (!aSku || !bSku) continue;

      // b is intended to be the unmapped side in this construction
      if (usedUnmapped.has(bSku)) continue;

      // allow anchor reuse (especially if anchor is mapped)
      const k = aSku;
      const n = anchorUse.get(k) || 0;
      if (n >= ANCHOR_REUSE_CAP) continue;

      usedUnmapped.add(bSku);
      anchorUse.set(k, n + 1);
      out0.push(p);

      if (out0.length >= limit) break;
    }

    return { pairs: out0, usedUnmapped };
  }

  const smwsFirst = smwsPairsFirst(workAll, limitPairs);
  const used = new Set(smwsFirst.usedUnmapped);
  const out = smwsFirst.pairs.slice();

  if (out.length >= limitPairs) return out.slice(0, limitPairs);

  // --- Existing logic continues (fills remaining slots), but avoid reusing SMWS-picked *unmapped* SKUs ---
  const seeds = topSuggestions(work, Math.min(400, work.length), "", mappedSkus).filter(
    (it) => !used.has(String(it?.sku || ""))
  );

  const TOKEN_BUCKET_CAP = 500;
  const tokMap = new Map();
  const itemTokens = new Map();
  const itemNormName = new Map();

  for (const it of work) {
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
  const MAX_CAND_TOTAL = 250;
  const MAX_FINE = 10;

  for (const a of seeds) {
    const aSku = String(a.sku || "");
    if (!aSku || used.has(aSku)) continue;

    const aToks = itemTokens.get(aSku) || [];
    if (!aToks.length) continue;

    const cand = new Map();
    for (const t of aToks) {
      const arr = tokMap.get(t);
      if (!arr) continue;

      for (let i = 0; i < arr.length && cand.size < MAX_CAND_TOTAL; i++) {
        const b = arr[i];
        if (!b) continue;
        const bSku = String(b.sku || "");
        if (!bSku || bSku === aSku) continue;
        if (used.has(bSku)) continue;
        if (mappedSkus && mappedSkus.has(bSku)) continue;

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
    if (!bSku || used.has(bSku)) continue;

    const key = aSku < bSku ? `${aSku}|${bSku}` : `${bSku}|${aSku}`;
    const prev = bestByPair.get(key);
    if (!prev || bestS > prev.score) bestByPair.set(key, { a, b: bestB, score: bestS });
  }

  const pairs = Array.from(bestByPair.values());
  pairs.sort((x, y) => y.score - x.score);

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

  return out.slice(0, limitPairs);
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
        ${
          localWrite
            ? `<span class="badge mono">LOCAL WRITE</span>`
            : `<button id="createPrBtn" class="btn" disabled>Create PR</button>`
        }
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

  const allAgg = aggregateBySku(allRows, (x) => x);

  const meta = await loadSkuMetaBestEffort();
  const mappedSkus = buildMappedSkuSet(meta.links || []);
  let ignoreSet = rules.ignoreSet;

  function isIgnoredPair(a, b) {
    return rules.isIgnoredPair(String(a || ""), String(b || ""));
  }

  function sameGroup(aSku, bSku) {
    if (!aSku || !bSku) return false;
    return String(rules.canonicalSku(aSku)) === String(rules.canonicalSku(bSku));
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
      ? `<a class="badge" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(store)}${esc(plus)}</a>`
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

    // manual search: allow mapped SKUs so you can merge groups,
    // BUT if the other side is pinned, hide anything already in that pinned's group
    if (tokens.length) {
      let out = allAgg
        .filter((it) => it && it.sku !== otherSku && matchesAllTokens(it.searchText, tokens))
        .slice(0, 120);

      if (otherPinned) {
        const oSku = String(otherPinned.sku || "");
        out = out.filter((it) => !isIgnoredPair(oSku, String(it.sku || "")));
        out = out.filter((it) => !storesOverlap(otherPinned, it));
        out = out.filter((it) => !sameGroup(oSku, String(it.sku || "")));
      }

      return out.slice(0, 80);
    }

    // auto-suggestions: never include mapped skus
    if (otherPinned)
      return recommendSimilar(allAgg, otherPinned, 60, otherSku, mappedSkus, isIgnoredPair);

    if (initialPairs && initialPairs.length) {
      const list = side === "L" ? initialPairs.map((p) => p.a) : initialPairs.map((p) => p.b);
      return list.filter(
        (it) =>
          it &&
          it.sku !== otherSku &&
          (!mappedSkus.has(String(it.sku)) || smwsKeyFromName(it.name || ""))
      );
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

        if (other && sameGroup(String(other.sku || ""), String(it.sku || ""))) {
          $status.textContent = "Already linked: both SKUs are in the same group.";
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
    const isPages = !localWrite;

    const $pr = isPages ? document.getElementById("createPrBtn") : null;
    if ($pr) {
      const c0 = pendingCounts();
      $pr.disabled = c0.total === 0;
    }

    if (!(pinnedL && pinnedR)) {
      $linkBtn.disabled = true;
      $ignoreBtn.disabled = true;

      if (isPages) {
        const c = pendingCounts();
        $status.textContent = c.total
          ? `Pending changes: ${c.links} link(s), ${c.ignores} ignore(s). Create PR when ready.`
          : "Pin one item on each side to enable linking / ignoring.";
      } else {
        if (!$status.textContent) $status.textContent = "Pin one item on each side to enable linking / ignoring.";
      }
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

    if (sameGroup(a, b)) {
      $linkBtn.disabled = true;
      $ignoreBtn.disabled = true;
      $status.textContent = "Already linked: both SKUs are in the same group.";
      return;
    }

    $linkBtn.disabled = false;
    $ignoreBtn.disabled = false;

    if (isIgnoredPair(a, b)) {
      $status.textContent = "This pair is already ignored.";
    } else if ($status.textContent === "Pin one item on each side to enable linking / ignoring.") {
      $status.textContent = "";
    }

    if ($pr) {
      const c = pendingCounts();
      $pr.disabled = c.total === 0;
    }
  }

  const $createPrBtn = document.getElementById("createPrBtn");
  if ($createPrBtn) {
    $createPrBtn.addEventListener("click", async () => {
      const c = pendingCounts();
      if (c.total === 0) return;

      const { owner, repo } = inferGithubOwnerRepo();

      // Move PENDING -> SUBMITTED (so it won't be sent again, but still affects suggestions/grouping)
      const editsToSend = movePendingToSubmitted();

      const payload = JSON.stringify(
        {
          schema: "stviz-sku-edits-v1",
          createdAt: editsToSend.createdAt || new Date().toISOString(),
          links: editsToSend.links,
          ignores: editsToSend.ignores,
        },
        null,
        2
      );

      const title = `[stviz] sku link updates (${editsToSend.links.length} link, ${editsToSend.ignores.length} ignore)`;
      const body =
        `Automated request from GitHub Pages SKU Linker.\n\n` +
        `<!-- stviz-sku-edits:BEGIN -->\n` +
        payload +
        `\n<!-- stviz-sku-edits:END -->\n`;

      const u =
        `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
        `/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

      window.open(u, "_blank", "noopener,noreferrer");

      // Refresh local rules so UI immediately reflects submitted shadow
      clearSkuRulesCache();
      rules = await loadSkuRules();
      ignoreSet = rules.ignoreSet;

      const rebuilt = buildMappedSkuSet(rules.links || []);
      mappedSkus.clear();
      for (const x of rebuilt) mappedSkus.add(x);

      const c2 = pendingCounts();
      $createPrBtn.disabled = c2.total === 0;

      $status.textContent = "PR request opened. Staged edits moved to submitted (won’t re-suggest).";
      pinnedL = null;
      pinnedR = null;
      updateAll();
    });
  }

  function updateAll() {
    renderSide("L");
    renderSide("R");
    updateButtons();
  }

  let tL = null,
    tR = null;
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
    if (!(pinnedL && pinnedR)) return;

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
    if (sameGroup(a, b)) {
      $status.textContent = "Already linked: both SKUs are in the same group.";
      return;
    }
    if (isIgnoredPair(a, b)) {
      $status.textContent = "This pair is already ignored.";
      return;
    }

    const aCanon = rules.canonicalSku(a);
    const bCanon = rules.canonicalSku(b);

    const preferred = pickPreferredCanonical(allRows, [a, b, aCanon, bCanon]);
    if (!preferred) {
      $status.textContent = "Write failed: could not choose a canonical SKU.";
      return;
    }

    const writes = [];
    function addWrite(fromSku, toSku) {
      const f = String(fromSku || "").trim();
      const t = String(toSku || "").trim();
      if (!f || !t || f === t) return;
      if (rules.canonicalSku(f) === t) return;
      writes.push({ fromSku: f, toSku: t });
    }

    addWrite(aCanon, preferred);
    addWrite(bCanon, preferred);
    addWrite(a, preferred);
    addWrite(b, preferred);

    const seenW = new Set();
    const uniq = [];
    for (const w of writes) {
      const k = `${w.fromSku}→${w.toSku}`;
      if (seenW.has(k)) continue;
      seenW.add(k);
      uniq.push(w);
    }

    if (!localWrite) {
      for (const w of uniq) addPendingLink(w.fromSku, w.toSku);

      clearSkuRulesCache();
      rules = await loadSkuRules();
      ignoreSet = rules.ignoreSet;

      const rebuilt = buildMappedSkuSet(rules.links || []);
      mappedSkus.clear();
      for (const x of rebuilt) mappedSkus.add(x);

      const c = pendingCounts();
      $status.textContent = `Staged locally. Pending: ${c.links} link(s), ${c.ignores} ignore(s).`;

      const $pr = document.getElementById("createPrBtn");
      if ($pr) $pr.disabled = c.total === 0;

      pinnedL = null;
      pinnedR = null;
      updateAll();
      return;
    }

    $status.textContent = `Writing ${uniq.length} link(s) to canonical ${displaySku(preferred)} …`;

    try {
      for (let i = 0; i < uniq.length; i++) {
        const w = uniq[i];
        $status.textContent = `Writing (${i + 1}/${uniq.length}): ${displaySku(w.fromSku)} → ${displaySku(w.toSku)} …`;
        await apiWriteSkuLink(w.fromSku, w.toSku);
      }

      clearSkuRulesCache();
      rules = await loadSkuRules();
      ignoreSet = rules.ignoreSet;

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
    if (!(pinnedL && pinnedR)) return;

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
    if (sameGroup(a, b)) {
      $status.textContent = "Already linked: both SKUs are in the same group.";
      return;
    }
    if (isIgnoredPair(a, b)) {
      $status.textContent = "This pair is already ignored.";
      return;
    }

    if (!localWrite) {
      $status.textContent = `Staging ignore: ${displaySku(a)} × ${displaySku(b)} …`;

      addPendingIgnore(a, b);

      clearSkuRulesCache();
      rules = await loadSkuRules();
      ignoreSet = rules.ignoreSet;

      const rebuilt = buildMappedSkuSet(rules.links || []);
      mappedSkus.clear();
      for (const x of rebuilt) mappedSkus.add(x);

      const c = pendingCounts();
      $status.textContent = `Staged locally. Pending: ${c.links} link(s), ${c.ignores} ignore(s).`;

      const $pr = document.getElementById("createPrBtn");
      if ($pr) $pr.disabled = c.total === 0;

      pinnedL = null;
      pinnedR = null;
      updateAll();
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
