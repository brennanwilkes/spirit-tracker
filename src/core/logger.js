"use strict";

const { C, color } = require("../utils/ansi");
const { ts } = require("../utils/time");

function createLogger({ debug = false, colorize: wantColor = true } = {}) {
  const isTTY = Boolean(process.stdout && process.stdout.isTTY);
  const enabled = Boolean(wantColor && isTTY);

  function ok(msg) {
    console.log(color(`[OK    ${ts()}] `, C.green, enabled) + String(msg));
  }

  function warn(msg) {
    console.log(color(`[WARN  ${ts()}] `, C.yellow, enabled) + String(msg));
  }

  function err(msg) {
    console.error(color(`[ERR   ${ts()}] `, C.red, enabled) + String(msg));
  }

  function info(msg) {
    if (debug) console.log(color(`[INFO  ${ts()}] `, C.cyan, enabled) + String(msg));
  }

  function dbg(msg) {
    if (debug) console.log(color(`[DEBUG ${ts()}] `, C.gray, enabled) + String(msg));
  }

  function dim(s) {
    return color(s, C.dim, enabled);
  }

  function bold(s) {
    return color(s, C.bold, enabled);
  }

  function paint(s, code) {
    return color(s, code, enabled);
  }

  return {
    debug,
    isTTY,
    colorize: enabled,
    C,
    ok,
    warn,
    err,
    info,
    dbg,
    dim,
    bold,
    color: paint,
  };
}

module.exports = { createLogger };
