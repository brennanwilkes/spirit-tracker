"use strict";

const fs = require("fs");
const path = require("path");

/* ---------------- Union-Find (undirected grouping) ---------------- */

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

    if (rka < rkb) this.parent.set(ra, rb);
    else if (rkb < rka) this.parent.set(rb, ra);
    else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rka + 1);
    }
  }
}

function isUnknownSkuKey(k) {
  return String(k || "").startsWith("u:");
}

function isNumericSku(k) {
  return /^\d+$/.test(String(k || "").trim());
}

function compareSku(a, b) {
  a = String(a || "").trim();
  b = String(b || "").trim();
  if (a === b) return 0;

  const au = isUnknownSkuKey(a);
  const bu = isUnknownSkuKey(b);
  if (au !== bu) return au ? 1 : -1; // real first

  const an = isNumericSku(a);
  const bn = isNumericSku(b);
  if (an && bn) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? -1 : 1;
  }

  return a < b ? -1 : 1;
}

/* ---------------- File discovery ---------------- */

function tryReadJson(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function defaultSkuLinksCandidates(dbDir) {
  const out = [];

  // 1) next to db dir: <dbDir>/../sku_links.json (common when dbDir is .../data/db)
  if (dbDir) {
    out.push(path.join(dbDir, "..", "sku_links.json"));
  }

  // 2) repo root conventional location
  out.push(path.join(process.cwd(), "data", "sku_links.json"));

  // 3) common worktree location
  out.push(path.join(process.cwd(), ".worktrees", "data", "data", "sku_links.json"));

  return out;
}

function findSkuLinksFile({ dbDir, mappingFile } = {}) {
  // env override
  const env = String(process.env.SPIRIT_TRACKER_SKU_LINKS || "").trim();
  if (env) return env;

  if (mappingFile) return mappingFile;

  for (const f of defaultSkuLinksCandidates(dbDir)) {
    if (!f) continue;
    try {
      if (fs.existsSync(f)) return f;
    } catch {
      // ignore
    }
  }

  return "";
}

/* ---------------- Public API ---------------- */

function buildSkuMapFromLinksArray(links) {
  const dsu = new DSU();
  const all = new Set();

  for (const x of Array.isArray(links) ? links : []) {
    const a = String(x?.fromSku || "").trim();
    const b = String(x?.toSku || "").trim();
    if (!a || !b) continue;

    all.add(a);
    all.add(b);

    // undirected union => hardened vs A->B->C and cycles
    dsu.union(a, b);
  }

  // root -> Set(members)
  const byRoot = new Map();
  for (const s of all) {
    const r = dsu.find(s);
    if (!r) continue;
    let set = byRoot.get(r);
    if (!set) byRoot.set(r, (set = new Set()));
    set.add(s);
  }

  // root -> canonical rep
  const repByRoot = new Map();
  for (const [root, members] of byRoot.entries()) {
    const arr = Array.from(members);
    arr.sort(compareSku);
    repByRoot.set(root, arr[0] || root);
  }

  // sku -> canonical rep
  const canonBySku = new Map();
  for (const [root, members] of byRoot.entries()) {
    const rep = repByRoot.get(root) || root;
    for (const s of members) canonBySku.set(s, rep);
  }

  function canonicalSku(sku) {
    const s = String(sku || "").trim();
    if (!s) return s;
    return canonBySku.get(s) || s;
  }

  return { canonicalSku, _canonBySku: canonBySku };
}

function loadSkuMap({ dbDir, mappingFile } = {}) {
  const file = findSkuLinksFile({ dbDir, mappingFile });
  if (!file) {
    return buildSkuMapFromLinksArray([]);
  }

  const obj = tryReadJson(file);
  const links = Array.isArray(obj?.links) ? obj.links : [];
  return buildSkuMapFromLinksArray(links);
}

module.exports = { loadSkuMap };
