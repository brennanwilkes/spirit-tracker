#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { C, color } = require("../src/utils/ansi");
const { padLeft, padRight } = require("../src/utils/string");
const { normalizeCspc } = require("../src/utils/sku");
const { priceToNumber, salePctOff, normPrice } = require("../src/utils/price");
const { isoTimestampFileSafe } = require("../src/utils/time");

function runGit(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function gitShowText(sha, filePath) {
  try {
    return execFileSync("git", ["show", `${sha}:${filePath}`], { encoding: "utf8" });
  } catch {
    return null;
  }
}

function gitListDbFiles(sha, dbDirRel) {
  const out = runGit(["ls-tree", "-r", "--name-only", sha, dbDirRel]);
  const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return new Set(lines);
}

function parseJsonOrNull(txt) {
  if (txt == null) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function mapItemsByUrl(obj) {
  const m = new Map();
  const items = Array.isArray(obj?.items) ? obj.items : [];
  for (const it of items) {
    if (!it || typeof it.url !== "string" || !it.url.startsWith("http")) continue;
    m.set(it.url, {
      name: String(it.name || ""),
      price: String(it.price || ""),
      sku: String(it.sku || ""),
      url: it.url,
      removed: Boolean(it.removed),
    });
  }
  return m;
}

function buildDiffForDb(prevObj, nextObj) {
  const prev = mapItemsByUrl(prevObj);
  const next = mapItemsByUrl(nextObj);

  const urls = new Set([...prev.keys(), ...next.keys()]);

  const newItems = [];
  const restoredItems = [];
  const removedItems = [];
  const updatedItems = [];

  for (const url of urls) {
    const a = prev.get(url);
    const b = next.get(url);

    const aExists = Boolean(a);
    const bExists = Boolean(b);

    const aRemoved = Boolean(a?.removed);
    const bRemoved = Boolean(b?.removed);

    if (!aExists && bExists && !bRemoved) {
      newItems.push({ ...b });
      continue;
    }

    if (aExists && aRemoved && bExists && !bRemoved) {
      restoredItems.push({ ...b });
      continue;
    }

    if (aExists && !aRemoved && (!bExists || bRemoved)) {
      removedItems.push({ ...a });
      continue;
    }

    if (aExists && bExists && !aRemoved && !bRemoved) {
      const aP = normPrice(a.price);
      const bP = normPrice(b.price);
      if (aP !== bP) {
        updatedItems.push({
          name: b.name || a.name || "",
          sku: normalizeCspc(b.sku || a.sku || ""),
          oldPrice: a.price || "",
          newPrice: b.price || "",
          url,
        });
      }
    }
  }

  return { newItems, restoredItems, removedItems, updatedItems };
}

function parseArgs(argv) {
  const flags = new Set();
  const kv = new Map();
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    if (a === "--no-color") {
      flags.add("no-color");
      continue;
    }
    if (a === "--color") {
      flags.add("color");
      continue;
    }
    if ((a === "--db-dir" || a === "--out") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      kv.set(a, argv[i + 1]);
      i++;
      continue;
    }
    flags.add(a);
  }

  const fromSha = positional[0] || "";
  const toSha = positional[1] || "";
  const dbDir = kv.get("--db-dir") || "data/db";
  const outFile = kv.get("--out") || "";

  return { fromSha, toSha, dbDir, outFile, flags };
}

function renderDiffReport(diffReport, { fromSha, toSha, colorize }) {
  const paint = (s, code) => color(s, code, colorize);

  let out = "";
  const ln = (s = "") => {
    out += String(s) + "\n";
  };

  ln(paint("========== DIFF REPORT ==========", C.bold));
  ln(`${paint("From", C.bold)} ${fromSha}  ${paint("to", C.bold)} ${toSha}`);
  ln(
    `${paint("Totals", C.bold)} | Categories=${diffReport.categories.length} | New=${diffReport.totals.newCount} | Restored=${diffReport.totals.restoredCount} | Removed=${diffReport.totals.removedCount} | PriceChanges=${diffReport.totals.updatedCount}`
  );
  ln("");

  const rows = diffReport.categories;
  const catW = Math.min(56, Math.max(...rows.map((r) => r.catLabel.length), 12));

  ln(paint("Per-category summary:", C.bold));
  ln(`${padRight("Store | Category", catW)}  ${padLeft("New", 4)}  ${padLeft("Res", 4)}  ${padLeft("Rem", 4)}  ${padLeft("Upd", 4)}`);
  ln(`${"-".repeat(catW)}  ----  ----  ----  ----`);
  for (const r of rows) {
    ln(`${padRight(r.catLabel, catW)}  ${padLeft(r.newCount, 4)}  ${padLeft(r.restoredCount, 4)}  ${padLeft(r.removedCount, 4)}  ${padLeft(r.updatedCount, 4)}`);
  }
  ln("");

  const labelW = Math.max(16, ...diffReport.newItems.map((x) => x.catLabel.length), ...diffReport.restoredItems.map((x) => x.catLabel.length), ...diffReport.removedItems.map((x) => x.catLabel.length), ...diffReport.updatedItems.map((x) => x.catLabel.length));

  const skuInline = (sku) => {
    const s = normalizeCspc(sku);
    return s ? paint(` ${s}`, C.gray) : "";
  };

  if (diffReport.newItems.length) {
    ln(paint(`NEW (${diffReport.newItems.length})`, C.bold + C.green));
    for (const it of diffReport.newItems.sort((a, b) => (a.catLabel + a.name).localeCompare(b.catLabel + b.name))) {
      const price = it.price ? paint(it.price, C.cyan) : paint("(no price)", C.gray);
      ln(`${paint("+", C.green)} ${padRight(it.catLabel, labelW)} | ${paint(it.name, C.bold)}${skuInline(it.sku)}  ${price}`);
      ln(`  ${paint(it.url, C.dim)}`);
    }
    ln("");
  }

  if (diffReport.restoredItems.length) {
    ln(paint(`RESTORED (${diffReport.restoredItems.length})`, C.bold + C.green));
    for (const it of diffReport.restoredItems.sort((a, b) => (a.catLabel + a.name).localeCompare(b.catLabel + b.name))) {
      const price = it.price ? paint(it.price, C.cyan) : paint("(no price)", C.gray);
      ln(`${paint("R", C.green)} ${padRight(it.catLabel, labelW)} | ${paint(it.name, C.bold)}${skuInline(it.sku)}  ${price}`);
      ln(`  ${paint(it.url, C.dim)}`);
    }
    ln("");
  }

  if (diffReport.removedItems.length) {
    ln(paint(`REMOVED (${diffReport.removedItems.length})`, C.bold + C.yellow));
    for (const it of diffReport.removedItems.sort((a, b) => (a.catLabel + a.name).localeCompare(b.catLabel + b.name))) {
      const price = it.price ? paint(it.price, C.cyan) : paint("(no price)", C.gray);
      ln(`${paint("-", C.yellow)} ${padRight(it.catLabel, labelW)} | ${paint(it.name, C.bold)}${skuInline(it.sku)}  ${price}`);
      ln(`  ${paint(it.url, C.dim)}`);
    }
    ln("");
  }

  if (diffReport.updatedItems.length) {
    ln(paint(`PRICE CHANGES (${diffReport.updatedItems.length})`, C.bold + C.cyan));

    for (const u of diffReport.updatedItems.sort((a, b) => (a.catLabel + a.name).localeCompare(b.catLabel + b.name))) {
      const oldRaw = u.oldPrice || "";
      const newRaw = u.newPrice || "";

      const oldN = priceToNumber(oldRaw);
      const newN = priceToNumber(newRaw);

      const oldP = oldRaw ? paint(oldRaw, C.yellow) : paint("(no price)", C.gray);

      let newP = newRaw ? newRaw : "(no price)";
      let offTag = "";

      if (Number.isFinite(oldN) && Number.isFinite(newN)) {
        if (newN > oldN) newP = paint(newP, C.red);
        else if (newN < oldN) {
          newP = paint(newP, C.green);
          const pct = salePctOff(oldRaw, newRaw);
          if (pct !== null) offTag = " " + paint(`[${pct}% Off]`, C.green);
        } else newP = paint(newP, C.cyan);
      } else newP = paint(newP, C.cyan);

      ln(
        `${paint("~", C.cyan)} ${padRight(u.catLabel, labelW)} | ${paint(u.name, C.bold)}${skuInline(u.sku)}  ${oldP} ${paint("->", C.gray)} ${newP}${offTag}`
      );
      ln(`  ${paint(u.url, C.dim)}`);
    }

    ln("");
  }

  ln(paint("======== END DIFF REPORT ========", C.bold));

  return out;
}

async function main() {
  const { fromSha, toSha, dbDir, outFile, flags } = parseArgs(process.argv.slice(2));

  if (!fromSha || !toSha) {
    console.error(`Usage: ${path.basename(process.argv[1])} <fromSha> <toSha> [--db-dir data/db] [--out reports/<file>.txt] [--no-color]`);
    process.exitCode = 2;
    return;
  }

  // If user provides short SHAs, git accepts them.
  const colorize = flags.has("no-color") ? false : Boolean(process.stdout && process.stdout.isTTY);

  const filesA = gitListDbFiles(fromSha, dbDir);
  const filesB = gitListDbFiles(toSha, dbDir);
  const files = new Set([...filesA, ...filesB]);

  const diffReport = {
    categories: [],
    totals: { newCount: 0, updatedCount: 0, removedCount: 0, restoredCount: 0 },
    newItems: [],
    restoredItems: [],
    removedItems: [],
    updatedItems: [],
  };

  for (const file of [...files].sort()) {
    const prevObj = parseJsonOrNull(gitShowText(fromSha, file));
    const nextObj = parseJsonOrNull(gitShowText(toSha, file));

    const storeLabel = String(nextObj?.storeLabel || prevObj?.storeLabel || nextObj?.store || prevObj?.store || "?");
    const catLabel = String(nextObj?.categoryLabel || prevObj?.categoryLabel || nextObj?.category || prevObj?.category || path.basename(file));
    const catLabelFull = `${storeLabel} | ${catLabel}`;

    const { newItems, restoredItems, removedItems, updatedItems } = buildDiffForDb(prevObj, nextObj);

    diffReport.categories.push({
      catLabel: catLabelFull,
      newCount: newItems.length,
      restoredCount: restoredItems.length,
      removedCount: removedItems.length,
      updatedCount: updatedItems.length,
    });

    diffReport.totals.newCount += newItems.length;
    diffReport.totals.restoredCount += restoredItems.length;
    diffReport.totals.removedCount += removedItems.length;
    diffReport.totals.updatedCount += updatedItems.length;

    for (const it of newItems) diffReport.newItems.push({ catLabel: catLabelFull, ...it });
    for (const it of restoredItems) diffReport.restoredItems.push({ catLabel: catLabelFull, ...it });
    for (const it of removedItems) diffReport.removedItems.push({ catLabel: catLabelFull, ...it });
    for (const u of updatedItems) diffReport.updatedItems.push({ catLabel: catLabelFull, ...u });
  }

  const reportText = renderDiffReport(diffReport, { fromSha, toSha, colorize });
  process.stdout.write(reportText);

  const outPath = outFile
    ? (path.isAbsolute(outFile) ? outFile : path.join(process.cwd(), outFile))
    : "";

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, renderDiffReport(diffReport, { fromSha, toSha, colorize: false }), "utf8");
  }
}

main().catch((e) => {
  const msg = e && e.stack ? e.stack : String(e);
  console.error(msg);
  process.exitCode = 1;
});
