#!/usr/bin/env node
"use strict";

/*
  Build a report of canonical SKUs and how many STORES carry each one.
  - "Store" means storeLabel, NOT category. We union across categories per store.
  - Uses sku_map canonicalization (same as alert tool).
  - Writes: reports/common_listings.json
  - Prints debug while scanning.

  Usage:
    node tools/build_common_listings.js [--top 50] [--min-stores 3] [--prefer-real-sku] [--require-all]

  Notes:
  - If --require-all is set, output includes only SKUs present in ALL stores (often empty).
  - Otherwise, outputs top N by store coverage.
*/

const fs = require("fs");
const path = require("path");

/* ---------------- helpers ---------------- */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listDbFilesOnDisk() {
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

/* ---------------- sku map + normalization ---------------- */

function loadSkuMapOrNull() {
  try {
    // eslint-disable-next-line node/no-missing-require
    const { loadSkuMap } = require(path.join(process.cwd(), "src", "utils", "sku_map"));
    return loadSkuMap({ dbDir: path.join(process.cwd(), "data", "db") });
  } catch {
    return null;
  }
}

function normalizeSkuKeyOrEmpty({ skuRaw, storeLabel, url }) {
  try {
    // eslint-disable-next-line node/no-missing-require
    const { normalizeSkuKey } = require(path.join(process.cwd(), "src", "utils", "sku"));
    const k = normalizeSkuKey(skuRaw, { storeLabel, url });
    return k ? String(k) : "";
  } catch {
    // fallback: a 6-digit SKU if present, else synthetic from URL
    const m = String(skuRaw ?? "").match(/\b(\d{6})\b/);
    if (m) return m[1];
    if (url) return `u:${String(storeLabel || "").toLowerCase()}:${String(url || "").toLowerCase()}`;
    return "";
  }
}

function canonicalize(skuKey, skuMap) {
  if (!skuKey) return "";
  if (skuMap && typeof skuMap.canonicalSku === "function") return String(skuMap.canonicalSku(skuKey) || skuKey);
  return skuKey;
}

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const out = {
    top: 50,
    minStores: 2,
    preferRealSku: true,
    requireAll: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top" && argv[i + 1]) out.top = Math.max(1, Number(argv[++i]) || 50);
    else if (a === "--min-stores" && argv[i + 1]) out.minStores = Math.max(1, Number(argv[++i]) || 2);
    else if (a === "--prefer-real-sku") out.preferRealSku = true;
    else if (a === "--no-prefer-real-sku") out.preferRealSku = false;
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

  const dbFiles = listDbFilesOnDisk();
  if (!dbFiles.length) {
    console.error("No DB files found under data/db");
    process.exitCode = 2;
    return;
  }

  const skuMap = loadSkuMapOrNull();
  console.log(`[debug] skuMap: ${skuMap ? "loaded" : "NOT loaded (will use raw sku keys)"}`);
  console.log(`[debug] scanning ${dbFiles.length} db files...`);

  // storeLabel -> Set(canonSku) (union across categories)
  const storeToCanon = new Map();

  // canonSku -> aggregate
  const canonAgg = new Map(); // canonSku -> { stores:Set, listings:[], cheapest:{priceNum,item}|null }

  const EXCLUDED_STORE_LABELS = new Set(["gull", "legacy", "strath", "vessel", "tudor"]);

  let liveRows = 0;
  let removedRows = 0;
  let skippedNoSku = 0;

  for (const abs of dbFiles.sort()) {
    const obj = readJson(abs);
    if (!obj) {
      console.log(`[debug] skip unreadable: ${path.relative(repoRoot, abs)}`);
      continue;
    }

    const storeLabel = String(obj.storeLabel || obj.store || "").trim();
    const categoryLabel = String(obj.categoryLabel || obj.category || "").trim();
    const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");

    if (!storeLabel) {
      console.log(`[debug] skip no-storeLabel: ${rel}`);
      continue;
    }

    if (!storeToCanon.has(storeLabel)) storeToCanon.set(storeLabel, new Set());

    const items = Array.isArray(obj.items) ? obj.items : [];
    console.log(`[debug] file ${rel} | store="${storeLabel}" cat="${categoryLabel}" items=${items.length}`);

    for (const it of items) {
      if (!it) continue;
      if (Boolean(it.removed)) {
        removedRows++;
        continue;
      }
      liveRows++;

      const skuRaw = String(it.sku || "");
      const url = String(it.url || "");
      const skuKey = normalizeSkuKeyOrEmpty({ skuRaw, storeLabel, url });
      if (!skuKey) {
        skippedNoSku++;
        continue;
      }
      const canonSku = canonicalize(skuKey, skuMap);
      if (!canonSku) {
        skippedNoSku++;
        continue;
      }

      storeToCanon.get(storeLabel).add(canonSku);

      let agg = canonAgg.get(canonSku);
      if (!agg) {
        agg = { stores: new Set(), listings: [], cheapest: null };
        canonAgg.set(canonSku, agg);
      }
      agg.stores.add(storeLabel);

      const priceStr = String(it.price || "");
      const priceNum = priceToNumber(priceStr);

      const listing = {
        canonSku,
        skuKey,
        skuRaw,
        name: String(it.name || ""),
        price: priceStr,
        priceNum,
        url,
        img: String(it.img || it.image || it.thumb || ""),
        storeLabel,
        categoryLabel,
        dbFile: rel,
        hasRealSku6: hasRealSku6(skuRaw) && !isSyntheticSkuKey(skuKey),
        excludedStore: EXCLUDED_STORE_LABELS.has(String(storeLabel || "").toLowerCase()),
      };

      agg.listings.push(listing);

      if (priceNum !== null) {
        if (!agg.cheapest || priceNum < agg.cheapest.priceNum) {
          agg.cheapest = { priceNum, item: listing };
        }
      }
    }
  }

  const stores = [...storeToCanon.keys()].sort((a, b) => a.localeCompare(b));
  const storeCount = stores.length;

  console.log(`[debug] stores=${storeCount} (${stores.join(", ")})`);
  console.log(
    `[debug] liveRows=${liveRows} removedRows=${removedRows} skippedNoSku=${skippedNoSku} canonSkus=${canonAgg.size}`
  );

  function pickRepresentative(agg) {
    // prefer: real 6-digit + non-excluded store + cheapest among those
    const candidates = agg.listings.slice();

    const byPrice = (a, b) => {
      const ap = a.priceNum;
      const bp = b.priceNum;
      if (ap === null && bp === null) return 0;
      if (ap === null) return 1;
      if (bp === null) return -1;
      return ap - bp;
    };

    const preferred = candidates
      .filter((x) => x.hasRealSku6 && !x.excludedStore)
      .sort(byPrice);

    if (args.preferRealSku && preferred.length) return preferred[0];

    // else: cheapest overall if available
    if (agg.cheapest && agg.cheapest.item) return agg.cheapest.item;

    // else: deterministic fallback
    candidates.sort((a, b) => {
      const ak = `${a.storeLabel}|${a.name}|${a.url}`;
      const bk = `${b.storeLabel}|${b.name}|${b.url}`;
      return ak.localeCompare(bk);
    });
    return candidates[0] || null;
  }

  const rows = [];
  for (const [canonSku, agg] of canonAgg.entries()) {
    const rep = pickRepresentative(agg);
    rows.push({
      canonSku,
      storeCount: agg.stores.size,
      stores: [...agg.stores].sort((a, b) => a.localeCompare(b)),
      representative: rep
        ? {
            name: rep.name,
            price: rep.price,
            priceNum: rep.priceNum,
            storeLabel: rep.storeLabel,
            skuRaw: rep.skuRaw,
            skuKey: rep.skuKey,
            url: rep.url,
            dbFile: rep.dbFile,
            categoryLabel: rep.categoryLabel,
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

  // Sort by coverage desc, then cheapest asc, then canonSku
  rows.sort((a, b) => {
    if (b.storeCount !== a.storeCount) return b.storeCount - a.storeCount;
    const ap = a.cheapest ? a.cheapest.priceNum : null;
    const bp = b.cheapest ? b.cheapest.priceNum : null;
    if (ap !== null && bp !== null && ap !== bp) return ap - bp;
    if (ap !== null && bp === null) return -1;
    if (ap === null && bp !== null) return 1;
    return String(a.canonSku).localeCompare(String(b.canonSku));
  });

  const allStoresRows = rows.filter((r) => r.storeCount === storeCount);
  const filtered = args.requireAll ? allStoresRows : rows.filter((r) => r.storeCount >= args.minStores);
  const top = filtered.slice(0, args.top);

  console.log(
    `[debug] all-stores=${allStoresRows.length} minStores>=${args.minStores} filtered=${filtered.length} top=${top.length}`
  );
  if (top.length) {
    console.log("[debug] sample:");
    for (const r of top.slice(0, Math.min(10, top.length))) {
      const rep = r.representative;
      console.log(
        `  - stores=${r.storeCount}/${storeCount} canon=${r.canonSku} | rep="${rep?.name || "?"}" ${rep?.price || ""} @ ${rep?.storeLabel || "?"}`
      );
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    args,
    storeCount,
    stores,
    totals: {
      liveRows,
      removedRows,
      skippedNoSku,
      canonSkus: canonAgg.size,
      allStores: allStoresRows.length,
      outputCount: top.length,
    },
    rows: top,
  };

  const outPath = path.join(reportsDir, "common_listings.json");
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${path.relative(repoRoot, outPath)} (${top.length} rows)`);
}

main();
