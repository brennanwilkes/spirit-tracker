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
  clearPendingEdits,
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

  // age words (we extract age separately)
  "year",
  "years",
  "yr",
  "yrs",
  "old",

  // whisky noise words
  "whisky",
  "whiskey",
  "scotch",
  "single",
  "malt",
  "cask",
  "finish",
  "edition",
  "release",
  "batch",
  "strength",
  "abv",
  "proof",

  // helps e.g. "20th Anniversary"
  "anniversary",
]);

const SMWS_WORD_RE = /\bsmws\b/i;
const SMWS_CODE_RE = /\b(\d{1,3}\.\d{1,4})\b/;

function smwsKeyFromName(name) {
  const s = String(name || "");
  if (!SMWS_WORD_RE.test(s)) return "";
  const m = s.match(SMWS_CODE_RE);
  return m ? m[1] : "";
}

// Treat ordinal tokens like "20th" as numbers, and detect ages explicitly.
const ORDINAL_RE = /^(\d+)(st|nd|rd|th)$/i;

function numKey(t) {
  const s = String(t || "").trim().toLowerCase();
  if (!s) return "";
  if (/^\d+$/.test(s)) return s;
  const m = s.match(ORDINAL_RE);
  return m ? m[1] : "";
}

function isNumberToken(t) {
  return !!numKey(t);
}

function extractAgeFromText(normName) {
  const s = String(normName || "");
  if (!s) return "";

  // "10 years", "10 year", "10 yr", "10 yrs", "aged 10 years"
  const m = s.match(/\b(?:aged\s*)?(\d{1,2})\s*(?:yr|yrs|year|years)\b/i);
  if (m && m[1]) return String(parseInt(m[1], 10));

  // "10 yo"
  const m2 = s.match(/\b(\d{1,2})\s*yo\b/i);
  if (m2 && m2[1]) return String(parseInt(m2[1], 10));

  return "";
}

function filterSimTokens(tokens) {
  const out = [];
  const seen = new Set();

  // Normalize some common variants -> single token
  const SIM_EQUIV = new Map([
    ["years", "yr"],
    ["year", "yr"],
    ["yrs", "yr"],
    ["yr", "yr"],

    // small safe extras
    ["whiskey", "whisky"],
    ["whisky", "whisky"],
    ["bourbon", "bourbon"],
  ]);

  const VOL_UNIT = new Set([
    "ml",
    "l",
    "cl",
    "oz",
    "liter",
    "liters",
    "litre",
    "litres",
  ]);

  const VOL_INLINE_RE = /^\d+(?:\.\d+)?(?:ml|l|cl|oz)$/i; // 700ml, 1.14l
  const PCT_INLINE_RE = /^\d+(?:\.\d+)?%$/; // 46%, 40.0%

  const arr = Array.isArray(tokens) ? tokens : [];

  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    let t = String(raw || "").trim().toLowerCase();
    if (!t) continue;

    // Drop tokens that are just punctuation / separators (e.g. "-")
    if (!/[a-z0-9]/i.test(t)) continue;

    // Drop inline volume + inline percentages
    if (VOL_INLINE_RE.test(t)) continue;
    if (PCT_INLINE_RE.test(t)) continue;

    // Normalize
    t = SIM_EQUIV.get(t) || t;

    // Normalize ordinals like "20th" -> "20"
    const nk = numKey(t);
    if (nk) t = nk;

    // Drop unit tokens (ml/l/oz/etc) and ABV-ish
    if (VOL_UNIT.has(t) || t === "abv" || t === "proof") continue;

    // Drop "number + unit" volume patterns: "750 ml", "1.14 l"
    if (/^\d+(?:\.\d+)?$/.test(t)) {
      const next = String(arr[i + 1] || "").trim().toLowerCase();
      const nextNorm = SIM_EQUIV.get(next) || next;
      if (VOL_UNIT.has(nextNorm)) {
        i++; // skip the unit token too
        continue;
      }
    }

    // Ignore ultra-common / low-signal tokens (but keep numbers)
    if (!isNumberToken(t) && SIM_STOP_TOKENS.has(t)) continue;

    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }

  return out;
}

