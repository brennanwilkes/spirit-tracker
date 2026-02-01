// viz/app/linker/suggestions.js
import { tokenizeQuery, normSearchText } from "../sku.js";
import {
  smwsKeyFromName,
  extractAgeFromText,
  filterSimTokens,
  tokenContainmentScore,
  fastSimilarityScore,
  similarityScore,
} from "./similarity.js";

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

export function topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus) {
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

// same behavior guarantees as your comment in linker_page.js
export function recommendSimilar(
  allAgg,
  pinned,
  limit,
  otherPinnedSku,
  mappedSkus,
  isIgnoredPairFn,
  sizePenaltyFn,
  sameStoreFn,
  sameGroupFn
) {
  if (!pinned || !pinned.name) return topSuggestions(allAgg, limit, otherPinnedSku, mappedSkus);

  const pinnedSku = String(pinned.sku || "");
  const otherSku = otherPinnedSku ? String(otherPinnedSku) : "";
  const base = String(pinned.name || "");

  const pinNorm = normSearchText(pinned.name || "");
  const pinRawToks = tokenizeQuery(pinNorm);
  const pinToks = filterSimTokens(pinRawToks);
  const pinBrand = pinToks[0] || "";
  const pinAge = extractAgeFromText(pinNorm);
  const pinnedSmws = smwsKeyFromName(pinned.name || "");

  const MAX_SCAN = 5000;
  const MAX_CHEAP_KEEP = 320;
  const MAX_FINE = 70;

  function pushTopK(arr, item, k) {
    arr.push(item);
    if (arr.length > k) {
      arr.sort((a, b) => b.s - a.s);
      arr.length = k;
    }
  }

  const cheap = [];
  let scanned = 0;

  for (const it of allAgg) {
    if (!it) continue;
    if (scanned++ > MAX_SCAN) break;

    const itSku = String(it.sku || "");
    if (!itSku) continue;

    if (itSku === pinnedSku) continue;
    if (otherSku && itSku === otherSku) continue;

    if (typeof sameStoreFn === "function" && sameStoreFn(pinnedSku, itSku)) continue;
    if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(pinnedSku, itSku)) continue;
    if (typeof sameGroupFn === "function" && sameGroupFn(pinnedSku, itSku)) continue;

    if (pinnedSmws) {
      const k = smwsKeyFromName(it.name || "");
      if (k && k === pinnedSmws) {
        const stores = it.stores ? it.stores.size : 0;
        const hasPrice = it.cheapestPriceNum != null ? 1 : 0;
        pushTopK(cheap, { it, s: 1e9 + stores * 10 + hasPrice, itNorm: "", itRawToks: null }, MAX_CHEAP_KEEP);
        continue;
      }
    }

    const itNorm = normSearchText(it.name || "");
    if (!itNorm) continue;

    const itRawToks = tokenizeQuery(itNorm);
    const itToks = filterSimTokens(itRawToks);
    if (!itToks.length) continue;

    const itBrand = itToks[0] || "";
    const firstMatch = pinBrand && itBrand && pinBrand === itBrand;
    const contain = tokenContainmentScore(pinRawToks, itRawToks);

    let s0 = fastSimilarityScore(pinRawToks, itRawToks, pinNorm, itNorm);
    if (s0 <= 0) s0 = 0.01 + 0.25 * contain;

    if (!firstMatch) {
      const smallN = Math.min(pinToks.length || 0, itToks.length || 0);
      let mult = 0.10 + 0.95 * contain;
      if (smallN <= 3 && contain < 0.78) mult *= 0.22;
      s0 *= Math.min(1.0, mult);
    }

    if (typeof sizePenaltyFn === "function") {
      s0 *= sizePenaltyFn(pinnedSku, itSku);
    }

    const itAge = extractAgeFromText(itNorm);
    if (pinAge && itAge) {
      if (pinAge === itAge) s0 *= 1.6;
      else s0 *= 0.22;
    }

    if (pinnedSku.startsWith("u:") || itSku.startsWith("u:")) s0 *= 1.08;

    pushTopK(cheap, { it, s: s0, itNorm, itRawToks }, MAX_CHEAP_KEEP);
  }

  cheap.sort((a, b) => b.s - a.s);

  const fine = [];
  for (const x of cheap.slice(0, MAX_FINE)) {
    const it = x.it;
    const itSku = String(it.sku || "");

    let s = similarityScore(base, it.name || "");
    if (s <= 0) continue;

    const itNorm = x.itNorm || normSearchText(it.name || "");
    const itRawToks = x.itRawToks || tokenizeQuery(itNorm);
    const itToks = filterSimTokens(itRawToks);
    const itBrand = itToks[0] || "";
    const firstMatch = pinBrand && itBrand && pinBrand === itBrand;
    const contain = tokenContainmentScore(pinRawToks, itRawToks);

    if (!firstMatch) {
      const smallN = Math.min(pinToks.length || 0, itToks.length || 0);
      let mult = 0.10 + 0.95 * contain;
      if (smallN <= 3 && contain < 0.78) mult *= 0.22;
      s *= Math.min(1.0, mult);
      if (s <= 0) continue;
    }

    if (typeof sizePenaltyFn === "function") {
      s *= sizePenaltyFn(pinnedSku, itSku);
      if (s <= 0) continue;
    }

    const itAge = extractAgeFromText(itNorm);
    if (pinAge && itAge) {
      if (pinAge === itAge) s *= 2.0;
      else s *= 0.15;
    }

    if (pinnedSku.startsWith("u:") || itSku.startsWith("u:")) s *= 1.12;

    if (s > 0) fine.push({ it, s });
  }

  fine.sort((a, b) => b.s - a.s);
  const out = fine.slice(0, limit).map((x) => x.it);
  if (out.length) return out;

  const fallback = [];
  for (const it of allAgg) {
    if (!it) continue;
    const itSku = String(it.sku || "");
    if (!itSku) continue;
    if (itSku === pinnedSku) continue;
    if (otherSku && itSku === otherSku) continue;

    if (typeof sameStoreFn === "function" && sameStoreFn(pinnedSku, itSku)) continue;
    if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(pinnedSku, itSku)) continue;
    if (typeof sameGroupFn === "function" && sameGroupFn(pinnedSku, itSku)) continue;

    const stores = it.stores ? it.stores.size : 0;
    const hasPrice = it.cheapestPriceNum !== null ? 1 : 0;
    const hasName = it.name ? 1 : 0;
    fallback.push({ it, s: stores * 2 + hasPrice * 1.2 + hasName * 1.0 });
    if (fallback.length >= 250) break;
  }

  fallback.sort((a, b) => b.s - a.s);
  return fallback.slice(0, limit).map((x) => x.it);
}

