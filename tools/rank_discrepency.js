#!/usr/bin/env node
"use strict";

/*
  Compare rank placement between AB and BC "common_listings_*_top*.json" reports.

  Usage:
    node scripts/rank_discrepency.js \
      --ab reports/common_listings_ab_top1000.json \
      --bc reports/common_listings_bc_top1000.json \
      --top 50

  Notes:
  - Rank = index in payload.rows (1-based).
  - Only compares SKUs that exist in BOTH files (unless --include-missing).
*/

const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function parseArgs(argv) {
  const out = {
    ab: "reports/common_listings_ab_top1000.json",
    bc: "reports/common_listings_bc_top1000.json",
    top: 50,
    includeMissing: false,
    minDiscrep: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ab" && argv[i + 1]) out.ab = argv[++i];
    else if (a === "--bc" && argv[i + 1]) out.bc = argv[++i];
    else if (a === "--top" && argv[i + 1]) out.top = Number(argv[++i]) || out.top;
    else if (a === "--min" && argv[i + 1]) out.minDiscrep = Number(argv[++i]) || out.minDiscrep;
    else if (a === "--include-missing") out.includeMissing = true;
  }
  return out;
}

function buildRankMap(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.canonSku) continue;
    map.set(String(r.canonSku), { rank: i + 1, row: r });
  }
  return map;
}

function fmtMoney(n) {
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();

  const abPath = path.isAbsolute(args.ab) ? args.ab : path.join(repoRoot, args.ab);
  const bcPath = path.isAbsolute(args.bc) ? args.bc : path.join(repoRoot, args.bc);

  const ab = readJson(abPath);
  const bc = readJson(bcPath);

  const abMap = buildRankMap(ab);
  const bcMap = buildRankMap(bc);

  const keys = new Set([...abMap.keys(), ...bcMap.keys()]);
  const diffs = [];

  for (const canonSku of keys) {
    const a = abMap.get(canonSku);
    const b = bcMap.get(canonSku);

    if (!args.includeMissing && (!a || !b)) continue;

    const rankAB = a ? a.rank : null;
    const rankBC = b ? b.rank : null;

    const discrep =
      rankAB !== null && rankBC !== null ? Math.abs(rankAB - rankBC) : Infinity;

    if (discrep !== Infinity && discrep < args.minDiscrep) continue;

    const rep = (a?.row?.representative || b?.row?.representative) ?? null;
    const name = rep?.name || "";
    const priceNum = rep?.priceNum;
    const url = rep?.url || "";

    diffs.push({
      canonSku,
      discrep,
      rankAB,
      rankBC,
      storeCountAB: a?.row?.storeCount ?? null,
      storeCountBC: b?.row?.storeCount ?? null,
      name,
      price: fmtMoney(priceNum),
      url,
    });
  }

  diffs.sort((x, y) => {
    if (y.discrep !== x.discrep) return y.discrep - x.discrep;
    // tie-breaker: best average rank (smaller is "higher")
    const ax = (x.rankAB ?? 1e9) + (x.rankBC ?? 1e9);
    const ay = (y.rankAB ?? 1e9) + (y.rankBC ?? 1e9);
    if (ax !== ay) return ax - ay;
    return String(x.canonSku).localeCompare(String(y.canonSku));
  });

  const top = diffs.slice(0, args.top);

  console.log(
    `AB: ${path.relative(repoRoot, abPath)} (rows=${ab?.rows?.length ?? 0})`
  );
  console.log(
    `BC: ${path.relative(repoRoot, bcPath)} (rows=${bc?.rows?.length ?? 0})`
  );
  console.log(
    `Showing top ${top.length} by |rankAB-rankBC| (min=${args.minDiscrep})\n`
  );

  for (const d of top) {
    const ra = d.rankAB === null ? "—" : String(d.rankAB);
    const rb = d.rankBC === null ? "—" : String(d.rankBC);
    const sca = d.storeCountAB === null ? "—" : String(d.storeCountAB);
    const scb = d.storeCountBC === null ? "—" : String(d.storeCountBC);

    console.log(
      [
        `Δ=${d.discrep}`,
        `AB#${ra} (stores=${sca})`,
        `BC#${rb} (stores=${scb})`,
        `sku=${d.canonSku}`,
        d.price ? `rep=${d.price}` : "",
        d.name ? `name="${d.name.replace(/\s+/g, " ").trim().slice(0, 120)}"` : "",
      ]
        .filter(Boolean)
        .join(" | ")
    );
    if (d.url) console.log(`  ${d.url}`);
  }
}

main();
