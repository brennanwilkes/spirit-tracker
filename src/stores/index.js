"use strict";

const { createStore: createSierra, parseProductsSierra } = require("./sierrasprings");
const { createStore: createBSW } = require("./bsw");
const { createStore: createKWM } = require("./kwm");
const { createStore: createKegNCork } = require("./kegncork");
const { createStore: createMaltsAndGrains } = require("./maltsandgrains");
const { createStore: createCraftCellars } = require("./craftcellars");
const { createStore: createBCL } = require("./bcl");
const { createStore: createStrath } = require("./strath");
const { createStore: createLegacy } = require("./legacyliquor");
const { createStore: createGull } = require("./gull");
const { createStore: createCoop } = require("./coop");
const { createStore: createTudor } = require("./tudor");
const { createStore: createVintage } = require("./vintagespirits");
const { createStore: createVessel } = require("./vessel");
const { createStore: createWillowPark } = require("./willowpark");
const { createStore: createArc } = require("./arc");
const { createStore: createClbSpirits } = require("./clbspirits");
const { createStore: createWhiskyDrop } = require("./whiskydrop");
const { createStore: createLime } = require("./lime");
const { createStore: createVineArts } = require("./vinearts");
const { createStore: createCanadianLiquor } = require("./canadianliquor");
const { createStore: createLiquorWarehouse } = require("./liquorwarehouse");
const { createStore: createZyn } = require("./zyn");
const { createStore: createWineAndBeyond } = require("./wineandbeyond");
const { createStore: createHighlander } = require("./highlander");
const { createStore: createLiberty } = require("./liberty");
const { createStore: createRmwsb } = require("./rmwsb");
const { createStore: createSherbrooke } = require("./sherbrooke");
const { createStore: createColorDeVino } = require("./colordevino");
const { createStore: createHighPointBws } = require("./highpointbws");
const { createStore: createNewDistrict } = require("./newdistrict");
const { createStore: createLiquorama } = require("./liquorama");
const { createStore: createMarquis } = require("./marquis");
const { createStore: createEverythingWine } = require("./everythingwine");

function getStoreRegions() {
	return Object.fromEntries(createStores().map((s) => [s.key, s.region || "unknown"]));
}

function createStores({ defaultUa } = {}) {
	// Order matters: the scheduler (src/tracker/run_all.js) builds its work
	// queue in this order and workers pick the earliest available item, so
	// slow stores should sit near the top to overlap with the fast tail
	// rather than straggle at the end of the run.
	return [
		// Slowest first — W&B paginates ~120 throttled HTML pages (~9 min);
		// gull is rate-limited to a 12s/request throttle.
		createWineAndBeyond(defaultUa),
		createGull(defaultUa),
		// Existing session/API stores.
		createKWM(defaultUa),
		createCraftCellars(defaultUa),
		createSierra(defaultUa),
		createCoop(defaultUa),
		createStrath(defaultUa),
		createBCL(defaultUa),
		createBSW(defaultUa),
		createWillowPark(defaultUa),
		createVessel(defaultUa),
		createMaltsAndGrains(defaultUa),
		createKegNCork(defaultUa),
		createTudor(defaultUa),
		createVintage(defaultUa),
		createLegacy(defaultUa),
		createArc(defaultUa),
		// Magento; does a budgeted detail-fetch SKU repair pass (slow-ish) so sits high.
		createEverythingWine(defaultUa),
		// New Shopify stores, largest catalog first.
		createLime(defaultUa),
		createZyn(defaultUa),
		createCanadianLiquor(defaultUa),
		createLiquorWarehouse(defaultUa),
		createClbSpirits(defaultUa),
		createWhiskyDrop(defaultUa),
		createVineArts(defaultUa),
		createHighlander(defaultUa),
		createLiberty(defaultUa),
		createRmwsb(defaultUa),
		createSherbrooke(defaultUa),
		createColorDeVino(defaultUa),
		createHighPointBws(defaultUa),
		createNewDistrict(defaultUa),
		createLiquorama(defaultUa),
		createMarquis(defaultUa),
	];
}

module.exports = { createStores, getStoreRegions, parseProductsSierra };
