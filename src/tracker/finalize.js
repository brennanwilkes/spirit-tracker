"use strict";

const { mergeDiscoveredIntoDb } = require("./merge");
const { buildDbObject, writeJsonAtomic } = require("./db");
const { addCategoryResultToReport } = require("./report");
const { secStr } = require("../utils/format");

/**
 * Standard end-of-scan: merge, write DB, log Done, update report.
 * Returns merge result for stores that need newItems/etc after the call.
 */
function finalizeCategoryScan(ctx, prevDb, discovered, report, { t0, scannedPages }) {
	const { merged, newItems, updatedItems, removedItems, restoredItems, metaChangedItems, skuUpgrades } =
		mergeDiscoveredIntoDb(prevDb, discovered, { storeLabel: ctx.store.name });
	const dbObj = buildDbObject(ctx, merged);
	writeJsonAtomic(ctx.dbFile, dbObj);

	if (skuUpgrades && skuUpgrades.length && report?.skuUpgrades) {
		const ts = dbObj.updatedAt;
		for (const u of skuUpgrades) {
			report.skuUpgrades.push({ ...u, ts, dbFile: ctx.dbFile });
		}
	}
	const elapsedMs = Date.now() - t0;
	ctx.logger.ok(
		`${ctx.catPrefixOut} | Done in ${secStr(elapsedMs)}. New=${newItems.length} Updated=${updatedItems.length} ` +
			`Removed=${removedItems.length} Restored=${restoredItems.length} Total(DB)=${merged.size}`,
	);
	report.categories.push({
		store: ctx.store.name,
		label: ctx.cat.label,
		key: ctx.cat.key,
		dbFile: ctx.dbFile,
		scannedPages,
		discoveredUnique: discovered.size,
		newCount: newItems.length,
		updatedCount: updatedItems.length,
		removedCount: removedItems.length,
		restoredCount: restoredItems.length,
		metaChangedCount: metaChangedItems.length,
		elapsedMs,
	});
	report.totals.newCount += newItems.length;
	report.totals.updatedCount += updatedItems.length;
	report.totals.removedCount += removedItems.length;
	report.totals.restoredCount += restoredItems.length;
	addCategoryResultToReport(
		report,
		ctx.store.name,
		ctx.cat.label,
		newItems,
		updatedItems,
		removedItems,
		restoredItems,
	);
	return { merged, newItems, updatedItems, removedItems, restoredItems, metaChangedItems, skuUpgrades };
}

module.exports = { finalizeCategoryScan };
