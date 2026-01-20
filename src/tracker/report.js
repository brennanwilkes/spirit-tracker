"use strict";

const { C, color } = require("../utils/ansi");
const { padLeft, padRight } = require("../utils/string");
const { normalizeCspc } = require("../utils/sku");
const { priceToNumber, salePctOff } = require("../utils/price");
const { buildCheapestSkuIndexFromAllDbs } = require("./db");

function secStr(ms) {
  const s = Number.isFinite(ms) ? ms / 1000 : 0;
  const tenths = Math.round(s * 10) / 10;
  let out;
  if (tenths < 10) out = `${tenths.toFixed(1)}s`;
  else out = `${Math.round(s)}s`;
  return out.padStart(7, " ");
}

function createReport() {
  return {
    startedAt: new Date(),
    categories: [],
    totals: { newCount: 0, updatedCount: 0, removedCount: 0, restoredCount: 0 },
    newItems: [],
    updatedItems: [],
    removedItems: [],
    restoredItems: [],
  };
}

function addCategoryResultToReport(report, storeName, catLabel, newItems, updatedItems, removedItems, restoredItems) {
  const reportCatLabel = `${storeName} | ${catLabel}`;

  for (const it of newItems) report.newItems.push({ catLabel: reportCatLabel, name: it.name, price: it.price || "", sku: it.sku || "", url: it.url });

  for (const it of restoredItems)
    report.restoredItems.push({ catLabel: reportCatLabel, name: it.name, price: it.price || "", sku: it.sku || "", url: it.url });

  for (const u of updatedItems) {
    report.updatedItems.push({
      catLabel: reportCatLabel,
      name: u.name,
      sku: u.sku || "",
      oldPrice: u.oldPrice,
      newPrice: u.newPrice,
      url: u.url,
    });
  }

  for (const it of removedItems)
    report.removedItems.push({ catLabel: reportCatLabel, name: it.name, price: it.price || "", sku: it.sku || "", url: it.url });
}

