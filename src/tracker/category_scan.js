"use strict";

const { humanBytes } = require("../utils/bytes");
const { padLeft, padRight, padLeftV, padRightV } = require("../utils/string");
const { normalizeBaseUrl, makePageUrlForCtx } = require("../utils/url");
const { parallelMapStaggered } = require("../utils/async");

const { ensureDir, dbPathFor, readDb, writeJsonAtomic, buildDbObject } = require("./db");
const { mergeDiscoveredIntoDb } = require("./merge");
const { addCategoryResultToReport } = require("./report");

const ACTION_W = 24;
const STATUS_W = 4;
const PROG_W = 4;

function kbStr(bytes) {
  return humanBytes(bytes).padStart(8, " ");
}

function secStr(ms) {
  const s = Number.isFinite(ms) ? ms / 1000 : 0;
  const tenths = Math.round(s * 10) / 10;
  let out;
  if (tenths < 10) out = `${tenths.toFixed(1)}s`;
  else out = `${Math.round(s)}s`;
  return out.padStart(7, " ");
}

function pctStr(done, total) {
  const pct = total ? Math.floor((done / total) * 100) : 0;
  return `${padLeft(pct, 3)}%`;
}

function pageStr(i, total) {
  const leftW = String(total).length;
  return `${padLeft(i, leftW)}/${total}`;
}

function actionCell(s) {
  return padRightV(String(s), ACTION_W);
}

function statusCell(logger, statusRaw, okBool) {
  const cell = padRightV(String(statusRaw || ""), STATUS_W);
  if (!statusRaw) return cell;
  return okBool ? logger.color(cell, logger.C.green) : logger.color(cell, logger.C.yellow);
}

function progCell(v) {
  const raw = String(v ?? "----");
  return padLeftV(raw, PROG_W);
}

function logProgressLine(logger, ctx, action, statusRaw, statusOk, progVal, rest) {
  logger.ok(`${ctx.catPrefixOut} | ${actionCell(action)} | ${statusCell(logger, statusRaw, statusOk)} | ${progCell(progVal)} | ${rest}`);
}

function makeCatPrefixers(stores, logger) {
  const storeW = Math.max(...stores.map((s) => String(s.name || "").length), 1);
  const catW = Math.max(...stores.flatMap((s) => (s.categories || []).map((c) => String(c.label || "").length)), 1);

  function catPrefixRaw(store, cat) {
    return `${padRight(String(store.name || ""), storeW)} | ${padRight(String(cat.label || ""), catW)}`;
  }

  function catPrefixOut(store, cat) {
    return logger.bold(catPrefixRaw(store, cat));
  }

  return { catPrefixRaw, catPrefixOut, width: storeW, catW };
}

function buildCategoryContext(store, cat, catPrefixOutFn, config) {
  const baseUrl = normalizeBaseUrl(cat.startUrl);
  const dbFile = dbPathFor(`${store.key}__${cat.key}`, baseUrl, config.dbDir);
  return {
    store,
    cat,
    baseUrl,
    dbFile,
    catPrefixOut: catPrefixOutFn(store, cat),
  };
}

function loadCategoryDb(logger, ctx) {
  const prevDb = readDb(ctx.dbFile);
  logger.ok(`${ctx.catPrefixOut} | DB loaded: ${padLeft(prevDb.byUrl.size, 5)} | ${logger.dim(ctx.dbFile)}`);
  return prevDb;
}

function shouldTrackItem(ctx, finalUrl, item) {
  const allow = ctx?.cat?.allowUrl;
  if (typeof allow !== "function") return true;
  return allow(item, ctx, finalUrl);
}

async function pageHasProducts(ctx, url) {
  const { http, config, logger } = ctx;
  try {
    const { text } = await http.fetchTextWithRetry(url, "discover", ctx.store.ua);

    if (typeof ctx.store.isEmptyListingPage === "function") {
      if (ctx.store.isEmptyListingPage(text, ctx, url)) return { ok: false, items: 0 };
    }

    const parser = ctx.store.parseProducts || config.defaultParseProducts;
    const items = parser(text, ctx).length;
    return { ok: items > 0, items };
  } catch {
    return { ok: false, items: 0 };
  }
}

async function probePage(ctx, baseUrl, pageNum, state) {
  const url = makePageUrlForCtx(ctx, baseUrl, pageNum);
  const t0 = Date.now();
  const r = await pageHasProducts(ctx, url);
  const ms = Date.now() - t0;

  const prog = discoverProg(state);

  logProgressLine(
    ctx.logger,
    ctx,
    `Discover probe page=${padLeftV(pageNum, 4)}`,
    r.ok ? "OK" : "MISS",
    Boolean(r.ok),
    prog,
    `items=${padLeftV(r.items, 3)} | bytes=${padLeftV("", 8)} | ${padRightV(ctx.http.inflightStr(), 11)} | ${secStr(ms)}`
  );

  return r;
}

function discoverProg(state) {
  if (!state || state.phase !== "binary") return "  0%";
  const span = Math.max(1, state.hiMiss - state.loOk);
  const initial = Math.max(1, state.binInitialSpan);
  if (initial <= 1) return "100%";

  const remaining = Math.max(0, span - 1);
  const total = Math.max(1, initial - 1);
  const pct = Math.max(0, Math.min(100, Math.floor(((total - remaining) / total) * 100)));
  return `${padLeft(pct, 3)}%`;
}

