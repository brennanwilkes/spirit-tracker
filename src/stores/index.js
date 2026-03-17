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

function getStoreRegions() {
	return Object.fromEntries(createStores().map((s) => [s.key, s.region || "unknown"]));
}

function createStores({ defaultUa } = {}) {
	return [
		createKWM(defaultUa),
		createCraftCellars(defaultUa),
		createSierra(defaultUa),
		createGull(defaultUa),
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
	];
}

module.exports = { createStores, getStoreRegions, parseProductsSierra };
