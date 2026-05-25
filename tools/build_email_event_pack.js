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

const skuHistoryCache = new Map();
function loadSkuHistory(canonSku) {
  if (skuHistoryCache.has(canonSku)) return skuHistoryCache.get(canonSku);
  const p = path.join(process.cwd(), "viz/data/skus", `${canonSku}.json`);
  let obj = null;
  try {
    const txt = fs.readFileSync(p, "utf8");
    obj = JSON.parse(txt);
  } catch {
    obj = null;
  }
  skuHistoryCache.set(canonSku, obj);
  return obj;
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

/* ---------------- SKU map (shared utilities) ---------------- */

const {
  normalizeImplicitSkuKey,
  buildGroupsAndCanonicalMap,
  compareSku,
} = require("../src/utils/sku_canonical");

const { isHiddenListing } = require("../src/utils/sku_hidden");

// Load the precomputed rarity snapshot built by tools/build_viz_rarity.js. The
// pack will embed rarity + tier per event so the email HTML can style rare /
// staple items consistently with the viz app.
function loadRaritySnapshot() {
  const candidates = [
    path.join(process.cwd(), "viz", "data", "rarity.json"),
    path.join(process.cwd(), ".worktrees", "data", "viz", "data", "rarity.json"),
  ];
  for (const f of candidates) {
    try {
      const obj = JSON.parse(fs.readFileSync(f, "utf8"));
      if (obj && obj.byCanon) return obj;
    } catch {}
  }
  return null;
}

function buildSkuMapFromLinksArray(links) {
  const { canonBySku, groupsByCanon } = buildGroupsAndCanonicalMap(links);

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

function categoryFromDbPath(p) {
  const base = path.posix.basename(p);
  const parts = base.split("__");
  return (parts[1] || "").trim();
}

const CATEGORY_TO_TYPES = {
  "rum": ["rum"], "rum-cane-spirit": ["rum"], "spirits-rum": ["rum"],
  "whisky": ["whisky"], "whisky-whiskey": ["whisky"], "spirits-whiskey": ["whisky"],
  "american-whiskey": ["whisky"], "bourbon-whiskey": ["whisky"], "canadian-whisky": ["whisky"],
  "canadian-whiskey": ["whisky"], "irish-whiskey": ["whisky"],
  "world-whisky": ["whisky"], "scotch": ["whisky"], "scotch-whisky": ["whisky"],
  "scotch-whisky-single-malt": ["whisky"],
  "scotch-selections": ["whisky"], "scottish-blends": ["whisky"],
  "scottish-single-malts": ["whisky"], "single-malt-whisky": ["whisky"],
  "spirits-scotch": ["whisky"], "whiskey-scotch": ["whisky"],
  "gin": ["gin"], "spirits-gin": ["gin"],
  "spirits-liquor": ["rum", "whisky"],
  "all-minus-gin-tequila-mezcal": ["rum", "whisky"],
  "fine-rare": ["whisky"],
  "other": ["whisky"],
  // sierrasprings "spirits": unfiltered catch-all. Resolved per-item by URL
  // slug in resolveItemSpiritTypes(); value here is unused.
  "spirits": [],
};

function categoryToSpiritTypes(categoryKey) {
  const k = String(categoryKey || "").toLowerCase().trim();
  return CATEGORY_TO_TYPES[k] || null;
}

const _RUM_FINISH = /\b(rum|rhum)\b.{0,25}\b(cask|finish|fnsh|barrel|barrique)\b/i;
const _RUM = /\b(rum|rhum)\b/i;
const _WHISKY_CO = /\b(whisk(?:e)?y|scotch|single malt|blended malt|bourbon|rye|peated|islay|speyside|highland|lowland|campbeltown|irish|japanese)\b/i;
const _RUM_BRANDS = /\b(appleton|mount gay|doorly'?s|foursquare|worthy park|hampden|long pond|river antoine|clairin|angostura|paranubes|el dorado|diplomatico|zacapa|plantation|planteray|velier|rum sponge)\b/i;

function resolveItemSpiritTypes(categoryKey, url, name) {
  const k = String(categoryKey || "").toLowerCase().trim();

  if (k === "all-minus-gin-tequila-mezcal") {
    const t = `${String(name || "")} ${String(url || "")}`.toLowerCase();
    const hasRum      = _RUM.test(t) || _RUM_BRANDS.test(t);
    const hasRumFinish = _RUM_FINISH.test(t);
    const hasWhiskyCo  = _WHISKY_CO.test(t);
    const rumFinishOnly = hasRum && hasRumFinish && hasWhiskyCo;
    return (hasRum && !rumFinishOnly) ? ["rum"] : ["whisky"];
  }
  if (k === "spirits") {
    const u = String(url || "").toLowerCase();
    const m = u.match(/\/shop\/spirits\/([^/]+)\//);
    const slug = m ? m[1] : "";
    if (!slug) return null;
    if (/^rum\b|^rum-/.test(slug)) return ["rum"];
    if (/^gin\b|^gin-/.test(slug)) return ["gin"];
    if (/whisky|whiskey|scotch/.test(slug)) return ["whisky"];
    return null;
  }
  if (k === "spirits-liquor") {
    const u = String(url || "").toLowerCase();
    const hasRum    = /\brum\b/.test(u);
    const hasWhisky = /\bwhisk/.test(u);
    if (hasRum && !hasWhisky) return ["rum"];
    if (hasWhisky && !hasRum) return ["whisky"];
    return ["rum", "whisky"];
  }
  return categoryToSpiritTypes(k);
}

const TYPE_ORDER = ["rum", "whisky", "gin"];

function sortedSpiritTypes(typeSet) {
  return TYPE_ORDER.filter((t) => typeSet.has(t));
}

function ensureIndex() {
  return {
    byStoreCanon: new Map(), // storeId -> Map(canonSku -> listing)
    anySeen: new Set(), // canonSku seen at least once (removed or not)
    inStockStores: new Map(), // canonSku -> Set(storeId) (removed=false)
    storeLabelById: new Map(), // storeId -> storeLabel
    skuKeysByCanon: new Map(), // canonSku -> Set(skuKey)
    spiritTypesByCanon: new Map(), // canonSku -> Set(spiritType)
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

  if (it.spiritTypes) {
    if (!idx.spiritTypesByCanon.has(it.canonSku)) idx.spiritTypesByCanon.set(it.canonSku, new Set());
    const ts = idx.spiritTypesByCanon.get(it.canonSku);
    for (const t of it.spiritTypes) ts.add(t);
  }

  if (!it.removed) {
    if (!idx.inStockStores.has(it.canonSku)) idx.inStockStores.set(it.canonSku, new Set());
    idx.inStockStores.get(it.canonSku).add(it.storeId);
  }

  const prev = idx.metaCandidatesByCanon.get(it.canonSku);
  const better = pickBetterListing(prev, it);
  idx.metaCandidatesByCanon.set(it.canonSku, better);
}

function ingestDbObject(idx, obj, { dbPath, canonicalSku, hiddenSet }) {
  if (!obj || typeof obj !== "object") return;

  const storeId = storeIdFromDbPath(dbPath);
  const storeLabel = String(obj.storeLabel || obj.store || storeId);
  const dbCategory = categoryFromDbPath(dbPath);

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

    // Hide raw store listings flagged in data/sku_hidden.json. Filtering here
    // (before the row enters the index) cleanly removes the listing from every
    // downstream surface: event detection, offers, cheapest-price, members.
    if (hiddenSet && hiddenSet.size > 0) {
      const rawSku = String(row.sku || "").trim();
      if (rawSku && isHiddenListing(hiddenSet, storeId, rawSku)) continue;
      if (isHiddenListing(hiddenSet, storeId, skuKey)) continue;
    }

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
      spiritTypes: resolveItemSpiritTypes(dbCategory, url, name),
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

  // Commit timestamps used for 24h flip-flop suppression window.
  // We look back 24h from head, but cap the upper bound at baseTimeMs so the
  // head commit's own scrape (whose ts < headTimeMs but >= baseTimeMs) can't
  // match itself.
  function commitTimeMs(sha) {
    try {
      const iso = runGit(["show", "-s", "--format=%cI", sha]);
      const parsed = Date.parse(iso);
      return Number.isFinite(parsed) ? parsed : Date.now();
    } catch {
      return Date.now();
    }
  }
  const headTimeMs = commitTimeMs(headSha);
  const baseTimeMs = commitTimeMs(baseSha);

  // SKU links from requested head commit
  const skuLinksObj = gitShowJson(headSha, skuLinksPath) || null;
  const links = skuLinksObj && Array.isArray(skuLinksObj.links) ? skuLinksObj.links : [];
  const skuMap = buildSkuMapFromLinksArray(links);

  // Curated hidden listings (data/sku_hidden.json on the head commit).
  // We pull from git rather than disk so the pack is reproducible from a sha.
  const hiddenObj = gitShowJson(headSha, "data/sku_hidden.json") || null;
  const hiddenSet = new Set();
  if (hiddenObj && Array.isArray(hiddenObj.hidden)) {
    for (const e of hiddenObj.hidden) {
      const sid = String(e?.storeId || "").trim();
      const sku = String(e?.sku || "").trim();
      if (sid && sku) hiddenSet.add(`${sid}|${sku}`);
    }
  }

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

    if (prevObj) ingestDbObject(baseIdx, prevObj, { dbPath: f, canonicalSku: skuMap.canonicalSku, hiddenSet });
    if (nextObj) ingestDbObject(headIdx, nextObj, { dbPath: f, canonicalSku: skuMap.canonicalSku, hiddenSet });
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

  // 24h flip-flop suppression: returns true if a transition of the same kind
  // (and, for price drops, to an equal-or-lower price) already fired for this
  // (sku, store) pair within the prior 24 hours. We walk consecutive pairs in
  // the SKU history cache and detect transitions, not just states.
  const WINDOW_MS = 48 * 60 * 60 * 1000;
  function isFlipFlop(ev) {
    if (ev.eventType === "GLOBAL_NEW") return false;
    const prefix = `data/db/${ev.storeId}__`;
    const newN = ev.eventType === "PRICE_DROP" ? priceToNumber(ev.newPrice) : NaN;
    if (ev.eventType === "PRICE_DROP" && !Number.isFinite(newN)) return false;

    // The pack's canonical sku may differ from the raw sku used at this store,
    // and per-SKU cache files are keyed by raw sku. Probe every raw sku that
    // links to this canonical group, plus any sku keys observed at base/head.
    const candidates = new Set([ev.sku]);
    for (const m of skuMap.groupMembersForCanonical(ev.sku)) if (m) candidates.add(m);
    const hk = headIdx.skuKeysByCanon.get(ev.sku);
    if (hk) for (const k of hk) if (k) candidates.add(k);
    const bk = baseIdx.skuKeysByCanon.get(ev.sku);
    if (bk) for (const k of bk) if (k) candidates.add(k);

    for (const rawSku of candidates) {
      const hist = loadSkuHistory(rawSku);
      if (!hist || !hist.stores) continue;
      for (const [key, entry] of Object.entries(hist.stores)) {
        if (!key.startsWith(prefix)) continue;
        const list = entry && Array.isArray(entry.events) ? entry.events : [];
        for (let i = 1; i < list.length; i++) {
          const prev = list[i - 1];
          const cur = list[i];
          const ts = Date.parse(cur.ts);
          if (!Number.isFinite(ts)) continue;
          if (ts >= baseTimeMs) continue;
          if (ts < headTimeMs - WINDOW_MS) continue;

          const prevIn = prev.p != null;
          const curIn = cur.p != null;

          if (ev.eventType === "OUT_OF_STOCK") {
            if (prevIn && !curIn) return true;
          } else if (ev.eventType === "GLOBAL_RETURN") {
            if (!prevIn && curIn) return true;
          } else if (ev.eventType === "PRICE_DROP") {
            if (prevIn && curIn) {
              const oldN = priceToNumber(prev.p);
              const curN = priceToNumber(cur.p);
              if (Number.isFinite(oldN) && Number.isFinite(curN) && curN < oldN && curN <= newN) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  }

  // Events (store-level), normalized over base->head
  const events = [];
  const affectedCanon = new Set();
  let suppressedCount = 0;
  const suppressedByType = {};

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
        payload = { listingUrl: next.url, newPrice: next.price || "" };
      } else if (prevSeen && prev.removed && nextInStock) {
        eventType = "GLOBAL_RETURN";
        payload = { listingUrl: next.url, newPrice: next.price || "" };
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

      const eventObj = {
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
        ...payload
      };

      if (isFlipFlop(eventObj)) {
        suppressedCount++;
        suppressedByType[eventType] = (suppressedByType[eventType] || 0) + 1;
        continue;
      }

      events.push(eventObj);
      affectedCanon.add(canonSku);
    }
  }

  // Annotate every event with the canonical's current rarity (0..1). The
  // renderer decides how to interpret the number — thresholds, tier names,
  // and any visual treatment all live with the consumer, not in the pack.
  const raritySnap = loadRaritySnapshot();
  if (raritySnap) {
    for (const e of events) {
      const entry = raritySnap.byCanon?.[e.sku];
      if (!entry) continue;
      e.rarity = entry.r;
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

    const headTypes = headIdx.spiritTypesByCanon.get(canonSku);
    const baseTypes = baseIdx.spiritTypesByCanon.get(canonSku);
    const allTypes = new Set([...(headTypes || []), ...(baseTypes || [])]);
    const spiritTypes = sortedSpiritTypes(allTypes);

    skus[canonSku] = {
      sku: canonSku,
      name,
      img,
      members,
      ...(spiritTypes.length ? { spiritTypes } : {}),
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
      suppressedCount,
      suppressedByType,
    },
    // Rarity context for the email renderer: thresholds so the renderer can
    // group/show events by tier, and a hint at the color tokens to keep email
    // styling visually consistent with the viz app. Tokens mirror the CSS in
    // viz/style.css (--rarity-*-border / --rarity-*-glow).
    ...(raritySnap && raritySnap.thresholds
      ? { rarityThresholds: { stapleMax: raritySnap.thresholds.stapleMax, rareMin: raritySnap.thresholds.rareMin } }
      : {}),
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