#!/usr/bin/env node
"use strict";

/*
  Rank discrepancy links, filtered by existence of a high-similarity "other" listing.

  Debug is verbose and goes to STDERR so STDOUT stays as emitted links.

  Examples:
    node ./tools/rank_discrepency.js --debug --debug-payload
    node ./tools/rank_discrepency.js --min-score 0.2 --debug
    node ./tools/rank_discrepency.js --name-field "product.title" --debug
*/

const fs = require("fs");
const path = require("path");

/* ---------------- IO ---------------- */

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function parseArgs(argv) {
  const out = {
    ab: "reports/common_listings_ab_top1000.json",
    bc: "reports/common_listings_bc_top1000.json",
    meta: "",

    top: 50,
    minDiscrep: 1,
    includeMissing: false,

    minScore: 0.75,
    base: "http://127.0.0.1:8080/#/link/?left=",

    // name picking
    nameField: "", // optional dotted path override, e.g. "product.title"

    // debug
    debug: false,
    debugN: 25,
    debugPayload: false,
    dumpScores: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ab" && argv[i + 1]) out.ab = argv[++i];
    else if (a === "--bc" && argv[i + 1]) out.bc = argv[++i];
    else if (a === "--meta" && argv[i + 1]) out.meta = argv[++i];

    else if (a === "--top" && argv[i + 1]) out.top = Number(argv[++i]) || out.top;
    else if (a === "--min" && argv[i + 1]) out.minDiscrep = Number(argv[++i]) || out.minDiscrep;
    else if (a === "--min-score" && argv[i + 1]) out.minScore = Number(argv[++i]) || out.minScore;
    else if (a === "--include-missing") out.includeMissing = true;
    else if (a === "--base" && argv[i + 1]) out.base = String(argv[++i] || out.base);

    else if (a === "--name-field" && argv[i + 1]) out.nameField = String(argv[++i] || "");
    else if (a === "--debug") out.debug = true;
    else if (a === "--debug-n" && argv[i + 1]) out.debugN = Number(argv[++i]) || out.debugN;
    else if (a === "--debug-payload") out.debugPayload = true;
    else if (a === "--dump-scores") out.dumpScores = true;
  }

  return out;
}

/* ---------------- row extraction ---------------- */

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;

  const candidates = [
    payload?.rows,
    payload?.data?.rows,
    payload?.data,
    payload?.items,
    payload?.list,
    payload?.results,
  ];
  for (const x of candidates) if (Array.isArray(x)) return x;

  return [];
}

function rowKey(r) {
  const k = r?.canonSku ?? r?.sku ?? r?.canon ?? r?.id ?? r?.key;
  return k ? String(k) : "";
}

function buildRankMap(payload) {
  const rows = extractRows(payload);
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const k = rowKey(r);
    if (!k) continue;
    map.set(String(k), { rank: i + 1, row: r });
  }
  return { map, rowsLen: rows.length, rows };
}

/* ---------------- name picking ---------------- */

