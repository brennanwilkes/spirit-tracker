// viz/app/linker/similarity.js
import { tokenizeQuery, normSearchText } from "../sku.js";

// Ignore ultra-common / low-signal tokens in bottle names.
const SIM_STOP_TOKENS = new Set([
  "the","a","an","and","of","to","in","for","with",
  "year","years","yr","yrs","old",
  "whisky","whiskey","scotch","single","malt","cask","finish","edition","release","batch","strength","abv","proof",
  "anniversary",
]);

const SMWS_WORD_RE = /\bsmws\b/i;
const SMWS_CODE_RE = /\b(\d{1,3}\.\d{1,4})\b/;

export function smwsKeyFromName(name) {
  const s = String(name || "");
  if (!SMWS_WORD_RE.test(s)) return "";
  const m = s.match(SMWS_CODE_RE);
  return m ? m[1] : "";
}

const ORDINAL_RE = /^(\d+)(st|nd|rd|th)$/i;

export function numKey(t) {
  const s = String(t || "").trim().toLowerCase();
  if (!s) return "";
  if (/^\d+$/.test(s)) return s;
  const m = s.match(ORDINAL_RE);
  return m ? m[1] : "";
}

function isNumberToken(t) {
  return !!numKey(t);
}

export function extractAgeFromText(normName) {
  const s = String(normName || "");
  if (!s) return "";

  const m = s.match(/\b(?:aged\s*)?(\d{1,2})\s*(?:yr|yrs|year|years)\b/i);
  if (m && m[1]) return String(parseInt(m[1], 10));

  const m2 = s.match(/\b(\d{1,2})\s*yo\b/i);
  if (m2 && m2[1]) return String(parseInt(m2[1], 10));

  return "";
}

export function filterSimTokens(tokens) {
  const out = [];
  const seen = new Set();

  const SIM_EQUIV = new Map([
    ["years", "yr"],
    ["year", "yr"],
    ["yrs", "yr"],
    ["yr", "yr"],
    ["whiskey", "whisky"],
    ["whisky", "whisky"],
    ["bourbon", "bourbon"],
  ]);

  const VOL_UNIT = new Set(["ml","l","cl","oz","liter","liters","litre","litres"]);
  const VOL_INLINE_RE = /^\d+(?:\.\d+)?(?:ml|l|cl|oz)$/i; // 700ml, 1.14l
  const PCT_INLINE_RE = /^\d+(?:\.\d+)?%$/; // 46%, 40.0%

  const arr = Array.isArray(tokens) ? tokens : [];

  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    let t = String(raw || "").trim().toLowerCase();
    if (!t) continue;

    if (!/[a-z0-9]/i.test(t)) continue;

    if (VOL_INLINE_RE.test(t)) continue;
    if (PCT_INLINE_RE.test(t)) continue;

    t = SIM_EQUIV.get(t) || t;

    const nk = numKey(t);
    if (nk) t = nk;

    if (VOL_UNIT.has(t) || t === "abv" || t === "proof") continue;

    if (/^\d+(?:\.\d+)?$/.test(t)) {
      const next = String(arr[i + 1] || "").trim().toLowerCase();
      const nextNorm = SIM_EQUIV.get(next) || next;
      if (VOL_UNIT.has(nextNorm)) {
        i++;
        continue;
      }
    }

    if (!isNumberToken(t) && SIM_STOP_TOKENS.has(t)) continue;

    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }

  return out;
}

export function numberMismatchPenalty(aTokens, bTokens) {
  const aNums = new Set((aTokens || []).map(numKey).filter(Boolean));
  const bNums = new Set((bTokens || []).map(numKey).filter(Boolean));
  if (!aNums.size || !bNums.size) return 1.0;
  for (const n of aNums) if (bNums.has(n)) return 1.0;
  return 0.28;
}

export function levenshtein(a, b) {
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

export function tokenContainmentScore(aTokens, bTokens) {
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

export function similarityScore(aName, bName) {
  const a = normSearchText(aName);
  const b = normSearchText(bName);
  if (!a || !b) return 0;

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

  let gate = firstMatch ? 1.0 : Math.min(0.80, 0.06 + 0.95 * contain);

  const smallN = Math.min(aToks.length, bToks.length);
  if (!firstMatch && smallN <= 3 && contain < 0.78) gate *= 0.18;

  const numGate = numberMismatchPenalty(aToks, bToks);

  let s =
    numGate *
    (firstMatch * 3.0 +
      overlapTail * 2.2 * gate +
      levSim * (firstMatch ? 1.0 : (0.10 + 0.70 * contain)));

  if (ageMatch) s *= 2.2;
  else if (ageMismatch) s *= 0.18;

  s *= 1 + 0.9 * contain;

  return s;
}

export function fastSimilarityScore(aTokens, bTokens, aNormName, bNormName) {
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