function renderFinalReport(report, { dbDir, colorize = Boolean(process.stdout && process.stdout.isTTY) } = {}) {
  const paint = (s, code) => color(s, code, colorize);
  const cheapestSku = buildCheapestSkuIndexFromAllDbs(dbDir);

  const endedAt = new Date();
  const durMs = endedAt - report.startedAt;

  const storesSet = new Set(report.categories.map((c) => c.store));
  const totalUnique = report.categories.reduce((acc, c) => acc + (Number.isFinite(c.discoveredUnique) ? c.discoveredUnique : 0), 0);

  let out = "";
  const ln = (s = "") => {
    out += String(s) + "\n";
  };

  ln("");
  ln(paint("========== REPORT ==========", C.bold));
  ln(
    paint("[OK] ", C.green) +
      `Totals | Stores=${storesSet.size} | Categories=${report.categories.length} | Unique=${totalUnique} | New=${report.totals.newCount} | Restored=${report.totals.restoredCount} | Removed=${report.totals.removedCount} | PriceChanges=${report.totals.updatedCount} | Runtime=${secStr(
        durMs
      )}`
  );
  ln("");

  ln(paint("Per-category summary:", C.bold));
  const rows = report.categories.map((c) => ({
    cat: `${c.store} | ${c.label}`,
    pages: c.scannedPages,
    uniq: c.discoveredUnique,
    newC: c.newCount,
    resC: c.restoredCount,
    remC: c.removedCount,
    updC: c.updatedCount,
    ms: c.elapsedMs,
  }));

  const catW = Math.min(48, Math.max(...rows.map((r) => r.cat.length), 8));
  ln(`${padRight("Store | Category", catW)}  ${padLeft("Pages", 5)}  ${padLeft("Unique", 6)}  ${padLeft("New", 4)}  ${padLeft("Res", 4)}  ${padLeft("Rem", 4)}  ${padLeft("Upd", 4)}  ${padLeft("Sec", 7)}`);
  ln(`${"-".repeat(catW)}  -----  ------  ----  ----  ----  ----  -------`);
  for (const r of rows) {
    ln(
      `${padRight(r.cat, catW)}  ${padLeft(r.pages, 5)}  ${padLeft(r.uniq, 6)}  ${padLeft(r.newC, 4)}  ${padLeft(r.resC, 4)}  ${padLeft(r.remC, 4)}  ${padLeft(r.updC, 4)}  ${secStr(r.ms)}`
    );
  }
  ln("");

  const reportLabelW = Math.max(
    16,
    ...report.newItems.map((x) => x.catLabel.length),
    ...report.restoredItems.map((x) => x.catLabel.length),
    ...report.updatedItems.map((x) => x.catLabel.length),
    ...report.removedItems.map((x) => x.catLabel.length)
  );

  function storeFromCatLabel(catLabel) {
    return String(catLabel || "").split(" | ")[0] || "";
  }

  function skuInline(sku) {
    const s = normalizeCspc(sku);
    return s ? paint(` ${s}`, C.gray) : "";
  }

  function cheaperAtInline(catLabel, sku, currentPriceStr) {
    const s = normalizeCspc(sku);
    if (!s) return "";
    const best = cheapestSku.get(s);
    if (!best || !best.storeLabel) return "";
    const curStore = storeFromCatLabel(catLabel);
    if (!curStore || best.storeLabel === curStore) return "";
    const curP = priceToNumber(currentPriceStr);
    if (!Number.isFinite(curP)) return "";
    if (best.priceNum >= curP) return "";
    return paint(` (Cheaper at ${best.storeLabel})`, C.gray);
  }

  function availableAtInline(catLabel, sku) {
    const s = normalizeCspc(sku);
    if (!s) return "";
    const best = cheapestSku.get(s);
    if (!best || !best.storeLabel) return "";
    const curStore = storeFromCatLabel(catLabel);
    if (curStore && best.storeLabel === curStore) return "";
    return paint(` (Available at ${best.storeLabel})`, C.gray);
  }

  if (report.newItems.length) {
    ln(paint(`NEW LISTINGS (${report.newItems.length})`, C.bold + C.green));
    for (const it of report.newItems.sort((a, b) => (a.catLabel + a.name).localeCompare(b.catLabel + b.name))) {
      const price = it.price ? paint(it.price, C.cyan) : paint("(no price)", C.gray);
      const sku = normalizeCspc(it.sku || "");
      const cheapTag = cheaperAtInline(it.catLabel, sku, it.price || "");
      ln(
        `${paint("+", C.green)} ${padRight(it.catLabel, reportLabelW)} | ${paint(it.name, C.bold)}${skuInline(sku)}  ${price}${cheapTag}`
      );
      ln(`  ${paint(it.url, C.dim)}`);
    }
    ln("");
  } else {
    ln(paint("NEW LISTINGS (0)", C.bold));
    ln("");
  }

  if (report.restoredItems.length) {
    ln(paint(`RESTORED (${report.restoredItems.length})`, C.bold + C.green));
    for (const it of report.restoredItems.sort((a, b) => (a.catLabel + a.name).localeCompare(b.catLabel + b.name))) {
      const price = it.price ? paint(it.price, C.cyan) : paint("(no price)", C.gray);
      const sku = normalizeCspc(it.sku || "");
      const cheapTag = cheaperAtInline(it.catLabel, sku, it.price || "");
      ln(
        `${paint("R", C.green)} ${padRight(it.catLabel, reportLabelW)} | ${paint(it.name, C.bold)}${skuInline(sku)}  ${price}${cheapTag}`
      );
      ln(`  ${paint(it.url, C.dim)}`);
    }
    ln("");
  } else {
    ln(paint("RESTORED (0)", C.bold));
    ln("");
  }

  if (report.removedItems.length) {
    ln(paint(`REMOVED (${report.removedItems.length})`, C.bold + C.yellow));
    for (const it of report.removedItems.sort((a, b) => (a.catLabel + a.name).localeCompare(b.catLabel + b.name))) {
      const price = it.price ? paint(it.price, C.cyan) : paint("(no price)", C.gray);
      const sku = normalizeCspc(it.sku || "");
      const availTag = availableAtInline(it.catLabel, sku);
      ln(
        `${paint("-", C.yellow)} ${padRight(it.catLabel, reportLabelW)} | ${paint(it.name, C.bold)}${skuInline(sku)}  ${price}${availTag}`
      );
      ln(`  ${paint(it.url, C.dim)}`);
    }
    ln("");
  } else {
    ln(paint("REMOVED (0)", C.bold));
    ln("");
  }

  if (report.updatedItems.length) {
    ln(paint(`PRICE CHANGES (${report.updatedItems.length})`, C.bold + C.cyan));

    for (const u of report.updatedItems.sort((a, b) => (a.catLabel + a.name).localeCompare(b.catLabel + b.name))) {
      const oldRaw = u.oldPrice || "";
      const newRaw = u.newPrice || "";

      const oldN = priceToNumber(oldRaw);
      const newN = priceToNumber(newRaw);

      const oldP = oldRaw ? paint(oldRaw, C.yellow) : paint("(no price)", C.gray);

      let newP = newRaw ? newRaw : "(no price)";
      let offTag = "";

      if (Number.isFinite(oldN) && Number.isFinite(newN)) {
        if (newN > oldN) {
          newP = paint(newP, C.red); // increase
        } else if (newN < oldN) {
          newP = paint(newP, C.green); // decrease
          const pct = salePctOff(oldRaw, newRaw);
          if (pct !== null) offTag = " " + paint(`[${pct}% Off]`, C.green);
        } else {
          newP = paint(newP, C.cyan);
        }
      } else {
        newP = paint(newP, C.cyan);
      }

      const sku = normalizeCspc(u.sku || "");
      const cheapTag = cheaperAtInline(u.catLabel, sku, newRaw || "");

      ln(
        `${paint("~", C.cyan)} ${padRight(u.catLabel, reportLabelW)} | ${paint(u.name, C.bold)}${skuInline(sku)}  ${oldP} ${paint("->", C.gray)} ${newP}${offTag}${cheapTag}`
      );
      ln(`  ${paint(u.url, C.dim)}`);
    }

    ln("");
  } else {
    ln(paint("PRICE CHANGES (0)", C.bold));
    ln("");
  }

  ln(paint("======== END REPORT ========", C.bold));

  return out;
}

module.exports = { createReport, addCategoryResultToReport, renderFinalReport };
