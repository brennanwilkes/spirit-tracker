#!/usr/bin/env node
"use strict";

/*
  Build a report of canonical SKUs and how many STORES carry each one.
  - Store = storeLabel (union across categories).
  - Canonicalizes via sku_map.
  - Debug output while scanning.
  - Writes: reports/common_listings.json

  Flags:
    --top N
    --min-stores N
    --require-all
*/

const fs = require("fs");
const path = require("path");

/* ---------------- helpers ---------------- */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function listDbFiles() {
  const dir = path.join(process.cwd(), "data", "db");
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function priceToNumber(v) {
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function hasRealSku6(s) {
  return /\b\d{6}\b/.test(String(s || ""));
}

function isSyntheticSkuKey(k) {
  return String(k || "").startsWith("u:");
}

/* ---------------- sku helpers ---------------- */

function loadSkuMapOrNull() {
  try {
    // eslint-disable-next-line node/no-missing-require
    const { loadSkuMap } = require(path.join(process.cwd(), "src/utils/sku_map"));
    return loadSkuMap({ dbDir: path.join(process.cwd(), "data/db") });
  } catch {
    return null;
  }
}

function normalizeSkuKeyOrEmpty({ skuRaw, storeLabel, url }) {
  try {
    // eslint-disable-next-line node/no-missing-require
    const { normalizeSkuKey } = require(path.join(process.cwd(), "src/utils/sku"));
    const k = normalizeSkuKey(skuRaw, { storeLabel, url });
    return k ? String(k) : "";
  } catch {
    const m = String(skuRaw ?? "").match(/\b(\d{6})\b/);
    if (m) return m[1];
    if (url) return `u:${storeLabel}:${url}`;
    return "";
  }
}

function canonicalize(k, skuMap) {
  if (!k) return "";
  if (skuMap && typeof skuMap.canonicalSku === "function") {
    return String(skuMap.canonicalSku(k) || k);
  }
  return k;
}

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const out = { top: 50, minStores: 2, requireAll: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top" && argv[i + 1]) out.top = Number(argv[++i]) || 50;
    else if (a === "--min-stores" && argv[i + 1]) out.minStores = Number(argv[++i]) || 2;
    else if (a === "--require-all") out.requireAll = true;
  }
  return out;
}

/* ---------------- main ---------------- */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const reportsDir = path.join(repoRoot, "reports");
  ensureDir(reportsDir);

  const dbFiles = listDbFiles();
  if (!dbFiles.length) {
    console.error("No DB files found");
    process.exitCode = 2;
    return;
  }

  const skuMap = loadSkuMapOrNull();
  console.log(`[debug] skuMap: ${skuMap ? "loaded" : "missing"}`);
  console.log(`[debug] scanning ${dbFiles.length} db files`);

  const storeToCanon = new Map();     // storeLabel -> Set(canonSku)
  const canonAgg = new Map();         // canonSku -> { stores:Set, listings:[], cheapest }

  let liveRows = 0;
  let removedRows = 0;

  for (const abs of dbFiles.sort()) {
    const obj = readJson(abs);
    if (!obj) continue;

    const storeLabel = String(obj.storeLabel || obj.store || "").trim();
    if (!storeLabel) continue;

    if (!storeToCanon.has(storeLabel)) {
      storeToCanon.set(storeLabel, new Set());
    }

    const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
    const items = Array.isArray(obj.items) ? obj.items : [];

    console.log(`[debug] ${rel} store="${storeLabel}" items=${items.length}`);

    for (const it of items) {
      if (!it) continue;
      if (it.removed) {
        removedRows++;
        continue;
      }
      liveRows++;

      const skuKey = normalizeSkuKeyOrEmpty({
        skuRaw: it.sku,
        storeLabel,
        url: it.url,
      });
      if (!skuKey) continue;

      const canonSku = canonicalize(skuKey, skuMap);
      if (!canonSku) continue;

      storeToCanon.get(storeLabel).add(canonSku);

      let agg = canonAgg.get(canonSku);
      if (!agg) {
        agg = { stores: new Set(), listings: [], cheapest: null };
        canonAgg.set(canonSku, agg);
      }

      agg.stores.add(storeLabel);

      const priceNum = priceToNumber(it.price);
      const listing = {
        canonSku,
        skuKey,
        skuRaw: String(it.sku || ""),
        name: String(it.name || ""),
        price: String(it.price || ""),
        priceNum,
        url: String(it.url || ""),
        storeLabel,
        categoryLabel: String(obj.categoryLabel || obj.category || ""),
        dbFile: rel,
        hasRealSku6: hasRealSku6(it.sku) && !isSyntheticSkuKey(skuKey),
      };

      agg.listings.push(listing);

      if (priceNum !== null) {
        if (!agg.cheapest || priceNum < agg.cheapest.priceNum) {
          agg.cheapest = { priceNum, item: listing };
        }
      }
    }
  }

  const stores = [...storeToCanon.keys()].sort();
  const storeCount = stores.length;

  console.log(`[debug] stores (${storeCount}): ${stores.join(", ")}`);
  console.log(`[debug] liveRows=${liveRows} removedRows=${removedRows} canonSkus=${canonAgg.size}`);

  function pickRepresentative(agg) {
    const preferred = agg.listings
      .filter((l) => l.hasRealSku6)
      .sort((a, b) => (a.priceNum ?? Infinity) - (b.priceNum ?? Infinity));

    if (preferred.length) return preferred[0];
    if (agg.cheapest) return agg.cheapest.item;
    return agg.listings[0] || null;
  }

  const rows = [];

  for (const [canonSku, agg] of canonAgg.entries()) {
    const rep = pickRepresentative(agg);
    const missingStores = stores.filter((s) => !agg.stores.has(s));

    rows.push({
      canonSku,
      storeCount: agg.stores.size,
      stores: [...agg.stores].sort(),
      missingStores,
      representative: rep
        ? {
            name: rep.name,
            price: rep.price,
            priceNum: rep.priceNum,
            storeLabel: rep.storeLabel,
            skuRaw: rep.skuRaw,
            skuKey: rep.skuKey,
            url: rep.url,
            categoryLabel: rep.categoryLabel,
            dbFile: rep.dbFile,
          }
        : null,
      cheapest: agg.cheapest
        ? {
            price: agg.cheapest.item.price,
            priceNum: agg.cheapest.priceNum,
            storeLabel: agg.cheapest.item.storeLabel,
            url: agg.cheapest.item.url,
          }
        : null,
    });
  }

  rows.sort((a, b) => b.storeCount - a.storeCount);

  const filtered = args.requireAll
    ? rows.filter((r) => r.storeCount === storeCount)
    : rows.filter((r) => r.storeCount >= args.minStores);

  const top = filtered.slice(0, args.top);

  const payload = {
    generatedAt: new Date().toISOString(),
    args,
    storeCount,
    stores,
    totals: {
      liveRows,
      removedRows,
      canonSkus: canonAgg.size,
      outputCount: top.length,
    },
    rows: top,
  };

  const outPath = path.join(reportsDir, "common_listings.json");
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${path.relative(repoRoot, outPath)} (${top.length} rows)`);
}

main();
