"use strict";

const { createStore: createSierra, parseProductsSierra } = require("./sierrasprings");
const { createStore: createBSW } = require("./bsw");
const { createStore: createKWM } = require("./kwm");
const { createStore: createKegNCork } = require("./kegncork");
const { createStore: createMaltsAndGrains } = require("./maltsandgrains");
const { createStore: createCraftCellars } = require("./craftcellars");
const { createStore: createBCL } = require("./bcl");
const { createStore: createStrath } = require("./strath");

function createStores({ defaultUa } = {}) {
  return [
    createSierra(defaultUa),
    createBSW(defaultUa),
    createKWM(defaultUa),
    createKegNCork(defaultUa),
    createMaltsAndGrains(defaultUa),
    createCraftCellars(defaultUa),
    createBCL(defaultUa),
    createStrath(defaultUa),
  ];
}

module.exports = { createStores, parseProductsSierra };