function numberMismatchPenalty(aTokens, bTokens) {
  const aNums = new Set((aTokens || []).map(numKey).filter(Boolean));
  const bNums = new Set((bTokens || []).map(numKey).filter(Boolean));
  if (!aNums.size || !bNums.size) return 1.0; // no penalty if either has no numbers
  for (const n of aNums) if (bNums.has(n)) return 1.0; // at least one number matches
  return 0.28; // stronger penalty than before
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

function tokenContainmentScore(aTokens, bTokens) {
  // Measures how well the smaller token set is contained in the larger one.
  // Returns 0..1 (1 = perfect containment).
  const A = filterSimTokens(aTokens || []);
  const B = filterSimTokens(bTokens || []);
  if (!A.length || !B.length) return 0;

  const aSet = new Set(A);
  const bSet = new Set(B);

  const small = aSet.size <= bSet.size ? aSet : bSet;
  const big = aSet.size <= bSet.size ? bSet : aSet;

  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;

  const recall = hit / Math.max(1, small.size);
  const precision = hit / Math.max(1, big.size);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);

  return f1;
}

function similarityScore(aName, bName) {
  const a = normSearchText(aName);
  const b = normSearchText(bName);
  if (!a || !b) return 0;

  // Explicit age handling
  const aAge = extractAgeFromText(a);
  const bAge = extractAgeFromText(b);
  const ageBoth = !!(aAge && bAge);
  const ageMatch = ageBoth && aAge === bAge;
  const ageMismatch = ageBoth && aAge !== bAge;

  const aToksRaw = tokenizeQuery(a);
  const bToksRaw = tokenizeQuery(b);

  const aToks = filterSimTokens(aToksRaw);
  const bToks = filterSimTokens(bToksRaw);
  if (!aToks.length || !bToks.length) return 0;

  const contain = tokenContainmentScore(aToksRaw, bToksRaw);

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

  // Dynamic gate: if first token mismatches, allow tail to matter more when containment is high.
  let gate = firstMatch ? 1.0 : Math.min(0.80, 0.06 + 0.95 * contain);

  // For very short names, keep first token more important unless containment is very high.
  const smallN = Math.min(aToks.length, bToks.length);
  if (!firstMatch && smallN <= 3 && contain < 0.78) gate *= 0.18;

  const numGate = numberMismatchPenalty(aToks, bToks);

  let s =
    numGate *
    (firstMatch * 3.0 +
      overlapTail * 2.2 * gate +
      levSim * (firstMatch ? 1.0 : (0.10 + 0.70 * contain)));

  // Age boosts/penalties
  if (ageMatch) s *= 2.2;
  else if (ageMismatch) s *= 0.18;

  // Bundle/containment boost (short name contained in long name)
  s *= 1 + 0.9 * contain;

  return s;
}

function fastSimilarityScore(aTokens, bTokens, aNormName, bNormName) {
  const aTokensRaw = aTokens || [];
  const bTokensRaw = bTokens || [];

  const aTokF = filterSimTokens(aTokensRaw);
  const bTokF = filterSimTokens(bTokensRaw);
  if (!aTokF.length || !bTokF.length) return 0;

  const a = String(aNormName || "");
  const b = String(bNormName || "");

  const aAge = extractAgeFromText(a);
  const bAge = extractAgeFromText(b);
  const ageBoth = !!(aAge && bAge);
  const ageMatch = ageBoth && aAge === bAge;
  const ageMismatch = ageBoth && aAge !== bAge;

  const contain = tokenContainmentScore(aTokensRaw, bTokensRaw);

  const aFirst = aTokF[0] || "";
  const bFirst = bTokF[0] || "";
  const firstMatch = aFirst && bFirst && aFirst === bFirst ? 1 : 0;

  const aTail = aTokF.slice(1);
  const bTail = bTokF.slice(1);

  let inter = 0;
  const bSet = new Set(bTail);
  for (const t of aTail) if (bSet.has(t)) inter++;

  const denom = Math.max(1, Math.max(aTail.length, bTail.length));
  const overlapTail = inter / denom;

  const pref =
    firstMatch &&
    a.slice(0, 10) &&
    b.slice(0, 10) &&
    a.slice(0, 10) === b.slice(0, 10)
      ? 0.2
      : 0;

  let gate = firstMatch ? 1.0 : Math.min(0.80, 0.06 + 0.95 * contain);
  const smallN = Math.min(aTokF.length, bTokF.length);
  if (!firstMatch && smallN <= 3 && contain < 0.78) gate *= 0.18;

  const numGate = numberMismatchPenalty(aTokF, bTokF);

  let s = numGate * (firstMatch * 2.4 + overlapTail * 2.0 * gate + pref);

  if (ageMatch) s *= 2.0;
  else if (ageMismatch) s *= 0.2;

  s *= 1 + 0.9 * contain;

  return s;
}