function getByPath(obj, dotted) {
  if (!obj || !dotted) return undefined;
  const parts = String(dotted).split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function pickFirstString(obj, paths) {
  for (const p of paths) {
    const v = getByPath(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// Tries hard to find a display name in common listing rows.
// Your debug showed `name: ''` for top discrepancies, so the field is elsewhere.
function pickName(row, nameFieldOverride) {
  if (!row) return "";

  if (nameFieldOverride) {
    const forced = getByPath(row, nameFieldOverride);
    if (typeof forced === "string" && forced.trim()) return forced.trim();
  }

  // Common direct fields
  const direct = [
    "name",
    "title",
    "productName",
    "displayName",
    "itemName",
    "label",
    "desc",
    "description",
    "query",
  ];
  for (const k of direct) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  // Common nested patterns used in listing aggregations
  const nested = [
    "product.name",
    "product.title",
    "product.displayName",
    "item.name",
    "item.title",
    "listing.name",
    "listing.title",
    "canon.name",
    "canon.title",
    "best.name",
    "best.title",
    "top.name",
    "top.title",
    "meta.name",
    "meta.title",
    "agg.name",
    "agg.title",
  ];
  const got = pickFirstString(row, nested);
  if (got) return got;

  // If rows have a "bestRow" or "example" child object, probe that too
  const children = ["bestRow", "example", "sample", "row", "source", "picked", "winner"];
  for (const c of children) {
    const child = row[c];
    if (child && typeof child === "object") {
      const g2 = pickName(child, "");
      if (g2) return g2;
    }
  }

  // Last resort: sometimes there is an array like `listings` or `rows` with objects containing name/title
  const arrays = ["listings", "sources", "items", "matches"];
  for (const a of arrays) {
    const arr = row[a];
    if (Array.isArray(arr) && arr.length) {
      for (let i = 0; i < Math.min(arr.length, 5); i++) {
        const g3 = pickName(arr[i], "");
        if (g3) return g3;
      }
    }
  }

  return "";
}

/* ---------------- sku_meta grouping (optional) ---------------- */

function normalizeImplicitSkuKey(k) {
  const s = String(k || "").trim();
  const m = s.match(/^id:(\d{1,6})$/i);
  if (m) return String(m[1]).padStart(6, "0");
  return s;
}

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

function compareSku(a, b) {
  a = String(a || "").trim();
  b = String(b || "").trim();
  if (a === b) return 0;

  const aUnknown = a.startsWith("u:");
  const bUnknown = b.startsWith("u:");
  if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;

  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? -1 : 1;
  }
  return a < b ? -1 : 1;
}

function buildCanonicalSkuFnFromMeta(meta) {
  const links = Array.isArray(meta?.links) ? meta.links : [];
  if (!links.length) return (sku) => normalizeImplicitSkuKey(sku);

  const dsu = new DSU();
  const all = new Set();

  for (const x of links) {
    const a = normalizeImplicitSkuKey(x?.fromSku);
    const b = normalizeImplicitSkuKey(x?.toSku);
    if (!a || !b || a === b) continue;
    all.add(a);
    all.add(b);
    dsu.union(a, b);
  }

  const groupsByRoot = new Map();
  for (const s of all) {
    const r = dsu.find(s);
    if (!r) continue;
    let set = groupsByRoot.get(r);
    if (!set) groupsByRoot.set(r, (set = new Set()));
    set.add(s);
  }

  const repByRoot = new Map();
  for (const [root, members] of groupsByRoot.entries()) {
    const arr = Array.from(members);
    arr.sort(compareSku);
    repByRoot.set(root, arr[0] || root);
  }

  const canonBySku = new Map();
  for (const [root, members] of groupsByRoot.entries()) {
    const rep = repByRoot.get(root) || root;
    for (const s of members) canonBySku.set(s, rep);
    canonBySku.set(rep, rep);
  }

  return (sku) => {
    const s = normalizeImplicitSkuKey(sku);
    return canonBySku.get(s) || s;
  };
}

/* ---------------- similarity (copied from viz/app) ---------------- */

function normSearchText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeQuery(q) {
  const n = normSearchText(q);
  return n ? n.split(" ").filter(Boolean) : [];
}

const SIM_STOP_TOKENS = new Set([
  "the","a","an","and","of","to","in","for","with",
  "year","years","yr","yrs","old",
  "whisky","whiskey","scotch","single","malt","cask","finish","edition","release","batch","strength","abv","proof",
  "anniversary",
]);

const ORDINAL_RE = /^(\d+)(st|nd|rd|th)$/i;

function numKey(t) {
  const s = String(t || "").trim().toLowerCase();
  if (!s) return "";
  if (/^\d+$/.test(s)) return s;
  const m = s.match(ORDINAL_RE);
  return m ? m[1] : "";
}

function extractAgeFromText(normName) {
  const s = String(normName || "");
  if (!s) return "";

  const m = s.match(/\b(?:aged\s*)?(\d{1,2})\s*(?:yr|yrs|year|years)\b/i);
  if (m && m[1]) return String(parseInt(m[1], 10));

  const m2 = s.match(/\b(\d{1,2})\s*yo\b/i);
  if (m2 && m2[1]) return String(parseInt(m2[1], 10));

  return "";
}

function filterSimTokens(tokens) {
  const out = [];
  const seen = new Set();

  const SIM_EQUIV = new Map([
    ["years", "yr"],
    ["year", "yr"],
    ["yrs", "yr"],
    ["yr", "yr"],
    ["whiskey", "whisky"],
    ["whisky", "whisky"],
    ["bourbon", "bourbon"],
  ]);

  const VOL_UNIT = new Set(["ml","l","cl","oz","liter","liters","litre","litres"]);
  const VOL_INLINE_RE = /^\d+(?:\.\d+)?(?:ml|l|cl|oz)$/i;
  const PCT_INLINE_RE = /^\d+(?:\.\d+)?%$/;

  const arr = Array.isArray(tokens) ? tokens : [];

  for (let i = 0; i < arr.length; i++) {
    let t = String(arr[i] || "").trim().toLowerCase();
    if (!t) continue;

    if (!/[a-z0-9]/i.test(t)) continue;
    if (VOL_INLINE_RE.test(t)) continue;
    if (PCT_INLINE_RE.test(t)) continue;

    t = SIM_EQUIV.get(t) || t;

    const nk = numKey(t);
    if (nk) t = nk;

    if (VOL_UNIT.has(t) || t === "abv" || t === "proof") continue;

    if (/^\d+(?:\.\d+)?$/.test(t)) {
      const next = String(arr[i + 1] || "").trim().toLowerCase();
      const nextNorm = SIM_EQUIV.get(next) || next;
      if (VOL_UNIT.has(nextNorm)) {
        i++;
        continue;
      }
    }

    if (!numKey(t) && SIM_STOP_TOKENS.has(t)) continue;

    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }

  return out;
}

function tokenContainmentScore(aTokens, bTokens) {
  const A = filterSimTokens(aTokens || []);
  const B = filterSimTokens(bTokens || []);
  if (!A.length || !B.length) return 0;

  const aSet = new Set(A);
  const bSet = new Set(B);

  const small = aSet.size <= bSet.size ? aSet : bSet;
  const big = aSet.size <= bSet.size ? bSet : aSet;

  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;

  const recall = hit / Math.max(1, small.size);
  const precision = hit / Math.max(1, big.size);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);

  return f1;
}

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;

  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j++) dp[j] = j;

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[m];
}

