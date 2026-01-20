#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listJsonFiles(dir) {
  const out = [];
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      if (!String(ent.name || "").endsWith(".json")) continue;
      out.push(path.join(dir, ent.name));
    }
  } catch {
    // ignore
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const dbDir = path.join(repoRoot, "data", "db");
  const outDir = path.join(repoRoot, "viz", "data");
  const outFile = path.join(outDir, "index.json");

  ensureDir(outDir);

  const items = [];

  for (const file of listJsonFiles(dbDir)) {
    const obj = readJson(file);
    if (!obj) continue;

    const store = String(obj.store || "");
    const storeLabel = String(obj.storeLabel || store || "");
    const category = String(obj.category || "");
    const categoryLabel = String(obj.categoryLabel || "");
    const source = String(obj.source || "");
    const updatedAt = String(obj.updatedAt || "");

    const dbFile = path
      .relative(repoRoot, file)
      .replace(/\\/g, "/"); // for GitHub raw paths on Windows too

    const arr = Array.isArray(obj.items) ? obj.items : [];
    for (const it of arr) {
      if (!it || it.removed) continue;

      const sku = String(it.sku || "").trim();
      const name = String(it.name || "").trim();
      const price = String(it.price || "").trim();
      const url = String(it.url || "").trim();
      const img = String(it.img || it.image || it.thumb || "").trim();

      items.push({
        sku,
        name,
        price,
        url,
        img,
        store,
        storeLabel,
        category,
        categoryLabel,
        source,
        updatedAt,
        dbFile,
      });
    }
  }

  items.sort((a, b) => {
    const ak = `${a.sku}|${a.storeLabel}|${a.name}|${a.url}`;
    const bk = `${b.sku}|${b.storeLabel}|${b.name}|${b.url}`;
    return ak.localeCompare(bk);
  });

  const outObj = {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };

  fs.writeFileSync(outFile, JSON.stringify(outObj, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${path.relative(repoRoot, outFile)} (${items.length} rows)\n`);
}

module.exports = { main };

if (require.main === module) {
  main();
}