/* ---------------- Size helpers ---------------- */

const SIZE_TOLERANCE_ML = 8; // tolerate minor formatting noise (e.g. 749 vs 750)

function parseSizesMlFromText(text) {
  const s = String(text || "").toLowerCase();
  if (!s) return [];

  const out = new Set();

  // 750ml, 700 ml, 1140ml, 1.14l, 70cl, etc.
  const re = /\b(\d+(?:\.\d+)?)\s*(ml|cl|l|litre|litres|liter|liters)\b/g;
  let m;
  while ((m = re.exec(s))) {
    const val = parseFloat(m[1]);
    const unit = m[2];
    if (!isFinite(val) || val <= 0) continue;

    let ml = 0;
    if (unit === "ml") ml = Math.round(val);
    else if (unit === "cl") ml = Math.round(val * 10);
    else ml = Math.round(val * 1000); // l/litre/liter

    // sanity: ignore crazy
    if (ml >= 50 && ml <= 5000) out.add(ml);
  }

  return Array.from(out);
}

function sizeSetsMatch(aSet, bSet) {
  if (!aSet?.size || !bSet?.size) return false;
  for (const a of aSet) {
    for (const b of bSet) {
      if (Math.abs(a - b) <= SIZE_TOLERANCE_ML) return true;
    }
  }
  return false;
}

