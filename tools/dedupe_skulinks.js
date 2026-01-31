#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DB_DIR = path.join(__dirname, "data/db");
const LINKS_FILE = path.join(__dirname, "data/sku_links.json");

// collect all valid SKUs from db files
const validSkus = new Set();

for (const file of fs.readdirSync(DB_DIR)) {
  if (!file.endsWith(".json")) continue;
  const data = JSON.parse(fs.readFileSync(path.join(DB_DIR, file), "utf8"));
  if (!Array.isArray(data.items)) continue;
  for (const item of data.items) {
    if (item.sku) validSkus.add(String(item.sku));
  }
}

// load links
const linksData = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
const originalCount = linksData.links.length;

// keep only links where BOTH skus exist
linksData.links = linksData.links.filter(
  ({ fromSku, toSku }) =>
    validSkus.has(String(fromSku)) && validSkus.has(String(toSku))
);

// write back in place
fs.writeFileSync(
  LINKS_FILE,
  JSON.stringify(linksData, null, 2) + "\n"
);

console.log(
  `Pruned ${originalCount - linksData.links.length} invalid links`
);
