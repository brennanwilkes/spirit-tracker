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

function createStores({ defaultUa } = {}) {
  return [
    createGull(defaultUa),
    createSierra(defaultUa),
    createKWM(defaultUa),
    createCraftCellars(defaultUa),
    createStrath(defaultUa),
    createBSW(defaultUa),
    createKegNCork(defaultUa),
    createMaltsAndGrains(defaultUa),
    createBCL(defaultUa),
    createLegacy(defaultUa),
  ];
}

module.exports = { createStores, parseProductsSierra };