function sizePenalty(aSet, bSet) {
  // If either side has no known sizes, don't punish much.
  if (!aSet?.size || !bSet?.size) return 1.0;

  // If any size matches (within tolerance), no penalty.
  if (sizeSetsMatch(aSet, bSet)) return 1.0;

  // Both have sizes but none match => probably different products (750 vs 1140).
  return 0.08;
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

function buildMappedSkuSet(links, rules) {
  const s = new Set();

  function add(k) {
    const x = String(k || "").trim();
    if (!x) return;
    s.add(x);
    if (rules && typeof rules.canonicalSku === "function") {
      const c = String(rules.canonicalSku(x) || "").trim();
      if (c) s.add(c);
    }
  }

  for (const x of Array.isArray(links) ? links : []) {
    add(x?.fromSku);
    add(x?.toSku);
  }

  return s;
}

function isBCStoreLabel(label) {
  const s = String(label || "").toLowerCase();
  return (
    s.includes("bcl") ||
    s.includes("strath") ||
    s.includes("gull") ||
    s.includes("legacy") ||
    s.includes("tudor") ||
    s.includes("vessel") ||
    s.includes("vintagespirits")
  );
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
  const s = String(skuKey || "").trim();
  return /^\d{6}$/.test(s); // only CSPC counts as "real"
}

function isSoftSkuKey(k) {
  const s = String(k || "");
  return s.startsWith("upc:") || s.startsWith("id:");
}

function isUnknownSkuKey2(k) {
  return String(k || "").trim().startsWith("u:");
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
  const soft = isSoftSkuKey(s) ? 1 : 0;
  const unk = isUnknownSkuKey2(s) ? 1 : 0;

  // Canonical preference:
  // CSPC (best) > soft (upc/id) > other non-u keys > u: (worst)
  let base = 0;
  if (real) base = 1000;
  else if (soft) base = 200;
  else if (!unk) base = 100; // some other stable-ish non-u key
  else base = -1000;

  return base + ab * 25 - bc * 10;
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

// IMPORTANT behavior guarantees:
// - NEVER fully blocks based on "brand"/first-token mismatch.
// - ONLY hard-blocks: same-store overlap, ignored pair, already-linked (same canonical group), otherPinnedSku, self.
// - If scoring gets too strict, it falls back to a "least-bad" list (still respecting hard blocks).
function recommendSimilar(
  allAgg,
  pinned,
  limit,
  otherPinnedSku,
  mappedSkus,
  isIgnoredPairFn,
  sizePenaltyFn,
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

  // ---- Tuning knobs (performance + not-overzealous) ----
  const MAX_SCAN = 5000;          // cap scan work
  const MAX_CHEAP_KEEP = 320;     // top-K candidates to keep from cheap stage
  const MAX_FINE = 70;            // only run expensive similarityScore on top-N
  // ------------------------------------------------------

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

    // HARD BLOCKS ONLY:
    if (storesOverlap(pinned, it)) continue;
    if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(pinnedSku, itSku)) continue;
    if (typeof sameGroupFn === "function" && sameGroupFn(pinnedSku, itSku)) continue;

    // SMWS exact NUM.NUM match => keep at top
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
    const contain = tokenContainmentScore(pinRawToks, itRawToks); // 0..1

    // Cheap score first (no Levenshtein)
    let s0 = fastSimilarityScore(pinRawToks, itRawToks, pinNorm, itNorm);

    // If fast score is 0 (token buckets don't overlap well), still allow it as "least bad"
    // using containment as a weak baseline.
    if (s0 <= 0) s0 = 0.01 + 0.25 * contain;

    // Soft first-token mismatch penalty (never blocks)
    if (!firstMatch) {
      const smallN = Math.min(pinToks.length || 0, itToks.length || 0);
      let mult = 0.10 + 0.95 * contain; // 0.10..~1.05
      if (smallN <= 3 && contain < 0.78) mult *= 0.22; // short names: first token matters more
      s0 *= Math.min(1.0, mult);
    }

    // Size penalty early so mismatched sizes don't dominate fine scoring
    if (typeof sizePenaltyFn === "function") {
      s0 *= sizePenaltyFn(pinnedSku, itSku);
    }

    // Age handling early (cheap)
    const itAge = extractAgeFromText(itNorm);
    if (pinAge && itAge) {
      if (pinAge === itAge) s0 *= 1.6;
      else s0 *= 0.22;
    }

    // Unknown boost (cheap)
    if (pinnedSku.startsWith("u:") || itSku.startsWith("u:")) s0 *= 1.08;

    pushTopK(cheap, { it, s: s0, itNorm, itRawToks }, MAX_CHEAP_KEEP);
  }

  cheap.sort((a, b) => b.s - a.s);

  // Fine stage: expensive scoring only on top candidates
  const fine = [];
  for (const x of cheap.slice(0, MAX_FINE)) {
    const it = x.it;
    const itSku = String(it.sku || "");

    let s = similarityScore(base, it.name || "");
    if (s <= 0) continue;

    // Apply soft first-token mismatch penalty again (final ordering)
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

  // Guarantee: never return empty unless the catalog is genuinely empty after hard blocks.
  if (out.length) return out;

  // Fallback: "least bad" options with hard blocks only.
  const fallback = [];
  for (const it of allAgg) {
    if (!it) continue;
    const itSku = String(it.sku || "");
    if (!itSku) continue;
    if (itSku === pinnedSku) continue;
    if (otherSku && itSku === otherSku) continue;

    if (storesOverlap(pinned, it)) continue;
    if (typeof isIgnoredPairFn === "function" && isIgnoredPairFn(pinnedSku, itSku)) continue;
    if (typeof sameGroupFn === "function" && sameGroupFn(pinnedSku, itSku)) continue;

    // very cheap fallback score: store count + has price + has name
    const stores = it.stores ? it.stores.size : 0;
    const hasPrice = it.cheapestPriceNum !== null ? 1 : 0;
    const hasName = it.name ? 1 : 0;
    fallback.push({ it, s: stores * 2 + hasPrice * 1.2 + hasName * 1.0 });
    if (fallback.length >= 250) break;
  }

  fallback.sort((a, b) => b.s - a.s);
  return fallback.slice(0, limit).map((x) => x.it);
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

  // --- SMWS exact-code pairs first (including mapped anchors) ---
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

      // Pick best anchor (prefer mapped if available)
      const anchor = (mapped.length ? mapped : unmapped)
        .slice()
        .sort((a, b) => itemRank(b) - itemRank(a))[0];

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
  const seeds = topSuggestions(work, Math.min(150, work.length), "", mappedSkus).filter(
    (it) => !used.has(String(it?.sku || ""))
  );

  const TOKEN_BUCKET_CAP = 500;
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

  // ---- Happy-medium randomness: light jitter inside a top band ----
  // Strongly prefers best pairs, but changes order/selection across reloads.
  const need = Math.max(0, limitPairs - out.length);
  if (!need) return out.slice(0, limitPairs);

  const TOP_BAND = Math.min(600, pairs.length); // bigger band => more variety
  const JITTER = 0.08; // total span; smaller => safer quality

  const band = pairs.slice(0, TOP_BAND).map((p) => {
    const jitter = (rnd() - 0.5) * JITTER; // +-JITTER/2
    return { ...p, _rank: p.score * (1 + jitter) };
  });
  band.sort((a, b) => b._rank - a._rank);

  function tryTake(p) {
    const aSku = String(p.a.sku || "");
    const bSku = String(p.b.sku || "");
    if (!aSku || !bSku || aSku === bSku) return false;
    if (used.has(aSku) || used.has(bSku)) return false;
    if (storesOverlap(p.a, p.b)) return false;

    used.add(aSku);
    used.add(bSku);
    out.push({ a: p.a, b: p.b, score: p.score });
    return true;
  }

  // First pass: jittered top band
  for (const p of band) {
    if (out.length >= limitPairs) break;
    tryTake(p);
  }

  // Second pass: remainder in strict score order (quality backstop)
  if (out.length < limitPairs) {
    for (let i = TOP_BAND; i < pairs.length; i++) {
      if (out.length >= limitPairs) break;
      tryTake(pairs[i]);
    }
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
        ${!localWrite ? `<span id="pendingTop" class="badge mono" style="display:none;"></span>` : ``}
        ${
          !localWrite
            ? `<button id="clearPendingBtn" class="btn" style="padding:6px 10px; display:none;">Clear</button>`
            : ``
        }
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
  const $pendingTop = !localWrite ? document.getElementById("pendingTop") : null;
  const $clearPendingBtn = !localWrite ? document.getElementById("clearPendingBtn") : null;

  $listL.innerHTML = `<div class="small">Loading index…</div>`;
  $listR.innerHTML = `<div class="small">Loading index…</div>`;

  const idx = await loadIndex();
  const allRows = Array.isArray(idx.items) ? idx.items : [];

  const URL_BY_SKU_STORE = new Map();

  function urlQuality(r) {
    // Prefer “better” URLs if dupes exist.
    // Heuristics: longer path > shorter, avoid obvious legacy/short generic slugs when possible.
    const u = String(r?.url || "").trim();
    if (!u) return -1;
    let s = 0;
    s += u.length; // more specific tends to be longer
    if (/\bproduct\/\d+\//.test(u)) s += 50;
    if (/[a-z0-9-]{8,}/i.test(u)) s += 10; // sluggy
    return s;
  }

  for (const r of allRows) {
    // Keep active only
    if (!r || r.removed) continue;

    const skuKey = String(keySkuForRow(r) || "").trim();
    if (!skuKey) continue;

    const storeLabel = String(r.storeLabel || r.store || "").trim();
    const url = String(r.url || "").trim();
    if (!storeLabel || !url) continue;

    let m = URL_BY_SKU_STORE.get(skuKey);
    if (!m) URL_BY_SKU_STORE.set(skuKey, (m = new Map()));

    const prevUrl = m.get(storeLabel);
    if (!prevUrl) {
      m.set(storeLabel, url);
      continue;
    }

    // If duplicates exist, prefer the “better” URL deterministically.
    const prevScore = urlQuality({ url: prevUrl });
    const nextScore = urlQuality(r);

    if (nextScore > prevScore) {
      m.set(storeLabel, url);
    } else if (nextScore === prevScore && url < prevUrl) {
      // stable tie-break
      m.set(storeLabel, url);
    }
  }

  const allAgg = aggregateBySku(allRows, (x) => x);

  const meta = await loadSkuMetaBestEffort();
  const mappedSkus = buildMappedSkuSet(meta.links || [], rules);
  let ignoreSet = rules.ignoreSet;

  /* ---------------- Canonical-group size cache (FAST) ---------------- */

  // skuKey -> Set<int ml>
  const SKU_SIZE_CACHE = new Map();

  function ensureSkuSet(k) {
    let set = SKU_SIZE_CACHE.get(k);
    if (!set) SKU_SIZE_CACHE.set(k, (set = new Set()));
    return set;
  }

  // 1) One pass over rows (O(allRows))
  for (const r of allRows) {
    if (!r || r.removed) continue;
    const skuKey = String(keySkuForRow(r) || "").trim();
    if (!skuKey) continue;

    const name = r.name || r.title || r.productName || "";
    const sizes = parseSizesMlFromText(name);
    if (!sizes.length) continue;

    const set = ensureSkuSet(skuKey);
    for (const x of sizes) set.add(x);
  }

  // 2) One pass over aggregated names (O(allAgg))
  for (const it of allAgg) {
    const skuKey = String(it?.sku || "").trim();
    if (!skuKey || !it?.name) continue;
    const sizes = parseSizesMlFromText(it.name);
    if (!sizes.length) continue;

    const set = ensureSkuSet(skuKey);
    for (const x of sizes) set.add(x);
  }

  // 3) canon -> Set<int ml> (O(allAgg))
  const CANON_SIZE_CACHE = new Map();

  function ensureCanonSet(k) {
    let set = CANON_SIZE_CACHE.get(k);
    if (!set) CANON_SIZE_CACHE.set(k, (set = new Set()));
    return set;
  }

  for (const it of allAgg) {
    const skuKey = String(it?.sku || "").trim();
    if (!skuKey) continue;

    const canon = String(rules.canonicalSku(skuKey) || skuKey);
    const canonSet = ensureCanonSet(canon);

    const skuSet = SKU_SIZE_CACHE.get(skuKey);
    if (skuSet) for (const x of skuSet) canonSet.add(x);
  }

  function sizePenaltyForPair(aSku, bSku) {
    const aCanon = String(rules.canonicalSku(String(aSku || "")) || "");
    const bCanon = String(rules.canonicalSku(String(bSku || "")) || "");
    const A = aCanon ? (CANON_SIZE_CACHE.get(aCanon) || new Set()) : new Set();
    const B = bCanon ? (CANON_SIZE_CACHE.get(bCanon) || new Set()) : new Set();
    return sizePenalty(A, B);
  }

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

  // ✅ change: if page was opened with #/link/?left=... (or sku=...), reload after LINK completes
  let shouldReloadAfterLink = false;

  function renderCard(it, pinned) {
    const storeCount = it.stores.size || 0;
    const plus = storeCount > 1 ? ` +${storeCount - 1}` : "";
    const price = it.cheapestPriceStr ? it.cheapestPriceStr : "(no price)";
    const store = it.cheapestStoreLabel || [...it.stores][0] || "Store";

    const href =
      URL_BY_SKU_STORE.get(String(it.sku || ""))?.get(String(store || "")) ||
      String(it.sampleUrl || "").trim() ||
      "";

    const storeBadge = href
      ? `<a class="badge" href="${esc(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${esc(
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
      return recommendSimilar(
        allAgg,
        otherPinned,
        60,
        otherSku,
        mappedSkus,
        isIgnoredPair,
        sizePenaltyForPair,
        sameGroup
      );

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

        // HARD BLOCK: store overlap (per your requirement)
        if (other && storesOverlap(other, it)) {
          $status.textContent = "Not allowed: both items belong to the same store.";
          return;
        }

        // HARD BLOCK: already linked group
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

    if ($pendingTop && $clearPendingBtn) {
      const c0 = pendingCounts();
      $pendingTop.textContent = c0.total ? `Pending: ${c0.total}` : "";
      $pendingTop.style.display = c0.total ? "inline-flex" : "none";
      $clearPendingBtn.style.display = c0.total ? "inline-flex" : "none";
      $clearPendingBtn.disabled = c0.total === 0;
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
        if (!$status.textContent)
          $status.textContent = "Pin one item on each side to enable linking / ignoring.";
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

    // HARD BLOCK: store overlap
    if (storesOverlap(pinnedL, pinnedR)) {
      $linkBtn.disabled = true;
      $ignoreBtn.disabled = true;
      $status.textContent = "Not allowed: both items belong to the same store.";
      return;
    }

    // HARD BLOCK: already linked
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

  if ($clearPendingBtn) {
    $clearPendingBtn.addEventListener("click", async () => {
      const c0 = pendingCounts();
      if (c0.total === 0) return;

      clearPendingEdits();

      clearSkuRulesCache();
      rules = await loadSkuRules();
      ignoreSet = rules.ignoreSet;

      const rebuilt = buildMappedSkuSet(rules.links || [], rules);
      mappedSkus.clear();
      for (const x of rebuilt) mappedSkus.add(x);

      const $pr = document.getElementById("createPrBtn");
      if ($pr) {
        const c = pendingCounts();
        $pr.disabled = c.total === 0;
      }

      pinnedL = null;
      pinnedR = null;
      $status.textContent = "Cleared pending staged edits.";
      updateAll();
    });
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

      const rebuilt = buildMappedSkuSet(rules.links || [], rules);
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

  function findAggForPreselectSku(rawSku) {
    const want = String(rawSku || "").trim();
    if (!want) return null;

    // exact match first
    let it = allAgg.find((x) => String(x?.sku || "") === want);
    if (it) return it;

    // try canonical group match
    const canonWant = String(rules.canonicalSku(want) || want).trim();
    if (!canonWant) return null;

    it = allAgg.find((x) => String(x?.sku || "") === canonWant);
    if (it) return it;

    // any member whose canonicalSku matches
    return (
      allAgg.find((x) => String(rules.canonicalSku(String(x?.sku || "")) || "") === canonWant) ||
      null
    );
  }

  function updateAll() {
    // One-time left preselect from hash query:
    //   #/link/?left=<sku>
    // (works with your router because "link" stays as the first path segment)
    if (!updateAll._didPreselect) {
      updateAll._didPreselect = true;

      const h = String(location.hash || "");
      const qi = h.indexOf("?");
      if (qi !== -1) {
        const qs = new URLSearchParams(h.slice(qi + 1));
        const leftSkuRaw = qs.get("left") || qs.get("sku");
        const leftSku = String(leftSkuRaw || "").trim();

        // ✅ change: remember that the query param was set (even if SKU not found)
        if (leftSku) shouldReloadAfterLink = true;

        if (leftSku && !pinnedL) {
          const it = findAggForPreselectSku(leftSku);
          if (it) pinnedL = it;
        }
      }
    }

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

      const rebuilt = buildMappedSkuSet(rules.links || [], rules);
      mappedSkus.clear();
      for (const x of rebuilt) mappedSkus.add(x);

      const c = pendingCounts();
      $status.textContent = `Staged locally. Pending: ${c.links} link(s), ${c.ignores} ignore(s).`;

      const $pr = document.getElementById("createPrBtn");
      if ($pr) $pr.disabled = c.total === 0;

      pinnedL = null;
      pinnedR = null;
      updateAll();

      // ✅ change: reload after LINK completes when query param was used
      if (shouldReloadAfterLink) location.reload();

      return;
    }

    $status.textContent = `Writing ${uniq.length} link(s) to canonical ${displaySku(preferred)} …`;

    try {
      for (let i = 0; i < uniq.length; i++) {
        const w = uniq[i];
        $status.textContent = `Writing (${i + 1}/${uniq.length}): ${displaySku(
          w.fromSku
        )} → ${displaySku(w.toSku)} …`;
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

      // ✅ change: reload after LINK completes when query param was used
      if (shouldReloadAfterLink) location.reload();
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

      const rebuilt = buildMappedSkuSet(rules.links || [], rules);
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
