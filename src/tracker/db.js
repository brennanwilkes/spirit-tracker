"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { normalizeSkuKey } = require("../utils/sku");
const { priceToNumber } = require("../utils/price");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function dbPathFor(key, baseUrl, dbDir) {
  ensureDir(dbDir);
  const hash = crypto.createHash("sha1").update(String(baseUrl)).digest("hex").slice(0, 8);
  const safeKey = String(key).replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.join(dbDir, `${safeKey}__${hash}.json`);
}

function readDb(file) {
  const byUrl = new Map();
  try {
    const txt = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(txt);
    if (obj && Array.isArray(obj.items)) {
      for (const it of obj.items) {
        if (it && typeof it.url === "string" && it.url.startsWith("http")) {
          byUrl.set(it.url, {
            name: String(it.name || ""),
            price: String(it.price || ""),
            sku: String(it.sku || ""),
            url: it.url,
            img: String(it.img || it.image || it.thumb || "").trim(),
            removed: Boolean(it.removed),
          });
        }
      }
    }
  } catch {
    // ignore missing or parse errors
  }
  return { byUrl };
}

function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function buildDbObject(ctx, merged) {
  const storeLabel = ctx?.store?.name || ctx?.store?.host || "";

  return {
    version: 6,
    store: ctx.store.host,
    storeLabel: ctx.store.name,
    category: ctx.cat.key,
    categoryLabel: ctx.cat.label,
    source: ctx.baseUrl,
    updatedAt: new Date().toISOString(),
    count: merged.size,
    items: [...merged.values()]
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map((it) => ({
        name: it.name,
        price: it.price || "",
        // IMPORTANT: keep real 6-digit when present; otherwise store stable u:hash(store|url)
        sku: normalizeSkuKey(it.sku, { storeLabel, url: it.url }) || "",
        url: it.url,
        img: String(it.img || "").trim(),
        removed: Boolean(it.removed),
      })),
  };
}

function listDbFiles(dbDir) {
  const out = [];
  try {
    for (const ent of fs.readdirSync(dbDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const name = ent.name || "";
      if (!name.endsWith(".json")) continue;
      out.push(path.join(dbDir, name));
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * cheapest map is keyed by CANONICAL sku (for report comparisons),
 * but DB rows remain raw/mined skuKey.
 */
function buildCheapestSkuIndexFromAllDbs(dbDir, { skuMap } = {}) {
  const cheapest = new Map(); // canonSku -> { storeLabel, priceNum }

  for (const file of listDbFiles(dbDir)) {
    try {
      const obj = JSON.parse(fs.readFileSync(file, "utf8"));
      const storeLabel = String(obj?.storeLabel || obj?.store || "");
      const items = Array.isArray(obj?.items) ? obj.items : [];

      for (const it of items) {
        if (it?.removed) continue;

        const skuKey = normalizeSkuKey(it?.sku || "", { storeLabel, url: it?.url || "" });
        if (!skuKey) continue;

        const canon = skuMap && typeof skuMap.canonicalSku === "function" ? skuMap.canonicalSku(skuKey) : skuKey;

        const p = priceToNumber(it?.price || "");
        if (!Number.isFinite(p) || p <= 0) continue;

        const prev = cheapest.get(canon);
        if (!prev || p < prev.priceNum) cheapest.set(canon, { storeLabel, priceNum: p });
      }
    } catch {
      // ignore parse errors
    }
  }

  return cheapest;
}

module.exports = {
  ensureDir,
  dbPathFor,
  readDb,
  writeJsonAtomic,
  buildDbObject,
  listDbFiles,
  buildCheapestSkuIndexFromAllDbs,
};