async function binaryFindLastOk(ctx, baseUrl, loOk, hiMiss, state) {
  state.phase = "binary";
  state.loOk = loOk;
  state.hiMiss = hiMiss;
  state.binInitialSpan = Math.max(1, hiMiss - loOk);

  while (hiMiss - loOk > 1) {
    const mid = loOk + Math.floor((hiMiss - loOk) / 2);
    state.loOk = loOk;
    state.hiMiss = hiMiss;

    const pm = await probePage(ctx, baseUrl, mid, state);
    if (pm.ok) loOk = mid;
    else hiMiss = mid;
  }

  state.loOk = loOk;
  state.hiMiss = hiMiss;
  return loOk;
}

async function discoverTotalPagesFast(ctx, baseUrl, guess, step) {
  const state = { phase: "pre", loOk: 1, hiMiss: 2, binInitialSpan: 0 };

  const p1 = await probePage(ctx, baseUrl, 1, state);
  if (!p1.ok) {
    ctx.logger.warn(`${ctx.store.name} | ${ctx.cat.label} | Page 1 did not look like a listing. Defaulting to 1.`);
    return 1;
  }

  const g = Math.max(2, guess);
  const pg = await probePage(ctx, baseUrl, g, state);
  if (!pg.ok) return await binaryFindLastOk(ctx, baseUrl, 1, g, state);

  let lastOk = g;
  while (true) {
    const probe = lastOk + step;
    const pr = await probePage(ctx, baseUrl, probe, state);
    if (!pr.ok) return await binaryFindLastOk(ctx, baseUrl, lastOk, probe, state);
    lastOk = probe;
    if (lastOk > 5000) {
      ctx.logger.warn(`${ctx.store.name} | ${ctx.cat.label} | Discovery hit safety cap at ${lastOk}. Using that as total pages.`);
      return lastOk;
    }
  }
}

async function discoverAndScanCategory(ctx, prevDb, report) {
  const { logger, config } = ctx;

  if (typeof ctx.store.scanCategory === "function") {
    await ctx.store.scanCategory(ctx, prevDb, report);
    return;
  }

  const t0 = Date.now();

  const guess = Number.isFinite(ctx.cat.discoveryStartPage) ? ctx.cat.discoveryStartPage : config.discoveryGuess;
  const step = config.discoveryStep;

  const totalPages = await discoverTotalPagesFast(ctx, ctx.baseUrl, guess, step);
  const scanPages = config.maxPages === null ? totalPages : Math.min(config.maxPages, totalPages);

  logger.ok(`${ctx.catPrefixOut} | Pages: ${scanPages}${scanPages !== totalPages ? ` (cap from ${totalPages})` : ""}`);

  const pages = [];
  for (let p = 1; p <= scanPages; p++) pages.push(makePageUrlForCtx(ctx, ctx.baseUrl, p));

  let donePages = 0;

  const perPageItems = await parallelMapStaggered(pages, config.concurrency, config.staggerMs, async (pageUrl, idx) => {
    const pnum = idx + 1;

    const { text: html, ms, bytes, status, finalUrl } = await ctx.http.fetchTextWithRetry(
      pageUrl,
      `page:${ctx.store.key}:${ctx.cat.key}:${pnum}`,
      ctx.store.ua
    );

    const parser = ctx.store.parseProducts || config.defaultParseProducts;
    const itemsRaw = parser(html, ctx, finalUrl);

    const items = [];
    for (const it of itemsRaw) {
      if (shouldTrackItem(ctx, finalUrl, it)) items.push(it);
    }

    donePages++;
    logProgressLine(
      logger,
      ctx,
      `Page ${pageStr(pnum, pages.length)}`,
      status ? String(status) : "",
      status >= 200 && status < 400,
      pctStr(donePages, pages.length),
      `items=${padLeft(items.length, 3)} | bytes=${kbStr(bytes)} | ${padRight(ctx.http.inflightStr(), 11)} | ${secStr(ms)}`
    );

    return items;
  });

  const discovered = new Map();
  let dups = 0;
  for (const arr of perPageItems) {
    for (const it of arr) {
      if (discovered.has(it.url)) dups++;
      discovered.set(it.url, it);
    }
  }

  logger.ok(`${ctx.catPrefixOut} | Unique products (this run): ${discovered.size}${dups ? ` (${dups} dups)` : ""}`);

  const { merged, newItems, updatedItems, removedItems, restoredItems } = mergeDiscoveredIntoDb(prevDb, discovered);

  const dbObj = buildDbObject(ctx, merged);
  writeJsonAtomic(ctx.dbFile, dbObj);

  logger.ok(`${ctx.catPrefixOut} | DB saved: ${logger.dim(ctx.dbFile)} (${dbObj.count} items)`);

  const elapsed = Date.now() - t0;
  logger.ok(
    `${ctx.catPrefixOut} | Done in ${secStr(elapsed)}. New=${newItems.length} Updated=${updatedItems.length} Removed=${removedItems.length} Restored=${restoredItems.length} Total(DB)=${merged.size}`
  );

  report.categories.push({
    store: ctx.store.name,
    label: ctx.cat.label,
    key: ctx.cat.key,
    dbFile: ctx.dbFile,
    scannedPages: scanPages,
    discoveredUnique: discovered.size,
    newCount: newItems.length,
    updatedCount: updatedItems.length,
    removedCount: removedItems.length,
    restoredCount: restoredItems.length,
    elapsedMs: elapsed,
  });
  report.totals.newCount += newItems.length;
  report.totals.updatedCount += updatedItems.length;
  report.totals.removedCount += removedItems.length;
  report.totals.restoredCount += restoredItems.length;

  addCategoryResultToReport(report, ctx.store.name, ctx.cat.label, newItems, updatedItems, removedItems, restoredItems);
}

module.exports = { makeCatPrefixers, buildCategoryContext, loadCategoryDb, discoverAndScanCategory };
