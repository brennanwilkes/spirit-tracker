"use strict";

const { createReport } = require("./report");
const { parallelMapStaggered } = require("../utils/async");

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

  await parallelMapStaggered(
    workItems,
    Math.min(config.categoryConcurrency, workItems.length),
    0,
    async (w) => {
      try {
        await discoverAndScanCategory(w.ctx, w.prevDb, report);
      } catch (e) {
        const storeName = w?.ctx?.store?.name || w?.ctx?.store?.host || "unknown-store";
        const catLabel = w?.ctx?.cat?.label || w?.ctx?.cat?.key || "unknown-category";

        // Keep it loud in logs, but do not fail the entire run.
        logger.warn(
          `Category failed (continuing): ${storeName} | ${catLabel}\n${formatErr(e)}`
        );

        // If you want failures surfaced in the final report later, you could also
        // push a "failed category" record onto report.categories here.
      }
      return null;
    }
  );

  return report;
}

module.exports = { runAllStores };
