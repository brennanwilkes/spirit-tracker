"use strict";

const { createReport } = require("./report");
const { setTimeout: sleep } = require("timers/promises");

const {
  makeCatPrefixers,
  buildCategoryContext,
  loadCategoryDb,
  discoverAndScanCategory,
} = require("./category_scan");

// Some sites will intermittently 403/429. We don't want a single category/store
// to abort the entire run. Log and continue.
function formatErr(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e.stack) return e.stack;
  return String(e);
}

async function runAllStores(stores, { config, logger, http }) {
  const report = createReport();
  const { catPrefixOut } = makeCatPrefixers(stores, logger);

  logger.info(`Debug=on`);
  logger.info(
    `Concurrency=${config.concurrency} StaggerMs=${config.staggerMs} Retries=${config.maxRetries} TimeoutMs=${config.timeoutMs}`
  );
  logger.info(
    `DiscoveryGuess=${config.discoveryGuess} DiscoveryStep=${config.discoveryStep}`
  );
  logger.info(`MaxPages=${config.maxPages === null ? "none" : config.maxPages}`);
  logger.info(`CategoryConcurrency=${config.categoryConcurrency}`);

  const workItems = [];
  for (const store of stores) {
    for (const cat of store.categories) {
      const baseCtx = buildCategoryContext(store, cat, catPrefixOut, config);
      const ctx = { ...baseCtx, config, logger, http };
      const prevDb = loadCategoryDb(logger, ctx);
      workItems.push({ ctx, prevDb });
    }
  }

  // Host-level serialization: never run two categories from the same host concurrently.
  const maxWorkers = Math.min(config.categoryConcurrency, workItems.length);
  const queue = workItems.slice();
  const inflightHosts = new Set();

  async function runOne(w) {
    try {
      await discoverAndScanCategory(w.ctx, w.prevDb, report);
    } catch (e) {
      const storeName = w?.ctx?.store?.name || w?.ctx?.store?.host || "unknown-store";
      const catLabel = w?.ctx?.cat?.label || w?.ctx?.cat?.key || "unknown-category";

      // Keep it loud in logs, but do not fail the entire run.
      logger.warn(`Category failed (continuing): ${storeName} | ${catLabel}\n${formatErr(e)}`);
    }
  }

  async function worker() {
    while (true) {
      if (queue.length === 0) return;

      // Pick next item whose host isn't currently running.
      const idx = queue.findIndex((w) => {
        const host = String(w?.ctx?.store?.host || w?.ctx?.store?.key || "");
        return host && !inflightHosts.has(host);
      });

      if (idx === -1) {
        // Nothing available right now; wait a bit.
        await sleep(50);
        continue;
      }

      const w = queue.splice(idx, 1)[0];
      const host = String(w?.ctx?.store?.host || w?.ctx?.store?.key || "");

      inflightHosts.add(host);
      try {
        await runOne(w);
      } finally {
        inflightHosts.delete(host);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < maxWorkers; i++) workers.push(worker());
  await Promise.all(workers);

  return report;
}

module.exports = { runAllStores };
