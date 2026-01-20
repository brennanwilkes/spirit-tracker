#!/usr/bin/env node
"use strict";

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

async function main() {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() not found. Please use Node.js 18+ (or newer). ");
  }

  const args = parseArgs(process.argv.slice(2));

  const logger = createLogger({ debug: args.debug, colorize: true });

  const config = {
    debug: args.debug,
    maxPages: args.maxPages,
    concurrency: args.concurrency ?? clampInt(process.env.CONCURRENCY, 6, 1, 64),
    staggerMs: args.staggerMs ?? clampInt(process.env.STAGGER_MS, 150, 0, 5000),
    maxRetries: clampInt(process.env.MAX_RETRIES, 6, 0, 20),
    timeoutMs: clampInt(process.env.TIMEOUT_MS, 25000, 1000, 120000),
    discoveryGuess: args.guess ?? clampInt(process.env.DISCOVERY_GUESS, 20, 1, 5000),
    discoveryStep: args.step ?? clampInt(process.env.DISCOVERY_STEP, 5, 1, 500),
    categoryConcurrency: clampInt(process.env.CATEGORY_CONCURRENCY, 5, 1, 64),
    defaultUa: DEFAULT_UA,
    defaultParseProducts: parseProductsSierra,
    dbDir: resolveDir(args.dataDir ?? process.env.DATA_DIR, path.join(process.cwd(), "data", "db")),
    reportDir: resolveDir(args.reportDir ?? process.env.REPORT_DIR, path.join(process.cwd(), "reports")),
  };

  ensureDir(config.dbDir);
  ensureDir(config.reportDir);

  const http = createHttpClient({ maxRetries: config.maxRetries, timeoutMs: config.timeoutMs, defaultUa: config.defaultUa, logger });
  const stores = createStores({ defaultUa: config.defaultUa });

  const report = await runAllStores(stores, { config, logger, http });

  const reportTextColor = renderFinalReport(report, { dbDir: config.dbDir, colorize: logger.colorize });
  process.stdout.write(reportTextColor);

  const reportTextPlain = renderFinalReport(report, { dbDir: config.dbDir, colorize: false });
  const file = path.join(config.reportDir, `${isoTimestampFileSafe(new Date())}.txt`);
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
