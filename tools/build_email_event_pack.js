#!/usr/bin/env node
"use strict";

/*
  tools/build_email_event_pack.js

  Usage:
    node tools/build_email_event_pack.js <sha> [--out pack.json] [--pretty]
    node tools/build_email_event_pack.js <fromSha> <toSha> [--out pack.json] [--pretty]

  Output: minimal JSON pack sufficient to evaluate email rules + render emails
  without loading the main codebase or data repo.
*/

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function gitShowText(sha, filePath) {
  try {
    return execFileSync("git", ["show", `${sha}:${filePath}`], { encoding: "utf8" });
  } catch {
    return null;
  }
}

function gitShowJson(sha, filePath) {
  const txt = gitShowText(sha, filePath);
  if (txt == null) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function getFirstParentSha(headSha) {
  try {
    const out = runGit(["rev-list", "--parents", "-n", "1", headSha]);
    const parts = out.split(/\s+/).filter(Boolean);
    return parts.length >= 2 ? parts[1] : "";
  } catch {
    return "";
  }
}

function gitListDbFiles(sha, dbDirRel) {
  try {
    const out = runGit(["ls-tree", "-r", "--name-only", sha, dbDirRel]);
    return new Set(
      out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && s.endsWith(".json"))
    );
  } catch {
    return new Set();
  }
}

function priceToNumber(p) {
  const s = String(p ?? "");
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function normImg(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^data:/i.test(s)) return "";
  if (/%7Bwidth%7D|\{width\}/i.test(s)) return "";
  return s;
}

// Try to reuse repo normalizeSkuKey if present; else fallback.
let normalizeSkuKey = null;
try {
  // eslint-disable-next-line node/no-missing-require
  const sku = require(path.join(process.cwd(), "src", "utils", "sku"));
  normalizeSkuKey = sku.normalizeSkuKey;
} catch {
  normalizeSkuKey = (v, { storeLabel, url } = {}) => {
    const raw = String(v ?? "").trim();
    const m = raw.match(/\b(\d{6})\b/);
    if (m) return m[1];
    if (/^upc:/i.test(raw)) return raw;
    if (/^id:/i.test(raw)) return raw;
    if (raw.startsWith("u:")) return raw;
    if (url) {
      const store = String(storeLabel || "store");
      const key = `${store}|${url}`;
      let h = 0;
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      return `u:${h.toString(16).padStart(8, "0")}`;
    }
    return "";
  };
}

/* ---------------- SKU map (match src/utils/sku_map.js) ---------------- */

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

function normalizeImplicitSkuKey(k) {
  const s = String(k || "").trim();
  const m = s.match(/^id:(\d{1,6})$/i);
  if (m) return String(m[1]).padStart(6, "0");
  return s;
}

function isUnknownSkuKey(k) {
  return String(k || "").startsWith("u:");
}

function isNumericSku(k) {
  return /^\d+$/.test(String(k || "").trim());
}

function isUpcSku(k) {
  const s = String(k || "").trim();
  if (s.startsWith("upc:")) return true;
  return /^\d{12,14}$/.test(s); // legacy support
}

function compareSku(a, b) {
  a = String(a || "").trim();
  b = String(b || "").trim();
  if (a === b) return 0;

  const au = isUnknownSkuKey(a);
  const bu = isUnknownSkuKey(b);
  if (au !== bu) return au ? 1 : -1; // real first

  const aUpc = isUpcSku(a);
  const bUpc = isUpcSku(b);
  if (aUpc !== bUpc) return aUpc ? 1 : -1; // UPCs after other "real" keys

  const an = isNumericSku(a);
  const bn = isNumericSku(b);
  if (an && bn) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? -1 : 1;
  }

  return a < b ? -1 : 1;
}

