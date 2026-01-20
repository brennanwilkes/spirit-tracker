#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function listDbFiles(dbDir) {
  try {
    return fs
      .readdirSync(dbDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => path.join(dbDir, e.name));
  } catch {
    return [];
  }
}

function dateOnly(iso) {
  const m = String(iso ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function main() {
  const repoRoot = process.cwd();
  const dbDir = path.join(repoRoot, "data", "db");
  const outDir = path.join(repoRoot, "viz", "data");
  const outFile = path.join(outDir, "db_commits.json");

  fs.mkdirSync(outDir, { recursive: true });

  const files = listDbFiles(dbDir).map((abs) => path.posix.join("data/db", path.basename(abs)));

  const payload = {
    generatedAt: new Date().toISOString(),
    branch: "data",
    files: {},
  };

  // We want the viz to show ONE point per day (the most recent run that day).
  // So we collapse multiple commits per day down to the newest commit for that date.
  //
  // With multiple runs/day, we also want to keep a long-ish daily history.
  // Raw commits per day could be ~4, so grab a larger raw window and then collapse.
  const MAX_RAW_PER_FILE = 2400; // ~600 days @ 4 runs/day
  const MAX_DAYS_PER_FILE = 600; // daily points kept after collapsing

  for (const rel of files.sort()) {
    let txt = "";
    try {
      // %H = sha, %cI = committer date strict ISO 8601 (includes time + tz)
      txt = runGit(["log", "--format=%H %cI", `-${MAX_RAW_PER_FILE}`, "--", rel]);
    } catch {
      continue;
    }

    const lines = txt.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    // git log is newest -> oldest.
    // Keep the FIRST commit we see for each date (that is the most recent commit for that date).
    const byDate = new Map(); // date -> { sha, date, ts }
    for (const line of lines) {
      const m = line.match(/^([0-9a-f]{7,40})\s+(.+)$/i);
      if (!m) continue;

      const sha = m[1];
      const ts = m[2];
      const d = dateOnly(ts);
      if (!d) continue;

      if (!byDate.has(d)) byDate.set(d, { sha, date: d, ts });
    }

    // Convert to oldest -> newest
    let arr = [...byDate.values()].reverse();

    // Keep only the newest MAX_DAYS_PER_FILE (still oldest -> newest)
    if (arr.length > MAX_DAYS_PER_FILE) {
      arr = arr.slice(arr.length - MAX_DAYS_PER_FILE);
    }

    payload.files[rel] = arr;
  }

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  process.stdout.write(`Wrote ${outFile} (${Object.keys(payload.files).length} files)\n`);
}

main();
