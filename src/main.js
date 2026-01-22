#!/usr/bin/env node
"use strict";

// NOTE: store filtering is implemented here without touching utils/args.js
const fs = require("fs");
const path = require("path");

const { parseArgs, clampInt } = require("./utils/args");
const { isoTimestampFileSafe } = require("./utils/time");

const { createLogger } = require("./core/logger");
const { createHttpClient } = require("./core/http");

const { createStores, parseProductsSierra } = require("./stores");
const { runAllStores } = require("./tracker/run_all");
const { renderFinalReport } = require("./tracker/report");
const { ensureDir } = require("./tracker/db");

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36";

function resolveDir(p, fallback) {
  const v = String(p || "").trim();
  if (!v) return fallback;
  return path.isAbsolute(v) ? v : path.join(process.cwd(), v);
}

function getFlagValue(argv, flag) {
  // Supports:
  //   --stores=a,b
  //   --stores a,b
  const idx = argv.indexOf(flag);
  if (idx >= 0) return argv[idx + 1] || "";
  const pref = `${flag}=`;
  for (const a of argv) {
    if (a.startsWith(pref)) return a.slice(pref.length);
  }
  return "";
}

function normToken(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "");
}

function parseStoresFilter(raw) {
  const v = String(raw || "").trim();
  if (!v) return [];
  return v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function filterStoresOrThrow(stores, wantedListRaw) {
  const wanted = parseStoresFilter(wantedListRaw);
  if (!wanted.length) return stores;

  const wantedNorm = wanted.map(normToken).filter(Boolean);

  const matched = [];
  const missing = [];

  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i];
    const wn = wantedNorm[i];
    if (!wn) continue;

    // match against key/name/host (normalized)
    const hit = stores.find((s) => {
      const candidates = [s.key, s.name, s.host].map(normToken).filter(Boolean);
      return candidates.includes(wn);
    });

    if (hit) matched.push(hit);
    else missing.push(w);
  }

  if (missing.length) {
    const avail = stores
      .map((s) => `${s.key}${s.name ? ` (${s.name})` : ""}`)
      .join(", ");
    throw new Error(
      `Unknown store(s) in --stores: ${missing.join(", ")}\nAvailable: ${avail}`
    );
  }

  // de-dupe by key (in case name+key both matched)
  const uniq = [];
  const seen = new Set();
  for (const s of matched) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    uniq.push(s);
  }
  return uniq;
}

async function main() {
  if (typeof fetch !== "function") {
    throw new Error(
      "Global fetch() not found. Please use Node.js 18+ (or newer). "
    );
  }

  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const logger = createLogger({ debug: args.debug, colorize: true });

  const config = {
    debug: args.debug,
    maxPages: args.maxPages,
    concurrency: args.concurrency ?? clampInt(process.env.CONCURRENCY, 6, 1, 64),
    staggerMs:
      args.staggerMs ?? clampInt(process.env.STAGGER_MS, 150, 0, 5000),
    maxRetries: clampInt(process.env.MAX_RETRIES, 6, 0, 20),
    timeoutMs: clampInt(process.env.TIMEOUT_MS, 25000, 1000, 120000),
    discoveryGuess:
      args.guess ?? clampInt(process.env.DISCOVERY_GUESS, 20, 1, 5000),
    discoveryStep:
      args.step ?? clampInt(process.env.DISCOVERY_STEP, 5, 1, 500),
    categoryConcurrency: clampInt(process.env.CATEGORY_CONCURRENCY, 5, 1, 64),
    defaultUa: DEFAULT_UA,
    defaultParseProducts: parseProductsSierra,
    dbDir: resolveDir(
      args.dataDir ?? process.env.DATA_DIR,
      path.join(process.cwd(), "data", "db")
    ),
    reportDir: resolveDir(
      args.reportDir ?? process.env.REPORT_DIR,
      path.join(process.cwd(), "reports")
    ),
  };

  ensureDir(config.dbDir);
  ensureDir(config.reportDir);

  const http = createHttpClient({
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    defaultUa: config.defaultUa,
    logger,
  });
  const stores = createStores({ defaultUa: config.defaultUa });

  const storesFilterRaw =
    getFlagValue(argv, "--stores") || String(process.env.STORES || "").trim();

  const storesToRun = filterStoresOrThrow(stores, storesFilterRaw);
  if (storesFilterRaw) {
    logger.info(`Stores filter: ${storesToRun.map((s) => s.key).join(", ")}`);
  }

  const report = await runAllStores(storesToRun, { config, logger, http });

  const meaningful =
    (report?.totals?.newCount || 0) +
      (report?.totals?.updatedCount || 0) +
      (report?.totals?.removedCount || 0) +
      (report?.totals?.restoredCount || 0) >
    0;

  const reportTextColor = renderFinalReport(report, {
    dbDir: config.dbDir,
    colorize: logger.colorize,
  });
  process.stdout.write(reportTextColor);

  if (!meaningful) {
    logger.ok("No meaningful changes; skipping report write.");
    process.exitCode = 3; // special "no-op" code
    return;
  }

  const reportTextPlain = renderFinalReport(report, {
    dbDir: config.dbDir,
    colorize: false,
  });
  const file = path.join(
    config.reportDir,
    `${isoTimestampFileSafe(new Date())}.txt`
  );
  try {
    fs.writeFileSync(file, reportTextPlain, "utf8");
    logger.ok(`Report saved: ${logger.dim(file)}`);
  } catch (e) {
    logger.warn(`Report save failed: ${e?.message || e}`);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => {
    const msg = e && e.stack ? e.stack : String(e);
    // no logger here; keep simple
    console.error(msg);
    process.exitCode = 1;
  });
}