function numberMismatchPenalty(aTokens, bTokens) {
  const aNums = new Set((aTokens || []).map(numKey).filter(Boolean));
  const bNums = new Set((bTokens || []).map(numKey).filter(Boolean));
  if (!aNums.size || !bNums.size) return 1.0;
  for (const n of aNums) if (bNums.has(n)) return 1.0;
  return 0.28;
}

function similarityScore(aName, bName) {
  const a = normSearchText(aName);
  const b = normSearchText(bName);
  if (!a || !b) return 0;

  const aAge = extractAgeFromText(a);
  const bAge = extractAgeFromText(b);
  const ageBoth = !!(aAge && bAge);
  const ageMatch = ageBoth && aAge === bAge;
  const ageMismatch = ageBoth && aAge !== bAge;

  const aToksRaw = tokenizeQuery(a);
  const bToksRaw = tokenizeQuery(b);

  const aToks = filterSimTokens(aToksRaw);
  const bToks = filterSimTokens(bToksRaw);
  if (!aToks.length || !bToks.length) return 0;

  const contain = tokenContainmentScore(aToksRaw, bToksRaw);

  const aFirst = aToks[0] || "";
  const bFirst = bToks[0] || "";
  const firstMatch = aFirst && bFirst && aFirst === bFirst ? 1 : 0;

  const A = new Set(aToks.slice(1));
  const B = new Set(bToks.slice(1));
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const denom = Math.max(1, Math.max(A.size, B.size));
  const overlapTail = inter / denom;

  const d = levenshtein(a, b);
  const maxLen = Math.max(1, Math.max(a.length, b.length));
  const levSim = 1 - d / maxLen;

  let gate = firstMatch ? 1.0 : Math.min(0.80, 0.06 + 0.95 * contain);

  const smallN = Math.min(aToks.length, bToks.length);
  if (!firstMatch && smallN <= 3 && contain < 0.78) gate *= 0.18;

  const numGate = numberMismatchPenalty(aToks, bToks);

  let s =
    numGate *
    (firstMatch * 3.0 +
      overlapTail * 2.2 * gate +
      levSim * (firstMatch ? 1.0 : (0.10 + 0.70 * contain)));

  if (ageMatch) s *= 2.2;
  else if (ageMismatch) s *= 0.18;

  s *= 1 + 0.9 * contain;

  return s;
}

/* ---------------- debug helpers ---------------- */

function eprintln(...args) {
  console.error(...args);
}

