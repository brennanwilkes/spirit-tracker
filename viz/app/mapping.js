import { loadSkuMetaBestEffort } from "./api.js";

let CACHED = null;

function canonicalPairKey(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y) return "";
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function buildForwardMap(links) {
  const m = new Map();
  for (const x of Array.isArray(links) ? links : []) {
    const fromSku = String(x?.fromSku || "").trim();
    const toSku = String(x?.toSku || "").trim();
    if (fromSku && toSku && fromSku !== toSku) m.set(fromSku, toSku);
  }
  return m;
}

function resolveSkuWithMap(sku, forwardMap) {
  const s0 = String(sku || "").trim();
  if (!s0) return s0;

  // Only resolve real SKUs; leave synthetic u: alone
  if (s0.startsWith("u:")) return s0;

  const seen = new Set();
  let cur = s0;
  while (forwardMap.has(cur)) {
    if (seen.has(cur)) break; // cycle guard
    seen.add(cur);
    cur = String(forwardMap.get(cur) || "").trim() || cur;
  }
  return cur || s0;
}

function buildToGroups(links, forwardMap) {
  // group: canonical toSku -> Set(all skus mapping to it, transitively) incl toSku itself
  const groups = new Map();

  // seed: include all explicit endpoints
  for (const x of Array.isArray(links) ? links : []) {
    const fromSku = String(x?.fromSku || "").trim();
    const toSku = String(x?.toSku || "").trim();
    if (!fromSku || !toSku) continue;

    const canonTo = resolveSkuWithMap(toSku, forwardMap);
    if (!groups.has(canonTo)) groups.set(canonTo, new Set([canonTo]));
    groups.get(canonTo).add(fromSku);
    groups.get(canonTo).add(toSku);
  }

  // close transitively: any sku that resolves to canonTo belongs in its group
  // (cheap pass: expand by resolving all known skus in current link set)
  const allSkus = new Set();
  for (const x of Array.isArray(links) ? links : []) {
    const a = String(x?.fromSku || "").trim();
    const b = String(x?.toSku || "").trim();
    if (a) allSkus.add(a);
    if (b) allSkus.add(b);
  }

  for (const s of allSkus) {
    const canon = resolveSkuWithMap(s, forwardMap);
    if (!groups.has(canon)) groups.set(canon, new Set([canon]));
    groups.get(canon).add(s);
  }

  return groups;
}

function buildIgnoreSet(ignores) {
  const s = new Set();
  for (const x of Array.isArray(ignores) ? ignores : []) {
    const a = String(x?.skuA || x?.a || x?.left || "").trim();
    const b = String(x?.skuB || x?.b || x?.right || "").trim();
    const k = canonicalPairKey(a, b);
    if (k) s.add(k);
  }
  return s;
}

export async function loadSkuRules() {
  if (CACHED) return CACHED;

  const meta = await loadSkuMetaBestEffort();
  const links = Array.isArray(meta?.links) ? meta.links : [];
  const ignores = Array.isArray(meta?.ignores) ? meta.ignores : [];

  const forwardMap = buildForwardMap(links);
  const toGroups = buildToGroups(links, forwardMap);
  const ignoreSet = buildIgnoreSet(ignores);

  function canonicalSku(sku) {
    return resolveSkuWithMap(sku, forwardMap);
  }

  function groupForCanonical(toSku) {
    const canon = canonicalSku(toSku);
    const g = toGroups.get(canon);
    return g ? new Set(g) : new Set([canon]);
  }

  function isIgnoredPair(a, b) {
    const k = canonicalPairKey(a, b);
    return k ? ignoreSet.has(k) : false;
  }

  CACHED = {
    links,
    ignores,
    forwardMap,
    toGroups,
    ignoreSet,
    canonicalSku,
    groupForCanonical,
    isIgnoredPair,
    canonicalPairKey,
  };

  return CACHED;
}
