"use strict";

function clampInt(v, def, min, max) {
  if (def === null && (v === null || v === undefined)) return null;
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function parseArgs(argv) {
  let debug = false;
  let maxPages = null;
  let concurrency = null;
  let staggerMs = null;
  let guess = null;
  let step = null;
  let dataDir = null;
  let reportDir = null;

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--debug" || a === "-d") {
      debug = true;
      continue;
    }

    if (a === "--max-pages" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      maxPages = clampInt(argv[i + 1], null, 1, 5000);
      i++;
      continue;
    }

    if (a === "--concurrency" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      concurrency = clampInt(argv[i + 1], null, 1, 64);
      i++;
      continue;
    }

    if ((a === "--stagger-ms" || a === "--staggerMs") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      staggerMs = clampInt(argv[i + 1], null, 0, 5000);
      i++;
      continue;
    }

    if (a === "--guess" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      guess = clampInt(argv[i + 1], null, 1, 5000);
      i++;
      continue;
    }

    if (a === "--step" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      step = clampInt(argv[i + 1], null, 1, 500);
      i++;
      continue;
    }

    if ((a === "--data-dir" || a === "--dataDir") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      dataDir = String(argv[i + 1]);
      i++;
      continue;
    }

    if ((a === "--report-dir" || a === "--reportDir") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      reportDir = String(argv[i + 1]);
      i++;
      continue;
    }

    if (!String(a).startsWith("-")) positional.push(a);
  }

  if (maxPages === null) {
    const cand = positional.find((x) => /^\d+$/.test(String(x)));
    if (cand) {
      const n = Number.parseInt(cand, 10);
      if (Number.isFinite(n) && n > 0) maxPages = Math.min(n, 5000);
    }
  }

  return { maxPages, debug, concurrency, staggerMs, guess, step, dataDir, reportDir };
}

module.exports = { clampInt, parseArgs };