function truncate(s, n) {
  s = String(s || "");
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function briefObjShape(x) {
  if (Array.isArray(x)) return { type: "array", len: x.length };
  if (x && typeof x === "object") return { type: "object", keys: Object.keys(x).slice(0, 30) };
  return { type: typeof x };
}

function trimForPrint(obj, maxKeys = 40, maxStr = 180) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  const keys = Object.keys(obj).slice(0, maxKeys);
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") out[k] = truncate(v, maxStr);
    else if (Array.isArray(v)) out[k] = `[array len=${v.length}]`;
    else if (v && typeof v === "object") out[k] = `{object keys=${Object.keys(v).slice(0, 12).join(",")}}`;
    else out[k] = v;
  }
  return out;
}

/* ---------------- main ---------------- */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();

  const abPath = path.isAbsolute(args.ab) ? args.ab : path.join(repoRoot, args.ab);
  const bcPath = path.isAbsolute(args.bc) ? args.bc : path.join(repoRoot, args.bc);
  const metaPath = args.meta
    ? path.isAbsolute(args.meta)
      ? args.meta
      : path.join(repoRoot, args.meta)
    : "";

  const ab = readJson(abPath);
  const bc = readJson(bcPath);

  const canonicalSku = metaPath
    ? buildCanonicalSkuFnFromMeta(readJson(metaPath))
    : (sku) => normalizeImplicitSkuKey(sku);

  const abBuilt = buildRankMap(ab);
  const bcBuilt = buildRankMap(bc);
  const abMap = abBuilt.map;
  const bcMap = bcBuilt.map;

  if (args.debug || args.debugPayload) {
    eprintln("[rank_discrepency] inputs:", {
      abPath,
      bcPath,
      metaPath: metaPath || "(none)",
      minDiscrep: args.minDiscrep,
      minScore: args.minScore,
      top: args.top,
      includeMissing: args.includeMissing,
      nameField: args.nameField || "(auto)",
    });
    eprintln("[rank_discrepency] payload shapes:", { ab: briefObjShape(ab), bc: briefObjShape(bc) });
    eprintln("[rank_discrepency] extracted rows:", {
      abRows: abBuilt.rowsLen,
      bcRows: bcBuilt.rowsLen,
      abKeys: abMap.size,
      bcKeys: bcMap.size,
    });
  }

  if (!abMap.size || !bcMap.size) {
    eprintln("[rank_discrepency] ERROR: empty rank maps. JSON shape issue.");
    process.exit(2);
  }

  // If asked, print sample row structure for AB/BC so you can see where the name is.
  if (args.debugPayload) {
    const ab0 = abBuilt.rows[0];
    const bc0 = bcBuilt.rows[0];
    eprintln("[rank_discrepency] sample AB row[0] keys:", ab0 && typeof ab0 === "object" ? Object.keys(ab0).slice(0, 80) : ab0);
    eprintln("[rank_discrepency] sample BC row[0] keys:", bc0 && typeof bc0 === "object" ? Object.keys(bc0).slice(0, 80) : bc0);
    eprintln("[rank_discrepency] sample AB row[0] trimmed:", trimForPrint(ab0));
    eprintln("[rank_discrepency] sample BC row[0] trimmed:", trimForPrint(bc0));
    eprintln("[rank_discrepency] sample AB name(auto):", truncate(pickName(ab0, args.nameField), 160));
    eprintln("[rank_discrepency] sample BC name(auto):", truncate(pickName(bc0, args.nameField), 160));
  }

  // Build pool of unique rows by sku key
  const rowBySku = new Map();
  for (const m of [abMap, bcMap]) {
    for (const [canonSku, v] of m.entries()) {
      if (!rowBySku.has(canonSku)) rowBySku.set(canonSku, v.row);
    }
  }

  const allSkus = Array.from(rowBySku.keys());
  const allNames = new Map();
  for (const sku of allSkus) {
    const n = pickName(rowBySku.get(sku), args.nameField);
    allNames.set(sku, n);
  }

  const keys = new Set([...abMap.keys(), ...bcMap.keys()]);
  const diffs = [];

  for (const canonSku of keys) {
    const a = abMap.get(canonSku);
    const b = bcMap.get(canonSku);

    if (!args.includeMissing && (!a || !b)) continue;

    const rankAB = a ? a.rank : null;
    const rankBC = b ? b.rank : null;

    const discrep = rankAB !== null && rankBC !== null ? Math.abs(rankAB - rankBC) : Infinity;
    if (discrep !== Infinity && discrep < args.minDiscrep) continue;

    diffs.push({
      canonSku,
      discrep,
      rankAB,
      rankBC,
      sumRank: (rankAB ?? 1e9) + (rankBC ?? 1e9),
    });
  }

  diffs.sort((x, y) => {
    if (y.discrep !== x.discrep) return y.discrep - x.discrep;
    if (x.sumRank !== y.sumRank) return x.sumRank - y.sumRank;
    return String(x.canonSku).localeCompare(String(y.canonSku));
  });

  if (args.debug) {
    eprintln("[rank_discrepency] discrepancy candidates:", {
      unionKeys: keys.size,
      diffsAfterMin: diffs.length,
      topDiscrepSample: diffs.slice(0, 8).map((d) => ({
        sku: d.canonSku,
        discrep: d.discrep,
        rankAB: d.rankAB,
        rankBC: d.rankBC,
        name: truncate(allNames.get(String(d.canonSku)) || "", 90),
      })),
    });
  }

  // BIG DEBUG: if we keep seeing empty names, dump the actual row objects for top discrepancies
  if (args.debugPayload) {
    for (const d of diffs.slice(0, Math.min(args.debugN, diffs.length))) {
      const sku = String(d.canonSku);
      const row = rowBySku.get(sku) || abMap.get(sku)?.row || bcMap.get(sku)?.row;
      const nm = pickName(row, args.nameField);
      if (!nm) {
        eprintln("[rank_discrepency] no-name row example:", {
          sku,
          discrep: d.discrep,
          rankAB: d.rankAB,
          rankBC: d.rankBC,
          rowKeys: row && typeof row === "object" ? Object.keys(row).slice(0, 80) : typeof row,
          rowTrim: trimForPrint(row),
        });
        break; // one is enough to reveal the name field
      }
    }
  }

  // Filter by having a good "other" match not in same linked group
  const filtered = [];
  const debugLines = [];

  for (const d of diffs) {
    const skuA = String(d.canonSku);
    const nameA = allNames.get(skuA) || "";
    if (!nameA) {
      if (args.debug && debugLines.length < args.debugN) debugLines.push({ sku: skuA, reason: "no-name" });
      continue;
    }

    const groupA = canonicalSku(skuA);

    let best = 0;
    let bestSku = "";
    let bestName = "";

    for (const skuB of allSkus) {
      if (skuB === skuA) continue;
      if (canonicalSku(skuB) === groupA) continue;

      const nameB = allNames.get(skuB) || "";
      if (!nameB) continue;

      const s = similarityScore(nameA, nameB);
      if (s > best) {
        best = s;
        bestSku = skuB;
        bestName = nameB;
      }
    }

    const pass = best >= args.minScore;
    if (args.debug && debugLines.length < args.debugN) {
      debugLines.push({
        sku: skuA,
        discrep: d.discrep,
        rankAB: d.rankAB,
        rankBC: d.rankBC,
        nameA: truncate(nameA, 90),
        best,
        bestSku,
        bestName: truncate(bestName, 90),
        pass,
      });
    }

    if (!pass) continue;

    filtered.push({ ...d, best, bestSku, bestName });
    if (filtered.length >= args.top) break;
  }

  if (args.debug) {
    eprintln("[rank_discrepency] filter results:", {
      filtered: filtered.length,
      minScore: args.minScore,
      minDiscrep: args.minDiscrep,
      totalDiffs: diffs.length,
      totalNamed: Array.from(allNames.values()).filter(Boolean).length,
    });
    eprintln("[rank_discrepency] debug sample (first N checked):");
    for (const x of debugLines) eprintln("  ", x);
  }

  // Emit links on STDOUT
  for (const d of filtered) {
    if (args.dumpScores) {
      eprintln(
        "[rank_discrepency] emit",
        JSON.stringify({
          sku: d.canonSku,
          discrep: d.discrep,
          rankAB: d.rankAB,
          rankBC: d.rankBC,
          best: d.best,
          bestSku: d.bestSku,
          bestName: truncate(d.bestName, 160),
        })
      );
    }
    console.log(args.base + encodeURIComponent(String(d.canonSku)));
  }

  if (args.debug) eprintln("[rank_discrepency] done.");
}

main();
