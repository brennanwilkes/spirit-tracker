// viz/app/mapping.js
import { loadSkuMetaBestEffort, isLocalWriteMode } from "./api.js";
import { applyPendingToMeta } from "./pending.js";

let CACHED = null;

export function clearSkuRulesCache() {
  CACHED = null;
}

function canonicalPairKey(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y) return "";
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function buildForwardMap(links) {
  // Keep this for reference/debug; grouping no longer depends on direction.
  const m = new Map();
  for (const x of Array.isArray(links) ? links : []) {
    const fromSku = String(x?.fromSku || "").trim();
    const toSku = String(x?.toSku || "").trim();
    if (fromSku && toSku && fromSku !== toSku) m.set(fromSku, toSku);
  }
  return m;
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

/* ---------------- Union-Find grouping (hardened) ---------------- */

class DSU {
  constructor() {
    this.parent = new Map();
    this.rank = new Map();
  }
  _add(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }
  find(x) {
    x = String(x || "").trim();
    if (!x) return "";
    this._add(x);
    let p = this.parent.get(x);
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a, b) {
    a = String(a || "").trim();
    b = String(b || "").trim();
    if (!a || !b || a === b) return;
    const ra = this.find(a);
    const rb = this.find(b);
    if (!ra || !rb || ra === rb) return;

    const rka = this.rank.get(ra) || 0;
    const rkb = this.rank.get(rb) || 0;

    if (rka < rkb) {
      this.parent.set(ra, rb);
    } else if (rkb < rka) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rka + 1);
    }
  }
}

function isUnknownSkuKey(key) {
  return String(key || "").startsWith("u:");
}

function isNumericSku(key) {
  return /^\d+$/.test(String(key || "").trim());
}

function compareSku(a, b) {
  // Stable ordering to choose a canonical representative.
  // Prefer real (non-u:) > unknown (u:). Among reals: numeric ascending if possible, else lex.
  a = String(a || "").trim();
  b = String(b || "").trim();
  if (a === b) return 0;

  const aUnknown = isUnknownSkuKey(a);
  const bUnknown = isUnknownSkuKey(b);
  if (aUnknown !== bUnknown) return aUnknown ? 1 : -1; // real first

  const aNum = isNumericSku(a);
  const bNum = isNumericSku(b);
  if (aNum && bNum) {
    // compare as integers (safe: these are small SKU strings)
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? -1 : 1;
  }

  // fallback lex
  return a < b ? -1 : 1;
}

function buildGroupsAndCanonicalMap(links) {
  const dsu = new DSU();
  const all = new Set();

  for (const x of Array.isArray(links) ? links : []) {
    const a = String(x?.fromSku || "").trim();
    const b = String(x?.toSku || "").trim();
    if (!a || !b) continue;
    all.add(a);
    all.add(b);

    // IMPORTANT: union is undirected for grouping (hardened vs cycles)
    dsu.union(a, b);
  }

  // root -> Set(members)
  const groupsByRoot = new Map();
  for (const s of all) {
    const r = dsu.find(s);
    if (!r) continue;
    let set = groupsByRoot.get(r);
    if (!set) groupsByRoot.set(r, (set = new Set()));
    set.add(s);
  }

  // Choose a canonical representative per group
  const repByRoot = new Map();
  for (const [root, members] of groupsByRoot.entries()) {
    const arr = Array.from(members);
    arr.sort(compareSku);
    const rep = arr[0] || root;
    repByRoot.set(root, rep);
  }

  // sku -> canonical rep
  const canonBySku = new Map();
  // canonical rep -> Set(members)   (what the rest of the app uses)
  const groupsByCanon = new Map();

  for (const [root, members] of groupsByRoot.entries()) {
    const rep = repByRoot.get(root) || root;
    let g = groupsByCanon.get(rep);
    if (!g) groupsByCanon.set(rep, (g = new Set([rep])));
    for (const s of members) {
      canonBySku.set(s, rep);
      g.add(s);
    }
  }

  return { canonBySku, groupsByCanon };
}

export async function loadSkuRules() {
  if (CACHED) return CACHED;

  let meta = await loadSkuMetaBestEffort();

  // On GitHub Pages (read-only), overlay local pending+submitted edits from localStorage
  if (!isLocalWriteMode()) {
    meta = applyPendingToMeta(meta);
  }

  const links = Array.isArray(meta?.links) ? meta.links : [];
  const ignores = Array.isArray(meta?.ignores) ? meta.ignores : [];

  // keep forwardMap for visibility/debug; grouping uses union-find
  const forwardMap = buildForwardMap(links);

  const { canonBySku, groupsByCanon } = buildGroupsAndCanonicalMap(links);
  const ignoreSet = buildIgnoreSet(ignores);

  function canonicalSku(sku) {
    const s = String(sku || "").trim();
    if (!s) return s;
    return canonBySku.get(s) || s;
  }

  function groupForCanonical(toSku) {
    const canon = canonicalSku(toSku);
    const g = groupsByCanon.get(canon);
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

    // "toGroups" retained name for compatibility with existing code
    toGroups: groupsByCanon,
    ignoreSet,

    canonicalSku,
    groupForCanonical,
    isIgnoredPair,
    canonicalPairKey,
  };

  return CACHED;
}