export function computeInitialPairsFast(allAgg, mappedSkus, limitPairs, isIgnoredPairFn, sameStoreFn) {
  const itemsAll = allAgg.filter((it) => !!it);

  const seed = (Date.now() ^ ((Math.random() * 1e9) | 0)) >>> 0;
  const rnd = mulberry32(seed);
  const itemsShuf = itemsAll.slice();
  shuffleInPlace(itemsShuf, rnd);

  const WORK_CAP = 5000;
  const workAll = itemsShuf.length > WORK_CAP ? itemsShuf.slice(0, WORK_CAP) : itemsShuf;

  const work = workAll.filter((it) => !(mappedSkus && mappedSkus.has(String(it.sku))));

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

      const arr = arr0
        .slice()
        .sort((a, b) => itemRank(b) - itemRank(a))
        .slice(0, 80);

      const mapped = [];
      const unmapped = [];
      for (const it of arr) {
        const sku = String(it.sku || "");
        if (mappedSkus && mappedSkus.has(sku)) mapped.push(it);
        else unmapped.push(it);
      }

      const anchor = (mapped.length ? mapped : unmapped)
        .slice()
        .sort((a, b) => itemRank(b) - itemRank(a))[0];

      if (!anchor) continue;

      if (unmapped.length) {
        for (const u of unmapped) {
          const a = anchor;
          const b = u;
          const aSku = String(a.sku || "");
          const bSku = String(b.sku || "");
          if (!aSku || !bSku || aSku === bSku) continue;
          if (typeof sameStoreFn === "function" && sameStoreFn(aSku, bSku)) continue;
          if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(aSku, bSku)) continue;

          const s = 1e9 + itemRank(a) + itemRank(b);
          candPairs.push({ a, b, score: s, aIsMapped: mappedSkus && mappedSkus.has(aSku) });
        }
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

      if (usedUnmapped.has(bSku)) continue;

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

  const seeds = topSuggestions(work, Math.min(150, work.length), "", mappedSkus).filter(
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
        if (typeof sameStoreFn === "function" && sameStoreFn(aSku, bSku)) continue;

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

  const need = Math.max(0, limitPairs - out.length);
  if (!need) return out.slice(0, limitPairs);

  const TOP_BAND = Math.min(600, pairs.length);
  const JITTER = 0.08;

  const band = pairs.slice(0, TOP_BAND).map((p) => {
    const jitter = (rnd() - 0.5) * JITTER;
    return { ...p, _rank: p.score * (1 + jitter) };
  });
  band.sort((a, b) => b._rank - a._rank);

  function tryTake(p) {
    const aSku = String(p.a.sku || "");
    const bSku = String(p.b.sku || "");
    if (!aSku || !bSku || aSku === bSku) return false;
    if (used.has(aSku) || used.has(bSku)) return false;
    if (typeof sameStoreFn === "function" && sameStoreFn(aSku, bSku)) return false;

    used.add(aSku);
    used.add(bSku);
    out.push({ a: p.a, b: p.b, score: p.score });
    return true;
  }

  for (const p of band) {
    if (out.length >= limitPairs) break;
    tryTake(p);
  }

  if (out.length < limitPairs) {
    for (let i = TOP_BAND; i < pairs.length; i++) {
      if (out.length >= limitPairs) break;
      tryTake(pairs[i]);
    }
  }

  return out.slice(0, limitPairs);
}