function buildSkuMapFromLinksArray(links) {
  const dsu = new DSU();
  const all = new Set();

  for (const x of Array.isArray(links) ? links : []) {
    const a = normalizeImplicitSkuKey(x?.fromSku);
    const b = normalizeImplicitSkuKey(x?.toSku);
    if (!a || !b) continue;

    all.add(a);
    all.add(b);

    // undirected union
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
  // canonical rep -> Set(members) (handy for pack.members)
  const groupsByCanon = new Map();

  for (const [root, members] of byRoot.entries()) {
    const rep = repByRoot.get(root) || root;
    let g = groupsByCanon.get(rep);
    if (!g) groupsByCanon.set(rep, (g = new Set([rep])));
    for (const s of members) {
      canonBySku.set(s, rep);
      g.add(s);
    }
  }

  function canonicalSku(sku) {
    const s = normalizeImplicitSkuKey(sku);
    if (!s) return s;
    return canonBySku.get(s) || s;
  }

  function groupMembersForCanonical(canon) {
    const c = canonicalSku(canon);
    const g = groupsByCanon.get(c);
    return g ? new Set(g) : new Set([c]);
  }

  return { canonicalSku, groupMembersForCanonical };
}

/* ---------------- Snapshot indexing ---------------- */

function listingScore(it) {
  if (!it) return 0;
  return (it.name ? 1 : 0) + (it.price ? 1 : 0) + (it.url ? 1 : 0) + (it.img ? 1 : 0);
}

function pickBetterListing(a, b) {
  if (!a) return b;
  if (!b) return a;

  if (a.removed !== b.removed) return a.removed ? b : a;

  const sa = listingScore(a);
  const sb = listingScore(b);
  if (sa !== sb) return sa > sb ? a : b;

  return String(a.url || "") <= String(b.url || "") ? a : b;
}

function storeIdFromDbPath(p) {
  const base = path.posix.basename(p);
  const parts = base.split("__");
  return (parts[0] || "").trim() || "unknown";
}

function ensureIndex() {
  return {
    byStoreCanon: new Map(), // storeId -> Map(canonSku -> listing)
    anySeen: new Set(), // canonSku seen at least once (removed or not)
    inStockStores: new Map(), // canonSku -> Set(storeId) (removed=false)
    storeLabelById: new Map(), // storeId -> storeLabel
    skuKeysByCanon: new Map(), // canonSku -> Set(skuKey)
    metaCandidatesByCanon: new Map(), // canonSku -> listing (best name/img candidate)
  };
}

function upsertIndex(idx, it) {
  if (!it || !it.canonSku || !it.storeId) return;

  idx.anySeen.add(it.canonSku);

  if (!idx.byStoreCanon.has(it.storeId)) idx.byStoreCanon.set(it.storeId, new Map());
  const storeMap = idx.byStoreCanon.get(it.storeId);

  const cur = storeMap.get(it.canonSku);
  const chosen = pickBetterListing(cur, it);
  storeMap.set(it.canonSku, chosen);

  if (it.storeLabel) idx.storeLabelById.set(it.storeId, it.storeLabel);

  if (!idx.skuKeysByCanon.has(it.canonSku)) idx.skuKeysByCanon.set(it.canonSku, new Set());
  if (it.skuKey) idx.skuKeysByCanon.get(it.canonSku).add(it.skuKey);

  if (!it.removed) {
    if (!idx.inStockStores.has(it.canonSku)) idx.inStockStores.set(it.canonSku, new Set());
    idx.inStockStores.get(it.canonSku).add(it.storeId);
  }

  const prev = idx.metaCandidatesByCanon.get(it.canonSku);
  const better = pickBetterListing(prev, it);
  idx.metaCandidatesByCanon.set(it.canonSku, better);
}

function ingestDbObject(idx, obj, { dbPath, canonicalSku }) {
  if (!obj || typeof obj !== "object") return;

  const storeId = storeIdFromDbPath(dbPath);
  const storeLabel = String(obj.storeLabel || obj.store || storeId);

  const items = Array.isArray(obj.items) ? obj.items : [];
  for (const row of items) {
    if (!row) continue;

    const url = String(row.url || "");
    if (!url || !/^https?:\/\//i.test(url)) continue;

    const name = String(row.name || "");
    const price = String(row.price || "");
    const img = normImg(row.img || row.image || row.thumb || "");
    const removed = Boolean(row.removed);

    const skuKey0 = normalizeSkuKey(row.sku || "", { storeLabel, url });
    const skuKey = normalizeImplicitSkuKey(skuKey0); // match sku_map implicit id: behavior
    if (!skuKey) continue;

    const canonSku = canonicalSku(skuKey);
    if (!canonSku) continue;

    upsertIndex(idx, {
      storeId,
      storeLabel,
      skuKey,
      canonSku,
      name,
      price,
      priceNum: priceToNumber(price),
      url,
      img,
      removed,
    });
  }
}

function computeCheapest(idx) {
  const cheapest = new Map(); // canonSku -> { priceNum, storeIds:Set }
  for (const [storeId, m] of idx.byStoreCanon.entries()) {
    for (const it of m.values()) {
      if (!it || it.removed) continue;
      const p = it.priceNum;
      if (!Number.isFinite(p) || p <= 0) continue;
      const cur = cheapest.get(it.canonSku);
      if (!cur || p < cur.priceNum) {
        cheapest.set(it.canonSku, { priceNum: p, storeIds: new Set([storeId]) });
      } else if (p === cur.priceNum) {
        cur.storeIds.add(storeId);
      }
    }
  }
  return cheapest;
}

function offersForCanon(idx, canonSku, { onlyInStock } = { onlyInStock: true }) {
  const out = [];
  for (const [storeId, m] of idx.byStoreCanon.entries()) {
    const it = m.get(canonSku);
    if (!it) continue;
    if (onlyInStock && it.removed) continue;
    out.push({
      storeId,
      storeLabel: it.storeLabel || idx.storeLabelById.get(storeId) || storeId,
      url: it.url,
      price: it.price || "",
      priceNum: Number.isFinite(it.priceNum) ? it.priceNum : null,
      removed: Boolean(it.removed),
    });
  }
  out.sort((a, b) => {
    const ap = a.priceNum == null ? Number.POSITIVE_INFINITY : a.priceNum;
    const bp = b.priceNum == null ? Number.POSITIVE_INFINITY : b.priceNum;
    if (ap !== bp) return ap - bp;
    return a.storeId.localeCompare(b.storeId);
  });
  return out;
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const positional = [];
  const kv = new Map();
  const flags = new Set();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    if (a === "--pretty") {
      flags.add("pretty");
      continue;
    }
    if ((a === "--out" || a === "--db-dir" || a === "--sku-links") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      kv.set(a, argv[i + 1]);
      i++;
      continue;
    }
    flags.add(a);
  }

  return {
    positional,
    outFile: kv.get("--out") || "",
    dbDirRel: kv.get("--db-dir") || "data/db",
    skuLinksPath: kv.get("--sku-links") || "data/sku_links.json",
    pretty: flags.has("pretty"),
  };
}

function main() {
  const { positional, outFile, dbDirRel, skuLinksPath, pretty } = parseArgs(process.argv.slice(2));

  if (positional.length < 1) {
    console.error(`Usage: ${path.basename(process.argv[1])} <sha>|<fromSha toSha> [--out file.json] [--pretty]`);
    process.exitCode = 2;
    return;
  }

  const headSha = positional.length >= 2 ? positional[1] : positional[0];
  const baseSha = positional.length >= 2 ? positional[0] : getFirstParentSha(headSha);

  if (!headSha) {
    console.error("Missing sha.");
    process.exitCode = 2;
    return;
  }
  if (!baseSha) {
    console.error("Could not determine base SHA (no parent?). Provide <fromSha> <toSha> explicitly.");
    process.exitCode = 2;
    return;
  }

  // SKU links from requested head commit
  const skuLinksObj = gitShowJson(headSha, skuLinksPath) || null;
  const links = skuLinksObj && Array.isArray(skuLinksObj.links) ? skuLinksObj.links : [];
  const skuMap = buildSkuMapFromLinksArray(links);

  // List DB files from both endpoints
  const filesA = gitListDbFiles(baseSha, dbDirRel);
  const filesB = gitListDbFiles(headSha, dbDirRel);
  const allFiles = new Set([...filesA, ...filesB]);

  // Build snapshots (base/head)
  const baseIdx = ensureIndex();
  const headIdx = ensureIndex();

  for (const f of [...allFiles].sort()) {
    const prevObj = filesA.has(f) ? gitShowJson(baseSha, f) : null;
    const nextObj = filesB.has(f) ? gitShowJson(headSha, f) : null;

    if (prevObj) ingestDbObject(baseIdx, prevObj, { dbPath: f, canonicalSku: skuMap.canonicalSku });
    if (nextObj) ingestDbObject(headIdx, nextObj, { dbPath: f, canonicalSku: skuMap.canonicalSku });
  }

  const cheapestNow = computeCheapest(headIdx);

  // Market indicators for acrossMarket rules
  function marketIndicators(canonSku) {
    const baseSeen = baseIdx.anySeen.has(canonSku);
    const baseIn = baseIdx.inStockStores.get(canonSku);
    const headIn = headIdx.inStockStores.get(canonSku);

    const baseInCount = baseIn ? baseIn.size : 0;
    const headInCount = headIn ? headIn.size : 0;

    // "new to market" vs "return" distinction depends on baseSeen (DB keeps removed rows)
    const marketNew = !baseSeen && headInCount > 0;
    const marketReturn = baseSeen && baseInCount === 0 && headInCount > 0;
    const marketOut = baseInCount > 0 && headInCount === 0;

    return { baseSeen, baseInCount, headInCount, marketNew, marketReturn, marketOut };
  }

  // Events (store-level), normalized over base->head
  const events = [];
  const affectedCanon = new Set();

  const storeIds = new Set([...baseIdx.byStoreCanon.keys(), ...headIdx.byStoreCanon.keys()]);
  for (const storeId of storeIds) {
    const a = baseIdx.byStoreCanon.get(storeId) || new Map();
    const b = headIdx.byStoreCanon.get(storeId) || new Map();

    const canonSkus = new Set([...a.keys(), ...b.keys()]);
    for (const canonSku of canonSkus) {
      const prev = a.get(canonSku) || null;
      const next = b.get(canonSku) || null;

      const prevSeen = Boolean(prev);
      const nextSeen = Boolean(next);

      const prevInStock = prevSeen && !prev.removed;
      const nextInStock = nextSeen && !next.removed;

      let eventType = "";
      let payload = {};

      if (!prevSeen && nextInStock) {
        eventType = "GLOBAL_NEW";
        payload = { listingUrl: next.url };
      } else if (prevSeen && prev.removed && nextInStock) {
        eventType = "GLOBAL_RETURN";
        payload = { listingUrl: next.url };
      } else if (prevInStock && !nextInStock) {
        eventType = "OUT_OF_STOCK";
        payload = { listingUrl: (prev && prev.url) || "" };
      } else if (prevInStock && nextInStock) {
        const oldN = prev.priceNum;
        const newN = next.priceNum;
        if (Number.isFinite(oldN) && Number.isFinite(newN) && newN < oldN) {
          eventType = "PRICE_DROP";
          const dropAbs = oldN - newN;
          const dropPct = oldN > 0 ? Math.round(((oldN - newN) / oldN) * 1000) / 10 : null; // 0.1 precision

          const best = cheapestNow.get(canonSku);
          const isCheapestNow =
            best &&
            Number.isFinite(best.priceNum) &&
            best.priceNum === newN &&
            best.storeIds &&
            best.storeIds.has(storeId);

          payload = {
            listingUrl: next.url,
            oldPrice: prev.price || "",
            newPrice: next.price || "",
            dropAbs: Math.round(dropAbs * 100) / 100,
            dropPct,
            isCheapestNow: Boolean(isCheapestNow),
          };
        }
      }

      if (!eventType) continue;

      const mi = marketIndicators(canonSku);
      const storeLabel =
        (next && next.storeLabel) ||
        (prev && prev.storeLabel) ||
        headIdx.storeLabelById.get(storeId) ||
        baseIdx.storeLabelById.get(storeId) ||
        storeId;

      const id = `${eventType}|${canonSku}|${storeId}`;
      const marketId = `${eventType}|${canonSku}`;

      events.push({
        id,
        marketId, // dedupe key when filters.acrossMarket === true
        eventType,
        sku: canonSku,
        storeId,
        storeLabel,
        listingUrl: payload.listingUrl || "",
        marketNew: mi.marketNew,
        marketReturn: mi.marketReturn,
        marketOut: mi.marketOut,
        baseInStockCount: mi.baseInCount,
        headInStockCount: mi.headInCount,
        ...(eventType === "PRICE_DROP" ? payload : {}),
      });

      affectedCanon.add(canonSku);
    }
  }

  // SKU context for affected SKUs only
  const skus = {};
  for (const canonSku of [...affectedCanon].sort(compareSku)) {
    const headMeta = headIdx.metaCandidatesByCanon.get(canonSku) || null;
    const baseMeta = baseIdx.metaCandidatesByCanon.get(canonSku) || null;

    const name = String((headMeta && headMeta.name) || (baseMeta && baseMeta.name) || "");
    const img = normImg((headMeta && headMeta.img) || (baseMeta && baseMeta.img) || "");

    const offersNow = offersForCanon(headIdx, canonSku, { onlyInStock: true });
    const bestNow = computeCheapest(headIdx).get(canonSku) || null;

    // Members: sku_links group + observed skuKeys (capped)
    const mem = new Set();
    for (const m of skuMap.groupMembersForCanonical(canonSku)) mem.add(m);

    const headKeys = headIdx.skuKeysByCanon.get(canonSku);
    const baseKeys = baseIdx.skuKeysByCanon.get(canonSku);
    if (headKeys) for (const k of headKeys) if (k) mem.add(k);
    if (baseKeys) for (const k of baseKeys) if (k) mem.add(k);

    const members = [...mem].filter(Boolean).sort(compareSku).slice(0, 64);

    // simple price range for rendering without re-scanning offers
    let minPriceNum = null;
    let maxPriceNum = null;
    for (const o of offersNow) {
      if (o.priceNum == null) continue;
      if (minPriceNum == null || o.priceNum < minPriceNum) minPriceNum = o.priceNum;
      if (maxPriceNum == null || o.priceNum > maxPriceNum) maxPriceNum = o.priceNum;
    }

    skus[canonSku] = {
      sku: canonSku,
      name,
      img,
      members,
      priceRangeNow: minPriceNum != null ? { min: minPriceNum, max: maxPriceNum ?? minPriceNum } : null,
      cheapestNow: bestNow
        ? { priceNum: bestNow.priceNum, storeIds: [...bestNow.storeIds].sort() }
        : null,
      offersNow: offersNow.map((o) => ({
        storeId: o.storeId,
        storeLabel: o.storeLabel,
        url: o.url,
        price: o.price,
        priceNum: o.priceNum,
      })),
    };
  }

  const pack = {
    version: 1,
    generatedAt: new Date().toISOString(),
    range: { fromSha: baseSha, toSha: headSha },
    stats: {
      skuCount: Object.keys(skus).length,
      eventCount: events.length,
      byType: events.reduce((acc, e) => {
        acc[e.eventType] = (acc[e.eventType] || 0) + 1;
        return acc;
      }, {}),
    },
    skus,
    events,
  };

  const json = JSON.stringify(pack, null, pretty ? 2 : 0) + "\n";

  if (outFile) {
    const outPath = path.isAbsolute(outFile) ? outFile : path.join(process.cwd(), outFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json, "utf8");
  } else {
    process.stdout.write(json);
  }
}

main();