#!/usr/bin/env node
"use strict";

/*
  Print local link URLs for SKUs with largest rank discrepancy between AB and BC lists.

  Usage:
    node scripts/rank_discrepency_links.js \
      --ab reports/common_listings_ab_top1000.json \
      --bc reports/common_listings_bc_top1000.json \
      --top 50 \
      --base "http://127.0.0.1:8080/#/link/?left="

  Output:
    http://127.0.0.1:8080/#/link/?left=<urlencoded canonSku>
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
    minDiscrep: 1,
    includeMissing: false,
    base: "http://127.0.0.1:8080/#/link/?left=",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ab" && argv[i + 1]) out.ab = argv[++i];
    else if (a === "--bc" && argv[i + 1]) out.bc = argv[++i];
    else if (a === "--top" && argv[i + 1]) out.top = Number(argv[++i]) || out.top;
    else if (a === "--min" && argv[i + 1]) out.minDiscrep = Number(argv[++i]) || out.minDiscrep;
    else if (a === "--include-missing") out.includeMissing = true;
    else if (a === "--base" && argv[i + 1]) out.base = String(argv[++i] || out.base);
  }
  return out;
}

function buildRankMap(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const k = r?.canonSku;
    if (!k) continue;
    map.set(String(k), { rank: i + 1, row: r });
  }
  return map;
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

    diffs.push({
      canonSku,
      discrep,
      // tie-breakers
      sumRank: (rankAB ?? 1e9) + (rankBC ?? 1e9),
    });
  }

  diffs.sort((x, y) => {
    if (y.discrep !== x.discrep) return y.discrep - x.discrep;
    if (x.sumRank !== y.sumRank) return x.sumRank - y.sumRank;
    return String(x.canonSku).localeCompare(String(y.canonSku));
  });

  const top = diffs.slice(0, args.top);

  for (const d of top) {
    // examples:
    // 884096 -> left=884096
    // id:1049355 -> left=id%3A1049355
    // u:bb504a62 -> left=u%3Abb504a62
    console.log(args.base + encodeURIComponent(d.canonSku));
  }
}

main();
